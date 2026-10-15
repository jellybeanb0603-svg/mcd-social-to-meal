#!/usr/bin/env python3
"""Compare normalized recommendations with an explicit store catalog and quotes.

This module never extracts natural language, guesses a product, calculates an
official price, or calls an account service. The host supplies normalized notes,
an observed catalog, separately verified conditions, and provider quotes.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import json
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


MODES = {"demo", "live"}
CONDITION_STATUSES = {"verified", "contradicted", "unknown"}
QUOTE_REVIEW_WINDOW_SECONDS = 300
FUTURE_CLOCK_SKEW_SECONDS = 30


def _aware_timestamp(value: Any) -> datetime:
    """Parse an explicit timezone-aware ISO8601 timestamp as UTC."""
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str) and value.strip():
        try:
            parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("Timestamp must use ISO8601") from exc
    else:
        raise ValueError("Timestamp must be an ISO8601 string or aware datetime")
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("Timestamp must explicitly declare a timezone")
    return parsed.astimezone(timezone.utc)


def _quote_freshness(quote: dict[str, Any], now: datetime) -> tuple[str, float | None, list[str]]:
    """Apply a local review window, never a guarantee of an official price."""
    if quote.get("quoted_at") is None:
        return "missing", None, ["真实报价缺少带时区的 quoted_at，需要重新核价。"]
    try:
        quoted_at = _aware_timestamp(quote["quoted_at"])
        expires_at = _aware_timestamp(quote["expires_at"]) if quote.get("expires_at") is not None else None
    except ValueError:
        return "invalid", None, ["报价时间无效或没有明确时区，需要重新核价。"]
    age = (now - quoted_at).total_seconds()
    if age < -FUTURE_CLOCK_SKEW_SECONDS:
        return "future", age, ["报价时间超过允许的时钟偏差（未来 30 秒），需要重新核价。"]
    if expires_at is not None and expires_at <= now:
        return "expired", age, ["报价已超过提供方声明的 expires_at，需要重新核价。"]
    if age > QUOTE_REVIEW_WINDOW_SECONDS:
        return "stale", age, ["报价超过本地 300 秒审核窗口，需要重新核价；此窗口不代表官方价格保证。"]
    return "fresh", age, []


def public_source(source: Any) -> dict[str, Any]:
    """Publish only attribution fields and sanitize authentication-bearing URLs."""
    if not isinstance(source, dict):
        return {}
    public_fields = ("platform", "url", "title", "published_at", "retrieved_at", "city")
    cleaned = {key: deepcopy(source[key]) for key in public_fields if key in source}
    url = source.get("url")
    if not isinstance(url, str):
        cleaned["url"] = None
        return cleaned
    try:
        parts = urlsplit(url)
        if parts.scheme not in {"http", "https"} or not parts.hostname:
            cleaned["url"] = None
            return cleaned
        query = [
            (key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True)
            if not any(fragment in key.casefold() for fragment in ("token", "auth", "session", "cookie", "signature", "credential", "password", "secret", "api_key"))
        ]
        # Userinfo and URL fragments are not needed to identify a public note.
        host = parts.hostname
        if ":" in host:
            host = f"[{host}]"
        netloc = f"{host}:{parts.port}" if parts.port is not None else host
        cleaned["url"] = urlunsplit((parts.scheme, netloc, parts.path, urlencode(query), ""))
    except ValueError:
        cleaned["url"] = None
    return cleaned


def _label(value: Any) -> str:
    return value.strip().casefold() if isinstance(value, str) else ""


def _positive_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _names(record: dict[str, Any]) -> set[str]:
    aliases = record.get("aliases", [])
    if not isinstance(aliases, list) or any(not isinstance(a, str) for a in aliases):
        raise ValueError("Catalog aliases must be an explicit list of strings")
    return {_label(record.get("name")), *(_label(a) for a in aliases)} - {""}


def money_to_cents(money: dict[str, Any]) -> int:
    """Convert an explicitly denominated CNY amount, rejecting fractional cents."""
    if not isinstance(money, dict) or money.get("currency") != "CNY":
        raise ValueError("Money must explicitly declare currency CNY")
    if money.get("unit") not in {"yuan", "cent"}:
        raise ValueError("Money must explicitly declare unit yuan or cent")
    amount = money.get("amount")
    if isinstance(amount, bool) or not isinstance(amount, (str, int, float, Decimal)):
        raise ValueError("Money amount must be a numeric string or number")
    try:
        parsed = Decimal(str(amount))
    except InvalidOperation as exc:
        raise ValueError("Invalid money amount") from exc
    if not parsed.is_finite() or parsed < 0:
        raise ValueError("Money must be finite and nonnegative")
    cents = parsed * (100 if money["unit"] == "yuan" else 1)
    if cents != cents.to_integral_value():
        raise ValueError("Money contains a fractional cent")
    return int(cents)


def canonical_basket(basket: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Canonical identifiers and quantities; labels cannot change the quote key."""
    merged: dict[str, dict[str, Any]] = {}
    for item in basket:
        options = sorted(
            [
                {
                    "group_id": option["group_id"],
                    "option_id": option["option_id"],
                    "quantity": option["quantity"],
                }
                for option in item.get("options", [])
            ],
            key=lambda option: (option["group_id"], option["option_id"]),
        )
        key = json.dumps({"sku_id": item["sku_id"], "options": options}, sort_keys=True)
        if key not in merged:
            merged[key] = {"sku_id": item["sku_id"], "quantity": 0, "options": options}
        merged[key]["quantity"] += item["quantity"]
    return sorted(merged.values(), key=lambda item: json.dumps(item, sort_keys=True))


