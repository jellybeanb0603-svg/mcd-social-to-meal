"""Build the entire synthetic consumer demo without any account or network."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from compare_engine import compare_records
from render_demo import render_report


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser=argparse.ArgumentParser(description="生成有明显模拟标记的种草对照演示，不请求任何账户接口。")
    parser.add_argument("--budget-yuan", default="35")
    parser.add_argument("--output-dir", default=str(Path(__file__).resolve().parents[1]/"demo"))
    args=parser.parse_args()
    root=Path(__file__).resolve().parents[1]
    try:
        inputs=[json.loads((root/"fixtures"/name).read_text(encoding="utf-8-sig")) for name in ("demo-input.json","demo-catalog.json","demo-quotes.json")]
        if any(item.get("mode")!="demo" for item in inputs):
            raise ValueError("Demo fixtures must explicitly declare mode=demo")
        report=compare_records(*inputs,budget_yuan=args.budget_yuan)
        if any(item["ready_to_order"] for item in report["recommendations"]):
            raise ValueError("Synthetic data unexpectedly became order eligible")
        destination=Path(args.output_dir)
        destination.mkdir(parents=True,exist_ok=True)
        report_path=destination/"report.json"
        report_path.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
        html_path=destination/"index.html"
        html_path.write_text(render_report(report),encoding="utf-8")
        print(json.dumps({"status":"demo_built","mode":"demo","report":str(report_path),"preview":str(html_path),"recommendations":len(report['recommendations'])},ensure_ascii=False))
        return 0
    except (ValueError,OSError,TypeError,KeyError) as error:
        print(json.dumps({"status":"error","message":str(error)},ensure_ascii=False))
        return 2


if __name__=="__main__":
    raise SystemExit(main())
