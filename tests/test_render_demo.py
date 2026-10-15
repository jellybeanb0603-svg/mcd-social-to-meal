"""Security and offline checks for the standalone report renderer."""

import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "render_demo.py"
spec = importlib.util.spec_from_file_location("render_demo", MODULE_PATH)
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)


class RenderDemoTests(unittest.TestCase):
    def test_untrusted_text_cannot_break_out_of_embedded_json(self):
        report = {"demo": True, "recommendations": [{"title": '</script><script>alert("x")</script>&\u2028\u2029'}]}
        html = renderer.render_report(report)
        payload = re.search(r'<script id="comparison-report" type="application/json">(.*?)</script>', html, re.S).group(1)
        self.assertEqual(json.loads(payload), report)
        self.assertNotIn("<", payload)
        self.assertNotIn("&", payload)
        self.assertEqual(html.count('<script>alert("x")'), 0)

    def test_rejects_missing_or_malformed_recommendations(self):
        for report in ({}, {"recommendations": "wrong"}, {"recommendations": ["wrong"]},
                       {"recommendations": [{"basket": [None]}]},
                       {"recommendations": [{"items": [{"options": [None]}]}]}):
            with self.subTest(report=report), self.assertRaises(ValueError):
                renderer.render_report(report)

    def test_rejects_nonfinite_prices(self):
        with self.assertRaises(ValueError):
            renderer.render_report({"recommendations": [{"current_price": float("nan")}]})

    def test_cli_accepts_utf8_bom_and_writes_standalone_file(self):
        # Keep transient test files inside the writable, resolved test directory.
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            root = Path(directory)
            source, output = root / "report.json", root / "preview.html"
            source.write_text(json.dumps({"demo": True, "recommendations": []}), encoding="utf-8-sig")
            self.assertEqual(renderer.main(["--report", str(source), "--output", str(output)]), 0)
            html = output.read_text(encoding="utf-8")
            self.assertIn('lang="zh-CN"', html)
            self.assertNotIn(renderer.PLACEHOLDER, html)
            self.assertNotRegex(html, r'<(?:script|link|img)[^>]+(?:src|href)="https?://')
            self.assertNotIn("fetch(", html)
            self.assertNotIn("XMLHttpRequest", html)

    @unittest.skipUnless(shutil.which("node"), "Node is required for the offline DOM harness")
    def test_selection_copy_freshness_and_pending_states_without_network(self):
        report = {
            "schema_version": "1.0", "mode": "demo", "demo": True,
            "context": {"store_name": "演示门店（模拟）", "budget_cents": 3500, "channel": "pickup"},
            "recommendations": [
                {"title": "[演示] 汉堡午餐", "source": {"platform": "synthetic", "url": None},
                 "claims": {"advertised_price": {"amount": "19.90", "unit": "yuan", "currency": "CNY"}},
                 "items": [{"name": "演示汉堡", "quantity": 1}],
                 "basket": [{"sku_id": "hidden-sku", "name": "演示汉堡", "quantity": 1, "options": [{"option_id": "hidden-option", "name": "去酱", "quantity": 1}]}],
                 "mapping_status": "matched", "condition_checks": [], "within_budget": True,
                 "quote": {"status": "demo", "mode": "demo", "total_cents": 2990, "quoted_at": "2026-10-14T12:00:00+08:00"}},
                {"title": "[演示] 券条件待确认", "claims": {}, "basket": [{"name": "演示鸡块", "quantity": 2}],
                 "mapping_status": "matched", "quote": {"status": "demo", "total_cents": 3990}, "within_budget": False,
                 "condition_checks": [{"description": "原帖专属优惠券", "status": "unknown"}], "reasons": ["超出预算"]},
                {"title": "[演示] 当前没有这款", "claims": {}, "items": [{"name": "季节新品", "quantity": 1}],
                 "mapping_status": "unavailable", "quote": {"status": "missing", "total_cents": None}, "condition_checks": []},
            ],
        }
        html = renderer.render_report(report)
        script = re.findall(r"<script>(.*?)</script>", html, re.S)[-1]
        harness = r'''
const vm=require("node:vm"), assert=require("node:assert/strict");
class El {
 constructor(tag){this.tag=tag;this.children=[];this.listeners={};this.className="";this._text="";this.value="";this.hidden=false;this.disabled=false;this.attrs={};this.classList={toggle:(name,on)=>{let parts=this.className.split(/\s+/).filter(Boolean);parts=parts.filter(x=>x!==name);if(on)parts.push(name);this.className=parts.join(" ");}};}
 get textContent(){return this._text+this.children.map(child=>child.textContent).join("");}
 set textContent(value){this._text=String(value);this.children=[];}
 append(...children){this.children.push(...children);}
 replaceChildren(...children){this._text="";this.children=children;}
 setAttribute(key,value){this.attrs[key]=value;}
 addEventListener(name,fn){this.listeners[name]=fn;}
 focus(){this.focused=true;}
 select(){this.selected=true;}
 scrollIntoView(){this.scrolled=true;}
}
function setup(report,clipboard,now=Date.now()){
 const ids=["comparison-report","context-rows","mode-badge","demo-notice","cards","candidate-count","empty","basket-title","basket-context","basket-items","basket-total","basket-price-label","copy-button","shopping-list","copy-feedback","copy-fallback","selection-announcement","basket-details","basket-toggle","basket-close"];
 const nodes=Object.fromEntries(ids.map(id=>[id,new El("div")]));nodes["comparison-report"].textContent=JSON.stringify(report);
 nodes["basket-details"].hidden=true;nodes["basket-toggle"].disabled=true;nodes["copy-button"].disabled=true;nodes["copy-fallback"].hidden=true;
 let copied="";const document={getElementById:id=>nodes[id],createElement:tag=>new El(tag),querySelectorAll:selector=>selector===".card"?nodes.cards.children:[]};
 const navigator=clipboard?{clipboard:typeof clipboard==="object"?clipboard:{writeText:async text=>{copied=text;}}}:{};
 const ClockDate=class extends Date {static now(){return typeof now==="object"?now.value:now;}};
 vm.runInNewContext(SCRIPT,{document,navigator,URL,Date:ClockDate});
 return {nodes,get copied(){return copied;}};
}
(async()=>{
 const ui=setup(REPORT,true),cards=ui.nodes.cards.children;
 assert.equal(cards.length,3);
 assert.equal(ui.nodes["copy-button"].disabled,true);assert.equal(ui.nodes["basket-toggle"].disabled,true);
 const radios=cards.map(card=>card.children.find(child=>child.tag==="label").children[0]);
 assert.equal(radios[2].disabled,true);
 radios[0].listeners.change();
 assert.equal(ui.nodes["basket-title"].textContent,"[演示] 汉堡午餐");
 assert.equal(ui.nodes["basket-total"].textContent,"¥29.90");
 assert.match(ui.nodes["basket-items"].textContent,/演示汉堡（去酱） × 1/);
 assert.equal(ui.nodes["basket-toggle"].disabled,false);assert.equal(ui.nodes["basket-details"].hidden,true);
 ui.nodes["basket-toggle"].listeners.click();
 assert.equal(ui.nodes["basket-details"].hidden,false);assert.equal(ui.nodes["basket-toggle"].attrs["aria-expanded"],"true");
 assert.equal(ui.nodes["basket-details"].scrolled,true);assert.equal(ui.nodes["basket-close"].focused,true);
 ui.nodes["basket-close"].listeners.click();
 assert.equal(ui.nodes["basket-details"].hidden,true);assert.equal(ui.nodes["basket-toggle"].attrs["aria-expanded"],"false");
 assert.equal(ui.nodes["basket-toggle"].focused,true);
 await ui.nodes["copy-button"].listeners.click();
 assert.match(ui.copied,/DEMO/);assert.match(ui.copied,/去酱/);
 assert.doesNotMatch(ui.copied,/hidden-sku|hidden-option/);
 radios[1].listeners.change();assert.equal(ui.nodes["copy-button"].textContent,"复制待确认清单");
 assert.match(ui.nodes["basket-context"].textContent,/原帖专属优惠券/);
 const live=JSON.parse(JSON.stringify(REPORT));live.mode="live";live.demo=false;
 live.recommendations=[live.recommendations[1]];live.recommendations[0].quote.status="verified";live.recommendations[0].quote.mode="live";
 const pending=setup(live,false),label=pending.nodes.cards.children[0].children.find(child=>child.tag==="label");
 assert.match(label.textContent,/待确认/);label.children[0].listeners.change();
 await pending.nodes["copy-button"].listeners.click();
 assert.equal(pending.nodes["copy-fallback"].hidden,false);
 assert.equal(pending.nodes["basket-details"].hidden,false);assert.equal(pending.nodes["basket-toggle"].attrs["aria-expanded"],"true");
 assert.equal(pending.nodes["shopping-list"].selected,true);
 assert.equal(pending.nodes["shopping-list"].scrolled,true);
 assert.match(pending.nodes["shopping-list"].value,/待确认/);
 // A late clipboard result must not replace a newly selected mobile meal.
 for(const changeBack of [false,true]){
  let rejectCopy;const clipboard={writeText:()=>new Promise((resolve,reject)=>{rejectCopy=reject;})};
  const changing=setup(REPORT,clipboard),choices=changing.nodes.cards.children.map(card=>card.children.find(child=>child.tag==="label").children[0]);
  choices[0].listeners.change();const attempt=changing.nodes["copy-button"].listeners.click();
  choices[1].listeners.change();if(changeBack)choices[0].listeners.change();
  rejectCopy(new Error("permission denied"));await attempt;
  assert.equal(changing.nodes["copy-fallback"].hidden,true);assert.equal(changing.nodes["copy-feedback"].textContent,"");
  assert.match(changing.nodes["shopping-list"].value,changeBack?/汉堡午餐/:/券条件待确认/);
  clipboard.writeText=async()=>{throw new Error("permission denied");};
  await changing.nodes["copy-button"].listeners.click();
  assert.equal(changing.nodes["copy-fallback"].hidden,false);
  assert.match(changing.nodes["shopping-list"].value,changeBack?/汉堡午餐/:/券条件待确认/);
 }
 // A verified report is a snapshot. Recheck its quote against the time the
 // consumer opens the page, rather than the report's generation time.
 const fixedNow=Date.parse("2026-10-14T04:00:00Z"),fresh=JSON.parse(JSON.stringify(REPORT));
 fresh.mode="live";fresh.demo=false;fresh.recommendations=[fresh.recommendations[0]];
 const candidate=fresh.recommendations[0];candidate.ready_to_order=true;
 candidate.quote={status:"verified",mode:"live",total_cents:2990,quoted_at:"2026-10-14T03:59:30Z"};
 candidate.claims.advertised_price={amount:2990,unit:"cent",currency:"CNY"};
 const currentPrice=ui=>ui.nodes.cards.children[0].children.find(child=>child.className==="price-box").children[1].children[1].textContent;
 const originalPrice=ui=>ui.nodes.cards.children[0].children.find(child=>child.className==="price-box").children[0].children[1].textContent;
 const cardRadio=ui=>ui.nodes.cards.children[0].children.find(child=>child.tag==="label").children[0];
 const freshUI=setup(fresh,true,fixedNow);assert.equal(currentPrice(freshUI),"¥29.90");
 assert.equal(originalPrice(freshUI),"¥29.90");assert.match(freshUI.nodes.cards.textContent,/已核验/);
 cardRadio(freshUI).listeners.change();assert.equal(freshUI.nodes["copy-button"].textContent,"复制购物清单");
 for(const changes of [
  {quoted_at:"2026-10-14T03:54:59Z"},
  {quoted_at:null},
  {quoted_at:"2026-10-14T03:59:30"},
  {quoted_at:"2026-02-30T03:59:30Z"},
  {quoted_at:"2026-10-14T04:00:31Z"},
  {expires_at:"2026-10-14T04:00:00Z"},
  {expires_at:"invalid"},
  {status:"stale"}
 ]){
  const old=JSON.parse(JSON.stringify(fresh));Object.assign(old.recommendations[0].quote,changes);
  const oldUI=setup(old,true,fixedNow);
  assert.equal(currentPrice(oldUI),"待重新核价");assert.match(oldUI.nodes.cards.textContent,/需重新核价/);
  assert.doesNotMatch(oldUI.nodes.cards.textContent,/已核验/);cardRadio(oldUI).listeners.change();
  assert.equal(oldUI.nodes["basket-total"].textContent,"待重新核价");
  assert.equal(oldUI.nodes["copy-button"].textContent,"复制待确认清单");
  await oldUI.nodes["copy-button"].listeners.click();assert.match(oldUI.copied,/待确认清单/);
  assert.match(oldUI.copied,/当前报价：待重新核价/);assert.match(oldUI.copied,/需要重新核价/);
 }
 // Copying also rechecks time after the page has been left open.
 const clock={value:fixedNow},leftOpen=setup(fresh,true,clock);cardRadio(leftOpen).listeners.change();clock.value+=301000;
 await leftOpen.nodes["copy-button"].listeners.click();assert.match(leftOpen.copied,/当前报价：待重新核价/);
 assert.equal(leftOpen.nodes["basket-total"].textContent,"待重新核价");
 assert.equal(leftOpen.nodes["copy-button"].textContent,"复制待确认清单");
 for(const amount of [2990.5,"2990.5",-1,true,"garbage"]){
  const invalidClaim=JSON.parse(JSON.stringify(fresh));invalidClaim.recommendations[0].claims.advertised_price.amount=amount;
  assert.equal(originalPrice(setup(invalidClaim,true,fixedNow)),"未注明");
 }
 const demoLater=setup(REPORT,true,Date.parse("2030-01-01T00:00:00Z"));
 assert.equal(currentPrice(demoLater),"¥29.90");assert.match(demoLater.nodes.cards.textContent,/演示报价/);
 const empty=setup({mode:"demo",demo:true,context:{},recommendations:[]},true);
 assert.equal(empty.nodes.empty.hidden,false);
 assert.equal(empty.nodes["copy-button"].disabled,true);assert.equal(empty.nodes["basket-toggle"].disabled,true);
})().catch(error=>{console.error(error);process.exitCode=1;});
'''
        harness = ("const SCRIPT=" + json.dumps(script, ensure_ascii=False) + ";\n"
                   + "const REPORT=" + json.dumps(report, ensure_ascii=False) + ";\n" + harness)
        completed = subprocess.run([shutil.which("node"), "-"], input=harness, text=True,
                                   encoding="utf-8", capture_output=True, timeout=20)
        self.assertEqual(completed.returncode, 0, completed.stderr)


if __name__ == "__main__":
    unittest.main()