def basket_fingerprint(store_id: str, context: dict[str, Any], basket: list[dict[str, Any]]) -> str:
    """Bind a basket to its exact store and provider context with SHA-256."""
    payload = {"store_id": store_id, "context": context, "basket": canonical_basket(basket)}
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _validate_catalog(catalog: dict[str, Any]) -> None:
    if catalog.get("mode") not in MODES:
        raise ValueError("Catalog mode must be demo or live")
    if not isinstance(catalog.get("store_id"), str) or not catalog["store_id"].strip():
        raise ValueError("Catalog must declare store_id")
    if not isinstance(catalog.get("context"), dict) or not catalog["context"].get("channel"):
        raise ValueError("Catalog context must include a channel")
    if not isinstance(catalog.get("items"), list):
        raise ValueError("Catalog items must be a list")
    sku_ids: set[str] = set()
    for item in catalog["items"]:
        if not isinstance(item, dict) or not item.get("sku_id") or not _label(item.get("name")):
            raise ValueError("Every catalog item needs sku_id and name")
        if item["sku_id"] in sku_ids:
            raise ValueError("Duplicate catalog sku_id")
        sku_ids.add(item["sku_id"])
        _names(item)
        groups = item.get("option_groups")
        if not isinstance(groups, list):
            raise ValueError("Catalog option_groups must be a list")
        group_ids: set[str] = set()
        for group in groups:
            if not isinstance(group, dict) or not group.get("group_id") or not _label(group.get("name")):
                raise ValueError("Every option group needs group_id and name")
            if group["group_id"] in group_ids:
                raise ValueError("Duplicate option group_id")
            group_ids.add(group["group_id"])
            _names(group)
            for bound in ("min", "max"):
                value = group.get(bound)
                if value is not None and (isinstance(value, bool) or not isinstance(value, int) or value < 0):
                    raise ValueError("Option group bounds must be nonnegative integers")
            minimum = group.get("min", 1 if group.get("required", False) else 0)
            maximum = group.get("max")
            if maximum is not None and maximum < minimum:
                raise ValueError("Option group max cannot be below min")
            options = group.get("options")
            if not isinstance(options, list):
                raise ValueError("Catalog option group needs options")
            option_ids: set[str] = set()
            for option in options:
                if not isinstance(option, dict) or not option.get("option_id") or not _label(option.get("name")):
                    raise ValueError("Every option needs option_id and name")
                if option["option_id"] in option_ids:
                    raise ValueError("Duplicate option_id within group")
                option_ids.add(option["option_id"])
                _names(option)


