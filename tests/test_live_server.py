"""Exercise the local HTTP boundary with fake providers, without account access."""

import http.client
import json
from pathlib import Path
import queue
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "scripts" / "live_server.mjs"
NODE = shutil.which("node")


@unittest.skipUnless(NODE and SERVER.is_file(), "Node.js and live server are required")
class LiveServerBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.web_dir = tempfile.TemporaryDirectory(prefix="live-http-", dir=ROOT / "tests")
        cls.web_root = Path(cls.web_dir.name)
        (cls.web_root / "index.html").write_text("<!doctype html><title>public fixture</title>", encoding="utf-8")
        (cls.web_root / "app.js").write_text("console.log('public fixture');", encoding="utf-8")
        (cls.web_root / "style.css").write_text("body { color: black; }", encoding="utf-8")
        # Not on the static allowlist, even though it is under webRoot.
        (cls.web_root / "cookies.json").write_text('{"fixture_secret":"never public"}', encoding="utf-8")
        harness = f"""
import {{createLiveServer}} from {json.dumps(SERVER.as_uri())};
const providers = {{
  status: async () => ({{providers: {{mcd: {{status:'configured'}}, xiaohongshu: {{status:'configured'}}, amap: {{status:'configured'}}}}}}),
  geocode: async () => {{throw new Error('Bearer fixture-server-secret https://example.invalid/?key=fixture-key');}},
  stores: async () => ({{stores:[{{id:'fixture-store',name:'Fixture store',address:'Fixture address'}}]}}),
  menu: async () => ({{storeCode:'fixture-store', items:[], queriedAt:new Date().toISOString()}}),
  search: async () => ({{notes:[], queriedAt:new Date().toISOString()}}),
  note: async () => {{throw new Error('Unused fixture note');}},
  detail: async (argument) => ({{received:argument}}),
  quote: async ({{items}}) => {{
    const kind = items[0].productCode;
    if (kind === 'selection-stale') {{ const error = new Error('private detail'); error.code = 'selection_stale'; throw error; }}
    const time = Date.now() + (kind === 'stale' ? -301000 : kind === 'future' ? 61000 : kind === 'older-valid' ? -120000 : 0);
    const quotedAt = new Date(time).toISOString();
    return {{
      totalCents: kind === 'fractional' ? 1390.5 : kind === 'negative' ? -1 : 1390,
      quotedAt: kind === 'timezone-missing' ? quotedAt.slice(0,-1) : quotedAt,
      queriedAt: new Date().toISOString(), currency:'CNY',
      receivedItems:items,
      ...(kind === 'expired' ? {{expiresAt:new Date(Date.now()-1000).toISOString()}} : {{}}),
    }};
  }},
}};
const app = await createLiveServer({{providers, webRoot:{json.dumps(str(cls.web_root))}}});
console.log('TEST_SERVER=' + app.url);
process.stdin.resume();
process.stdin.on('data', async () => {{await app.close(); process.exit(0);}});
"""
        cls.process = subprocess.Popen(
            [NODE, "--input-type=module", "-e", harness], cwd=ROOT,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8",
        )
        cls.addClassCleanup(cls.stop_server)
        lines = queue.Queue()

        def read_startup():
            for line in cls.process.stdout:
                if line.startswith("TEST_SERVER="):
                    lines.put(line.strip().split("=", 1)[1])
                    return
            lines.put(None)

        threading.Thread(target=read_startup, daemon=True).start()
        try:
            cls.base_url = lines.get(timeout=15)
        except queue.Empty:
            cls.process.terminate()
            cls.process.wait(timeout=5)
            cls.web_dir.cleanup()
            raise RuntimeError("Local test server did not start within 15 seconds")
        if not cls.base_url:
            error = cls.process.stderr.read()
            cls.process.wait(timeout=5)
            cls.web_dir.cleanup()
            raise RuntimeError("Local test server failed to start: " + error)
        parsed = urlsplit(cls.base_url)
        cls.host, cls.port = parsed.hostname, parsed.port
        response, _, body = cls.request("GET", "/api/status")
        if response != 200:
            raise RuntimeError("Local test status endpoint did not respond")
        cls.csrf = json.loads(body)["csrfToken"]

    @classmethod
    def stop_server(cls):
        if cls.process.poll() is None:
            try:
                cls.process.communicate("close\n", timeout=5)
            except subprocess.TimeoutExpired:
                cls.process.terminate()
                cls.process.communicate(timeout=5)
        cls.web_dir.cleanup()

    @classmethod
    def request(cls, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection(cls.host, cls.port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read().decode("utf-8")
        finally:
            connection.close()

    def post(self, path, value, **headers):
        return self.request("POST", path, json.dumps(value), {
            "Content-Type": "application/json", "X-CSRF-Token": self.csrf, **headers,
        })

    def test_only_explicit_public_assets_are_served(self):
        status, headers, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("public fixture", body)
        self.assertIn("text/html", headers.get("Content-Type", ""))
        for path in ("/cookies.json", "/private/cookies.json", "/scripts/live_server.mjs", "/../cookies.json", "/%2e%2e/cookies.json"):
            with self.subTest(path=path):
                status, _, body = self.request("GET", path)
                self.assertEqual(status, 404)
                self.assertNotIn("fixture_secret", body)

    def test_changed_combo_options_have_actionable_public_error(self):
        self.post('/api/stores', {'city': 'Shanghai', 'location': 'Public place'})
        status, _, body = self.post('/api/quote', {
            'storeCode': 'fixture-store', 'items': [{'productCode': 'selection-stale', 'quantity': 1}],
        })
        self.assertEqual(status, 502)
        result = json.loads(body)
        self.assertEqual(result['error']['code'], 'selection_stale')
        self.assertIn('重新确认', result['error']['message'])
        self.assertNotIn('private detail', body)

    def test_unrecognized_host_cannot_reach_local_accounts(self):
        status, _, _ = self.request("GET", "/api/status", headers={"Host": f"attacker.example:{self.port}"})
        self.assertIn(status, (400, 403))

    def test_foreign_origin_is_rejected_without_cors(self):
        status, headers, _ = self.request("GET", "/api/status", headers={"Origin": "https://attacker.example"})
        self.assertEqual(status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_localhost_alias_is_allowed(self):
        status, _, _ = self.request("GET", "/api/status", headers={
            "Host": f"localhost:{self.port}", "Origin": f"http://localhost:{self.port}",
        })
        self.assertEqual(status, 200)

    def test_post_requires_per_process_csrf(self):
        for token in (None, "wrong-token"):
            with self.subTest(token=token):
                headers = {"Content-Type": "application/json"}
                if token is not None:
                    headers["X-CSRF-Token"] = token
                status, _, _ = self.request("POST", "/api/location", '{}', headers)
                self.assertEqual(status, 403)

    def test_post_rejects_non_json_content_type(self):
        status, _, _ = self.request("POST", "/api/location", '{}', {
            "Content-Type": "text/plain", "X-CSRF-Token": self.csrf,
        })
        self.assertEqual(status, 415)

    def test_malformed_and_non_object_json_are_rejected(self):
        for body in ("{", "[]", "null", '"text"'):
            with self.subTest(body=body):
                status, _, _ = self.request("POST", "/api/location", body, {
                    "Content-Type": "application/json", "X-CSRF-Token": self.csrf,
                })
                self.assertEqual(status, 400)

    def test_oversize_body_is_rejected(self):
        status, _, _ = self.post("/api/location", {"location": "x" * 70000})
        self.assertEqual(status, 413)

    def test_arbitrary_tool_or_transaction_routes_do_not_exist(self):
        for path in ("/api/mcp", "/api/call", "/api/create-order", "/api/publish"):
            with self.subTest(path=path):
                status, _, _ = self.post(path, {"tool": "create-order", "arguments": {}})
                self.assertEqual(status, 404)

    def test_provider_exceptions_do_not_disclose_credentials_or_urls(self):
        status, _, body = self.post("/api/location", {"city": "上海", "location": "南京路步行街"})
        self.assertEqual(status, 502)
        error = json.loads(body)
        self.assertFalse(error["ok"])
        self.assertEqual(error["error"]["code"], "provider_error")
        for secret in ("fixture-server-secret", "fixture-key", "example.invalid", "Bearer"):
            self.assertNotIn(secret, body)

    def seed_store(self):
        status, _, _ = self.post("/api/stores", {"city": "上海", "location": "南京路步行街"})
        self.assertEqual(status, 200)

    def test_quote_requires_a_previously_queried_store(self):
        status, _, body = self.post("/api/quote", {
            "storeCode": "never-queried", "items": [{"productCode": "valid", "quantity": 1}],
        })
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error"]["code"], "unknown_store")

    def test_automatic_plans_require_known_store(self):
        status, _, body = self.post('/api/meal-plans', {
            'storeCode': 'never-queried', 'intent': 'fries', 'keyword': '麦当劳 薯条',
        })
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)['error']['code'], 'unknown_store')

    def test_automatic_plan_job_read_requires_csrf(self):
        job_path = '/api/meal-plans/' + 'a' * 48
        status, _, _ = self.request('GET', job_path)
        self.assertEqual(status, 403)
        status, _, body = self.request('GET', job_path, headers={'X-CSRF-Token': self.csrf})
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body)['error']['code'], 'job_not_found')

    def test_automatic_plan_inputs_are_bounded(self):
        self.seed_store()
        for changes in ({'intent': 'publish'}, {'budgetCents': 1.5}, {'budgetCents': -1},
                        {'noteIds': ['one'] * 4}, {'keyword': ''}):
            with self.subTest(changes=changes):
                status, _, _ = self.post('/api/meal-plans', {
                    'storeCode': 'fixture-store', 'intent': 'fries', 'keyword': '麦当劳 薯条', **changes,
                })
                self.assertEqual(status, 400)

    def test_automatic_plan_job_has_separate_polling_endpoint(self):
        self.seed_store()
        status, _, body = self.post('/api/meal-plans', {
            'storeCode': 'fixture-store', 'intent': 'fries', 'keyword': '麦当劳 薯条',
        })
        self.assertEqual(status, 200)
        job_id = json.loads(body)['jobId']
        self.assertRegex(job_id, r'^[a-f0-9]{32,64}$')
        job = None
        for _ in range(50):
            status, _, body = self.request('GET', '/api/meal-plans/' + job_id,
                                           headers={'X-CSRF-Token': self.csrf})
            self.assertEqual(status, 200)
            job = json.loads(body)['job']
            if job['status'] != 'running':
                break
            time.sleep(0.02)
        self.assertIsNotNone(job)
        self.assertIn(job['status'], ('complete', 'failed'))
        self.assertEqual(job['id'], job_id)

    def test_quote_preserves_integer_cents_and_exact_basket(self):
        self.seed_store()
        basket = [{"productCode": "valid", "quantity": 2}]
        status, _, body = self.post("/api/quote", {"storeCode": "fixture-store", "items": basket})
        self.assertEqual(status, 200)
        result = json.loads(body)
        self.assertEqual(result["totalCents"], 1390)
        self.assertEqual(result["basket"], basket)
        self.assertEqual(result["storeCode"], "fixture-store")
        self.assertEqual(result["channel"], "到店自取")
        self.assertTrue(result["expiresAt"])

    def test_offer_reference_survives_quote_and_detail_without_raw_coupon_fields(self):
        self.seed_store()
        reference = "f2634511-ea4c-44f0-8599-30be720ae7a1"
        item = {"productCode": "valid", "quantity": 1, "offerRef": reference}
        status, _, body = self.post("/api/quote", {
            "storeCode": "fixture-store", "items": [{**item, "couponId": "private-id", "couponCode": "private-code"}],
        })
        self.assertEqual(status, 200)
        result = json.loads(body)
        self.assertEqual(result["receivedItems"], [item])
        self.assertEqual(result["basket"], [item])
        status, _, body = self.post("/api/item", {
            "storeCode": "fixture-store", "productCode": "valid", "offerRef": reference,
            "couponId": "private-id", "couponCode": "private-code",
        })
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["received"], {
            "storeCode": "fixture-store", "productCode": "valid", "offerRef": reference,
        })
        self.assertNotIn("private-id", body)
        self.assertNotIn("private-code", body)

    def test_offer_reference_is_bounded_and_nonempty(self):
        self.seed_store()
        for value in ("", "a" * 129, {"couponId": "raw"}):
            with self.subTest(value=value):
                status, _, _ = self.post("/api/quote", {
                    "storeCode": "fixture-store", "items": [{"productCode": "valid", "quantity": 1, "offerRef": value}],
                })
                self.assertEqual(status, 400)

    def test_quote_rejects_invalid_quantities_and_non_integer_provider_amounts(self):
        self.seed_store()
        for quantity in (0, True, 21, 1.5):
            with self.subTest(quantity=quantity):
                status, _, _ = self.post("/api/quote", {
                    "storeCode": "fixture-store", "items": [{"productCode": "valid", "quantity": quantity}],
                })
                self.assertEqual(status, 400)
        for product in ("fractional", "negative"):
            with self.subTest(product=product):
                status, _, _ = self.post("/api/quote", {
                    "storeCode": "fixture-store", "items": [{"productCode": product, "quantity": 1}],
                })
                self.assertEqual(status, 502)

    def test_quote_rejects_stale_future_expired_or_timezone_missing_time(self):
        self.seed_store()
        for product in ("stale", "future", "expired", "timezone-missing"):
            with self.subTest(product=product):
                status, _, _ = self.post("/api/quote", {
                    "storeCode": "fixture-store", "items": [{"productCode": product, "quantity": 1}],
                })
                self.assertEqual(status, 502)

    def test_read_time_does_not_extend_an_older_valid_quote(self):
        from datetime import datetime

        self.seed_store()
        status, _, body = self.post("/api/quote", {
            "storeCode": "fixture-store", "items": [{"productCode": "older-valid", "quantity": 1}],
        })
        self.assertEqual(status, 200)
        result = json.loads(body)
        quoted = datetime.fromisoformat(result["quotedAt"].replace("Z", "+00:00"))
        expires = datetime.fromisoformat(result["expiresAt"].replace("Z", "+00:00"))
        self.assertLessEqual((expires - quoted).total_seconds(), 300)


if __name__ == "__main__":
    unittest.main()
