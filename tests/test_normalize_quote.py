from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from normalize_quote import normalize_capture


class NormalizeTests(unittest.TestCase):
    def setUp(self):
        self.args = {"items":[{"code":"test-only"}]}
        digest=hashlib.sha256(json.dumps(self.args,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()).hexdigest()
        self.capture={"mode":"live","server":"mcd","tool":"calculate-price","arguments_sha256":digest,"captured_at":"2026-10-14T03:00:00+00:00",
          "quote_binding":{"note_id":"sample","store_id":"mock","context":{"channel":"pickup"},"basket_fingerprint":"test-fingerprint"},
          "result":{"structuredContent":{"ok":True,"payable":"29.90"}}}
        self.map={"payload":"structured","success_checks":[{"pointer":"/ok","equals":True}],"total_pointer":"/payable","total_unit":"yuan","currency":"CNY"}

    def test_explicit_amount_unit_and_binding_preserved(self):
        output=normalize_capture(self.capture,self.args,self.map)
        self.assertEqual(output['quotes'][0]['total']['amount'],'29.90')
        self.assertEqual(output['quotes'][0]['basket_fingerprint'],'test-fingerprint')

    def test_changed_request_refused(self):
        with self.assertRaises(ValueError): normalize_capture(self.capture,{},self.map)

    def test_domain_failure_is_not_http_success(self):
        changed=deepcopy(self.capture);changed['result']['structuredContent']['ok']=False
        with self.assertRaises(ValueError): normalize_capture(changed,self.args,self.map)

    def test_unknown_money_unit_refused(self):
        changed=deepcopy(self.map);changed['total_unit']='unknown'
        with self.assertRaises(ValueError): normalize_capture(self.capture,self.args,changed)

    def test_absent_success_checks_refused(self):
        changed=deepcopy(self.map);changed['success_checks']=[]
        with self.assertRaises(ValueError): normalize_capture(self.capture,self.args,changed)

    def test_text_json_must_be_explicit(self):
        changed=deepcopy(self.capture);changed['result']={'content':[{'type':'text','text':'{"ok":true,"payable":2990}'}]}
        mapping=deepcopy(self.map);mapping.update(payload='text-json',text_index=0,total_unit='cent')
        output=normalize_capture(changed,self.args,mapping)
        self.assertEqual(output['quotes'][0]['total']['amount'],2990)

    def test_provider_times_are_preserved_instead_of_reset_to_capture(self):
        changed=deepcopy(self.capture)
        changed['result']['structuredContent'].update(issued='2026-10-14T02:50:00Z',expires='2026-10-14T02:55:00Z')
        mapping=deepcopy(self.map)
        mapping.update(quoted_at_pointer='/issued',expires_at_pointer='/expires')
        quote=normalize_capture(changed,self.args,mapping)['quotes'][0]
        self.assertEqual(quote['quoted_at'],'2026-10-14T02:50:00Z')
        self.assertEqual(quote['expires_at'],'2026-10-14T02:55:00Z')

    def test_declared_provider_expiry_must_exist_and_have_timezone(self):
        mapping=deepcopy(self.map);mapping['expires_at_pointer']='/expires'
        with self.assertRaises(KeyError): normalize_capture(self.capture,self.args,mapping)
        for value in (None,123,'2026-10-14T03:00:00','not-a-date'):
            with self.subTest(value=value):
                changed=deepcopy(self.capture);changed['result']['structuredContent']['expires']=value
                with self.assertRaises(ValueError): normalize_capture(changed,self.args,mapping)


if __name__ == '__main__': unittest.main()