def _match_options(request: dict[str, Any], product: dict[str, Any]) -> tuple[list[dict[str, Any]], list[str], bool]:
    selections = request.get("options", [])
    if not isinstance(selections, list):
        return [], ["餐品选项格式不完整。"], False
    if "components" in request:
        return [], ["套餐子项需要明确转换为 options 后再核对，不能忽略 components。"], False
    groups = product.get("option_groups", [])
    matched: dict[tuple[str, str], dict[str, Any]] = {}
    reasons: list[str] = []
    ambiguous = False
    for selection in selections:
        if not isinstance(selection, dict) or not _label(selection.get("group")) or not _label(selection.get("name")):
            reasons.append("每个选项都需要明确的选项组和名称。")
            continue
        quantity = selection.get("quantity", 1)
        if not _positive_int(quantity):
            reasons.append("选项数量必须是正整数。")
            continue
        candidates = [group for group in groups if _label(selection["group"]) in _names(group)]
        if selection.get("group_id") is not None:
            candidates = [group for group in candidates if group["group_id"] == selection["group_id"]]
        if len(candidates) != 1:
            ambiguous |= len(candidates) > 1
            reasons.append(f"选项组“{selection['group']}”{'存在多个匹配' if candidates else '未能匹配'}。")
            continue
        group = candidates[0]
        choices = [option for option in group["options"] if _label(selection["name"]) in _names(option)]
        if selection.get("option_id") is not None:
            choices = [option for option in choices if option["option_id"] == selection["option_id"]]
        if len(choices) != 1:
            ambiguous |= len(choices) > 1
            reasons.append(f"选项“{selection['name']}”{'存在多个匹配' if choices else '未能匹配'}。")
            continue
        choice = choices[0]
        if choice.get("available") is not True:
            reasons.append(f"选项“{choice['name']}”未确认在售。")
            continue
        key = (group["group_id"], choice["option_id"])
        if key not in matched:
            matched[key] = {
                "group_id": group["group_id"],
                "option_id": choice["option_id"],
                "name": choice["name"],
                "quantity": 0,
            }
        matched[key]["quantity"] += quantity
    for group in groups:
        count = sum(option["quantity"] for option in matched.values() if option["group_id"] == group["group_id"])
        minimum = group.get("min", 1 if group.get("required", False) else 0)
        maximum = group.get("max")
        if count < minimum:
            reasons.append(f"“{product['name']}”需要明确选择“{group['name']}”（至少 {minimum} 项）。")
        if maximum is not None and count > maximum:
            reasons.append(f"“{group['name']}”最多允许 {maximum} 项。")
    return sorted(matched.values(), key=lambda option: (option["group_id"], option["option_id"])), reasons, ambiguous


def _map_items(note: dict[str, Any], catalog: dict[str, Any]) -> tuple[list[dict[str, Any]], str, list[str]]:
    requests = note.get("items")
    if not isinstance(requests, list) or not requests:
        return [], "incomplete", ["笔记没有可核对的完整餐品清单。"]
    basket: list[dict[str, Any]] = []
    reasons: list[str] = []
    states: set[str] = set()
    for request in requests:
        if not isinstance(request, dict) or not _label(request.get("name")) or not _positive_int(request.get("quantity")):
            states.add("invalid")
            reasons.append("餐品名称不能为空，数量必须是正整数。")
            continue
        candidates = [product for product in catalog["items"] if _label(request["name"]) in _names(product)]
        if request.get("sku_id") is not None:
            candidates = [product for product in candidates if product["sku_id"] == request["sku_id"]]
        if len(candidates) != 1:
            states.add("ambiguous" if len(candidates) > 1 else "unavailable")
            reasons.append(f"餐品“{request['name']}”{'存在多个同名商品，请选择具体规格' if candidates else '没有精确匹配的当前商品'}。")
            continue
        product = candidates[0]
        if product.get("available") is not True:
            states.add("unavailable")
            reasons.append(f"餐品“{product['name']}”未确认在当前门店在售。")
            continue
        options, option_reasons, ambiguous = _match_options(request, product)
        if option_reasons:
            states.add("ambiguous" if ambiguous else "incomplete")
            reasons.extend(option_reasons)
            continue
        basket.append({"sku_id": product["sku_id"], "name": product["name"], "quantity": request["quantity"], "options": options})
    status = next((state for state in ("invalid", "ambiguous", "unavailable", "incomplete") if state in states), "matched")
    return basket, status, reasons


