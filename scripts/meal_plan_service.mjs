/** Bounded, read-only complete meals from live menus and optional social inspiration. */
import { randomBytes } from 'node:crypto';
import { parseRecommendation } from './meal_planner.mjs';
import { selectDetailItems, composeCandidates } from './meal_composer.mjs';

const INTENTS = new Set(['low_calorie', 'low_budget', 'fries', 'breakfast', 'new_products', 'dessert', 'custom']);
const JOB_TTL = 900000, QUOTE_TTL = 300000, MAX_JOBS = 20, MAX_NOTES = 2, MAX_QUOTES = 6, RUN_LIMIT = 120000;
const ROLES = ['main', 'side', 'drink'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const list = value => Array.isArray(value) ? value : [];
const text = (value, limit = 500) => typeof value === 'string' ? value.slice(0, limit) : '';
const unique = values => [...new Set(values.filter(Boolean))];
const clone = value => structuredClone(value);
const codeOf = value => text(value?.productCode || value?.id, 80);
const keyOf = value => `${codeOf(value)}:${text(value?.offerRef, 80)}`;

export class MealPlanError extends Error {
  constructor(code, message) { super(message); this.name = 'MealPlanError'; this.code = code; }
}
const messages = {
  invalid_input: '餐单生成参数无效，请重新选择门店、词条和预算。',
  job_busy: '上一份餐单仍在生成或连接仍在恢复，请等待完成后重试。',
  service_closed: '餐单服务已停止，请刷新后重试。',
  timeout: '本次生成已达到时间限制，已保留完成核价的完整一餐；可稍后重试。',
  optional_timeout: '灵感查询超过等待时间，本次根据门店真实菜单搭配。',
  not_logged_in: '小红书登录已失效，本次根据门店菜单搭配；可在本机重新扫码。',
  authentication_required: '接口鉴权失败，请检查本机连接。', not_configured: '接口尚未配置，请检查本机连接。',
  store_required: '门店信息已过期，请重新查询并选择门店。', menu_required: '门店菜单已变化，请刷新后重新生成。',
  note_required: '笔记读取信息已过期，本次根据门店真实菜单搭配。', note_unavailable: '部分笔记正文暂时无法读取，未用作灵感来源。',
  search_not_ready: '小红书搜索尚未准备好，本次根据门店菜单搭配。', selection_required: '当前套餐缺少完整搭配，请在菜单中确认规格。',
  selection_stale: '门店套餐选项已变化，请重新生成或手动选择规格。', invalid_response: '数据服务未返回可核验的完整结果，请稍后重试。',
  business_rejected: '门店暂时无法核价这份搭配，请重新选择规格。', provider_unavailable: '数据服务暂时无法完成查询，请稍后重试。',
  provider_rejected: '数据服务未完成本次只读查询，请稍后重试。',
};
function safeError(error) { const code = Object.hasOwn(messages, error?.code) ? error.code : 'provider_unavailable'; return { code, message: messages[code] }; }
function fail(code) { throw new MealPlanError(code, messages[code] || messages.invalid_response); }
function input(value, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f]/u.test(value)) fail('invalid_input');
  return value.trim();
}
function argumentsOf(args) {
  if (!object(args) || Object.keys(args).some(key => !['storeCode', 'intent', 'keyword', 'budgetCents', 'noteIds'].includes(key))) fail('invalid_input');
  const result = { storeCode: input(args.storeCode, 40), intent: args.intent, keyword: input(args.keyword, 100) };
  if (!INTENTS.has(result.intent)) fail('invalid_input');
  if (args.budgetCents !== undefined && args.budgetCents !== null) {
    if (!Number.isSafeInteger(args.budgetCents) || args.budgetCents < 0 || args.budgetCents > 999900) fail('invalid_input');
    result.budgetCents = args.budgetCents;
  }
  if (args.noteIds !== undefined) {
    if (!Array.isArray(args.noteIds) || !args.noteIds.length || args.noteIds.length > 3 || args.noteIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{24}$/iu.test(id))) fail('invalid_input');
    result.noteIds = unique(args.noteIds).sort();
  }
  return result;
}
function sourceOf(note) {
  const id = /^[a-f0-9]{24}$/iu.test(note?.id) ? note.id : '';
  return { platform: 'xiaohongshu', id, title: text(note?.title, 200), author: text(note?.author, 80), ...(id ? { url: `https://www.xiaohongshu.com/explore/${id}` } : {}) };
}
function noteScore(note, args) {
  const patterns = { low_calorie: /低卡|减脂|轻食|热量|控卡|高蛋白|减肥/u, low_budget: /低预算|穷鬼|省钱|平价|便宜|性价比|打工人|优惠/u,
    fries: /薯条|薯饼|薯条星人/u, breakfast: /早餐|麦满分|早八|早饭/u, new_products: /新品|尝鲜|上新|新款/u, dessert: /甜品|麦旋风|冰淇淋|新地|圆筒|派|甜筒/u };
  const title = text(note.title, 200);
  return (patterns[args.intent]?.test(title) ? 5 : 0) + (/点法|教程|搭配|攻略|吃法|清单|食谱|小全|怎么点|如何点|照着点|点单指南|点餐指南/u.test(title) ? 8 : 0)
    + args.keyword.split(/[\s，,]+/u).filter(word => word.length >= 2 && word !== '麦当劳' && title.includes(word)).length;
}
function validateMenu(response, storeCode) {
  if (!object(response) || response.storeCode !== storeCode || !Array.isArray(response.items)) fail('invalid_response');
  const codes = new Set();
  for (const item of response.items) {
    const code = codeOf(item);
    if (!code || code.length > 80 || typeof item.name !== 'string' || !item.name || codes.has(keyOf(item))) fail('invalid_response');
    codes.add(keyOf(item));
  }
  return response.items;
}
function validDetail(response, request, storeCode) {
  const item = response?.item;
  if (response?.storeCode !== storeCode || !object(item) || codeOf(item) !== request.productCode || typeof item.name !== 'string' || !Array.isArray(item.rounds) || item.rounds.length > 16 || (item.offerRef || '') !== (request.offerRef || '')) fail('invalid_response');
  return item;
}
function fallbackOffers() {
  return { membership: { name: '麦金卡', status: 'unverified', label: '麦金卡资格待核实', message: '未取得可验证的会员资格，不预设麦金卡折扣，也不自动购卡。' }, coupons: [], pricingNote: '只按本次官方核价确认的优惠计入整餐价格；不自动购卡。' };
}
function publicOffers(response) {
  return { ...fallbackOffers(), membership: { ...fallbackOffers().membership, evidence: list(response?.membership?.evidence).filter(value => typeof value === 'string').map(value => text(value, 300)).slice(0, 6) },
    coupons: list(response?.coupons).slice(0, 100).map(coupon => ({ title: text(coupon?.title, 200), validTime: text(coupon?.validTime, 150), eligible: coupon?.eligible === true, applicationNote: text(coupon?.applicationNote, 300) })).filter(coupon => coupon.title),
    pricingNote: text(response?.pricingNote, 600) || fallbackOffers().pricingNote };
}
function basketOf(items) {
  return items.map(item => ({ productCode: item.productCode, quantity: item.quantity, ...(item.offerRef ? { offerRef: item.offerRef } : {}), ...(item.roundList?.length ? { roundList: clone(item.roundList) } : {}) }));
}
function sameBasket(actual, expected, compareSelections) {
  if (!Array.isArray(actual) || actual.length !== expected.length || new Set(actual.map(item => item?.productCode)).size !== actual.length) return false;
  return expected.every(item => {
    const matched = actual.find(candidate => candidate?.productCode === item.productCode);
    if (!matched || matched.quantity !== item.quantity) return false;
    if (!compareSelections) return true; // Official product rows do not echo coupon refs.
    if ((matched.offerRef || '') !== (item.offerRef || '')) return false;
    const a = list(matched.roundList), e = list(item.roundList);
    return a.length === e.length && new Set(a.map(round => round?.round)).size === a.length && e.every(round => {
      const observed = a.find(value => value?.round === round.round);
      return observed && Array.isArray(observed.comboItemList) && observed.comboItemList.length === round.comboItemList.length && new Set(observed.comboItemList.map(choice => choice?.code)).size === observed.comboItemList.length && round.comboItemList.every(choice => observed.comboItemList.some(value => value?.code === choice.code && value.quantity === choice.quantity));
    });
  });
}
function validateQuote(value, storeCode, items, now) {
  const time = typeof value?.queriedAt === 'string' ? Date.parse(value.queriedAt) : NaN;
  const expiry = typeof value?.expiresAt === 'string' ? Date.parse(value.expiresAt) : NaN, current = now(), explicitZone = /(?:Z|[+-]\d{2}:\d{2})$/u;
  if (!object(value) || value.storeCode !== storeCode || value.currency !== 'CNY' || !Number.isSafeInteger(value.totalCents) || value.totalCents < 0 || !explicitZone.test(value.queriedAt || '') || !explicitZone.test(value.expiresAt || '') || !Number.isFinite(time) || !Number.isFinite(expiry) || time > current + 30000 || current - time >= QUOTE_TTL || expiry <= current || expiry <= time || !sameBasket(value.items, items, false) || !sameBasket(value.selections, items, true)) fail('invalid_response');
  const expectedOffers = items.filter(item => item.offerRef), appliedOffers = list(value.appliedOffers);
  if (appliedOffers.length !== expectedOffers.length || new Set(appliedOffers.map(offer => `${offer?.productCode}:${offer?.offerRef}`)).size !== appliedOffers.length || expectedOffers.some(item => !appliedOffers.some(offer => offer?.productCode === item.productCode && offer.offerRef === item.offerRef && typeof offer.title === 'string' && offer.title.trim()))) fail('invalid_response');
  const nonnegative = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const originalCents = nonnegative(value.originalCents), discountCents = nonnegative(value.discountCents);
  if (value.discountEvidence?.confirmedCents !== undefined && value.discountEvidence.confirmedCents !== null && value.discountEvidence.confirmedCents !== discountCents) fail('invalid_response');
  return { source: text(value.source, 80) || '麦当劳官方 MCP', mode: 'live', storeCode, currency: 'CNY', totalCents: value.totalCents, originalCents, discountCents,
    appliedOffers: appliedOffers.map(offer => ({ productCode: offer.productCode, offerRef: offer.offerRef, title: text(offer.title, 200) })),
    discountEvidence: { basis: 'official_calculate_price', confirmedCents: discountCents, attribution: 'unspecified', membershipAttributionVerified: false, note: '只记录本次官方核价返回的优惠，未将其归因为已验证的麦金卡权益；未购卡。' },
    items: value.items.map(item => ({ productCode: item.productCode, name: text(item.name, 200), quantity: item.quantity, subtotalCents: nonnegative(item.subtotalCents) })),
    selections: clone(items), queriedAt: new Date(time).toISOString(), expiresAt: new Date(Math.min(time + QUOTE_TTL, expiry)).toISOString(),
    validityNote: '此报价为当前门店到店自取的查询快照，有效期不超过 5 分钟，优惠券可能更早结束；以页面有效期和官方确认为准。', channel: '到店自取', orderType: 1, beType: 1 };
}
function priceBenefits(quote) {
  return { originalCents: quote.originalCents, discountCents: quote.discountCents, membershipAttributionVerified: false, description: '优惠已按本次官方整餐试算计入；不预设麦金卡折扣，不自动购卡，也不把优惠券标价重复减价。' };
}
function expireQuote(plan, time) {
  if (plan.status !== 'quoted' || Date.parse(plan.quote?.expiresAt) > time) return false;
  delete plan.quote; delete plan.budgetStatus; delete plan.priceBenefits; plan.status = 'needs_confirmation';
  plan.unresolved = unique(list(plan.unresolved).concat('这份完整配餐的报价已过期，请重新生成或加入餐篮后重新核价。')); return true;
}
function groups(plan, budgetCents) {
  const result = { plans: [], overBudgetPlans: [], ...(budgetCents !== undefined ? { budgetCents, withinBudgetCount: 0, overBudgetCount: 0 } : {}) };
  if (!plan) return result;
  if (budgetCents !== undefined && plan.status === 'quoted') {
    const withinBudget = plan.quote.totalCents <= budgetCents; plan.budgetStatus = { budgetCents, withinBudget, differenceCents: budgetCents - plan.quote.totalCents };
    result[withinBudget ? 'plans' : 'overBudgetPlans'] = [plan]; result[withinBudget ? 'withinBudgetCount' : 'overBudgetCount'] = 1;
  } else result.plans = [plan]; return result;
}
function completionMessage(result) {
  if (!result) return messages.invalid_response;
  if (result.plans[0]?.status === 'needs_confirmation') return '完整配餐已保留，报价已过期，请重新核价。';
  if (result.plans.length) return result.budgetCents !== undefined ? '已为你选出 1 份预算内完整配餐。' : '已为你选出 1 份已核价完整配餐。';
  if (result.overBudgetPlans.length) return '当前预算暂未搭成，已保留 1 份最接近预算的完整配餐。';
  return '暂未取得主食、小食和饮料齐全、且已核价的完整配餐。';
}
function quoteQueue(candidates) {
  const queue = candidates.slice(0, 4);
  const couponCandidates = [], seenOffers = new Set();
  for (const candidate of candidates) {
    const refs = candidate.items.map(item => item.offerRef).filter(Boolean);
    if (!refs.some(ref => !seenOffers.has(ref))) continue;
    couponCandidates.push(candidate); for (const ref of refs) seenOffers.add(ref);
    if (seenOffers.size >= 2) break;
  }
  const reserved = [...couponCandidates, candidates.find(candidate => !candidate.membershipTagged && candidate.items.every(item => !item.offerRef))].filter(Boolean);
  for (const candidate of reserved) if (!queue.includes(candidate)) {
    if (queue.length < MAX_QUOTES) queue.push(candidate);
    else { const index = queue.findLastIndex(value => !reserved.includes(value)); if (index >= 0) queue[index] = candidate; }
  }
  for (const candidate of candidates) if (queue.length < MAX_QUOTES && !queue.includes(candidate)) queue.push(candidate);
  return queue;
}
function makePlan(candidate, inspirations, id) {
  const components = candidate.items.flatMap(item => list(item.components));
  const inspirationSources = inspirations.filter(inspiration => inspiration.codes.some(code => candidate.matchedInspirationCodes.includes(code))).map(inspiration => inspiration.source);
  const coverage = Object.fromEntries(ROLES.map(role => [role, unique(components.filter(component => component.role === role).map(component => `${component.name}${component.quantity > 1 ? ` × ${component.quantity}` : ''}`))]));
  coverage.complete = candidate.coverage.complete === true && ROLES.every(role => coverage[role].length > 0); if (!coverage.complete) return null;
  const items = candidate.items.map(item => ({ productCode: item.productCode, name: item.name, quantity: item.quantity, ...(item.offerRef ? { offerRef: item.offerRef, offerTitle: item.offerTitle } : {}), roundList: clone(item.roundList), specs: clone(item.specs), selectionSnapshot: clone(item.selectionSnapshot), origin: item.origin === 'inspiration' ? 'inspiration' : 'menu' }));
  return { id, title: candidate.title, rationale: candidate.rationale, coverage, items, compositionOrigin: items.length === 1 ? 'official_combo' : 'menu_completed',
    source: inspirationSources[0] || { platform: 'mcd', title: '当前麦当劳门店菜单与官方核价' }, inspirationSources,
    inspirationItems: items.filter(item => item.origin === 'inspiration').map(item => item.name), addedItems: items.filter(item => item.origin === 'menu').map(item => item.name),
    evidence: inspirationSources.length ? ['原帖仅提供餐品灵感；本餐的完整搭配、规格和价格来自当前门店菜单及官方核价，并非复刻原帖点法。'] : ['本次按所选偏好和预算，从当前门店已核验的餐品与规格组成完整一餐。'],
    warnings: unique(list(candidate.warnings).concat(candidate.pricingNote || '', '餐品供应与价格随门店及时间变化；最终请在麦当劳官方渠道确认。')), unresolved: [], status: 'needs_confirmation' };
}

