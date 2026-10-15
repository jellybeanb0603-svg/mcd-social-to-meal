"""Behavioral checks for data boundaries, SKU matching and quote eligibility."""

from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from compare_engine import basket_fingerprint, compare_records, money_to_cents

FIXED_NOW = datetime(2026, 10, 14, 4, 0, tzinfo=timezone.utc)


def live_inputs():
    notes = {
        "mode": "live",
        "notes": [{
            "note_id": "one",
            "source": {"platform": "test", "title": "Original claim", "url": "https://example.invalid/one", "retrieved_at": "2026-10-14T12:00:00+08:00"},
            "claims": {"summary": "Author thinks this tastes good", "advertised_price": {"amount": "19.90", "unit": "yuan", "currency": "CNY"}},
            "items": [{"name": "Test burger", "quantity": 1}],
            "conditions": [],
        }],
    }
    catalog = {
        "mode": "live", "store_id": "TEST-STORE",
        "context": {"channel": "pickup", "service_date": "2026-10-14"},
        "items": [{"sku_id": "BURGER-1", "name": "Test burger", "aliases": ["Explicit alias"], "available": True, "option_groups": []}],
        "condition_checks": [],
    }
    quotes = {"mode": "live", "store_id": catalog["store_id"], "context": deepcopy(catalog["context"]), "quotes": []}
    return notes, catalog, quotes


def add_quote(notes, catalog, quotes, note_id="one", amount="29.90", unit="yuan"):
    pending = compare_records(notes, catalog, quotes)
    rec = next(item for item in pending["recommendations"] if item["note_id"] == note_id)
    quotes["quotes"].append({
        "note_id": note_id, "status": "success", "basket_fingerprint": rec["basket_fingerprint"],
        "total": {"amount": amount, "unit": unit, "currency": "CNY"},
        "quoted_at": FIXED_NOW.isoformat(),
    })


