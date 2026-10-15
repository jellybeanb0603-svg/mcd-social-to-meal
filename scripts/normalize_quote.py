"""Normalize one captured official quote using an explicitly verified field map."""
from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
import sys
from typing import Any

from compare_engine import money_to_cents


def observed_timestamp(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Observed quote timestamps must be explicit strings")
    parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("Observed quote timestamps must include a timezone")
    return value


def pointer_get(value: Any, pointer: str) -> Any:
    if pointer == "":
        return value
    if not isinstance(pointer, str) or not pointer.startswith("/"):
        raise ValueError("Use an explicit JSON Pointer for each response field")
    for part in pointer[1:].split("/"):
        key = part.replace("~1", "/").replace("~0", "~")
        if isinstance(value, dict):
            value = value[key]
        elif isinstance(value, list) and key.isdecimal():
            value = value[int(key)]
        else:
            raise ValueError("Field pointer does not match the observed response")
    return value


def normalize_capture(capture: dict, arguments: dict, field_map: dict) -> dict:
    if capture.get("mode") != "live" or capture.get("server") != "mcd" or capture.get("tool") != "calculate-price":
        raise ValueError("Only captured official price-tool responses may be normalized")
    arguments_hash = hashlib.sha256(json.dumps(arguments, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()).hexdigest()
    if arguments_hash != capture.get("arguments_sha256"):
        raise ValueError("The supplied request differs from the captured request")
    result = capture.get("result")
    if not isinstance(result, dict) or result.get("isError") is True:
        raise ValueError("A tool error is not a valid quote")
    binding = capture.get("quote_binding")
    if not isinstance(binding, dict) or not all(key in binding for key in ["note_id", "store_id", "context", "basket_fingerprint"]):
        raise ValueError("The capture has no recommendation binding")
    mode = field_map.get("payload")
    if mode == "structured":
        payload = result.get("structuredContent")
    elif mode == "text-json":
        blocks = [block for block in result.get("content", []) if block.get("type") == "text"]
        index = field_map.get("text_index")
        if type(index) is not int or index < 0 or index >= len(blocks):
            raise ValueError("Choose the specific JSON text block")
        payload = json.loads(blocks[index]["text"])
    else:
        raise ValueError("Declare structured or text-json payload; opaque text is not guessed")
    if not isinstance(payload, (dict, list)):
        raise ValueError("Business payload is absent or is not structured data")
    checks = field_map.get("success_checks")
    if not isinstance(checks, list) or not checks:
        raise ValueError("Declare observed business-success checks")
    for check in checks:
        expected = check["equals"]
        actual = pointer_get(payload, check["pointer"])
        if type(actual) is not type(expected) or actual != expected:
            raise ValueError("Business status did not satisfy the verified success condition")
    total = {"amount": pointer_get(payload, field_map["total_pointer"]), "unit": field_map["total_unit"], "currency": field_map["currency"]}
    money_to_cents(total)
    quoted_at = capture["captured_at"]
    if "quoted_at_pointer" in field_map:
        quoted_at = pointer_get(payload, field_map["quoted_at_pointer"])
    quote = {"note_id": binding["note_id"], "basket_fingerprint": binding["basket_fingerprint"], "status": "success", "total": total,
             "quoted_at": observed_timestamp(quoted_at), "evidence": {"source": "mcp_bridge_capture", "arguments_sha256": arguments_hash}}
    if "expires_at_pointer" in field_map:
        quote["expires_at"] = observed_timestamp(pointer_get(payload, field_map["expires_at_pointer"]))
    return {"mode": "live", "store_id": binding["store_id"], "context": binding["context"], "currency": "CNY", "quotes": [quote]}


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="按已核实的字段路径归一化真实官方报价；不猜金额字段或单位。")
    parser.add_argument("--capture", required=True)
    parser.add_argument("--arguments", required=True)
    parser.add_argument("--field-map", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        read = lambda path: json.loads(Path(path).read_text(encoding="utf-8-sig"))
        normalized = normalize_capture(read(args.capture), read(args.arguments), read(args.field_map))
        destination = Path(args.output)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(normalized, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
        print(json.dumps({"status":"normalized", "path":str(destination), "quotes":1}, ensure_ascii=False))
        return 0
    except (ValueError, KeyError, IndexError, TypeError, OSError):
        print(json.dumps({"status":"error", "message":"Capture, request binding, business status, field path or amount unit failed validation."}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
