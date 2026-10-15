"""Small read-only Streamable HTTP bridge for the two project integrations.

This is not a general MCP client: stdio, legacy SSE and stream resumption are
not implemented. A failed tool call is never silently replayed.

HTTP opening and body consumption share one review deadline. Incremental reads
bound ordinary slow response bodies; urllib's DNS/TLS/HTTP-header internals and
socket timeouts do not provide a strict wall-clock cancellation guarantee.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import socket
import sys
import time
from typing import Any
import urllib.error
import urllib.parse
import urllib.request

VERSIONS = {"2025-11-25", "2025-06-18", "2025-03-26"}
ALLOWLISTS = {
    "mcd": {"query-nearby-stores", "query-meals", "query-meal-detail",
            "query-store-coupons", "calculate-price", "now-time-info"},
    "xiaohongshu": {"check_login_status", "search_feeds", "get_feed_detail"},
}
MAX_BYTES = 8 * 1024 * 1024
MAX_EVENTS = 1024
READ_CHUNK_BYTES = 64 * 1024


class BridgeError(Exception):
    def __init__(self, kind: str, message: str):
        self.kind = kind
        self.message = message
        super().__init__(message)


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise BridgeError("redirect_refused", "Endpoint redirected; credentials were not forwarded.")


def endpoint_config(server: str) -> tuple[str, str | None]:
    if server == "mcd":
        token = os.environ.get("MCD_MCP_TOKEN", "").strip()
        if not token:
            raise BridgeError("not_configured", "Set MCD_MCP_TOKEN in your local environment first.")
        return "https://mcp.mcd.cn", token
    url = os.environ.get("XHS_MCP_URL", "http://127.0.0.1:18060/mcp").strip()
    parsed = urllib.parse.urlsplit(url)
    try:
        parsed.port
    except ValueError as error:
        raise BridgeError("invalid_endpoint", "Invalid local Xiaohongshu endpoint port.") from error
    if (parsed.scheme not in {"http", "https"}
            or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}
            or parsed.username or parsed.password or parsed.query or parsed.fragment):
        raise BridgeError("invalid_endpoint", "XHS_MCP_URL must be a loopback HTTP(S) endpoint without embedded credentials.")
    return url, os.environ.get("XHS_MCP_AUTH_TOKEN") or None


def _message_result(message: Any, request_id: int) -> tuple[bool, Any]:
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
        raise BridgeError("invalid_rpc", "Expected a JSON-RPC 2.0 object.")
    if "method" in message:
        if "id" in message:
            raise BridgeError("unsupported_server_request", "Server-to-client requests are not supported by this bridge.")
        return False, None
    if type(message.get("id")) is not int or message["id"] != request_id:
        return False, None
    if "error" in message:
        error = message["error"]
        if not isinstance(error, dict) or type(error.get("code")) is not int:
            raise BridgeError("invalid_rpc", "Server returned an invalid JSON-RPC error object.")
        code = error["code"]
        raise BridgeError("rpc_error", f"Server returned JSON-RPC error code {code}; inspect the request schema.")
    if "result" not in message:
        raise BridgeError("invalid_rpc", "Matching response contains neither result nor error.")
    return True, message["result"]


def _remaining_time(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise BridgeError("timeout", "Request deadline reached; the tool call was not replayed.")
    return remaining


def _response_chunks(response, deadline: float):
    """Check one deadline between socket reads instead of filling a large read.

    HTTPResponse.read1 performs at most one buffered/raw read, unlike read(n),
    which can keep filling n bytes while a peer continuously trickles data.
    The one-byte fallback is for response wrappers without read1.
    """
    total = 0
    reader = getattr(response, "read1", None)
    while True:
        remaining = _remaining_time(deadline)
        fp = getattr(response, "fp", None)
        raw = getattr(fp, "raw", None)
        transport_socket = getattr(raw, "_sock", None)
        if transport_socket is not None:
            transport_socket.settimeout(remaining)
        chunk = reader(READ_CHUNK_BYTES) if callable(reader) else response.read(1)
        _remaining_time(deadline)
        if not chunk:
            return
        total += len(chunk)
        if total > MAX_BYTES:
            raise BridgeError("response_limit", "Response exceeds the size limit.")
        yield chunk


def read_result(response, request_id: int, deadline: float) -> Any:
    _remaining_time(deadline)
    media_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
    if media_type == "application/json":
        raw = b"".join(_response_chunks(response, deadline))
        try:
            message = json.loads(raw.decode("utf-8-sig"))
        except (ValueError, UnicodeError) as error:
            raise BridgeError("invalid_json", "Server response is not valid UTF-8 JSON.") from error
        matched, result = _message_result(message, request_id)
        if not matched:
            raise BridgeError("response_id_mismatch", "JSON response did not match the request ID.")
        _remaining_time(deadline)
        return result
    if media_type != "text/event-stream":
        raise BridgeError("unsupported_content_type", "Expected JSON or an SSE stream.")
    parts: list[str] = []
    events = 0
    line_buffer = bytearray()
    previous_cr = False
    first_line = True

    def consume_line(raw: bytes) -> tuple[bool, Any]:
        nonlocal parts, events, first_line
        try:
            line = raw.decode("utf-8-sig" if first_line else "utf-8")
        except UnicodeError as error:
            raise BridgeError("invalid_json", "SSE data is not valid UTF-8.") from error
        first_line = False
        if line:
            field, _, value = line.partition(":")
            if field == "data":
                parts.append(value[1:] if value.startswith(" ") else value)
            return False, None
        events += 1
        if events > MAX_EVENTS:
            raise BridgeError("response_limit", "SSE event limit reached.")
        data = "\n".join(parts)
        parts = []
        if not data.strip():
            return False, None
        try:
            message = json.loads(data)
        except ValueError as error:
            raise BridgeError("invalid_json", "SSE event is not a JSON-RPC JSON object.") from error
        return _message_result(message, request_id)

    for chunk in _response_chunks(response, deadline):
        for byte in chunk:
            if previous_cr and byte == 10:
                previous_cr = False
                continue
            previous_cr = False
            if byte in (10, 13):
                matched, result = consume_line(bytes(line_buffer))
                line_buffer.clear()
                previous_cr = byte == 13
                if matched:
                    _remaining_time(deadline)
                    return result
            else:
                line_buffer.append(byte)
        _remaining_time(deadline)
    raise BridgeError("stream_interrupted", "Stream ended before a matching result; automatic replay is disabled.")


def validate_arguments(value: Any, schema: dict, path: str = "arguments") -> None:
    """Validate common JSON Schema constraints; the server remains authoritative."""
    if not isinstance(schema, dict):
        return
    expected = schema.get("type")
    types = {
        "object": lambda x: isinstance(x, dict), "array": lambda x: isinstance(x, list),
        "string": lambda x: isinstance(x, str), "integer": lambda x: type(x) is int,
        "number": lambda x: type(x) in {int, float}, "boolean": lambda x: type(x) is bool,
        "null": lambda x: x is None,
    }
    if isinstance(expected, str) and expected in types and not types[expected](value):
        raise BridgeError("invalid_arguments", f"{path} must have type {expected}.")
    if "enum" in schema and value not in schema["enum"]:
        raise BridgeError("invalid_arguments", f"{path} is not an allowed enum value.")
    if isinstance(value, dict):
        required = schema.get("required", [])
        for key in required:
            if key not in value:
                raise BridgeError("invalid_arguments", f"{path}.{key} is required by the current tool schema.")
        properties = schema.get("properties", {})
        for key, item in value.items():
            if key in properties:
                validate_arguments(item, properties[key], f"{path}.{key}")
            elif schema.get("additionalProperties") is False:
                raise BridgeError("invalid_arguments", f"{path}.{key} is not permitted.")
    elif isinstance(value, list):
        for name, comparison in (("minItems", lambda n: len(value) < n), ("maxItems", lambda n: len(value) > n)):
            if name in schema and comparison(schema[name]):
                raise BridgeError("invalid_arguments", f"{path} violates {name}.")
        for i, item in enumerate(value):
            validate_arguments(item, schema.get("items", {}), f"{path}[{i}]")
    elif type(value) in {int, float}:
        if not math.isfinite(value):
            raise BridgeError("invalid_arguments", f"{path} must be finite.")
        if "minimum" in schema and value < schema["minimum"] or "maximum" in schema and value > schema["maximum"]:
            raise BridgeError("invalid_arguments", f"{path} is outside the permitted numeric range.")


class ReadOnlyClient:
    def __init__(self, server: str, timeout: float = 25):
        self.server = server
        self.url, self.token = endpoint_config(server)
        self.timeout = max(1, min(timeout, 60))
        self.opener = urllib.request.build_opener(NoRedirects())
        self.version: str | None = None
        self.session: str | None = None
        self.sequence = 0
        self.tools: dict[str, dict] = {}

    def _post(self, method: str, params: dict | None = None, notification: bool = False):
        self.sequence += 1
        message = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = params
        if not notification:
            message["id"] = self.sequence
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        if self.version:
            headers["MCP-Protocol-Version"] = self.version
        if self.session:
            headers["MCP-Session-Id"] = self.session
        request = urllib.request.Request(self.url, data=json.dumps(message, allow_nan=False).encode("utf-8"), headers=headers, method="POST")
        deadline = time.monotonic() + self.timeout
        try:
            with self.opener.open(request, timeout=_remaining_time(deadline)) as response:
                _remaining_time(deadline)
                session = response.headers.get("MCP-Session-Id")
                if session is not None:
                    if not session or any(ord(c) < 33 or ord(c) > 126 for c in session):
                        raise BridgeError("invalid_session", "Server supplied an invalid session identifier.")
                    self.session = session
                if notification:
                    if response.status != 202:
                        raise BridgeError("invalid_notification_response", "Notification was not acknowledged with HTTP 202.")
                    return None
                if response.status != 200:
                    raise BridgeError("invalid_http_response", "RPC request did not return HTTP 200.")
                return read_result(response, self.sequence, deadline)
        except urllib.error.HTTPError as error:
            kind = {401: "authentication_failed", 403: "access_denied", 429: "rate_limited", 404: "endpoint_or_session_missing"}.get(error.code, "http_error")
            raise BridgeError(kind, f"HTTP {error.code}; no tool call was automatically replayed.") from error
        except (urllib.error.URLError, TimeoutError, socket.timeout, OSError) as error:
            raise BridgeError("network_error", "Could not complete the endpoint request; check the local connection.") from error

    def connect(self) -> list[dict]:
        result = self._post("initialize", {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "mcd-social-to-meal-readonly", "version": "0.1.0"}})
        if not isinstance(result, dict) or result.get("protocolVersion") not in VERSIONS:
            raise BridgeError("unsupported_protocol", "Server negotiated an unsupported protocol version.")
        if not isinstance(result.get("capabilities"), dict) or "tools" not in result["capabilities"]:
            raise BridgeError("tools_unavailable", "Server did not advertise tool support.")
        self.version = result["protocolVersion"]
        self._post("notifications/initialized", notification=True)
        cursor = None
        seen = set()
        self.tools = {}
        for _ in range(10):
            page = self._post("tools/list", {"cursor": cursor} if cursor else {})
            if not isinstance(page, dict) or not isinstance(page.get("tools"), list):
                raise BridgeError("invalid_tools_list", "Invalid tool discovery response.")
            for tool in page["tools"]:
                if not isinstance(tool, dict) or not isinstance(tool.get("name"), str) or not isinstance(tool.get("inputSchema"), dict):
                    raise BridgeError("invalid_tools_list", "Invalid tool definition.")
                if tool["name"] in self.tools:
                    raise BridgeError("duplicate_tool", "Tool discovery returned duplicate names.")
                self.tools[tool["name"]] = tool
            cursor = page.get("nextCursor")
            if not cursor:
                return [self.tools[name] for name in sorted(self.tools) if name in ALLOWLISTS[self.server]]
            if not isinstance(cursor, str) or cursor in seen:
                raise BridgeError("pagination_loop", "Tool pagination cursor repeated or is invalid.")
            seen.add(cursor)
        raise BridgeError("pagination_limit", "Tool discovery exceeded ten pages.")

    def call_tool(self, name: str, arguments: dict) -> dict:
        if name not in ALLOWLISTS[self.server]:
            raise BridgeError("tool_not_allowed", "This bridge supports only the documented read-only allowlist.")
        if name not in self.tools:
            raise BridgeError("tool_not_discovered", "The tool is absent from the current server definition.")
        if not isinstance(arguments, dict):
            raise BridgeError("invalid_arguments", "Tool arguments must be a JSON object.")
        validate_arguments(arguments, self.tools[name]["inputSchema"])
        result = self._post("tools/call", {"name": name, "arguments": arguments})
        if not isinstance(result, dict):
            raise BridgeError("invalid_tool_result", "Tool result is not an object.")
        if result.get("isError") is True:
            raise BridgeError("tool_error", "The tool reported an execution error; this is not a valid business result.")
        # Business status in content is deliberately not guessed here.
        return result


def private_output(path: str) -> Path:
    root = Path(__file__).resolve().parent.parent / "private"
    destination = Path(path).resolve()
    try:
        destination.relative_to(root.resolve())
    except ValueError as error:
        raise BridgeError("private_output_required", "Live responses must be written inside this project's ignored private/ directory.") from error
    destination.parent.mkdir(parents=True, exist_ok=True)
    return destination


def make_quote_binding(report: dict, catalog: dict, note_id: str) -> dict:
    from compare_engine import basket_fingerprint
    if report.get("mode") != "live" or catalog.get("mode") != "live":
        raise BridgeError("live_binding_required", "Official price calls require a live catalog and source report.")
    candidates = [item for item in report.get("recommendations", []) if item.get("note_id") == note_id]
    if len(candidates) != 1 or candidates[0].get("mapping_status") != "matched":
        raise BridgeError("invalid_quote_binding", "Choose one recommendation with all product and option mappings resolved.")
    item = candidates[0]
    fingerprint = basket_fingerprint(catalog["store_id"], catalog["context"], item["basket"])
    if fingerprint != item.get("basket_fingerprint"):
        raise BridgeError("invalid_quote_binding", "Recommendation no longer matches the catalog context.")
    return {"note_id": note_id, "store_id": catalog["store_id"], "context": catalog["context"], "basket_fingerprint": fingerprint}


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="只读检查麦当劳与本地小红书 MCP；不登录、不下单。")
    sub = parser.add_subparsers(dest="command", required=True)
    for command in ("probe", "call"):
        child = sub.add_parser(command)
        child.add_argument("--server", choices=sorted(ALLOWLISTS), required=True)
        child.add_argument("--output", required=True, help="必须位于项目 private/ 目录内")
        if command == "call":
            child.add_argument("--tool", required=True)
            child.add_argument("--arguments", required=True)
            child.add_argument("--binding-report", help="calculate-price requires a current unquoted report")
            child.add_argument("--binding-catalog", help="calculate-price requires the live normalized catalog")
            child.add_argument("--note-id", help="Source recommendation being priced")
    args = parser.parse_args()
    try:
        destination = private_output(args.output)
        arguments = None
        binding = None
        if args.command == "call":
            arguments = json.loads(Path(args.arguments).read_text(encoding="utf-8-sig"))
            if args.tool == "calculate-price":
                if args.server != "mcd" or not all([args.binding_report, args.binding_catalog, args.note_id]):
                    raise BridgeError("quote_binding_required", "Price calls require --binding-report, --binding-catalog and --note-id.")
                binding = make_quote_binding(
                    json.loads(Path(args.binding_report).read_text(encoding="utf-8-sig")),
                    json.loads(Path(args.binding_catalog).read_text(encoding="utf-8-sig")), args.note_id)
        client = ReadOnlyClient(args.server)
        tools = client.connect()
        capture = {"server": args.server, "mode": "live"}
        if args.command == "probe":
            capture["tools"] = tools
        else:
            capture.update(tool=args.tool, arguments_sha256=hashlib.sha256(json.dumps(arguments, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()).hexdigest(), result=client.call_tool(args.tool, arguments))
            if binding:
                capture["quote_binding"] = binding
        capture["captured_at"] = datetime.now(timezone.utc).isoformat()
        destination.write_text(json.dumps(capture, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
        print(json.dumps({"status": "captured", "server": args.server, "path": str(destination), "mode": "live"}, ensure_ascii=False))
        return 0
    except BridgeError as error:
        print(json.dumps({"status": "error", "kind": error.kind, "message": error.message}, ensure_ascii=False))
        return 2
    except (ValueError, OSError, TypeError, KeyError):
        print(json.dumps({"status": "error", "kind": "invalid_local_input", "message": "Check the local JSON input and output path."}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
