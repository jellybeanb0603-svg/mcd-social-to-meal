import test from 'node:test';
import assert from 'node:assert/strict';
import { createMealPlanService, MealPlanError } from '../scripts/meal_plan_service.mjs';

const startTime = Date.parse('2026-10-15T02:00:00Z');
const ids = ['111111111111111111111111', '222222222222222222222222', '333333333333333333333333'];
const args = { storeCode: 's1', intent: 'low_budget', keyword: '麦当劳 低预算' };
const item = (productCode, name, displayPriceCents = 1000, extra = {}) => ({ id: productCode, productCode, name, displayPriceCents, tags: [], ...extra });
const catalogue = [item('p1', '吉士汉堡', 1200), item('p2', '中薯条', 800), item('p3', '可乐小杯', 500)];
const choice = (id, name, quantity = 1, extra = {}) => ({ id, name, quantity, isDefault: quantity > 0, maxQuantity: 1, diffPrice: '+ ¥0', ...extra });
const round = (id, choices, extra = {}) => ({ id, name: `选配${id}`, minQuantity: 1, maxQuantity: 1, choices, ...extra });
const comboRounds = () => [round('m', [choice('cm', '吉士汉堡')]), round('s', [choice('cs', '中薯条')]), round('d', [choice('cd', '可乐小杯')])];
function fixture(options = {}) {
  let time = startTime;
  const calls = [], menu = options.menu || catalogue;
  const notes = options.notes || [{ id: ids[0], title: '低预算点餐', author: '作者', body: '推荐点吉士汉堡1份，配中薯条1份。' }];
  const offerItems = options.offerItems || [];
  const providers = {
    async menu(value) { calls.push(['menu', structuredClone(value)]); return { storeCode: value.storeCode, items: menu, categories: [] }; },
    async search(value) { calls.push(['search', structuredClone(value)]); return { notes: notes.map(({ body, ...note }) => note) }; },
    async note(value) { calls.push(['note', structuredClone(value)]); return { note: notes.find(note => note.id === value.id) }; },
    async detail(value) {
      calls.push(['detail', structuredClone(value)]);
      const product = (value.offerRef ? offerItems : menu).find(item => item.productCode === value.productCode && (item.offerRef || '') === (value.offerRef || ''));
      return { storeCode: value.storeCode, item: { ...product, supportModify: false, rounds: options.details?.[value.offerRef ? `${value.productCode}:${value.offerRef}` : value.productCode] || [] } };
    },
    async quote(value) {
      calls.push(['quote', structuredClone(value)]);
      const totalCents = value.items.reduce((total, product) => total + (options.prices?.[product.offerRef ? `${product.productCode}:${product.offerRef}` : product.productCode] ?? ({ p1: 1200, p2: 800, p3: 500 }[product.productCode] ?? 1000)) * product.quantity, 0);
      return { source: '麦当劳官方 MCP', mode: 'live', storeCode: value.storeCode, currency: 'CNY', totalCents, originalCents: totalCents + (options.discountCents || 0), discountCents: options.discountCents || 0,
        queriedAt: new Date(time).toISOString(), expiresAt: new Date(time + 300000).toISOString(),
        appliedOffers: value.items.filter(product => product.offerRef).map(product => ({ offerRef: product.offerRef, productCode: product.productCode, title: offerItems.find(item => item.offerRef === product.offerRef)?.offerTitle || '测试可用券' })),
        items: value.items.map(product => ({ productCode: product.productCode, quantity: product.quantity, name: [...menu, ...offerItems].find(item => item.productCode === product.productCode)?.name || product.productCode, subtotalCents: 1000 })), selections: structuredClone(value.items) };
    },
  };
  if (options.offers || offerItems.length) providers.offers = async value => {
    calls.push(['offers', structuredClone(value)]);
    return { storeCode: value.storeCode, membership: { status: 'unverified' }, coupons: offerItems.map(product => ({ title: product.offerTitle, validTime: '测试有效期', eligible: true })), eligibleItems: offerItems, ...options.offers };
  };
  Object.assign(providers, options.providers);
  return { providers, calls, now: () => time, advance: value => { time += value; } };
}
async function finish(service, id) {
  for (let index = 0; index < 250; index++) {
    const job = service.get(id); if (job?.status !== 'running') return job;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('Job did not finish');
}
async function run(fix, overrides = {}) {
  const service = createMealPlanService(fix), { jobId } = service.start({ ...args, ...overrides });
  return { service, jobId, job: await finish(service, jobId) };
}
const allPlans = job => [...job.result.plans, ...job.result.overBudgetPlans];

test('a note mentioning fries becomes one complete live-store meal with traceable system additions', async () => {
  const fix = fixture({ notes: [{ id: ids[0], title: '薯条点法', body: '推荐点中薯条1份。' }] });
  const { service, job } = await run(fix, { intent: 'fries', keyword: '麦当劳 薯条', budgetCents: 3000 });
  try {
    assert.equal(job.status, 'complete'); assert.equal(job.result.plans.length, 1); assert.deepEqual(job.result.overBudgetPlans, []);
    const plan = job.result.plans[0];
    assert.equal(plan.coverage.complete, true); for (const role of ['main', 'side', 'drink']) assert.equal(plan.coverage[role].length, 1);
    assert.equal(plan.quote.totalCents, 2500); assert.equal(plan.quote.channel, '到店自取');
    assert.equal(plan.items.length, 3); assert.equal(plan.items.find(item => item.productCode === 'p2').origin, 'inspiration');
    assert.deepEqual(plan.addedItems.sort(), ['可乐小杯', '吉士汉堡'].sort());
    assert.equal(plan.source.id, ids[0]); assert.equal(plan.inspirationSources.length, 1);
    assert.equal(plan.budgetStatus.withinBudget, true); assert.equal(plan.compositionOrigin, 'menu_completed');
    assert.equal('estimatedCents' in plan, false); assert.equal(JSON.stringify(job).includes('estimateOnly'), false);
    assert.equal(fix.calls[0][0], 'menu'); assert.equal(fix.calls.filter(([name]) => name === 'quote').length, 1);
  } finally { service.close(); }
});

test('empty social search still composes a complete current-menu meal without claiming a note source', async () => {
  const fix = fixture({ notes: [] }), { service, job } = await run(fix);
  try { assert.equal(job.result.plans.length, 1); assert.equal(job.result.plans[0].source.platform, 'mcd'); assert.deepEqual(job.result.plans[0].inspirationSources, []); assert.match(job.result.notice, /没有可读取/); }
  finally { service.close(); }
});

test('failed or absent social providers do not block real-menu composition or expose secret errors', async t => {
  for (const variant of ['search', 'note', 'absent']) await t.test(variant, async () => {
    const fix = fixture();
    if (variant === 'absent') { delete fix.providers.search; delete fix.providers.note; }
    else fix.providers[variant] = async () => { throw new Error('PRIVATE-TOKEN-DO-NOT-EXPOSE'); };
    const { service, job } = await run(fix);
    try { assert.equal(job.status, 'complete'); assert.equal(job.result.plans.length, 1); assert.equal(JSON.stringify(job).includes('PRIVATE-TOKEN'), false); }
    finally { service.close(); }
  });
});

test('at most two actionable notes are read and a note outside a selected search is never substituted', async () => {
  const notes = [
    { id: ids[0], title: '薯条照片', body: '中薯条。' }, { id: ids[1], title: '薯条搭配攻略', body: '推荐点中薯条。' }, { id: ids[2], title: '麦门基础点法教程', body: '推荐点吉士汉堡。' },
  ];
  const fix = fixture({ notes }), { service, job } = await run(fix, { intent: 'fries', keyword: '麦当劳 薯条' });
  try { assert.equal(fix.calls.filter(([name]) => name === 'note').length, 2); assert.equal(job.result.plans.length, 1); assert.equal(fix.calls.filter(([name]) => name === 'search').length, 1); }
  finally { service.close(); }
  const fresh = fixture({ notes: [notes[0]] }), second = await run(fresh, { noteIds: [ids[2]] });
  try { assert.equal(fresh.calls.some(([name]) => name === 'note'), false); assert.match(second.job.result.notice, /未使用其他笔记替代/); assert.equal(second.job.result.plans[0].source.platform, 'mcd'); }
  finally { second.service.close(); }
});

test('missing current-store roles return an empty result rather than a partial fries plan', async () => {
  const fix = fixture({ menu: [catalogue[1]] }), { service, job } = await run(fix, { intent: 'fries' });
  try { assert.deepEqual(job.result.plans, []); assert.deepEqual(job.result.overBudgetPlans, []); assert.deepEqual(job.result.missingRoles, ['main', 'drink']); assert.equal(fix.calls.some(([name]) => name === 'quote'), false); }
  finally { service.close(); }
});

test('the final result is one meal only and actual official totals decide budget fit', async () => {
  const cheap = item('p4', '麦香鸡', 4000), menu = [...catalogue, cheap];
  const fix = fixture({ menu, prices: { p4: 1000 }, notes: [] }), { service, job } = await run(fix, { budgetCents: 2400 });
  try {
    assert.equal(job.result.plans.length, 1); assert.deepEqual(job.result.overBudgetPlans, []);
    assert.equal(job.result.plans[0].quote.totalCents, 2300); assert.ok(job.result.plans[0].items.some(item => item.productCode === 'p4'));
    assert.equal(job.result.withinBudgetCount, 1); assert.equal(job.result.overBudgetCount, 0); assert.equal(job.result.comparedCount, 2);
  } finally { service.close(); }
});

test('insufficient and zero budgets preserve one complete over-budget fallback only', async t => {
  for (const budgetCents of [0, 2400]) await t.test(String(budgetCents), async () => {
    const fix = fixture(), { service, job } = await run(fix, { budgetCents });
    try { assert.deepEqual(job.result.plans, []); assert.equal(job.result.overBudgetPlans.length, 1); assert.equal(job.result.overBudgetPlans[0].items.length, 3); assert.equal(job.result.overBudgetPlans[0].budgetStatus.withinBudget, false); assert.equal(job.result.overBudgetCount, 1); }
    finally { service.close(); }
  });
});

test('without a budget there is one recommendation and no budget claim', async () => {
  const fix = fixture({ menu: [...catalogue, item('p4', '麦香鸡', 1000)] }), { service, job } = await run(fix);
  try { assert.equal(job.result.plans.length, 1); assert.deepEqual(job.result.overBudgetPlans, []); assert.equal(job.result.plans[0].budgetStatus, undefined); assert.equal(job.result.budgetCents, undefined); }
  finally { service.close(); }
});

test('a verified complete combo is one paid SKU with actual selected contents and sizes', async () => {
  const combo = item('combo', '吉士汉堡三件套', 1800), fix = fixture({ menu: [combo], details: { combo: comboRounds() }, notes: [] });
  const { service, job } = await run(fix);
  try { const plan = job.result.plans[0]; assert.equal(plan.items.length, 1); assert.equal(plan.items[0].productCode, 'combo'); assert.equal(plan.compositionOrigin, 'official_combo'); assert.deepEqual(plan.coverage.drink, ['可乐小杯']); assert.deepEqual(fix.calls.find(([name]) => name === 'quote')[1].items[0].roundList[2].comboItemList, [{ code: 'cd', quantity: 1 }]); }
  finally { service.close(); }
});

test('breakfast cannot silently turn into a lunch meal and low-calorie wording remains qualified', async () => {
  const fix = fixture(), first = await run(fix, { intent: 'breakfast' });
  try { assert.deepEqual(first.job.result.plans, []); assert.equal(fix.calls.some(([name]) => name === 'quote'), false); }
  finally { first.service.close(); }
  const light = fixture(), second = await run(light, { intent: 'low_calorie' });
  try { assert.match(second.job.result.plans[0].warnings.join(' '), /不代表已验证低卡/); }
  finally { second.service.close(); }
});

test('unsupported note modifications are not silently executed or presented as a reproduction', async () => {
  const fix = fixture({ notes: [{ id: ids[0], title: '低预算点法', body: '推荐吉士汉堡1份，去酱，少冰。' }] }), { service, job } = await run(fix);
  try { assert.equal(job.result.plans.length, 1); assert.match(job.result.notice, /未自动复刻/); assert.equal(JSON.stringify(fix.calls.filter(([name]) => name === 'quote')).includes('modification'), false); }
  finally { service.close(); }
});

test('gold labels and conditional display prices do not imply eligibility or an applied discount', async () => {
  const gold = item('gold', '吉士汉堡四件套', 100, { tags: ['麦金卡'], conditionalPrice: true, originalPriceCents: 5700 });
  const fix = fixture({ menu: [...catalogue, gold], details: { gold: comboRounds() }, prices: { gold: 5700 }, offers: { membership: { status: 'verified', couponId: 'PRIVATE-CREDENTIAL' } } });
  const { service, job } = await run(fix, { budgetCents: 3000 });
  try { const plan = job.result.plans[0]; assert.equal(plan.quote.totalCents, 2500); assert.equal(plan.priceBenefits.discountCents, 0); assert.equal(plan.quote.discountEvidence.membershipAttributionVerified, false); assert.equal(job.result.offers.membership.status, 'unverified'); assert.equal(JSON.stringify(job).includes('PRIVATE-CREDENTIAL'), false); assert.ok(fix.calls.filter(([name]) => name === 'quote').every(([, request]) => !('withOrder' in request))); }
  finally { service.close(); }
});

test('an actual coupon small-food set is completed, quoted with its opaque ref and can win on price', async () => {
  const offer = item('snack', '王牌小食拼', null, { offerRef: 'offer-1', offerTitle: '本店王牌小食券', conditionalPrice: true });
  const fix = fixture({ offerItems: [offer], details: { 'snack:offer-1': [round('s', [choice('fries', '中薯条')]), round('d', [choice('cola', '可乐中杯')])] }, prices: { 'snack:offer-1': 900 }, discountCents: 600 });
  const { service, job } = await run(fix, { budgetCents: 2200 });
  try {
    const plan = job.result.plans[0]; assert.equal(plan.quote.totalCents, 2100); assert.equal(plan.items.length, 2); assert.equal(plan.items[0].offerRef, 'offer-1');
    assert.equal(plan.quote.appliedOffers[0].title, '本店王牌小食券'); assert.equal(plan.priceBenefits.discountCents, 600); assert.equal(plan.quote.discountEvidence.attribution, 'unspecified');
    assert.ok(fix.calls.some(([name, request]) => name === 'detail' && request.productCode === 'snack' && request.offerRef === 'offer-1'));
    assert.equal(fix.calls.filter(([name]) => name === 'quote').length, 2);
  } finally { service.close(); }
});

test('the six-quote budget reserves real coupon comparisons beyond cheap menu estimates', async () => {
  const mains = Array.from({ length: 6 }, (_, index) => item(`main${index}`, `鸡腿堡${index}`, 1000 + index));
  const offer = item('offer-side', '中薯条买一送一', null, { offerRef: 'ref', offerTitle: '中薯买一送一' });
  const fix = fixture({ menu: [...mains, catalogue[1], catalogue[2]], offerItems: [offer], prices: { 'offer-side:ref': 1 }, notes: [] });
  const { service, job } = await run(fix, { budgetCents: 5000 });
  try { const calls = fix.calls.filter(([name]) => name === 'quote'); assert.ok(calls.length <= 6); assert.ok(calls.some(([, request]) => request.items.some(item => item.offerRef === 'ref'))); assert.ok(calls.some(([, request]) => request.items.every(item => !item.offerRef))); assert.equal(job.result.plans.length, 1); }
  finally { service.close(); }
});

test('both distinct coupon refs are quoted even when the first coupon has many main-course variants', async () => {
  const mains = Array.from({ length: 6 }, (_, index) => item(`main${index}`, `鸡腿堡${index}`, 1000 + index));
  const offers = [item('fries-offer', '中薯条买一送一', null, { offerRef: 'fries-ref', offerTitle: '中薯买一送一' }), item('snack-offer', '王牌小食拼', null, { offerRef: 'snack-ref', offerTitle: '小食饮料券' })];
  const fix = fixture({ menu: [...mains, catalogue[1], catalogue[2]], offerItems: offers, notes: [], prices: { 'fries-offer:fries-ref': 1200, 'snack-offer:snack-ref': 800 }, details: {
    'fries-offer:fries-ref': [round('two', [choice('fries', '中薯条', 2, { maxQuantity: 2 })], { minQuantity: 2, maxQuantity: 2 })],
    'snack-offer:snack-ref': [round('side', [choice('small', '中薯条')]), round('drink', [choice('medium', '可乐中杯')])],
  } });
  const { service, job } = await run(fix, { budgetCents: 2000, intent: 'fries' });
  try {
    const quoteCalls = fix.calls.filter(([name]) => name === 'quote');
    assert.ok(quoteCalls.length <= 6);
    assert.deepEqual(new Set(quoteCalls.flatMap(([, request]) => request.items.map(item => item.offerRef).filter(Boolean))), new Set(['fries-ref', 'snack-ref']));
    assert.ok(quoteCalls.some(([, request]) => request.items.every(item => !item.offerRef)));
    assert.equal(job.result.plans.length, 1); assert.deepEqual(job.result.overBudgetPlans, []);
    assert.equal(job.result.plans[0].quote.totalCents, 1800);
    assert.equal(job.result.plans[0].quote.appliedOffers[0].offerRef, 'snack-ref');
  } finally { service.close(); }
});

test('optional offer-query failure falls back to ordinary real-menu prices', async () => {
  const fix = fixture({ providers: { async offers() { throw new Error('SECRET-OFFER'); } } }), { service, job } = await run(fix);
  try { assert.equal(job.result.plans.length, 1); assert.equal(job.result.offers.membership.status, 'unverified'); assert.match(job.result.notice, /优惠查询暂未完成/); assert.equal(JSON.stringify(job).includes('SECRET-OFFER'), false); }
  finally { service.close(); }
});

test('stale, fractional, wrong-store, wrong-basket and unzoned quotes are never displayed', async t => {
  for (const [name, mutate] of [
    ['stale', value => ({ ...value, queriedAt: new Date(startTime - 301000).toISOString() })],
    ['fractional', value => ({ ...value, totalCents: 1.1 })], ['wrong-store', value => ({ ...value, storeCode: 's2' })],
    ['wrong-items', value => ({ ...value, items: [{ productCode: 'p1', quantity: 1 }] })],
    ['wrong-selection', value => ({ ...value, selections: value.selections.map(item => ({ ...item, quantity: 2 })) })],
    ['missing-zone', value => ({ ...value, queriedAt: '2026-10-15T02:00:00' })],
    ['future', value => ({ ...value, queriedAt: new Date(startTime + 31000).toISOString() })],
    ['extra-offer', value => ({ ...value, appliedOffers: [{ productCode: 'p1', offerRef: 'unrequested', title: 'Unrequested' }] })],
    ['false-discount-evidence', value => ({ ...value, discountEvidence: { confirmedCents: 9999 } })],
  ]) await t.test(name, async () => {
    const fix = fixture(), original = fix.providers.quote; fix.providers.quote = async request => mutate(await original(request));
    const { service, job } = await run(fix);
    try { assert.deepEqual(allPlans(job), []); assert.match(job.result.notice, /未取得可核验/); assert.equal(JSON.stringify(job).includes('totalCents'), false); }
    finally { service.close(); }
  });
});

test('coupon selection refs and applied-offer receipts must exactly bind the requested basket', async t => {
  for (const variant of ['missing-selection-ref', 'wrong-selection-ref', 'missing-receipt', 'wrong-receipt']) await t.test(variant, async () => {
    const offer = item('snack', '王牌小食拼', null, { offerRef: 'r', offerTitle: '券' });
    const fix = fixture({ menu: [catalogue[0]], offerItems: [offer], details: { 'snack:r': [round('s', [choice('s', '中薯条')]), round('d', [choice('d', '可乐小杯')])] } });
    const original = fix.providers.quote;
    fix.providers.quote = async request => { const value = await original(request); if (variant.includes('selection')) value.selections = value.selections.map(item => item.offerRef ? { ...item, offerRef: variant.startsWith('missing') ? undefined : 'wrong' } : item); else value.appliedOffers = variant.startsWith('missing') ? [] : [{ productCode: 'snack', offerRef: 'wrong', title: '券' }]; return value; };
    const { service, job } = await run(fix);
    try { assert.deepEqual(allPlans(job), []); }
    finally { service.close(); }
  });
});

test('later polls clear expired quote, confirmed benefits and budget eligibility together', async t => {
  for (const budgetCents of [0, 5000]) await t.test(String(budgetCents), async () => {
    const fix = fixture(), { service, jobId, job } = await run(fix, { budgetCents });
    try {
      assert.equal(allPlans(job).length, 1); fix.advance(300001); const aged = service.get(jobId), plan = aged.result.plans[0];
      assert.equal(aged.result.withinBudgetCount, 0); assert.equal(aged.result.overBudgetCount, 0); assert.deepEqual(aged.result.overBudgetPlans, []);
      assert.equal(plan.status, 'needs_confirmation'); assert.equal(plan.quote, undefined); assert.equal(plan.priceBenefits, undefined); assert.equal(plan.budgetStatus, undefined); assert.match(plan.unresolved.join(' '), /过期/);
    } finally { service.close(); }
  });
});

test('earlier provider expiry is preserved instead of promising a fresh five minutes', async () => {
  const fix = fixture(), original = fix.providers.quote;
  fix.providers.quote = async request => ({ ...await original(request), expiresAt: new Date(startTime + 5000).toISOString() });
  const { service, jobId, job } = await run(fix);
  try { assert.equal(job.result.plans[0].quote.expiresAt, new Date(startTime + 5000).toISOString()); fix.advance(5001); assert.equal(service.get(jobId).result.plans[0].quote, undefined); }
  finally { service.close(); }
});

test('quotes that age during later comparisons are removed before picking a winner', async () => {
  const fix = fixture({ menu: [...catalogue, item('p4', '麦香鸡', 1100)], notes: [] });
  const original = fix.providers.quote; let count = 0;
  fix.providers.quote = async request => { if (++count === 2) fix.advance(301000); return original(request); };
  const { service, job } = await run(fix);
  try { assert.equal(job.result.comparedCount, 1); assert.equal(job.result.plans.length, 1); assert.equal(job.result.plans[0].quote.queriedAt, new Date(startTime + 301000).toISOString()); }
  finally { service.close(); }
});

test('running jobs coalesce identical inputs, isolate changed inputs and return immutable snapshots', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const fix = fixture(), original = fix.providers.search; fix.providers.search = async request => { await gate; return original(request); };
  const service = createMealPlanService(fix);
  try {
    const first = service.start(args); assert.match(first.jobId, /^[a-f0-9]{48}$/u); assert.equal(service.start({ ...args }).jobId, first.jobId);
    assert.throws(() => service.start({ ...args, storeCode: 's2' }), error => error instanceof MealPlanError && error.code === 'job_busy');
    const snapshot = service.get(first.jobId); snapshot.progress.message = 'mutated'; assert.notEqual(service.get(first.jobId).progress.message, 'mutated'); assert.equal(service.get('bad'), null);
    release(); const job = await finish(service, first.jobId); job.result.plans[0].items[0].quantity = 99;
    assert.equal(service.get(first.jobId).result.plans[0].items[0].quantity, 1); assert.equal('signature' in service.get(first.jobId), false);
    const second = service.start({ ...args, storeCode: 's2' }); const secondJob = await finish(service, second.jobId);
    assert.notEqual(second.jobId, first.jobId); assert.equal(secondJob.result.storeCode, 's2'); assert.equal(service.get(first.jobId).result.storeCode, 's1');
  } finally { release(); service.close(); }
});