export function createMealPlanService({ providers, now = Date.now, runLimitMs = RUN_LIMIT } = {}) {
  if (!providers || ['menu', 'detail', 'quote'].some(name => typeof providers[name] !== 'function') || !Number.isInteger(runLimitMs) || runLimitMs < 1 || runLimitMs > RUN_LIMIT) throw new TypeError('Meal plan providers and a valid runtime limit are required.');
  const jobs = new Map(), cancellations = new Set(); let active = null, closed = false, pending = 0;
  function prune() {
    for (const [id, job] of jobs) if (job.status !== 'running' && now() - job.finishedAt >= JOB_TTL) jobs.delete(id);
    while (jobs.size >= MAX_JOBS) { const first = [...jobs].find(([, job]) => job.status !== 'running'); if (!first) break; jobs.delete(first[0]); }
  }
  async function execute(job, args) {
    const notices = [], inspirations = [], quoted = [], detailCache = new Map();
    let offers = fallbackOffers(), missingRoles = [], menuRead = false, quoteCount = 0, candidateCount = 0;
    const deadline = Date.now() + runLimitMs;
    const progress = (stage, message, current = 0, total = 0) => { if (!closed) job.progress = { stage, message, current, total }; };
    async function call(method, argument, optionalTimeoutMs) {
      if (closed) fail('service_closed'); const remaining = deadline - Date.now(); if (remaining <= 0) fail('timeout');
      pending++; let timer, cancel;
      const promise = Promise.resolve().then(() => providers[method](argument)).finally(() => { pending--; });
      try { return await Promise.race([promise, new Promise((_, reject) => {
        cancel = () => reject(new MealPlanError('service_closed', messages.service_closed)); cancellations.add(cancel);
        const local = Number.isInteger(optionalTimeoutMs) && optionalTimeoutMs < remaining;
        timer = setTimeout(() => { const code = local ? 'optional_timeout' : 'timeout'; reject(new MealPlanError(code, messages[code])); }, Math.max(1, local ? optionalTimeoutMs : remaining));
      })]); } finally { clearTimeout(timer); cancellations.delete(cancel); }
    }
    try {
      progress('menu', '正在刷新当前门店菜单，准备搭配完整一餐…');
      const menuResponse = await call('menu', { storeCode: args.storeCode }), normalItems = validateMenu(menuResponse, args.storeCode); menuRead = true;
      let offerItems = [];
      if (typeof providers.offers === 'function') {
        progress('offers', '正在查询本门店可用券与会员价格条件…');
        try {
          const response = await call('offers', { storeCode: args.storeCode });
          if (!object(response) || response.storeCode !== args.storeCode || !Array.isArray(response.eligibleItems)) fail('invalid_response');
          offers = publicOffers(response);
          offerItems = response.eligibleItems.filter(item => typeof item?.offerRef === 'string' && item.offerRef && item.offerRef.length <= 80 && codeOf(item) && typeof item.name === 'string').slice(0, 30).map(item => ({ ...item, conditionalPrice: true, requiresCoupon: true }));
        } catch (error) { if (error?.code === 'timeout' || error?.code === 'service_closed') throw error; notices.push(`优惠查询暂未完成：${safeError(error).message} 未预设任何会员折扣。`); }
      }
      const menu = { ...menuResponse, items: [...normalItems, ...offerItems] }; validateMenu(menu, args.storeCode);
      if (typeof providers.search === 'function' && typeof providers.note === 'function') {
        progress('search', '正在读取小红书灵感；完整配餐以本店菜单为准…');
        try {
          const response = await call('search', { keyword: args.keyword }, 20000); if (!Array.isArray(response?.notes)) fail('invalid_response');
          const selected = response.notes.filter(note => /^[a-f0-9]{24}$/iu.test(note?.id) && (!args.noteIds || args.noteIds.includes(note.id))).map((note, index) => ({ note, index, score: noteScore(note, args) })).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, MAX_NOTES);
          if (!selected.length) notices.push(args.noteIds ? '新搜索未找到指定笔记，未使用其他笔记替代；本次按门店菜单搭配。' : '本次没有可读取的小红书灵感，仍根据本店真实菜单搭配完整一餐。');
          for (let index = 0; index < selected.length; index++) {
            const summary = selected[index].note; progress('note', `正在读取第 ${index + 1} / ${selected.length} 篇灵感正文…`, index + 1, selected.length);
            try {
              const note = (await call('note', { id: summary.id }, 8000))?.note;
              if (!object(note) || note.id !== summary.id || typeof note.body !== 'string' || !note.body.trim()) fail('note_unavailable');
              const parsed = parseRecommendation({ note, menu, intent: args.intent, budgetCents: args.budgetCents });
              const codes = unique(list(parsed.drafts).flatMap(draft => list(draft.matches).map(match => codeOf(match)))).filter(code => menu.items.some(item => codeOf(item) === code));
              inspirations.push({ source: sourceOf(note), codes });
              if (parsed.needsConfirmation) notices.push('部分原帖含改配或其他条件，仅借鉴可对应菜单的餐品；未自动复刻特调或原帖优惠。');
            } catch (error) {
              if (error?.code === 'timeout' || error?.code === 'service_closed') throw error;
              notices.push(`“${text(summary.title, 100)}”：${safeError(error).message}`); if (error?.code === 'optional_timeout') break;
            }
          }
        } catch (error) { if (error?.code === 'timeout' || error?.code === 'service_closed') throw error; notices.push(`小红书灵感未完成：${safeError(error).message} 完整配餐仍以本店菜单为准。`); }
      }
      const anchorCodes = unique(inspirations.flatMap(inspiration => inspiration.codes));
      const requested = selectDetailItems({ menu, intent: args.intent, budgetCents: args.budgetCents, inspirations: anchorCodes, limit: 15 });
      for (let index = 0; index < requested.length; index++) {
        const request = requested[index]; progress('detail', `正在核对真实餐品规格 ${index + 1} / ${requested.length}…`, index + 1, requested.length);
        try { detailCache.set(keyOf(request), validDetail(await call('detail', { storeCode: args.storeCode, ...request }), request, args.storeCode)); }
        catch (error) { if (error?.code === 'timeout' || error?.code === 'service_closed') throw error; notices.push(`部分餐品规格未完成核验，未用于搭配：${safeError(error).message}`); }
      }
      progress('compose', '正在搭齐主食、小食和饮料，比较预算与优惠…');
      const composition = composeCandidates({ menu, details: detailCache, intent: args.intent, budgetCents: args.budgetCents, inspirations: anchorCodes, maxCandidates: 8 });
      notices.push(...composition.notices); missingRoles = composition.missingRoles; candidateCount = composition.candidates.length;
      const queue = quoteQueue(composition.candidates);
      for (let index = 0; index < queue.length; index++) {
        const candidate = queue[index], plan = makePlan(candidate, inspirations, `${job.id}-${index + 1}`); if (!plan || !plan.coverage.complete) continue;
        progress('quote', `正在核算整餐价格 ${index + 1} / ${queue.length}，只保留最适合的一餐…`, index + 1, queue.length);
        try {
          const basket = basketOf(plan.items); quoteCount++;
          plan.quote = validateQuote(await call('quote', { storeCode: args.storeCode, items: basket }), args.storeCode, basket, now);
          plan.status = 'quoted'; plan.priceBenefits = priceBenefits(plan.quote); quoted.push({ plan, rank: composition.candidates.indexOf(candidate) });
        } catch (error) { if (error?.code === 'timeout' || error?.code === 'service_closed') throw error; notices.push(`一份候选未取得可核验的官方整餐报价，未用于推荐：${safeError(error).message}`); }
      }
      if (!quoted.length && candidateCount) notices.push('已核对完整搭配，但本次未取得有效官方整餐金额，未展示估价或不完整餐单。');
      job.status = 'complete';
    } catch (error) {
      if (menuRead || quoted.length || error?.code === 'timeout') { job.status = 'complete'; notices.push(safeError(error).message); }
      else { job.status = 'failed'; job.error = safeError(error); }
    } finally {
      if (!closed) {
        const valid = quoted.filter(({ plan }) => !expireQuote(plan, now()));
        valid.sort((a, b) => {
          const aWithin = args.budgetCents === undefined || a.plan.quote.totalCents <= args.budgetCents, bWithin = args.budgetCents === undefined || b.plan.quote.totalCents <= args.budgetCents;
          if (aWithin !== bWithin) return aWithin ? -1 : 1;
          if (!aWithin || args.intent === 'low_budget') return a.plan.quote.totalCents - b.plan.quote.totalCents || a.rank - b.rank;
          return a.rank - b.rank || a.plan.quote.totalCents - b.plan.quote.totalCents;
        });
        const winner = valid[0]?.plan;
        if (job.status === 'complete') job.result = { storeCode: args.storeCode, intent: args.intent, keyword: args.keyword, ...groups(winner, args.budgetCents), missingRoles, offers, comparedCount: valid.length, candidateCount, quoteCount,
          notice: unique(notices).concat('只展示本次已核价候选中最适合的一份完整配餐；小红书仅提供灵感，不用原帖价格代替门店报价，未预设麦金卡资格或自动购卡。').join(' '), queriedAt: new Date(now()).toISOString() };
        job.finishedAt = now(); job.progress = { stage: job.status === 'failed' ? 'failed' : 'complete', message: job.status === 'failed' ? job.error.message : completionMessage(job.result), current: winner ? 1 : 0, total: winner ? 1 : 0 };
      }
      if (active === job.id) active = null;
    }
  }
  return {
    start(raw) {
      if (closed) fail('service_closed'); const args = argumentsOf(raw), signature = JSON.stringify(args); prune();
      if (active) { const job = jobs.get(active); if (job?.signature === signature) return { jobId: job.id }; fail('job_busy'); }
      if (pending) fail('job_busy'); // Timed-out MCP calls may still be unwinding.
      const id = randomBytes(24).toString('hex'), job = { id, signature, status: 'running', progress: { stage: 'queued', message: '已开始搭配完整一餐…', current: 0, total: 0 }, createdAt: now() };
      jobs.set(id, job); active = id; void execute(job, args); return { jobId: id };
    },
    get(id) {
      if (closed || typeof id !== 'string' || !/^[a-f0-9]{48}$/u.test(id)) return null;
      prune(); const job = jobs.get(id); if (!job) return null;
      if (job.result) { const plan = job.result.plans[0] || job.result.overBudgetPlans[0]; if (plan && expireQuote(plan, now())) { Object.assign(job.result, groups(plan, job.result.budgetCents)); job.progress.message = completionMessage(job.result); } }
      const { signature, finishedAt, ...publicJob } = job; return clone(publicJob);
    },
    close() { closed = true; jobs.clear(); active = null; for (const cancel of cancellations) cancel(); cancellations.clear(); },
  };
}
