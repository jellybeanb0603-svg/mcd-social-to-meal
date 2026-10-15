import io
import json
import os
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from mcp_bridge import BridgeError, ReadOnlyClient, endpoint_config, read_result, validate_arguments


class Response(io.BytesIO):
    def __init__(self, data, content_type):
        super().__init__(data)
        self.headers = {"Content-Type": content_type}


class TrickleResponse(Response):
    """A peer that continually sends bytes instead of triggering an idle timeout."""
    def read1(self, size=-1):
        time.sleep(0.01)
        return super().read(1)


class BridgeTests(unittest.TestCase):
    def test_stateless_json(self):
        result = read_result(Response(b'{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}', 'application/json; charset=utf-8'), 2, time.monotonic()+1)
        self.assertEqual(result, {"tools": []})

    def test_sse_skips_empty_prime_and_notification(self):
        data = b': keepalive\nid: initial\ndata:\n\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\ndata: {"jsonrpc":"2.0","id":4,\ndata: "result":{"value":7}}\n\n'
        self.assertEqual(read_result(Response(data, 'text/event-stream'), 4, time.monotonic()+1), {"value":7})

    def test_matching_id_required(self):
        with self.assertRaises(BridgeError) as caught:
            read_result(Response(b'{"jsonrpc":"2.0","id":1,"result":{}}', 'application/json'), 2, time.monotonic()+1)
        self.assertEqual(caught.exception.kind, 'response_id_mismatch')

    def test_disconnected_stream_is_not_success(self):
        with self.assertRaises(BridgeError) as caught:
            read_result(Response(b'id: initial\ndata:\n\n', 'text/event-stream'), 3, time.monotonic()+1)
        self.assertEqual(caught.exception.kind, 'stream_interrupted')

    def test_json_cannot_succeed_after_an_expired_deadline(self):
        response = Response(b'{"jsonrpc":"2.0","id":1,"result":{}}', 'application/json')
        with self.assertRaises(BridgeError) as caught:
            read_result(response, 1, time.monotonic()-1)
        self.assertEqual(caught.exception.kind, 'timeout')

    def test_continuous_slow_json_and_sse_share_a_body_deadline(self):
        cases = (
            ('application/json', b'{"jsonrpc":"2.0","id":1,"result":{}}'),
            ('text/event-stream', b'data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'),
        )
        for content_type, data in cases:
            with self.subTest(content_type=content_type):
                response = TrickleResponse(data, content_type)
                with self.assertRaises(BridgeError) as caught:
                    read_result(response, 1, time.monotonic()+0.035)
                self.assertEqual(caught.exception.kind, 'timeout')
                self.assertLess(response.tell(), len(data))

    def test_opening_does_not_restart_the_result_deadline(self):
        with patch.dict(os.environ, {'MCD_MCP_TOKEN':'test-only'}):
            client = ReadOnlyClient('mcd')
        client.timeout = 0.015

        class SlowOpen:
            def open(self, request, timeout):
                time.sleep(0.025)
                response = Response(b'{"jsonrpc":"2.0","id":1,"result":{}}', 'application/json')
                response.status = 200
                return response

        client.opener = SlowOpen()
        with self.assertRaises(BridgeError) as caught:
            client._post('initialize', {})
        self.assertEqual(caught.exception.kind, 'timeout')

    def test_rpc_error_does_not_echo_server_secret(self):
        with self.assertRaises(BridgeError) as caught:
            read_result(Response(b'{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Bearer secret"}}', 'application/json'), 1, time.monotonic()+1)
        self.assertNotIn('secret', str(caught.exception))

    def test_malformed_rpc_error_codes_are_not_echoed(self):
        for code in ('Bearer secret', {'credential':'secret'}, True, -32602.0, None):
            with self.subTest(code_type=type(code).__name__):
                data = json.dumps({'jsonrpc':'2.0', 'id':1,
                    'error':{'code':code, 'message':'Bearer secret'}}).encode()
                with self.assertRaises(BridgeError) as caught:
                    read_result(Response(data, 'application/json'), 1, time.monotonic()+1)
                self.assertEqual(caught.exception.kind, 'invalid_rpc')
                self.assertEqual(caught.exception.message, 'Server returned an invalid JSON-RPC error object.')
                self.assertNotIn('secret', str(caught.exception))

    def test_local_service_endpoint_restriction(self):
        with patch.dict(os.environ, {'XHS_MCP_URL':'http://external.example/mcp'}):
            with self.assertRaises(BridgeError):
                endpoint_config('xiaohongshu')

    def test_missing_token_has_no_network_call(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(BridgeError) as caught:
                ReadOnlyClient('mcd')
            self.assertEqual(caught.exception.kind, 'not_configured')

    def test_no_writes_even_if_server_advertises_them(self):
        with patch.dict(os.environ, {'MCD_MCP_TOKEN':'test-only'}):
            client = ReadOnlyClient('mcd')
        client.tools = {'create-order':{'inputSchema':{'type':'object'}}}
        with self.assertRaises(BridgeError) as caught:
            client.call_tool('create-order', {})
        self.assertEqual(caught.exception.kind, 'tool_not_allowed')

    def test_required_parameter_blocks_request(self):
        with self.assertRaises(BridgeError):
            validate_arguments({}, {'type':'object','required':['storeCode']})

    def test_bool_is_not_quantity(self):
        with self.assertRaises(BridgeError):
            validate_arguments(True, {'type':'integer'})

    def test_pagination_loop_fails(self):
        with patch.dict(os.environ, {'MCD_MCP_TOKEN':'test-only'}):
            client = ReadOnlyClient('mcd')
        responses = [
            {'protocolVersion':'2025-11-25','capabilities':{'tools':{}}},
            None,
            {'tools':[], 'nextCursor':'repeat'},
            {'tools':[], 'nextCursor':'repeat'},
        ]
        client._post = lambda *a, **k: responses.pop(0)
        with self.assertRaises(BridgeError) as caught:
            client.connect()
        self.assertEqual(caught.exception.kind, 'pagination_loop')


if __name__ == '__main__':
    unittest.main()