test('a deadline preserves an already quoted complete meal and blocks new work until an old call unwinds', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const fix = fixture({ menu: [...catalogue, item('p4', '麦香鸡', 1100)], notes: [] }), original = fix.providers.quote; let count = 0;
  fix.providers.quote = async request => { if (++count === 2) await gate; return original(request); };
  const service = createMealPlanService({ ...fix, runLimitMs: 30 });
  try {
    const { jobId } = service.start(args), job = await finish(service, jobId);
    assert.equal(job.status, 'complete'); assert.equal(job.result.plans.length, 1); assert.equal(job.result.plans[0].coverage.complete, true); assert.match(job.result.notice, /时间限制/);
    assert.throws(() => service.start(args), error => error.code === 'job_busy'); release(); await new Promise(resolve => setTimeout(resolve, 5));
    const next = service.start(args); assert.ok(next.jobId); await finish(service, next.jobId);
  } finally { release(); service.close(); }
});

test('menu failure remains fatal and safe, while closing cancels a waiting job', async () => {
  const fix = fixture({ providers: { async menu() { throw new Error('PRIVATE-MENU-TOKEN'); } } }), first = await run(fix);
  try { assert.equal(first.job.status, 'failed'); assert.equal(first.job.result, undefined); assert.equal(JSON.stringify(first.job).includes('PRIVATE-MENU'), false); }
  finally { first.service.close(); }
  let release; const gate = new Promise(resolve => { release = resolve; }); const waiting = fixture({ providers: { async menu() { await gate; return { storeCode: 's1', items: catalogue }; } } });
  const service = createMealPlanService(waiting), { jobId } = service.start(args); service.close(); release(); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(service.get(jobId), null); assert.throws(() => service.start(args), error => error.code === 'service_closed');
});

test('invalid jobs, input keys and expired jobs cannot be reused', async () => {
  const fix = fixture(), { service, jobId } = await run(fix);
  try {
    fix.advance(900001); assert.equal(service.get(jobId), null);
    for (const bad of [{ budgetCents: -1 }, { budgetCents: 1.1 }, { budgetCents: 1000000 }, { intent: 'unknown' }, { noteIds: ['bad'] }, { keyword: 'bad\nquery' }, { sourceBody: 'do not trust' }]) assert.throws(() => service.start({ ...args, ...bad }), error => error.code === 'invalid_input');
    assert.throws(() => createMealPlanService({ ...fix, runLimitMs: 0 }), TypeError);
  } finally { service.close(); }
});