class ComparisonTests(unittest.TestCase):
    def setUp(self):
        self.notes, self.catalog, self.quotes = live_inputs()

    def recommendation(self, budget=None):
        return compare_records(self.notes, self.catalog, self.quotes, budget, now=FIXED_NOW)["recommendations"][0]

    def test_authoritative_quote_does_not_replace_original_claim(self):
        add_quote(self.notes, self.catalog, self.quotes)
        rec = self.recommendation("35")
        self.assertEqual(rec["claims"]["advertised_price"]["amount"], "19.90")
        self.assertEqual(rec["quote"]["total_cents"], 2990)
        self.assertEqual(rec["quote"]["status"], "verified")
        self.assertTrue(rec["ready_to_order"])

    def test_notes_and_sources_remain_separate_for_same_basket(self):
        second = deepcopy(self.notes["notes"][0])
        second["note_id"] = "two"
        second["source"]["url"] = "https://example.invalid/two"
        second["claims"]["advertised_price"]["amount"] = "9.90"
        self.notes["notes"].append(second)
        add_quote(self.notes, self.catalog, self.quotes)
        add_quote(self.notes, self.catalog, self.quotes, "two")
        recs = compare_records(self.notes, self.catalog, self.quotes)["recommendations"]
        self.assertEqual(len(recs), 2)
        self.assertEqual(recs[0]["basket_fingerprint"], recs[1]["basket_fingerprint"])
        self.assertNotEqual(recs[0]["source"]["url"], recs[1]["source"]["url"])
        self.assertNotEqual(recs[0]["claims"], recs[1]["claims"])

    def test_exact_explicit_alias_can_match(self):
        self.notes["notes"][0]["items"][0]["name"] = "Explicit alias"
        self.assertEqual(self.recommendation()["mapping_status"], "matched")

    def test_fuzzy_near_name_cannot_match(self):
        self.notes["notes"][0]["items"][0]["name"] = "Test burger large"
        rec = self.recommendation()
        self.assertEqual(rec["mapping_status"], "unavailable")
        self.assertIsNone(rec["basket_fingerprint"])
        self.assertIsNone(rec["quote"]["total_cents"])

    def test_same_name_products_are_ambiguous_even_if_one_unavailable(self):
        duplicate = deepcopy(self.catalog["items"][0])
        duplicate.update(sku_id="BURGER-2", available=False)
        self.catalog["items"].append(duplicate)
        rec = self.recommendation()
        self.assertEqual(rec["mapping_status"], "ambiguous")
        self.assertFalse(rec["ready_to_order"])

    def test_explicit_sku_id_disambiguates_matching_name(self):
        duplicate = deepcopy(self.catalog["items"][0])
        duplicate["sku_id"] = "BURGER-2"
        self.catalog["items"].append(duplicate)
        self.notes["notes"][0]["items"][0]["sku_id"] = "BURGER-1"
        self.assertEqual(self.recommendation()["mapping_status"], "matched")

    def test_unknown_availability_is_not_available(self):
        del self.catalog["items"][0]["available"]
        self.assertEqual(self.recommendation()["mapping_status"], "unavailable")

    def _combo(self):
        self.catalog["items"][0]["option_groups"] = [{
            "group_id": "DRINK", "name": "Drink", "required": True, "min": 1, "max": 1,
            "options": [{"option_id": "ZERO-M", "name": "Zero medium", "available": True}, {"option_id": "REG-M", "name": "Regular medium", "available": True}],
        }]

    def test_required_option_never_defaults(self):
        self._combo()
        rec = self.recommendation()
        self.assertEqual(rec["mapping_status"], "incomplete")
        self.assertEqual(rec["basket"], [])
        self.assertIsNone(rec["basket_fingerprint"])

    def test_option_changes_invalidate_previous_quote(self):
        self._combo()
        request = self.notes["notes"][0]["items"][0]
        request["options"] = [{"group": "Drink", "name": "Zero medium"}]
        add_quote(self.notes, self.catalog, self.quotes)
        request["options"][0]["name"] = "Regular medium"
        rec = self.recommendation()
        self.assertEqual(rec["quote"]["status"], "mismatch")
        self.assertIsNone(rec["quote"]["total_cents"])
        self.assertFalse(rec["ready_to_order"])

    def test_duplicate_same_name_options_are_ambiguous(self):
        self._combo()
        options = self.catalog["items"][0]["option_groups"][0]["options"]
        duplicate = deepcopy(options[0])
        duplicate["option_id"] = "ZERO-L"
        options.append(duplicate)
        self.notes["notes"][0]["items"][0]["options"] = [{"group": "Drink", "name": "Zero medium"}]
        self.assertEqual(self.recommendation()["mapping_status"], "ambiguous")

    def test_option_group_max_and_unknown_availability_block(self):
        self._combo()
        request = self.notes["notes"][0]["items"][0]
        request["options"] = [{"group": "Drink", "name": "Zero medium", "quantity": 2}]
        self.assertEqual(self.recommendation()["mapping_status"], "incomplete")
        request["options"][0]["quantity"] = 1
        del self.catalog["items"][0]["option_groups"][0]["options"][0]["available"]
        self.assertEqual(self.recommendation()["mapping_status"], "incomplete")

    def test_raw_components_cannot_be_silently_ignored(self):
        self.notes["notes"][0]["items"][0]["components"] = [{"name": "Something unknown"}]
        self.assertEqual(self.recommendation()["mapping_status"], "incomplete")

    def test_missing_quote_is_unknown_not_free(self):
        rec = self.recommendation("35")
        self.assertEqual(rec["quote"]["status"], "missing")
        self.assertIsNone(rec["quote"]["total_cents"])
        self.assertIsNone(rec["within_budget"])
        self.assertFalse(rec["ready_to_order"])

    def test_store_context_and_basket_mismatch_are_rejected(self):
        for field, value in (("store_id", "OTHER"), ("context", {"channel": "delivery"}), ("basket_fingerprint", "wrong")):
            with self.subTest(field=field):
                self.notes, self.catalog, self.quotes = live_inputs()
                add_quote(self.notes, self.catalog, self.quotes)
                self.quotes["quotes"][0][field] = value
                rec = self.recommendation()
                self.assertEqual(rec["quote"]["status"], "mismatch")
                self.assertIsNone(rec["quote"]["total_cents"])

    def test_failed_quote_and_duplicate_quote_are_not_success(self):
        add_quote(self.notes, self.catalog, self.quotes)
        self.quotes["quotes"][0]["status"] = "error"
        self.assertEqual(self.recommendation()["quote"]["status"], "failed")
        self.quotes["quotes"].append(deepcopy(self.quotes["quotes"][0]))
        self.assertEqual(self.recommendation()["quote"]["status"], "invalid")

    def test_currency_and_units_are_mandatory(self):
        add_quote(self.notes, self.catalog, self.quotes)
        money = self.quotes["quotes"][0]["total"]
        for bad in ({"amount": 2990, "currency": "CNY"}, {"amount": 2990, "unit": "cent"}, {"amount": "29.901", "unit": "yuan", "currency": "CNY"}):
            with self.subTest(bad=bad):
                self.quotes["quotes"][0]["total"] = bad
                self.assertEqual(self.recommendation()["quote"]["status"], "invalid")
        self.quotes["quotes"][0]["total"] = money

    def test_yuan_and_cent_quotes_agree_and_budget_uses_cents(self):
        add_quote(self.notes, self.catalog, self.quotes, amount=2990, unit="cent")
        rec = self.recommendation("29.90")
        self.assertEqual(rec["quote"]["total_cents"], 2990)
        self.assertTrue(rec["within_budget"])
        rec = self.recommendation("29.89")
        self.assertFalse(rec["within_budget"])
        self.assertFalse(rec["ready_to_order"])

    def test_unknown_condition_blocks_even_with_real_price(self):
        self.notes["notes"][0]["conditions"] = [{"condition_id": "coupon", "kind": "coupon", "description": "Author-only coupon"}]
        # A claim carrying a verification status is not verifier evidence.
        self.notes["notes"][0]["conditions"][0]["status"] = "verified"
        add_quote(self.notes, self.catalog, self.quotes)
        rec = self.recommendation()
        self.assertEqual(rec["condition_checks"][0]["status"], "unknown")
        self.assertEqual(rec["quote"]["status"], "verified")
        self.assertFalse(rec["ready_to_order"])

    def test_absent_condition_extraction_is_unknown_not_no_conditions(self):
        del self.notes["notes"][0]["conditions"]
        add_quote(self.notes, self.catalog, self.quotes)
        rec = self.recommendation()
        self.assertEqual(rec["quote"]["status"], "verified")
        self.assertFalse(rec["ready_to_order"])
        self.assertTrue(rec["reasons"])

    def test_condition_verification_requires_independent_nonempty_evidence(self):
        self.notes["notes"][0]["conditions"] = [{"condition_id": "coupon", "kind": "coupon", "description": "Specific coupon"}]
        self.catalog["condition_checks"] = [{"note_id": "one", "condition_id": "coupon", "status": "verified", "evidence": ""}]
        add_quote(self.notes, self.catalog, self.quotes)
        self.assertFalse(self.recommendation()["ready_to_order"])
        self.catalog["condition_checks"][0]["evidence"] = "Provider confirms this account's coupon applies"
        self.assertTrue(self.recommendation()["ready_to_order"])
        self.catalog["condition_checks"][0]["status"] = "contradicted"
        self.assertFalse(self.recommendation()["ready_to_order"])

    def test_demo_anywhere_prevents_live_readiness(self):
        for target in ("notes", "catalog", "quotes", "quote"):
            with self.subTest(target=target):
                self.notes, self.catalog, self.quotes = live_inputs()
                add_quote(self.notes, self.catalog, self.quotes)
                if target == "quote":
                    self.quotes["quotes"][0]["mode"] = "demo"
                else:
                    getattr(self, target)["mode"] = "demo"
                report = compare_records(self.notes, self.catalog, self.quotes)
                self.assertTrue(report["demo"])
                self.assertFalse(report["recommendations"][0]["ready_to_order"])

    def test_missing_quote_mode_cannot_be_verified(self):
        add_quote(self.notes, self.catalog, self.quotes)
        del self.quotes["mode"]
        rec = self.recommendation()
        self.assertEqual(rec["quote"]["status"], "invalid")
        self.assertFalse(rec["ready_to_order"])

    def test_live_quote_without_timestamp_is_not_ready(self):
        add_quote(self.notes, self.catalog, self.quotes)
        del self.quotes["quotes"][0]["quoted_at"]
        rec = self.recommendation()
        self.assertEqual(rec["quote"]["freshness_status"], "missing")
        self.assertEqual(rec["quote"]["status"], "stale")
        self.assertEqual(rec["quote"]["total_cents"], 2990)
        self.assertFalse(rec["ready_to_order"])

    def test_live_quote_unparseable_or_timezone_free_is_not_ready(self):
        add_quote(self.notes, self.catalog, self.quotes)
        for quoted_at in ("yesterday", "2026-10-14T04:00:00", "2026-10-14", "", 1780000000):
            with self.subTest(quoted_at=quoted_at):
                self.quotes["quotes"][0]["quoted_at"] = quoted_at
                rec = self.recommendation()
                self.assertEqual(rec["quote"]["freshness_status"], "invalid")
                self.assertFalse(rec["ready_to_order"])

    def test_live_quote_maximum_local_age_is_300_seconds(self):
        add_quote(self.notes, self.catalog, self.quotes)
        quote = self.quotes["quotes"][0]
        quote["quoted_at"] = (FIXED_NOW - timedelta(seconds=300)).isoformat()
        self.assertTrue(self.recommendation()["ready_to_order"])
        quote["quoted_at"] = (FIXED_NOW - timedelta(seconds=300, microseconds=1)).isoformat()
        rec = self.recommendation()
        self.assertEqual(rec["quote"]["freshness_status"], "stale")
        self.assertFalse(rec["ready_to_order"])

    def test_live_quote_future_clock_skew_is_bounded(self):
        add_quote(self.notes, self.catalog, self.quotes)
        quote = self.quotes["quotes"][0]
        quote["quoted_at"] = (FIXED_NOW + timedelta(seconds=30)).isoformat()
        self.assertTrue(self.recommendation()["ready_to_order"])
        quote["quoted_at"] = (FIXED_NOW + timedelta(seconds=30, microseconds=1)).isoformat()
        rec = self.recommendation()
        self.assertEqual(rec["quote"]["freshness_status"], "future")
        self.assertFalse(rec["ready_to_order"])

    def test_provider_expiry_overrides_local_review_window(self):
        add_quote(self.notes, self.catalog, self.quotes)
        quote = self.quotes["quotes"][0]
        quote["quoted_at"] = (FIXED_NOW - timedelta(seconds=20)).isoformat()
        quote["expires_at"] = (FIXED_NOW - timedelta(seconds=1)).isoformat()
        rec = self.recommendation()
        self.assertEqual(rec["quote"]["freshness_status"], "expired")
        self.assertFalse(rec["ready_to_order"])
        quote["expires_at"] = FIXED_NOW.isoformat()
        self.assertFalse(self.recommendation()["ready_to_order"])
        quote["expires_at"] = (FIXED_NOW + timedelta(seconds=1)).isoformat()
        self.assertTrue(self.recommendation()["ready_to_order"])

    def test_supplied_expiry_must_also_have_parseable_timezone(self):
        add_quote(self.notes, self.catalog, self.quotes)
        for expires_at in ("tomorrow", "2026-10-14T05:00:00", ""):
            with self.subTest(expires_at=expires_at):
                self.quotes["quotes"][0]["expires_at"] = expires_at
                rec = self.recommendation()
                self.assertEqual(rec["quote"]["freshness_status"], "invalid")
                self.assertFalse(rec["ready_to_order"])

    def test_fresh_aware_live_quote_accepts_equivalent_timezone_and_z(self):
        add_quote(self.notes, self.catalog, self.quotes)
        for quoted_at in ("2026-10-14T12:00:00+08:00", "2026-10-14T04:00:00Z"):
            with self.subTest(quoted_at=quoted_at):
                self.quotes["quotes"][0]["quoted_at"] = quoted_at
                rec = self.recommendation()
                self.assertEqual(rec["quote"]["freshness_status"], "fresh")
                self.assertEqual(rec["quote"]["age_seconds"], 0)
                self.assertTrue(rec["ready_to_order"])

    def test_deterministic_now_requires_timezone(self):
        with self.assertRaises(ValueError):
            compare_records(self.notes, self.catalog, self.quotes, now="2026-10-14T04:00:00")
        report = compare_records(self.notes, self.catalog, self.quotes, now=FIXED_NOW.isoformat())
        self.assertEqual(report["generated_at"], FIXED_NOW.isoformat())

    def test_quantity_change_invalidates_quote_and_boolean_is_not_quantity(self):
        add_quote(self.notes, self.catalog, self.quotes)
        self.notes["notes"][0]["items"][0]["quantity"] = 2
        self.assertEqual(self.recommendation()["quote"]["status"], "mismatch")
        self.notes["notes"][0]["items"][0]["quantity"] = True
        self.assertEqual(self.recommendation()["mapping_status"], "invalid")

    def test_duplicate_note_id_is_not_implicitly_merged(self):
        self.notes["notes"].append(deepcopy(self.notes["notes"][0]))
        with self.assertRaisesRegex(ValueError, "Duplicate note_id"):
            self.recommendation()

    def test_public_source_removes_tokens_and_userinfo_without_mutation(self):
        source = self.notes["notes"][0]["source"]
        source["url"] = "https://user:password@example.invalid/one?xsec_token=SECRET&auth=KEY&session_id=ID&topic=burger#secret"
        original = deepcopy(self.notes)
        rec = self.recommendation()
        self.assertEqual(rec["source"]["url"], "https://example.invalid/one?topic=burger")
        self.assertEqual(self.notes, original)
        self.assertNotIn("SECRET", json.dumps(rec))

    def test_public_source_drops_unknown_raw_metadata_and_preserves_attribution(self):
        source = self.notes["notes"][0]["source"]
        source.update({
            "published_at": "2026-10-13T12:00:00+08:00", "city": "Observed city",
            "token": "SECRET_TOKEN", "cookie": "SECRET_COOKIE",
            "raw_result": {"credentials": "SECRET_RAW"}, "unexpected_metadata": "PRIVATE",
        })
        original = deepcopy(source)
        rec = self.recommendation()
        expected = {key: source[key] for key in ("platform", "url", "title", "published_at", "retrieved_at", "city")}
        self.assertEqual(rec["source"], expected)
        self.assertEqual(source, original)
        self.assertNotIn("SECRET", json.dumps(rec))

    def test_inputs_are_not_mutated(self):
        add_quote(self.notes, self.catalog, self.quotes)
        before = deepcopy((self.notes, self.catalog, self.quotes))
        self.recommendation()
        self.assertEqual((self.notes, self.catalog, self.quotes), before)

    def test_fingerprint_is_order_independent_and_preserves_option_quantities(self):
        item = {"sku_id": "B", "quantity": 1, "options": [{"group_id": "G", "option_id": "X", "quantity": 1}]}
        other = {"sku_id": "A", "quantity": 1, "options": []}
        first = basket_fingerprint("STORE", {"channel": "pickup"}, [item, other])
        self.assertEqual(first, basket_fingerprint("STORE", {"channel": "pickup"}, [other, item]))
        item["options"][0]["quantity"] = 2
        self.assertNotEqual(first, basket_fingerprint("STORE", {"channel": "pickup"}, [item, other]))

    def test_repeated_identical_items_canonicalize_to_summed_quantity(self):
        item = {"sku_id": "B", "quantity": 1, "options": []}
        double = {"sku_id": "B", "quantity": 2, "options": []}
        self.assertEqual(basket_fingerprint("S", {}, [item, item]), basket_fingerprint("S", {}, [double]))

    def test_demo_fixtures_have_no_fake_live_data_or_price_for_incomplete_baskets(self):
        data = [json.loads((ROOT / "fixtures" / name).read_text(encoding="utf-8")) for name in ("demo-input.json", "demo-catalog.json", "demo-quotes.json")]
        report = compare_records(*data, budget_yuan="35")
        self.assertTrue(report["demo"])
        self.assertEqual([r["mapping_status"] for r in report["recommendations"]], ["matched", "matched", "unavailable", "incomplete"])
        self.assertEqual([r["quote"]["total_cents"] for r in report["recommendations"]], [2990, 3950, None, None])
        self.assertFalse(any(r["ready_to_order"] for r in report["recommendations"]))
        self.assertTrue(all("example.invalid" in r["source"]["url"] for r in report["recommendations"]))


class MoneyTests(unittest.TestCase):
    def test_reject_boolean_negative_nonfinite_unknown_unit_and_fractional_cent(self):
        for amount, unit in ((True, "cent"), (-1, "yuan"), ("NaN", "yuan"), ("Infinity", "cent"), (1, "unknown"), ("0.001", "yuan"), ("1.5", "cent")):
            with self.subTest(amount=amount, unit=unit), self.assertRaises(ValueError):
                money_to_cents({"amount": amount, "unit": unit, "currency": "CNY"})


if __name__ == "__main__":
    unittest.main()
