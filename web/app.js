"use strict";

(() => {
  const $ = id => document.getElementById(id);
  const list = value => Array.isArray(value) ? value : [];
  const txt = value => value == null ? "" : String(value);
  const node = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text != null) el.textContent = txt(text); return el; };
  const replace = (id, ...children) => $(id).replaceChildren(...children);
  const money = cents => Number.isSafeInteger(cents) && cents >= 0 ? "¥" + (cents / 100).toFixed(2) : "待核价";
  const clock = value => { const date = new Date(value); return value && Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("zh-CN", {timeZone:"Asia/Shanghai",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).format(date) : "时间未返回"; };
  const sourceName = source => typeof source === "string" ? source : source && typeof source.name === "string" ? source.name : "实时接口";
  const sourceMeta = response => sourceName(response.source) + " · 查询于 " + clock(response.queriedAt) + "（北京时间）";
  const state = {csrfToken:null,point:null, locationAddress:"",locationCandidates:[], stores:[],store:null,menu:[],notes:[],activeNote:null,viewNote:null,cart:[],cartPlanOrigin:null,quote:null,route:null,item:null,itemQuantity:1,itemSelections:[],busy:new Set(),contextVersion:0,searchVersion:0,noteVersion:0,itemVersion:0,mealVersion:0,mealResult:null,mealSignature:null};
  let toastTimer,mealPollTimer;

  function safeURL(value, kind) {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value);
      if (url.username || url.password) return null;
      if (kind === "note") return url.protocol === "https:" && (url.hostname === "xiaohongshu.com" || url.hostname.endsWith(".xiaohongshu.com") || url.hostname === "xhslink.com" || url.hostname.endsWith(".xhslink.com")) ? url.href : null;
      if (kind === "navigation") return url.protocol === "https:" && (url.hostname === "amap.com" || url.hostname.endsWith(".amap.com")) ? url.href : null;
      return url.protocol === "https:" ? url.href : null;
    } catch { return null; }
  }
  function image(value, className, alt) {
    const url = safeURL(value, "image"); if (!url) return null;
    const img = node("img",className); img.src = url; img.alt = alt || ""; img.loading = "lazy"; img.referrerPolicy = "no-referrer"; img.addEventListener("error",() => img.remove(),{once:true}); return img;
  }
  function feedback(id, message = "", error = false) { $(id).textContent = message; $(id).classList.toggle("error",error); }
  function toast(message) { clearTimeout(toastTimer); $("toast").textContent = message; $("toast").hidden = false; toastTimer = setTimeout(() => $("toast").hidden = true,3200); }
  function busy(key, enabled, buttonId) { enabled ? state.busy.add(key) : state.busy.delete(key); if (buttonId) { $(buttonId).disabled = enabled; $(buttonId).classList.toggle("loading",enabled); } }
  async function api(path, body) {
    if (body !== undefined && !state.csrfToken) throw new Error("页面连接尚未就绪，请先点击上方“重新检查连接”。");
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(),95000);
    try {
      const response = await fetch(path,{method:body === undefined ? "GET" : "POST",headers:body === undefined ? {Accept:"application/json",...(state.csrfToken ? {"X-CSRF-Token":state.csrfToken} : {})} : {"Content-Type":"application/json",Accept:"application/json","X-CSRF-Token":state.csrfToken},body:body === undefined ? undefined : JSON.stringify(body),signal:controller.signal,credentials:"omit"});
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) throw new Error("服务没有返回可用数据，请检查本地服务是否已启动。");
      const result = await response.json();
      if (!response.ok || result.ok === false) {
        const error = new Error(result.error && typeof result.error.message === "string" ? result.error.message : "查询暂时失败，请稍后重试。");
        if (result.error && typeof result.error.code === "string") error.code = result.error.code;
        throw error;
      }
      return result;
    } catch (error) { if (error.name === "AbortError") throw new Error("查询等待较久，尚未获取结果。请重试。"); if (error instanceof TypeError) throw new Error("无法连接本地服务，请确认服务仍在运行。"); throw error; }
    finally { clearTimeout(timeout); }
  }
  function empty(message, icon) { const el = node("div","empty-state small"); if (icon) el.append(node("span","empty-icon",icon)); el.append(node("p",null,message)); return el; }
  function loading(id, text) { const el = empty(text); el.classList.add("loading"); replace(id,el); }
  const storeId = store => txt(store && (store.id || store.storeCode));
  const productId = item => txt(item && (item.id || item.productCode));
  const pickedCount = () => state.cart.reduce((sum,item) => sum + item.quantity,0);
  const actionError = error => error.code === "selection_stale" ? "当前餐品规格已变化，原餐单未自动替换。请在餐单点击“修改规格 / 份数”，重新确认配餐后再核算。" : error.code === "menu_required" ? "当前门店菜单需重新读取。请点击“当前菜单”右侧的“刷新”，再确认餐品与规格后重新核算。" : error.message;

  function syncSearchSuggestions() {
    const keyword = $("keyword-input").value.trim(),disabled = !state.csrfToken || state.busy.has("search");
    $("search-suggestions").querySelectorAll("button[data-keyword]").forEach(button => { button.disabled = disabled; button.setAttribute("aria-pressed",String(button.dataset.keyword === keyword)); });
    updateMealBuilder();
  }

  function mealPreference() {
    const keyword = $("keyword-input").value.trim();
    const chip = [...$("search-suggestions").querySelectorAll("button[data-keyword]")].find(button => button.dataset.keyword === keyword);
    return {keyword,intent:chip ? chip.dataset.intent : "custom",label:chip ? chip.dataset.label : "你的搜索"};
  }
  function mealBudget() {
    const value = $("meal-budget-input").value.trim();
    return /^\d+(?:\.\d{1,2})?$/.test(value) && Number(value) <= 9999 ? Math.round(Number(value) * 100) : null;
  }
  function mealContextSignature() { const preference = mealPreference(); return JSON.stringify([state.contextVersion,storeId(state.store),preference.intent,preference.keyword,mealBudget()]); }
  function updateMealBuilder() {
    const preference = mealPreference(),running = state.busy.has("meal-plans");
    $("meal-builder-context").textContent = state.store ? preference.label + " · " + state.store.name + " · 到店自取" : "先选好取餐门店，再按你的偏好搭配完整一餐。";
    const budget = mealBudget(); $("meal-budget-summary").textContent = budget == null ? "暂未设置预算 · 可在上方地点设置区填写" : "整餐预算 " + money(budget) + " · 按优惠后的官方试算选一餐";
    $("meal-store-guide").hidden = !!state.store;
    $("generate-meal-plans").disabled = !state.csrfToken || !state.store || !preference.keyword || state.busy.has("search") || state.busy.has("menu") || running;
    $("generate-meal-plans").textContent = running ? "正在搭配完整一餐…" : state.mealResult ? "重新搭配这一餐 →" : "按预算，搭配完整一餐 →";
    $("generate-meal-plans").classList.toggle("loading",running);
  }
  function invalidateMealPlans(message = "") {
    state.mealVersion++; clearTimeout(mealPollTimer); state.busy.delete("meal-plans"); state.mealResult = null; state.mealSignature = null;
    $("meal-progress").hidden = true; $("meal-plan-results").hidden = true; $("meal-overbudget-details").hidden = true; $("meal-overbudget-details").open = false; replace("meal-plan-list"); replace("meal-overbudget-list"); renderMealOffers(null); feedback("meal-plan-feedback",message); updateMealBuilder();
  }
  function resultFresh() {
    const result = state.mealResult,queriedAt = result && Date.parse(result.queriedAt);
    return !!result && state.mealSignature === mealContextSignature() && txt(result.storeCode) === storeId(state.store) && Number.isFinite(queriedAt) && queriedAt <= Date.now() + 30000 && queriedAt + 300000 > Date.now();
  }
  function quoteIsFresh(quote) { const now = Date.now(); return !!quote && Number.isSafeInteger(quote.totalCents) && quote.totalCents >= 0 && Number.isFinite(quoteDeadline(quote)) && Date.parse(quote.queriedAt) <= now + 30000 && quoteDeadline(quote) > now; }
  function planItemsValid(plan) {
    const items = list(plan.items);
    return items.length > 0 && items.length <= 12 && new Set(items.map(item => item.productCode)).size === items.length && items.every(item => typeof item.productCode === "string" && item.productCode && Number.isInteger(item.quantity) && item.quantity >= 1 && item.quantity <= 10 && Array.isArray(item.roundList) && item.roundList.every(round => typeof round.round === "string" && Array.isArray(round.comboItemList) && round.comboItemList.every(choice => typeof choice.code === "string" && Number.isInteger(choice.quantity) && choice.quantity >= 1 && choice.quantity <= 10)));
  }
  const mealRoles = [{key:"main",label:"主食"},{key:"side",label:"小食"},{key:"drink",label:"饮料"}];
  function coverageNames(plan,key) { return list(plan.coverage && plan.coverage[key]).filter(value => typeof value === "string" && value.trim()); }
  function completeMeal(plan) { return !!(plan && plan.coverage && plan.coverage.complete === true && mealRoles.every(role => coverageNames(plan,role.key).length > 0)); }
  function planUsable(plan) { return resultFresh() && completeMeal(plan) && planItemsValid(plan) && (plan.status === "needs_confirmation" || plan.status === "quoted" && quoteIsFresh(plan.quote)); }
  function renderMealOffers(offers) {
    const membership = offers && offers.membership || {},verified = membership.status === "verified",notMember = membership.status === "not_member";
    $("membership-summary").classList.toggle("verified",verified);
    $("membership-label").textContent = verified ? txt(membership.label || "麦金卡资格已核实") : notMember ? txt(membership.label || "当前未查询到麦金卡资格") : "麦金卡资格待核实";
    $("membership-message").textContent = txt(membership.message) || list(membership.evidence).filter(value => typeof value === "string" && value.trim()).join("；") || (offers ? "没有可核实的金卡权益，按官方实际报价搭配；不会预设金卡折扣。" : "生成餐单时查询可用权益；只按官方确认的优惠核价。");
    $("meal-offers").hidden = !offers; if (!offers) { replace("meal-offers"); return; }
    const content = [node("strong",null,"这一餐，优惠怎么算"),node("p",null,$("membership-label").textContent + " · " + $("membership-message").textContent)];
    const coupons = list(offers.coupons).filter(coupon => coupon && typeof coupon.title === "string" && coupon.title.trim());
    if (coupons.length) { const details = node("details"),summary = node("summary",null,"已查询到的券与权益（是否生效以本餐核价为准）"); details.append(summary); const lines = node("ul"); coupons.forEach(coupon => { const line = node("li",null,coupon.title); if (typeof coupon.validTime === "string" && coupon.validTime.trim()) line.append(node("span",null," · " + coupon.validTime)); lines.append(line); }); details.append(lines); content.push(details); }
    content.push(node("p","meal-offers-notice",txt(offers.pricingNote || offers.notice) || "优惠券与会员权益不能直接叠加估算，只有官方核算确认的优惠会进入餐单金额。")); replace("meal-offers",...content);
  }
  function mealPlanGroups(result) {
    const budget = Number.isSafeInteger(result.budgetCents) && result.budgetCents >= 0 ? result.budgetCents : mealBudget(),plans = [],overBudgetPlans = [];
    for (const plan of list(result.plans)) { if (budget != null && plan.status === "quoted" && Number.isSafeInteger(plan.quote && plan.quote.totalCents) && plan.quote.totalCents > budget) overBudgetPlans.push(plan); else plans.push(plan); }
    for (const plan of list(result.overBudgetPlans)) { if (!overBudgetPlans.some(existing => existing === plan || existing.id && existing.id === plan.id)) overBudgetPlans.push(plan); }
    return {budget,plans:plans.slice(0,1),overBudgetPlans:plans.length ? [] : overBudgetPlans.slice(0,1)};
  }
  function renderMealPlans() {
    const result = state.mealResult; if (!result) return;
    const {budget,plans,overBudgetPlans} = mealPlanGroups(result),fresh = resultFresh(); $("meal-plan-results").hidden = false; $("meal-plan-count").textContent = plans.length && completeMeal(plans[0]) ? "完整配餐" : overBudgetPlans.length ? "预算需调整" : "等待完整配餐";
    $("meal-result-meta").textContent = (state.store ? state.store.name + " · " : "") + "按偏好与预算搭配 · " + clock(result.queriedAt) + "（北京时间）"; renderMealOffers(result.offers || {});
    $("meal-result-notice").textContent = txt(result.notice);
    const renderPlan = (plan,index,isOverBudget = false) => {
      const quoted = plan.status === "quoted",validQuote = quoted && fresh && quoteIsFresh(plan.quote),usable = planUsable(plan),complete = completeMeal(plan);
      const card = node("article","meal-plan-card" + (isOverBudget ? " over-budget" : "") + (!fresh || quoted && !validQuote ? " expired" : ""));
      const heading = node("div","meal-plan-heading"); heading.append(node("span","meal-plan-number",complete ? "✓" : "!"),node("h4",null,plan.title || "为你搭好的这一餐")); card.append(heading);
      if (plan.rationale) card.append(node("p","meal-plan-rationale",plan.rationale));
      const coverage = node("div","meal-coverage"); coverage.setAttribute("aria-label",complete ? "已包含主食、小食和饮料" : "配餐尚未完整"); mealRoles.forEach(role => { const names = coverageNames(plan,role.key),row = node("div","meal-coverage-role" + (names.length ? " covered" : " missing")); row.append(node("strong",null,(names.length ? "✓ " : "! ") + role.label),node("span",null,names.length ? names.join("、") : "尚未补齐")); coverage.append(row); }); card.append(coverage);
      const composition = node("p","meal-composition",plan.compositionOrigin === "official_combo" ? "已核对套餐内所选规格，包含三类餐品。" : plan.compositionOrigin === "menu_completed" ? "按所选偏好，由系统从本店菜单补齐一餐。" : "已对照当前门店菜单核对搭配。"); card.append(composition);
      const items = node("ol","meal-plan-items"); list(plan.items).forEach(item => { const row = node("li"),heading = node("div","meal-item-heading"); heading.append(node("strong",null,txt(item.name) + " × " + txt(item.quantity))); const origin = item.origin === "menu" ? "本店补齐" : item.origin === "inspiration" ? "笔记灵感" : "当前菜单"; heading.append(node("span","meal-item-origin" + (item.origin === "menu" ? " added" : ""),origin)); row.append(heading); const specs = list(item.specs).filter(value => typeof value === "string"); if (specs.length) row.append(node("p",null,specs.join("；"))); items.append(row); }); card.append(items);
      const price = node("div","meal-plan-price"); const priceText = validQuote ? money(plan.quote.totalCents) : quoted ? "报价已过期" : "先确认规格"; price.append(node("strong",null,priceText),node("span",null,validQuote ? "整餐应付 · 官方试算" : quoted ? "请重新生成或手动核价" : "未取得可用整单金额")); card.append(price);
      if (validQuote) {
        if (budget != null) card.append(node("p","meal-plan-budget" + (isOverBudget ? " over-budget-label" : ""),plan.quote.totalCents <= budget ? "本次试算在你的预算内" : "本次试算超出预算 " + money(plan.quote.totalCents - budget)));
        const benefits = plan.priceBenefits || plan.quote,discount = Number.isSafeInteger(benefits.discountCents) && benefits.discountCents >= 0 ? benefits.discountCents : null,original = Number.isSafeInteger(benefits.originalCents) && benefits.originalCents >= 0 ? benefits.originalCents : null;
        const benefit = node("div","meal-price-benefits"); if (original != null || discount != null) benefit.append(node("p",null,(original != null ? "官方原价 " + money(original) : "") + (original != null && discount != null ? " · " : "") + (discount != null ? "已确认优惠 " + money(discount) : ""))); benefit.append(node("p",null,txt(benefits.description) || "应付金额以官方本次试算为准，未确认的金卡权益或券不会另行减价。")); card.append(benefit);
        const applied = list(plan.quote.appliedOffers).map(offer => offer && offer.title).filter(value => typeof value === "string" && value.trim()); if (applied.length) benefit.append(node("p",null,"本餐已用券：" + [...new Set(applied)].join("、")));
        card.append(node("p","meal-plan-quote-meta",sourceMeta(plan.quote) + " · 金额在复核窗口内有效"));
      }
      const warnings = [...list(plan.warnings),...list(plan.unresolved)].filter(value => typeof value === "string" && value.trim());
      if (warnings.length) { const box = node("div","meal-plan-warnings"); box.append(node("strong",null,"照着点之前，请留意")); const lines = node("ul"); [...new Set(warnings)].forEach(value => lines.append(node("li",null,value))); box.append(lines); card.append(box); }
      const source = plan.source || {},evidence = list(plan.evidence).filter(value => typeof value === "string" && value.trim());
      const details = node("details","meal-plan-evidence"),summary = node("summary",null,"查看搭配来源与依据"); details.append(summary);
      if (source.title || source.url) details.append(node("p","meal-plan-source",(source.platform === "mcd" ? "菜单依据：" : "参考笔记：") + txt(source.title || "小红书参考笔记") + (typeof source.author === "string" ? " · " + source.author : ""))); else details.append(node("p",null,"当前菜单搭配；本次未取得可展示的小红书正文依据。"));
      if (evidence.length) { const lines = node("ul"); evidence.forEach(value => lines.append(node("li",null,value))); details.append(lines); }
      const inspiration = list(plan.inspirationItems).filter(value => typeof value === "string" && value.trim()),added = list(plan.addedItems).filter(value => typeof value === "string" && value.trim()); if (inspiration.length) details.append(node("p",null,"笔记灵感：" + inspiration.join("、"))); if (added.length) details.append(node("p",null,"系统补齐：" + added.join("、")));
      list(plan.inspirationSources).forEach(inspiration => { if (!inspiration || typeof inspiration.title !== "string") return; const row = node("p",null,"灵感参考：" + inspiration.title),url = safeURL(inspiration.url,"note"); if (url) { const link = node("a","external-link","查看这篇笔记 ↗"); link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer"; row.append(link); } details.append(row); });
      const url = safeURL(source.url,"note"); if (url) { const link = node("a","external-link","查看小红书原帖 ↗"); link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer"; details.append(link); } card.append(details);
      const adopt = node("button","button " + (quoted && !isOverBudget ? "button-primary" : "button-secondary") + " wide",!complete ? "尚未搭成完整一餐" : isOverBudget ? "采用这份超预算配餐 →" : quoted ? state.cart.length ? "采用并替换当前餐单 →" : "就吃这一餐 →" : "采用配餐，确认规格 →"); adopt.type = "button"; adopt.disabled = !usable; adopt.dataset.planAdopt = "true"; adopt.dataset.planIndex = String(index); adopt.dataset.planGroup = isOverBudget ? "over-budget" : "main"; adopt.addEventListener("click",() => adoptMealPlan(plan,isOverBudget)); card.append(adopt);
      const status = node("p","meal-plan-validity",!fresh ? "推荐已过复核窗口，请重新生成。" : !complete ? "缺少主食、小食或饮料，暂不能作为完整一餐采用。" : !planItemsValid(plan) ? "餐品与规格不完整，请重新搭配。" : validQuote ? "改变餐品、份数或门店后，需要重新核价。" : quoted ? "本次金额已过复核窗口，请重新生成。" : "采用后逐项确认实际规格，再核算整单金额。"); status.dataset.planValidity = "true"; card.append(status); return card;
    };
    replace("meal-plan-list",...(plans.length ? plans.map((plan,index) => renderPlan(plan,index)) : [empty(budget != null ? "暂时没有在预算内搭齐主食、小食和饮料。可调整上方预算，再搭配这一餐。" : "本店菜单暂时未能搭齐完整一餐。可刷新菜单，或更换门店后重试。","✦")]));
    $("meal-overbudget-details").hidden = !overBudgetPlans.length; $("meal-overbudget-summary").textContent = "查看最接近预算的完整一餐"; replace("meal-overbudget-list",...overBudgetPlans.map((plan,index) => renderPlan(plan,index,true)));
  }
  function refreshMealPlanValidity() {
    if (!state.mealResult) return;
    const {plans,overBudgetPlans} = mealPlanGroups(state.mealResult); $("meal-plan-results").querySelectorAll("button[data-plan-adopt]").forEach(button => {
      const plan = (button.dataset.planGroup === "over-budget" ? overBudgetPlans : plans)[Number(button.dataset.planIndex)],usable = !!plan && planUsable(plan); button.disabled = !usable;
      if (!usable && plan && (!resultFresh() || plan.status === "quoted" && !quoteIsFresh(plan.quote))) {
        const card = button.closest("article"),price = card.querySelector(".meal-plan-price strong"); card.classList.add("expired");
        if (price && plan.status === "quoted") price.textContent = "报价已过期";
        const benefits = card.querySelector(".meal-price-benefits"); if (benefits) { benefits.hidden = true; benefits.replaceChildren(); }
        const budget = card.querySelector(".meal-plan-budget"); if (budget) budget.hidden = true;
        const quoteMeta = card.querySelector(".meal-plan-quote-meta"); if (quoteMeta) quoteMeta.textContent = "原报价与优惠已失效，请重新生成并核价后确认。";
        const validity = card.querySelector("[data-plan-validity]"); if (validity) validity.textContent = "报价和优惠已过复核窗口，请重新搭配并核价。";
      }
    });
  }
  function mealCompletionMessage(result) {
    const {budget,plans,overBudgetPlans} = mealPlanGroups(result),plan = plans[0];
    if (plan && completeMeal(plan) && plan.status === "quoted" && quoteIsFresh(plan.quote)) return "已为你搭好主食、小食和饮料" + (budget != null ? "，本次官方试算在预算内" : "，并取得整餐官方试算") + "。查看搭配与优惠后，就能照着点。";
    if (plan && completeMeal(plan)) return "已搭齐完整一餐，请先确认餐品规格，再核算整餐金额。";
    if (overBudgetPlans.length) return "当前预算内未能搭齐一餐。下方保留了最接近预算的完整搭配，可查看超出金额后调整预算。";
    return "本次未能从当前菜单搭齐主食、小食和饮料，请调整预算、偏好或门店后重试。";
  }
  async function generateMealPlans() {
    const preference = mealPreference(); if (!state.store || !preference.keyword || state.busy.has("meal-plans") || state.busy.has("search") || state.busy.has("menu")) return;
    invalidateMealPlans(); const version = state.mealVersion,signature = mealContextSignature(),budgetCents = mealBudget(); state.mealSignature = signature; busy("meal-plans",true); updateMealBuilder(); $("meal-progress").hidden = false; $("meal-progress-message").textContent = "正在找灵感、搭齐主食小食饮料，并查询实际可用优惠…";
    const current = () => version === state.mealVersion && signature === mealContextSignature();
    try {
      const response = await api("/api/meal-plans",{storeCode:storeId(state.store),intent:preference.intent,keyword:preference.keyword,...(budgetCents != null ? {budgetCents} : {})}); if (!current()) return;
      if (typeof response.jobId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(response.jobId)) throw new Error("未取得本次解析任务，请重试。");
      const jobId = response.jobId; let polls = 0;
      const poll = async () => {
        if (!current()) return;
        try {
          const response = await api("/api/meal-plans/" + encodeURIComponent(jobId)); if (!current()) return;
          const job = response.job; if (!job || !["running","complete","failed"].includes(job.status)) throw new Error("解析任务未返回有效状态，请重试。");
          if (job.status === "failed") throw new Error(job.error && typeof job.error.message === "string" ? job.error.message : "这次正文解析未完成，请换一个词条或稍后重试。");
          if (job.status === "complete") {
            if (!job.result || txt(job.result.storeCode) !== storeId(state.store)) throw new Error("餐单与当前门店不一致，请重新生成。");
            state.mealResult = job.result; state.mealSignature = signature; busy("meal-plans",false); $("meal-progress").hidden = true; renderMealPlans(); updateMealBuilder(); feedback("meal-plan-feedback",mealCompletionMessage(job.result)); $("meal-plan-results").scrollIntoView({behavior:"smooth",block:"start"}); return;
          }
          const progress = job.progress || {},count = Number.isInteger(progress.current) && Number.isInteger(progress.total) && progress.total > 0 ? "（" + progress.current + "/" + progress.total + "）" : "";
          $("meal-progress-message").textContent = (typeof progress.message === "string" && progress.message.trim() ? progress.message : "正在按预算搭配完整一餐，并由官方核价…") + count;
          if (++polls >= 240) throw new Error("本次任务等待较久，尚未取得完整餐单。可稍后重新生成。");
          mealPollTimer = setTimeout(poll,1500);
        } catch (error) { if (current()) { busy("meal-plans",false); $("meal-progress").hidden = true; feedback("meal-plan-feedback",actionError(error),true); updateMealBuilder(); } }
      };
      mealPollTimer = setTimeout(poll,100);
    } catch (error) { if (current()) { busy("meal-plans",false); $("meal-progress").hidden = true; feedback("meal-plan-feedback",actionError(error),true); updateMealBuilder(); } }
  }
  function adoptMealPlan(plan,isOverBudget = false) {
    if (!planUsable(plan)) { refreshMealPlanValidity(); toast("推荐或报价已变化，请重新生成餐单。"); return; }
    const needsConfirmation = plan.status !== "quoted";
    state.cart = list(plan.items).map(item => { const roundList = list(item.roundList).map(round => ({round:round.round,comboItemList:list(round.comboItemList).map(choice => ({code:choice.code,quantity:choice.quantity}))})); const offerRef = typeof item.offerRef === "string" && item.offerRef ? item.offerRef : null; return {key:JSON.stringify([item.productCode,roundList,offerRef]),productCode:item.productCode,...(offerRef ? {offerRef} : {}),name:txt(item.name),quantity:item.quantity,roundList,specs:list(item.specs).filter(value => typeof value === "string"),selectionSnapshot:list(item.selectionSnapshot),needsConfirmation}; });
    const budget = mealBudget(),excess = isOverBudget && budget != null && Number.isSafeInteger(plan.quote && plan.quote.totalCents) ? Math.max(0,plan.quote.totalCents - budget) : 0;
    state.cartPlanOrigin = {title:txt(plan.title),source:plan.source || {},compositionOrigin:plan.compositionOrigin,inspirationItems:list(plan.inspirationItems),addedItems:list(plan.addedItems),warnings:[...list(plan.warnings),...list(plan.unresolved),...(isOverBudget ? ["已采用超预算参考，超出当前预算 " + money(excess)] : [])].filter(value => typeof value === "string")};
    invalidateQuote(); if (!needsConfirmation && quoteIsFresh(plan.quote)) { state.quote = {...plan.quote}; showQuote(state.quote); }
    renderCart(); feedback("quote-feedback",needsConfirmation ? "已采用能匹配的餐品。请逐项点“确认规格 / 份数”，确认后再核算；未匹配的原帖内容见上方提醒。" : isOverBudget ? "已采用超预算餐单，本次官方试算超出预算 " + money(excess) + "。请按具体规格点餐。" : "已采用这份实际规格与官方试算，购物清单可直接复制。",needsConfirmation || isOverBudget);
    toast(needsConfirmation ? "餐品已加入 · 请确认每项规格" : "已采用餐单 · 请按规格点餐"); $("cart-section").scrollIntoView({behavior:"smooth",block:"start"}); updateMealBuilder();
  }

  async function checkStatus() {
    busy("status",true,"refresh-status"); $("connection-label").textContent = "正在检查数据连接";
    try {
      const response = await api("/api/status"); if (!/^[a-f0-9]{64}$/.test(response.csrfToken || "")) throw new Error("未获取到页面连接凭据，请刷新重试。"); state.csrfToken = response.csrfToken; const providers = response.providers || {}; let ready = 0;
      const names = {xiaohongshu:"小红书 · 推荐笔记",mcd:"麦当劳 · 门店与菜单",amap:"高德 · 地点与路线"};
      const states = {ready:"已就绪",connected:"已连接",available:"可用",configured:"已配置，查询时验证",ok:"已连接",logged_in:"已登录",error:"暂不可用",unavailable:"暂不可用",not_configured:"未配置",not_logged_in:"需登录",login_required:"请在本机重新扫码登录",offline:"未连接",unknown:"状态待确认"};
      const entries = Object.entries(names).map(([key,name]) => { const provider = providers[key] || {}; const status = typeof provider.status === "string" ? provider.status : "unknown"; if (["ready","connected","available","ok","logged_in"].includes(status)) ready++; const row = node("li"); row.append(node("span",null,name),node("span",null,states[status] || "状态待确认")); return row; });
      replace("provider-list",...entries); $("connection-label").textContent = ready === 3 ? "3 个数据服务已连接" : "数据连接状态 · " + ready + "/3 已就绪"; $("connection-dot").className = "connection-dot" + (ready === 3 ? "" : " partial");
    } catch (error) { $("connection-label").textContent = "无法检查服务连接"; $("connection-dot").className = "connection-dot error"; replace("provider-list",node("li",null,error.message)); }
    finally { busy("status",false,"refresh-status"); $("find-stores").disabled = !state.csrfToken || state.busy.has("stores"); $("search-button").disabled = !state.csrfToken || state.busy.has("search"); syncSearchSuggestions(); }
  }

  function invalidateQuote() { state.quote = null; $("quote-panel").hidden = true; feedback("quote-feedback"); feedback("copy-feedback"); $("copy-fallback").hidden = true; updateDock(); }
  function resetContext() {
    state.contextVersion++; state.itemVersion++; state.point = null; state.locationAddress = ""; state.locationCandidates = []; $("geo-picker-label").hidden = true; state.stores = []; state.store = null; state.menu = []; state.cart = []; state.cartPlanOrigin = null; state.route = null; state.item = null; invalidateMealPlans();
    if ($("item-dialog").open) $("item-dialog").close();
    invalidateQuote(); renderStores(); renderMenu(); renderCart(); resetRoute();
    $("location-summary").textContent = "地点已更改，请重新查找门店"; feedback("location-feedback"); feedback("stores-feedback");
  }
  async function findStores(event) {
    event.preventDefault(); if (state.busy.has("stores")) return;
    const city = $("city-input").value.trim(), location = $("location-input").value.trim(); if (!city || !location) return;
    resetContext(); const version = state.contextVersion; busy("stores",true,"find-stores"); feedback("location-feedback","正在解析出发地点，并查询麦当劳官方门店…"); loading("store-list","正在查找附近的真实门店…");
    try {
      const [geoResult,storesResult] = await Promise.allSettled([api("/api/location",{city,location}),api("/api/stores",{city,location})]); if (version !== state.contextVersion) return;
      const geo = geoResult.status === "fulfilled" ? geoResult.value : null;
      if (geo && typeof geo.location === "string" && /^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/.test(geo.location)) {
        state.point = geo.location; state.locationAddress = txt(geo.formattedAddress || city + location); $("location-summary").textContent = state.locationAddress; feedback("location-feedback","高德解析：" + state.locationAddress + "。" + (typeof geo.resolutionNote === "string" && geo.resolutionNote.trim() ? geo.resolutionNote + " " : "") + "若不准确，请填写更具体的地标或门牌。");
        state.locationCandidates = list(geo.places).filter(place => typeof place.location === "string" && /^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/.test(place.location));
        $("geo-picker-label").hidden = state.locationCandidates.length < 2;
        replace("geo-picker",...state.locationCandidates.map((place,index) => { const option = node("option",null,txt(place.name ? place.name + " · " : "") + txt(place.formattedAddress || place.district || place.location)); option.value = String(index); option.selected = place.location === state.point; return option; }));
      } else { state.locationAddress = city + location; $("location-summary").textContent = state.locationAddress; feedback("location-feedback","出发点坐标暂未获取，仍可选店配餐；步行路线暂不可用。",true); }
      if (storesResult.status !== "fulfilled") throw storesResult.reason;
      const response = storesResult.value;
      state.stores = list(response.stores); renderStores(); $("stores-meta").textContent = sourceMeta(response); feedback("stores-feedback",state.stores.length ? "找到 " + state.stores.length + " 家门店，请选择取餐门店。" : "这个地点暂未返回可取餐门店，请换一个出发地点。",!state.stores.length);
      if (state.stores.length) $("stores-section").scrollIntoView({behavior:"smooth",block:"start"});
    } catch (error) { if (version === state.contextVersion) { renderStores(); feedback("stores-feedback",error.message,true); } }
    finally { busy("stores",false,"find-stores"); }
  }
  function renderStores() {
    $("store-count").textContent = state.stores.length ? state.stores.length + " 家门店" : "等待地点";
    if (!state.stores.length) { replace("store-list",empty("填写出发地点，查找附近真实门店。","⌖")); return; }
    replace("store-list",...state.stores.map(store => {
      const selected = storeId(store) === storeId(state.store); const card = node("article","store-card" + (selected ? " selected" : ""));
      const heading = node("div","store-card-title"); const statusText = store.open === true ? "营业中" : store.open === false ? "当前未营业" : "营业状态待确认";
      heading.append(node("span","store-icon","m"),node("h3",null,store.name || "麦当劳门店"),node("span","store-state" + (store.open === true ? " open" : ""),statusText));
      card.append(heading,node("p","store-address",store.address || "地址未返回")); const bottom = node("div","store-card-bottom");
      const distance = store.distanceMeters == null || store.distanceMeters === "" ? NaN : Number(store.distanceMeters); bottom.append(node("span",null,Number.isFinite(distance) && distance >= 0 ? (distance < 1000 ? Math.round(distance) + " m" : (distance / 1000).toFixed(1) + " km") + " · 门店距离" : "到店自取"));
      const select = node("button","store-select",selected ? "已选取餐店 ✓" : "选这家"); select.type = "button"; select.disabled = !storeId(store); select.addEventListener("click",() => selectStore(store)); bottom.append(select); card.append(bottom); return card;
    }));
  }
  async function selectStore(store) {
    if (storeId(state.store) === storeId(store) && state.menu.length) { $("menu-section").scrollIntoView({behavior:"smooth"}); return; }
    state.contextVersion++; state.itemVersion++; state.store = store; state.cart = []; state.cartPlanOrigin = null; state.menu = []; state.route = null; state.item = null; invalidateMealPlans(); if ($("item-dialog").open) $("item-dialog").close(); invalidateQuote(); renderStores(); renderCart(); resetRoute(); await loadMenu();
  }
  async function loadMenu() {
    if (!state.store) return; invalidateMealPlans(); const version = state.contextVersion; const id = storeId(state.store); busy("menu",true,"refresh-menu"); updateMealBuilder(); $("menu-store").textContent = state.store.name + " · 到店自取"; feedback("menu-feedback","正在读取该门店当前菜单…"); loading("menu-list","菜单来自麦当劳官方服务，请稍候…");
    try { const response = await api("/api/menu",{storeCode:id}); if (version !== state.contextVersion) return; state.menu = list(response.items); $("menu-meta").textContent = sourceMeta(response); renderMenu(); feedback("menu-feedback",state.menu.length ? "" : "该门店暂未返回可选餐品，请刷新或选择其他门店。",!state.menu.length); $("menu-section").scrollIntoView({behavior:"smooth",block:"start"}); }
    catch (error) { if (version === state.contextVersion) { state.menu = []; renderMenu(); feedback("menu-feedback",error.message,true); } }
    finally { busy("menu",false,"refresh-menu"); $("refresh-menu").disabled = !state.store; updateMealBuilder(); }
  }
  function mention(item) { return !!(state.activeNote && txt(item.name).length >= 2 && (txt(state.activeNote.title) + "\n" + txt(state.activeNote.body)).includes(txt(item.name))); }
  function renderMenu() {
    $("menu-tools").hidden = !state.menu.length; $("refresh-menu").disabled = !state.store || state.busy.has("menu"); $("matches-only").disabled = !state.activeNote; if (!state.activeNote) $("matches-only").checked = false;
    const matching = state.menu.filter(mention); $("note-match-summary").textContent = !state.store ? "选好门店后，可对照当前菜单。" : matching.length ? "原文出现 " + matching.length + " 个当前菜单名称，仅按文字原样匹配；规格、套餐组成与优惠需自行确认。" : "原文未出现当前菜单中的完整餐品名，请自行对照正文选择。";
    if (!state.menu.length) { replace("menu-list",empty(state.store ? "还没有读取到该门店的可选菜单。" : "选择取餐门店后，读取该店当前菜单。","☷")); if (!state.store) { $("menu-store").textContent = "先选择门店，再读取该门店菜单。"; $("menu-meta").textContent = ""; } return; }
    const filter = $("menu-filter").value.trim().toLocaleLowerCase(); const items = state.menu.filter(item => (!filter || txt(item.name).toLocaleLowerCase().includes(filter)) && (!$("matches-only").checked || mention(item)));
    if (!items.length) { replace("menu-list",empty("当前筛选没有餐品。可更换关键词，或关闭“只看文中提到”。")); return; }
    replace("menu-list",...items.map(item => {
      const card = node("article","menu-card"); const img = image(item.image,"menu-image",item.name); if (img) card.append(img); const content = node("div","menu-content"); content.append(node("h3",null,item.name || "餐品"));
      const tags = node("div","menu-tags"); if (mention(item)) tags.append(node("span","tag matched","文中提到 · 名称匹配")); list(item.tags).slice(0,3).forEach(tag => { if (typeof tag === "string") tags.append(node("span","tag",tag)); }); if (tags.childElementCount) content.append(tags);
      const bottom = node("div","menu-card-bottom"); const displayPrice = typeof item.displayPrice === "string" && /^\d+(?:\.\d{1,2})?$/.test(item.displayPrice) ? "¥" + item.displayPrice : "以试算为准"; const price = node("span","menu-price",displayPrice); if (displayPrice !== "以试算为准") price.append(node("small",null,item.conditionalPrice ? "条件标价" : "菜单标价")); if (item.conditionalPrice) content.append(node("p","menu-price-condition",txt(item.priceCondition) || "优惠需满足资格，本次应付以官方核价为准。"));
      const select = node("button","item-select","选规格 +"); select.type = "button"; select.disabled = !productId(item); select.addEventListener("click",() => openItem(item,select)); bottom.append(price,select); content.append(bottom); card.append(content); return card;
    }));
  }

  async function searchNotes(event) {
    event.preventDefault(); if (state.busy.has("search")) return; const keyword = $("keyword-input").value.trim(); if (!keyword) return; invalidateMealPlans(); const version = ++state.searchVersion; busy("search",true,"search-button"); syncSearchSuggestions(); feedback("search-feedback","正在小红书查找真实笔记，首次查询可能需要一些时间…"); loading("note-list","正在读取小红书搜索结果…");
    try { const response = await api("/api/search",{keyword}); if (version !== state.searchVersion) return; state.notes = list(response.notes); $("notes-meta").textContent = sourceMeta(response) + " · " + state.notes.length + " 条"; renderNotes(); feedback("search-feedback",state.notes.length ? "" : "这次没有返回笔记。可更换关键词重试；当前没有可展示的推荐。",!state.notes.length); }
    catch (error) { if (version === state.searchVersion) { state.notes = []; renderNotes(); feedback("search-feedback",error.message,true); $("notes-meta").textContent = "此次查询未完成"; } }
    finally { busy("search",false,"search-button"); syncSearchSuggestions(); }
  }
  function renderNotes() {
    if (!state.notes.length) { replace("note-list",empty("尚无可展示的实际笔记，请搜索或更换关键词。","✦")); return; }
    replace("note-list",...state.notes.map(note => {
      const card = node("article","note-card"); const cover = image(note.cover,"note-cover",""); if (cover) card.append(cover); const content = node("div","note-card-content"); content.append(node("h3",null,note.title || "未命名笔记"),node("p","note-author",typeof note.author === "string" ? note.author : "小红书作者"));
      const bottom = node("div","note-card-bottom"); bottom.append(node("span","note-likes",note.likes == null ? "作者推荐 · 待对照菜单" : "♡ " + txt(note.likes)));
      const button = node("button","text-button","读这篇 ↗"); button.type = "button"; button.disabled = !note.id; button.addEventListener("click",() => readNote(note,button)); bottom.append(button); content.append(bottom); card.append(content); return card;
    }));
  }
  async function readNote(note,button) {
    const version = ++state.noteVersion; button.disabled = true; button.classList.add("loading"); feedback("search-feedback","正在读取这篇笔记的正文…");
    try { const response = await api("/api/note",{id:note.id}); if (version !== state.noteVersion) return; if (!response.note) throw new Error("未读取到笔记正文，请尝试其他笔记。"); state.viewNote = {...note,...response.note,source:response.source,queriedAt:response.queriedAt}; showNote(state.viewNote); feedback("search-feedback"); }
    catch (error) { if (version === state.noteVersion) feedback("search-feedback",error.message,true); }
    finally { button.disabled = false; button.classList.remove("loading"); }
  }
  function showNote(note) {
    $("note-dialog-title").textContent = note.title || "小红书笔记"; $("note-dialog-meta").textContent = (typeof note.author === "string" ? note.author + " · " : "") + sourceMeta(note); $("note-dialog-body").textContent = note.body || "这篇笔记没有返回可读取的正文，请打开原帖查看。";
    const url = safeURL(note.url,"note"); $("note-original").hidden = !url; if (url) $("note-original").href = url; else $("note-original").removeAttribute("href"); if (!$("note-dialog").open) $("note-dialog").showModal();
  }
  function useNote() {
    if (!state.viewNote) return; state.activeNote = state.viewNote; $("selected-note").hidden = false; $("selected-note-title").textContent = state.activeNote.title || "小红书笔记"; $("selected-note-excerpt").textContent = txt(state.activeNote.body).slice(0,130) + (txt(state.activeNote.body).length > 130 ? "…" : ""); $("note-dialog").close(); renderMenu(); toast("已作为参考。请按当前门店菜单选择餐品。"); (state.store ? $("menu-section") : $("stores-section")).scrollIntoView({behavior:"smooth"});
  }

  function choiceMax(round,choice) { const max = Number(choice.maxQuantity); return Math.min(Number.isInteger(max) && max >= 0 ? max : round.maxQuantity,10); }
  function defaultQuantity(choice) {
    if (choice.quantity !== null && choice.quantity !== undefined) { const quantity = Number(choice.quantity); return Number.isInteger(quantity) && quantity > 0 ? quantity : 0; }
    return choice.isDefault === true ? 1 : 0;
  }
  function normalizeRounds(item) {
    return list(item.rounds).map(round => {
      const min = Number(round.minQuantity), max = Number(round.maxQuantity);
      return {...round,id:txt(round.id),name:txt(round.name || "餐品选择"),minQuantity:Number.isInteger(min) && min >= 0 ? min : 0,maxQuantity:Number.isInteger(max) && max >= 0 ? max : 1,choices:list(round.choices).map(choice => ({...choice,id:txt(choice.id),name:txt(choice.name || "可选餐品")}))};
    });
  }
  async function openItem(item,button) {
    if (!state.store) return; const version = ++state.itemVersion; const contextVersion = state.contextVersion; const id = storeId(state.store); button.disabled = true; button.classList.add("loading"); feedback("menu-feedback","正在读取“" + item.name + "”的实际规格…");
    try {
      const previous = state.cart.find(entry => entry.productCode === productId(item)),offerRef = item.offerRef || previous && previous.offerRef;
      const response = await api("/api/item",{storeCode:id,productCode:productId(item),...(offerRef ? {offerRef} : {})}); if (version !== state.itemVersion || contextVersion !== state.contextVersion) return; if (!response.item) throw new Error("未返回餐品详情，暂时不能加入餐单。");
      state.item = {...item,...response.item,...(offerRef ? {offerRef} : {}),id:productId(response.item) || productId(item),rounds:normalizeRounds(response.item),source:response.source,queriedAt:response.queriedAt}; state.itemQuantity = 1;
      const existing = state.cart.find(entry => entry.productCode === state.item.id);
      if (existing) state.itemQuantity = existing.quantity;
      state.itemSelections = state.item.rounds.map(round => round.choices.map(choice => {
        if (existing) { const selectedRound = existing.roundList.find(entry => entry.round === round.id); const selectedChoice = selectedRound && selectedRound.comboItemList.find(entry => entry.code === choice.id); return selectedChoice ? selectedChoice.quantity : 0; }
        return defaultQuantity(choice);
      }));
      const lost = [],addedRounds = [],changedLimits = [];
      if (existing) {
        for (const previousRound of existing.roundList) {
          const currentRound = state.item.rounds.find(round => round.id === previousRound.round);
          const snapshot = list(existing.selectionSnapshot).find(round => round.id === previousRound.round);
          for (const previousChoice of previousRound.comboItemList) {
            if (currentRound && currentRound.choices.some(choice => choice.id === previousChoice.code)) continue;
            const oldChoice = snapshot && list(snapshot.choices).find(choice => choice.id === previousChoice.code);
            lost.push(oldChoice ? (snapshot.name ? snapshot.name + "：" : "") + oldChoice.name : existing.specs.length ? existing.specs.join("；") : "原先选定的套餐配餐");
          }
        }
        state.item.rounds.forEach((round,index) => {
          if (!existing.roundList.some(previousRound => previousRound.round === round.id)) addedRounds.push(round.name);
          if (!roundValid(round,index) && !addedRounds.includes(round.name)) changedLimits.push(round.name);
        });
      }
      const notices = [];
      if (lost.length) notices.push("以下原规格当前已不可选：" + [...new Set(lost)].join("；") + "。");
      if (addedRounds.length) notices.push("新增配餐选项：" + addedRounds.join("、") + "，请重新选择。");
      if (changedLimits.length) notices.push("请重新确认“" + changedLimits.join("、") + "”的选择数量。");
      if (notices.length) notices.push("仍可用的选择已保留；原餐单尚未更改，确认后再更新。");
      $("item-dialog-title").textContent = state.item.name || item.name; $("item-dialog-meta").textContent = sourceMeta(response) + (state.item.supportModify ? " · 可特调，本餐使用默认特调" : ""); $("add-item").textContent = existing ? notices.length ? "确认新规格并更新餐单" : "更新餐单中的这份餐品" : "加入我的这一餐"; feedback("item-feedback",notices.join(" "),notices.length > 0); renderRounds();
      if (existing) state.item.rounds.forEach((round,index) => { if (!roundValid(round,index)) $("round-" + index).classList.add("invalid"); });
      updateItemQuantity(); feedback("menu-feedback"); $("item-dialog").showModal();
    } catch (error) { if (version === state.itemVersion && contextVersion === state.contextVersion) feedback("menu-feedback",actionError(error),true); }
    finally { button.disabled = false; button.classList.remove("loading"); }
  }
  function roundValid(round,index) { const sum = state.itemSelections[index].reduce((a,b) => a+b,0); return sum >= round.minQuantity && sum <= round.maxQuantity && state.itemSelections[index].every((quantity,i) => quantity >= 0 && quantity <= choiceMax(round,round.choices[i])); }
  function renderRounds() {
    if (!state.item) return;
    if (!state.item.rounds.length) { replace("item-rounds",empty("该餐品没有返回需选择的套餐配餐。加入后进行官方试算。")); return; }
    replace("item-rounds",...state.item.rounds.map((round,roundIndex) => {
      const field = node("section","round"); field.id = "round-" + roundIndex; field.append(node("h3",null,round.name),node("p","round-hint",round.minQuantity === round.maxQuantity ? "请选择 " + round.minQuantity + " 份" : "可选 " + round.minQuantity + "–" + round.maxQuantity + " 份"));
      if (!round.choices.length && round.minQuantity > 0) field.append(node("p","feedback error","当前没有返回可选项，这份餐品暂时无法加入。"));
      round.choices.forEach((choice,choiceIndex) => {
        const row = node("div","round-choice"); const name = node("span",null,choice.name); if (defaultQuantity(choice) > 0) name.append(node("small",null,"默认")); const stepper = node("div","stepper");
        const minus = node("button",null,"−"),output = node("output",null,state.itemSelections[roundIndex][choiceIndex]),plus = node("button",null,"+"); minus.type = plus.type = "button"; minus.setAttribute("aria-label","减少" + choice.name); plus.setAttribute("aria-label","增加" + choice.name);
        const sync = () => { const quantity = state.itemSelections[roundIndex][choiceIndex],sum = state.itemSelections[roundIndex].reduce((a,b) => a+b,0); output.textContent = quantity; minus.disabled = quantity <= 0; plus.disabled = quantity >= choiceMax(round,choice) || (sum >= round.maxQuantity && round.maxQuantity !== 1) || choice.disabled === true; };
        minus.addEventListener("click",() => { if (state.itemSelections[roundIndex][choiceIndex] > 0) state.itemSelections[roundIndex][choiceIndex]--; renderRounds(); });
        plus.addEventListener("click",() => { if (round.maxQuantity === 1) { state.itemSelections[roundIndex].fill(0); state.itemSelections[roundIndex][choiceIndex] = 1; } else if (state.itemSelections[roundIndex].reduce((a,b) => a+b,0) < round.maxQuantity && state.itemSelections[roundIndex][choiceIndex] < choiceMax(round,choice)) state.itemSelections[roundIndex][choiceIndex]++; renderRounds(); });
        sync(); stepper.append(minus,output,plus); row.append(name,stepper); field.append(row);
      }); return field;
    }));
  }
  function updateItemQuantity() { $("item-quantity").textContent = state.itemQuantity; $("item-minus").disabled = state.itemQuantity <= 1; $("item-plus").disabled = state.itemQuantity >= 10; }
  function addItem() {
    if (!state.item || !state.store) return;
    const invalid = state.item.rounds.findIndex((round,index) => !roundValid(round,index));
    if (invalid >= 0) { feedback("item-feedback","请完成“" + state.item.rounds[invalid].name + "”的选择数量。",true); $("round-" + invalid).classList.add("invalid"); $("round-" + invalid).scrollIntoView({block:"nearest",behavior:"smooth"}); return; }
    const roundList = state.item.rounds.map((round,index) => ({round:round.id,comboItemList:round.choices.flatMap((choice,i) => state.itemSelections[index][i] > 0 ? [{code:choice.id,quantity:state.itemSelections[index][i]}] : [])}));
    const specs = state.item.rounds.flatMap((round,index) => round.choices.flatMap((choice,i) => state.itemSelections[index][i] > 0 ? [round.name + "：" + choice.name + (state.itemSelections[index][i] > 1 ? " × " + state.itemSelections[index][i] : "")] : []));
    const key = JSON.stringify([state.item.id,roundList,state.item.offerRef || null]); const existing = state.cart.find(item => item.productCode === state.item.id);
    if (!existing && state.cart.length >= 12) { feedback("item-feedback","本餐最多核算 12 种餐品，请先移除部分餐品。",true); return; }
    const selectionSnapshot = state.item.rounds.map((round,index) => ({id:round.id,name:round.name,choices:round.choices.flatMap((choice,i) => state.itemSelections[index][i] > 0 ? [{id:choice.id,name:choice.name,quantity:state.itemSelections[index][i]}] : [])}));
    const entry = {key,productCode:state.item.id,...(state.item.offerRef ? {offerRef:state.item.offerRef} : {}),name:state.item.name,quantity:state.itemQuantity,roundList,specs,selectionSnapshot};
    if (existing) state.cart[state.cart.indexOf(existing)] = entry; else state.cart.push(entry);
    invalidateQuote(); renderCart(); $("item-dialog").close(); toast((existing ? "餐品规格与份数已更新" : "已加入这一餐") + " · 请重新核价");
  }
  function renderCart() {
    $("cart-count").textContent = pickedCount(); $("clear-cart").disabled = !state.cart.length; $("copy-cart").disabled = !state.cart.length;
    $("cart-plan-origin").hidden = !state.cartPlanOrigin || !state.cart.length;
    if (state.cartPlanOrigin && state.cart.length) { const origin = state.cartPlanOrigin,content = [node("strong",null,"为你搭配：" + origin.title)]; if (origin.source.title) content.push(node("p",null,(origin.source.platform === "mcd" ? "菜单依据：" : "参考笔记：") + txt(origin.source.title))); if (origin.compositionOrigin === "menu_completed") content.push(node("p",null,"按所选偏好，从本店菜单补齐；修改餐品后需重新核价。")); const added = origin.addedItems.filter(value => typeof value === "string" && value.trim()); if (added.length) content.push(node("p",null,"系统补齐：" + added.join("、"))); const url = safeURL(origin.source.url,"note"); if (url) { const link = node("a","text-button","查看这篇原帖 ↗"); link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer"; content.push(link); } if (origin.warnings.length) content.push(node("p","cart-origin-warning",origin.warnings.join("；"))); replace("cart-plan-origin",...content); }
    if (!state.cart.length) { state.cartPlanOrigin = null; replace("cart-list",empty("从菜单选择餐品，确认规格后加入餐单。")); updateDock(); updateMealBuilder(); return; }
    replace("cart-list",...state.cart.map(item => {
      const row = node("article","cart-row"); const head = node("div","cart-row-head"); const remove = node("button","text-button","移除"); remove.type = "button"; remove.setAttribute("aria-label","移除" + item.name); remove.addEventListener("click",() => { state.cart = state.cart.filter(entry => entry.key !== item.key); invalidateQuote(); renderCart(); }); head.append(node("h3",null,item.name),remove); row.append(head); if (item.specs.length) row.append(node("p","cart-row-spec",item.specs.join("；")));
      const edit = node("button","text-button cart-edit",item.needsConfirmation ? "确认规格 / 份数" : "修改规格 / 份数"); edit.type = "button"; edit.addEventListener("click",() => openItem({...state.menu.find(entry => productId(entry) === item.productCode),...item,id:item.productCode},edit)); row.append(edit); if (item.needsConfirmation) row.append(node("p","cart-confirmation-note","请打开并确认当前规格，完成后可整单核价。"));
      const bottom = node("div","cart-row-bottom"); bottom.append(node("span",null,"金额以整单官方试算为准")); const stepper = node("div","stepper"); const minus = node("button",null,"−"),plus = node("button",null,"+"); minus.type = plus.type = "button"; minus.setAttribute("aria-label","减少" + item.name + "份数"); plus.setAttribute("aria-label","增加" + item.name + "份数"); minus.disabled = item.quantity <= 1; plus.disabled = item.quantity >= 10;
      minus.addEventListener("click",() => { if (item.quantity > 1) item.quantity--; invalidateQuote(); renderCart(); }); plus.addEventListener("click",() => { if (item.quantity < 10) item.quantity++; invalidateQuote(); renderCart(); }); stepper.append(minus,node("output",null,item.quantity),plus); bottom.append(stepper); row.append(bottom); return row;
    })); updateDock(); updateMealBuilder();
  }
  function quoteDeadline(quote) { if (!quote) return NaN; const queried = Date.parse(quote.queriedAt); const expires = Date.parse(quote.expiresAt); if (!Number.isFinite(queried) || (quote.expiresAt != null && !Number.isFinite(expires))) return NaN; return Number.isFinite(expires) ? Math.min(expires,queried + 300000) : queried + 300000; }
  function quoteFresh() { return quoteIsFresh(state.quote); }
  function showQuote(response) {
    $("quote-panel").hidden = false; $("quote-panel-total").textContent = money(response.totalCents); const details = [];
    if (Number.isSafeInteger(response.originalCents) && response.originalCents >= 0) details.push("原价 " + money(response.originalCents)); if (Number.isSafeInteger(response.discountCents) && response.discountCents >= 0) details.push("优惠 " + money(response.discountCents)); $("quote-details").textContent = details.length ? details.join(" · ") : "本次取餐条件下的官方试算结果"; $("quote-source").textContent = sourceMeta(response);
    const applied = list(response.appliedOffers).map(offer => offer && offer.title).filter(value => typeof value === "string" && value.trim());
    $("quote-benefit-note").textContent = (applied.length ? "本餐已用券：" + [...new Set(applied)].join("、") + "。" : "") + (txt(response.priceBenefits && response.priceBenefits.description) || txt(response.benefitNotice) || "已返回的优惠计入本次官方试算；未核实的麦金卡权益或券不另行减价。");
  }
  function updateDock() {
    const count = pickedCount(),fresh = quoteFresh(); $("dock-cart-label").textContent = "我的这一餐 · " + count + " 件 ⌃"; $("dock-store").textContent = state.store ? state.store.name : "尚未选择门店"; $("dock-total").textContent = fresh ? money(state.quote.totalCents) : "—";
    $("dock-price-label").textContent = fresh ? "官方试算 · 到店自取" : state.quote ? "报价已过期，请重新核算" : "等待官方试算"; $("dock-total").parentElement.classList.toggle("stale",!!state.quote && !fresh);
    const awaitingConfirmation = state.cart.some(item => item.needsConfirmation); $("quote-button").disabled = !state.store || !state.cart.length || awaitingConfirmation || state.busy.has("quote"); $("quote-button").textContent = state.busy.has("quote") ? "官方核价中…" : awaitingConfirmation ? "请先确认餐品规格" : state.quote ? "重新核算这一餐 →" : "核算这一餐 →";
    if (state.quote) { const remaining = Math.max(0,Math.ceil((quoteDeadline(state.quote) - Date.now()) / 1000)); $("quote-panel").classList.toggle("stale",!fresh); $("quote-expiry").textContent = fresh ? "复核窗口剩余 " + Math.floor(remaining / 60) + " 分 " + remaining % 60 + " 秒 · 餐单变更后需重新核价" : "已过复核窗口，当前金额不能作为有效报价，请重新核算。"; }
    const budget = $("budget-input").value.trim(),budgetCents = /^\d+(?:\.\d{1,2})?$/.test(budget) ? Math.round(Number(budget) * 100) : NaN; $("budget-feedback").textContent = fresh && Number.isSafeInteger(budgetCents) ? state.quote.totalCents <= budgetCents ? "本次试算在你的预算内" : "本次试算超出预算 " + money(state.quote.totalCents - budgetCents) : "";
  }
  async function quoteCart() {
    if (!state.store || !state.cart.length || state.cart.some(item => item.needsConfirmation) || state.busy.has("quote")) return; const version = state.contextVersion; const signature = JSON.stringify(state.cart); busy("quote",true); updateDock(); feedback("quote-feedback","正在由麦当劳官方接口核算整份餐单…");
    try {
      const response = await api("/api/quote",{storeCode:storeId(state.store),items:state.cart.map(item => ({productCode:item.productCode,quantity:item.quantity,...(item.offerRef ? {offerRef:item.offerRef} : {}),...(item.roundList.length ? {roundList:item.roundList} : {})}))});
      if (version !== state.contextVersion || signature !== JSON.stringify(state.cart)) { feedback("quote-feedback","餐单已变更，请按当前餐单重新核算。"); return; }
      if (!Number.isSafeInteger(response.totalCents) || response.totalCents < 0) throw new Error("官方接口未返回可识别的整单金额，请重新核算。"); state.quote = response;
      if (!quoteFresh()) { state.quote = null; throw new Error("本次报价缺少有效查询时间或已过期，请重新核算。"); }
      showQuote(response); feedback("quote-feedback","已取得当前餐单试算。最终支付金额请在官方渠道确认。");
    } catch (error) { if (version === state.contextVersion && signature === JSON.stringify(state.cart)) { state.quote = null; $("quote-panel").hidden = true; feedback("quote-feedback",actionError(error),true); } }
    finally { busy("quote",false); updateDock(); }
  }
  async function copyCart() {
    if (!state.store || !state.cart.length) return; const lines = ["麦麦种草落地 · 购物清单","取餐门店：" + state.store.name,"地址：" + txt(state.store.address),"方式：到店自取",...state.cart.flatMap(item => ["• " + item.name + " × " + item.quantity,...item.specs.map(spec => "  " + spec)])];
    if (quoteFresh()) { lines.push("官方试算：" + money(state.quote.totalCents),"查询时间：" + clock(state.quote.queriedAt) + "（北京时间）"); const offers = list(state.quote.appliedOffers).map(offer => offer && offer.title).filter(value => typeof value === "string" && value.trim()); if (offers.length) lines.push("本餐已用券：" + [...new Set(offers)].join("、")); } else lines.push("金额待重新核价"); const source = state.cartPlanOrigin ? state.cartPlanOrigin.source : state.activeNote; if (source && source.title) { lines.push((source.platform === "mcd" ? "菜单依据：" : "参考笔记：") + source.title); const url = safeURL(source.url,"note"); if (url) lines.push(url); } if (state.cartPlanOrigin && state.cartPlanOrigin.warnings.length) lines.push("待留意：" + state.cartPlanOrigin.warnings.join("；")); if (state.cart.some(item => item.needsConfirmation)) lines.push("当前含待确认规格，请完成规格确认再下单。"); lines.push("请在麦当劳官方渠道确认商品与最终金额后自行下单。");
    const text = lines.join("\n"); try { await navigator.clipboard.writeText(text); feedback("copy-feedback","购物清单已复制。"); } catch { $("copy-fallback").value = text; $("copy-fallback").hidden = false; $("copy-fallback").focus(); $("copy-fallback").select(); feedback("copy-feedback","可在下方手动复制完整清单。"); }
  }

  function resetRoute() { state.route = null; $("route-result").hidden = true; $("route-button").disabled = !state.store || !state.point; $("route-context").textContent = state.store && state.point ? state.locationAddress + " → " + state.store.name : "选好出发地点和门店后，规划实际步行路线。"; feedback("route-feedback"); }
  async function getRoute() {
    if (!state.store || !state.point || state.busy.has("route")) return; const version = state.contextVersion; busy("route",true,"route-button"); feedback("route-feedback","正在查询高德实际步行路线…"); $("route-result").hidden = true;
    try {
      const response = await api("/api/route",{city:$("city-input").value.trim(),origin:state.point,storeCode:storeId(state.store)}); if (version !== state.contextVersion) return;
      if (!Number.isFinite(response.distanceMeters) || response.distanceMeters < 0 || !Number.isFinite(response.durationSeconds) || response.durationSeconds < 0) throw new Error("未取得完整步行距离与预计时间，请稍后重试。");
      state.route = response; $("route-distance").textContent = response.distanceMeters < 1000 ? Math.round(response.distanceMeters) + " 米" : (response.distanceMeters / 1000).toFixed(1) + " 公里"; $("route-duration").textContent = response.durationSeconds < 60 ? "不足 1 分钟" : Math.ceil(response.durationSeconds / 60) + " 分钟"; $("route-meta").textContent = sourceMeta(response); $("route-destination").textContent = (response.destination && response.destination.formattedAddress ? "解析终点：" + response.destination.formattedAddress + "。" : "") + txt(response.locationNotice);
      const steps = list(response.steps).filter(step => typeof step.instruction === "string" && step.instruction.trim()); replace("route-steps",...steps.map(step => { const row = node("li",null,step.instruction); if (Number.isFinite(step.distanceMeters) && step.distanceMeters >= 0) row.append(node("span",null,Math.round(step.distanceMeters) + " 米")); return row; }));
      const url = safeURL(response.navigationUrl,"navigation"); $("navigation-link").hidden = !url; if (url) $("navigation-link").href = url; else $("navigation-link").removeAttribute("href"); $("route-result").hidden = false; feedback("route-feedback",steps.length ? "" : "路线接口未返回详细指引，可打开高德查看实时导航。");
    } catch (error) { if (version === state.contextVersion) feedback("route-feedback",error.message,true); }
    finally { busy("route",false,"route-button"); $("route-button").disabled = !state.store || !state.point; }
  }

  $("item-rounds").before($("item-feedback"));
  $("keyword-input").addEventListener("input",() => { invalidateMealPlans(); syncSearchSuggestions(); });
  $("search-suggestions").addEventListener("click",event => { const button = event.target.closest("button[data-keyword]"); if (!button || button.disabled || !state.csrfToken || state.busy.has("search")) return; $("keyword-input").value = button.dataset.keyword; invalidateMealPlans(); syncSearchSuggestions(); $("search-form").requestSubmit(); });
  $("generate-meal-plans").addEventListener("click",generateMealPlans);
  $("meal-budget-input").addEventListener("input",() => { $("budget-input").value = $("meal-budget-input").value; invalidateMealPlans(); updateDock(); });
  $("refresh-status").addEventListener("click",checkStatus); $("location-form").addEventListener("submit",findStores); $("city-input").addEventListener("input",resetContext); $("location-input").addEventListener("input",resetContext); $("search-form").addEventListener("submit",searchNotes); $("refresh-menu").addEventListener("click",loadMenu); $("menu-filter").addEventListener("input",renderMenu); $("matches-only").addEventListener("change",renderMenu);
  $("geo-picker").addEventListener("change",() => { const place = state.locationCandidates[Number($("geo-picker").value)]; if (!place) return; state.point = place.location; state.locationAddress = txt(place.formattedAddress || place.name || place.district || place.location); $("location-summary").textContent = state.locationAddress; feedback("location-feedback","出发点已切换为：" + state.locationAddress + "。请核对实际位置。"); resetRoute(); });
  $("close-note").addEventListener("click",() => $("note-dialog").close()); $("close-item").addEventListener("click",() => $("item-dialog").close()); $("use-note").addEventListener("click",useNote); $("reopen-note").addEventListener("click",() => { if (state.activeNote) { state.viewNote = state.activeNote; showNote(state.activeNote); } }); $("clear-note").addEventListener("click",() => { state.activeNote = null; $("selected-note").hidden = true; renderMenu(); });
  $("item-minus").addEventListener("click",() => { if (state.itemQuantity > 1) state.itemQuantity--; updateItemQuantity(); }); $("item-plus").addEventListener("click",() => { if (state.itemQuantity < 10) state.itemQuantity++; updateItemQuantity(); }); $("add-item").addEventListener("click",addItem); $("clear-cart").addEventListener("click",() => { state.cart = []; state.cartPlanOrigin = null; invalidateQuote(); renderCart(); }); $("quote-button").addEventListener("click",quoteCart); $("copy-cart").addEventListener("click",copyCart); $("route-button").addEventListener("click",getRoute); $("budget-input").addEventListener("input",() => { $("meal-budget-input").value = $("budget-input").value; invalidateMealPlans(); updateDock(); });
  setInterval(() => { updateDock(); refreshMealPlanValidity(); },1000); updateDock(); updateMealBuilder(); checkStatus();
})();

