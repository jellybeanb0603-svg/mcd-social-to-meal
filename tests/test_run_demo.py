"""Exercise the documented first command through its real script entry point."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class DemoEntryPointTests(unittest.TestCase):
    def test_documented_command_produces_marked_interactive_demo(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(dir=root / "tests") as destination:
            result = subprocess.run(
                [sys.executable, str(root / "scripts" / "run_demo.py"),
                 "--budget-yuan", "35", "--output-dir", destination],
                cwd=root, capture_output=True, text=True, encoding="utf-8", timeout=20,
            )
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            output = Path(destination)
            report = json.loads((output / "report.json").read_text(encoding="utf-8"))
            self.assertEqual(report["mode"], "demo")
            self.assertEqual(report["context"]["budget_cents"], 3500)
            self.assertEqual(len(report["recommendations"]), 4)
            self.assertTrue(all(not item["ready_to_order"] for item in report["recommendations"]))
            html = (output / "index.html").read_text(encoding="utf-8")
            self.assertIn("模拟", html)
            self.assertNotIn("__REPORT_JSON__", html)
            self.assertIn('<script', html)


if __name__ == "__main__":
    unittest.main()