def _condition_checks(note: dict[str, Any], catalog: dict[str, Any]) -> tuple[list[dict[str, Any]], list[str]]:
    conditions = note.get("conditions")
    checks: list[dict[str, Any]] = []
    reasons: list[str] = []
    if not isinstance(conditions, list):
        return [], ["推荐条件格式不完整。"]
    seen: set[str] = set()
    for condition in conditions:
        if not isinstance(condition, dict) or not isinstance(condition.get("condition_id"), str) or not condition["condition_id"] or condition["condition_id"] in seen:
            reasons.append("推荐条件需要独立且不重复的 condition_id。")
            continue
        seen.add(condition["condition_id"])
        candidates = [check for check in catalog.get("condition_checks", []) if check.get("note_id") == note["note_id"] and check.get("condition_id") == condition["condition_id"]]
        status, evidence = "unknown", None
        if len(candidates) == 1:
            check = candidates[0]
            if check.get("status") in CONDITION_STATUSES:
                evidence = check.get("evidence")
                if isinstance(evidence, str) and evidence.strip():
                    status = check["status"]
        checks.append({**deepcopy(condition), "status": status, "evidence": evidence})
        if status != "verified":
            reasons.append(f"条件“{condition.get('description', condition['condition_id'])}”{'与当前情况不符' if status == 'contradicted' else '尚未核实'}。")
    return checks, reasons


def _quote_for(note_id: str, fingerprint: str | None, catalog: dict[str, Any], quotes: dict[str, Any], now: datetime) -> tuple[dict[str, Any], list[str]]:
    quote_result: dict[str, Any] = {"status": "missing", "total_cents": None, "currency": "CNY", "mode": quotes.get("mode"), "freshness_status": "not_checked", "review_window_seconds": QUOTE_REVIEW_WINDOW_SECONDS, "age_seconds": None}
    if fingerprint is None:
        quote_result["status"] = "not_requested"
        return quote_result, []
    candidates = [quote for quote in quotes.get("quotes", []) if quote.get("note_id") == note_id]
    if not candidates:
        return quote_result, ["缺少对应餐篮的官方报价，金额未知。"]
    if len(candidates) != 1:
        quote_result["status"] = "invalid"
        return quote_result, ["同一推荐存在多份报价，请提供已选定的一份。"]
    quote = candidates[0]
    mode = quote.get("mode", quotes.get("mode"))
    quote_result["mode"] = mode
    quote_result["quoted_at"] = quote.get("quoted_at")
    quote_result["expires_at"] = quote.get("expires_at")
    if quote.get("status") != "success":
        quote_result["status"] = "failed"
        return quote_result, ["报价调用未成功，金额未知。"]
    store_id = quote.get("store_id", quotes.get("store_id"))
    context = quote.get("context", quotes.get("context"))
    if store_id != catalog["store_id"] or context != catalog["context"] or quote.get("basket_fingerprint") != fingerprint:
        quote_result["status"] = "mismatch"
        return quote_result, ["报价的门店、点餐条件或餐篮不一致，需要重新核价。"]
    if mode not in MODES:
        quote_result["status"] = "invalid"
        return quote_result, ["报价没有声明 live 或 demo 模式。"]
    try:
        cents = money_to_cents(quote.get("total"))
    except ValueError as exc:
        quote_result["status"] = "invalid"
        return quote_result, [f"报价金额无法核验：{exc}。"]
    quote_result["total_cents"] = cents
    if mode == "live" and catalog["mode"] == "live":
        freshness_status, age, freshness_reasons = _quote_freshness(quote, now)
        quote_result["freshness_status"] = freshness_status
        quote_result["age_seconds"] = age
        quote_result["status"] = "verified" if freshness_status == "fresh" else "stale"
        return quote_result, freshness_reasons
    quote_result["status"] = "demo"
    quote_result["freshness_status"] = "demo"
    return quote_result, []


