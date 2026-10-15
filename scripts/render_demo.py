"""Render a comparison report as a self-contained consumer preview.

The output is a shopping-list preview. It never submits an order or fetches
external resources. All report text is placed in the DOM with textContent.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


DEFAULT_TEMPLATE = Path(__file__).resolve().parents[1] / "assets" / "demo-template.html"
PLACEHOLDER = "__REPORT_JSON__"


def script_safe_json(report: dict[str, Any]) -> str:
    """Prevent user-supplied text from closing the application/json script."""
    serialized = json.dumps(report, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    return (serialized.replace("&", "\\u0026").replace("<", "\\u003c")
            .replace(">", "\\u003e").replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029"))


def render_report(report: dict[str, Any], template: str | None = None) -> str:
    if not isinstance(report, dict):
        raise ValueError("report must be a JSON object")
    recommendations = report.get("recommendations")
    if not isinstance(recommendations, list):
        raise ValueError("report.recommendations must be a list")
    if any(not isinstance(candidate, dict) for candidate in recommendations):
        raise ValueError("each recommendation must be an object")
    if report.get("context") is not None and not isinstance(report["context"], dict):
        raise ValueError("report.context must be an object")
    for candidate in recommendations:
        for field in ("source", "claims", "quote"):
            if candidate.get(field) is not None and not isinstance(candidate[field], dict):
                raise ValueError(f"recommendation.{field} must be an object")
        for field in ("items", "basket", "condition_checks"):
            if candidate.get(field) is not None:
                values = candidate[field]
                if not isinstance(values, list) or any(not isinstance(value, dict) for value in values):
                    raise ValueError(f"recommendation.{field} must be a list of objects")
        for item in (candidate.get("items") or []) + (candidate.get("basket") or []):
            options = item.get("options")
            if options is not None and (not isinstance(options, list) or any(not isinstance(option, dict) for option in options)):
                raise ValueError("item.options must be a list of objects")
    if template is None:
        template = DEFAULT_TEMPLATE.read_text(encoding="utf-8")
    if template.count(PLACEHOLDER) != 1:
        raise ValueError("template must contain one report placeholder")
    return template.replace(PLACEHOLDER, script_safe_json(report))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", required=True, type=Path, help="comparison report JSON")
    parser.add_argument("--output", required=True, type=Path, help="standalone HTML output")
    args = parser.parse_args(argv)
    try:
        report = json.loads(args.report.read_text(encoding="utf-8-sig"))
        html = render_report(report)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(html, encoding="utf-8")
    except (OSError, ValueError, TypeError) as error:
        parser.exit(2, f"Unable to render comparison report: {error}\n")
    print(f"Rendered consumer preview: {args.output.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