def compare_records(notes: dict[str, Any], catalog: dict[str, Any], quotes: dict[str, Any] | None = None, budget_yuan: Any = None, *, now: datetime | str | None = None) -> dict[str, Any]:
    """Return a source-preserving comparison without altering the supplied inputs.

    ``ready_to_order`` means the inputs pass this comparison. It never authorizes
    ordering: the Skill must obtain user confirmation and obtain a fresh quote.
    Live quote timestamps must fall inside a local 300-second review window;
    this window is not an official price guarantee. ``now`` supports deterministic
    testing with an aware datetime or ISO8601 string; omitted means UTC now.
    """
    comparison_time = _aware_timestamp(now) if now is not None else datetime.now(timezone.utc)
    if not isinstance(notes, dict) or notes.get("mode") not in MODES or not isinstance(notes.get("notes"), list):
        raise ValueError("Notes must declare mode and a notes list")
    if not isinstance(catalog, dict):
        raise ValueError("Catalog must be an object")
    _validate_catalog(catalog)
    quotes = quotes if quotes is not None else {"mode": catalog["mode"], "quotes": []}
    if not isinstance(quotes, dict) or not isinstance(quotes.get("quotes", []), list):
        raise ValueError("Quotes must be an object with a quotes list")
    for quote in quotes.get("quotes", []):
        if not isinstance(quote, dict):
            raise ValueError("Every quote must be an object")
    condition_checks = catalog.get("condition_checks", [])
    if not isinstance(condition_checks, list) or any(not isinstance(check, dict) for check in condition_checks):
        raise ValueError("Catalog condition_checks must be a list of objects")
    budget_cents = money_to_cents({"amount": budget_yuan, "unit": "yuan", "currency": "CNY"}) if budget_yuan is not None else None
    input_modes = {notes["mode"], catalog["mode"], quotes.get("mode"), *(quote.get("mode", quotes.get("mode")) for quote in quotes.get("quotes", []))}
    mode = next(iter(input_modes)) if len(input_modes) == 1 else "mixed"
    report: dict[str, Any] = {
        "schema_version": "1.0",
        "generated_at": comparison_time.isoformat(),
        "mode": mode,
        "demo": "demo" in input_modes,
        "context": {"store_id": catalog["store_id"], **deepcopy(catalog["context"]), "budget_cents": budget_cents},
        "recommendations": [],
    }
    ids: set[str] = set()
    for note in notes["notes"]:
        if not isinstance(note, dict) or not isinstance(note.get("note_id"), str) or not note["note_id"]:
            raise ValueError("Every note must have a nonempty string note_id")
        if note["note_id"] in ids:
            raise ValueError("Duplicate note_id: sources cannot be merged implicitly")
        ids.add(note["note_id"])
        basket, mapping_status, mapping_reasons = _map_items(note, catalog)
        fingerprint = basket_fingerprint(catalog["store_id"], catalog["context"], basket) if mapping_status == "matched" else None
        checks, condition_reasons = _condition_checks(note, catalog)
        quote, quote_reasons = _quote_for(note["note_id"], fingerprint, catalog, quotes, comparison_time)
        within_budget = quote["total_cents"] <= budget_cents if quote["total_cents"] is not None and budget_cents is not None else None
        reasons = mapping_reasons + condition_reasons + quote_reasons
        if within_budget is False:
            reasons.append("当前应付金额超过预算。")
        if quote["status"] == "demo" or notes["mode"] == "demo":
            reasons.append("演示数据仅用于验证流程，不能作为真实在售信息、报价或下单依据。")
        ready = mapping_status == "matched" and not condition_reasons and quote["status"] == "verified" and mode == "live" and within_budget is not False
        report["recommendations"].append({
            "note_id": note["note_id"],
            "recommendation_id": note["note_id"],
            "title": public_source(note.get("source")).get("title", note["note_id"]),
            "source": public_source(note.get("source")),
            "claims": deepcopy(note.get("claims", {})),
            "items": deepcopy(note.get("items", [])),
            "basket": basket,
            "basket_fingerprint": fingerprint,
            "mapping_status": mapping_status,
            "condition_checks": checks,
            "quote": quote,
            "within_budget": within_budget,
            "ready_to_order": ready,
            "reasons": reasons,
        })
    return report


def _read_json(path: str) -> dict[str, Any]:
    with Path(path).open(encoding="utf-8-sig") as handle:
        return json.load(handle)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--notes", required=True, help="Normalized note JSON")
    parser.add_argument("--catalog", required=True, help="Current store catalog JSON")
    parser.add_argument("--quotes", help="Provider quote JSON; omitted means price unknown")
    parser.add_argument("--budget-yuan", help="Optional maximum CNY amount in yuan")
    parser.add_argument("--output", help="Output report JSON, otherwise stdout")
    args = parser.parse_args(argv)
    try:
        report = compare_records(_read_json(args.notes), _read_json(args.catalog), _read_json(args.quotes) if args.quotes else None, args.budget_yuan)
    except (ValueError, OSError, TypeError, KeyError) as exc:
        parser.exit(2, f"Comparison failed: {exc}\n")
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
