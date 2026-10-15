import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMenu, selectDetailCodes, selectDetailItems, composeCandidates } from '../scripts/meal_composer.mjs';

const product = (productCode, name, displayPriceCents = 1000, extra = {}) => ({ id: productCode, productCode, name, displayPriceCents, tags: [], ...extra });
const detail = (item, rounds = [], extra = {}) => ({ id: item.productCode, productCode: item.productCode, name: item.name, rounds, supportModify: false, ...extra });
const choice = (id, name, quantity = 1, extra = {}) => ({ id, name, quantity, isDefault: quantity > 0, maxQuantity: 1, diffPrice: '+ ¥0', ...extra });
const round = (id, choices, extra = {}) => ({ id, name: `选配${id}`, minQuantity: 1, maxQuantity: 1, choices, ...extra });
const main = product('main', '板烧鸡腿堡', 1600), side = product('side', '中薯条', 800), drink = product('drink', '可乐小杯', 500);
const apple = product('apple', '苹果片', 600), water = product('water', '纯悦', 400);
const combo = product('combo', '板烧鸡腿堡三件套', 2200, { tags: ['套餐'] });
const comboDetail = detail(combo, [round('1', [choice('m1', '板烧鸡腿堡')]), round('2', [choice('s1', '中薯条')]), round('3', [choice('d1', '可乐小杯')])]);
const base = [main, side, drink];
const detailsFor = menu => new Map(menu.map(item => [item.productCode, detail(item)]));
const run = (menu, details, extra = {}) => composeCandidates({ menu, details, ...extra });

test('classifies concrete food roles and excludes sauces, toys, dessert mains and sharing sets', () => {
  const menu = [...base, product('sauce', '日式鲜磨山葵风味酱'), product('toy', '玩具汉堡'), product('ice', '圆筒冰淇淋'), product('share', '全明星双人分享餐八件套'), product('chicken', '蘸酱脆皮鸡柳')];
  const result = classifyMenu(menu);
  assert.deepEqual(result.mains.map(item => item.productCode), ['main']);
  assert.deepEqual(result.drinks.map(item => item.productCode), ['drink']);
  assert.ok(result.sides.some(item => item.productCode === 'chicken'));
  assert.deepEqual(result.desserts.map(item => item.productCode), ['ice']);
  assert.ok(result.excluded.some(item => item.productCode === 'share'));
});

test('three verified single products form one complete meal with no invented SKU or price', () => {
  const { candidates } = run(base, detailsFor(base));
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].coverage, { main: 1, side: 1, drink: 1, complete: true });
  assert.deepEqual(new Set(candidates[0].items.map(item => item.productCode)), new Set(['main', 'side', 'drink']));
  assert.equal(candidates[0].estimatedCents, 2900);
  assert.equal(candidates[0].estimateOnly, true);
  assert.equal(candidates[0].quote, undefined);
});

test('a single portion of fries is never returned as a complete meal', () => {
  const result = run([side], detailsFor([side]), { intent: 'fries' });
  assert.equal(result.candidates.length, 0);
  assert.deepEqual(result.missingRoles, ['main', 'drink']);
});

test('a verified three-role combo remains one paid item; children are not purchased again', () => {
  const result = run([combo, ...base], new Map([...detailsFor(base), ['combo', comboDetail]]));
  const candidate = result.candidates.find(value => value.items.length === 1);
  assert.ok(candidate);
  assert.equal(candidate.items[0].productCode, 'combo');
  assert.equal(candidate.items[0].roundList.length, 3);
  assert.deepEqual(candidate.items[0].components.map(component => component.code), ['m1', 's1', 'd1']);
  assert.ok(candidate.items[0].components.every(component => component.included));
  assert.equal(candidate.estimatedCents, 2200);
});

test('a combo title alone does not establish its contents', () => {
  const result = run([combo], new Map([['combo', detail(combo)]]));
  assert.equal(result.candidates.length, 0);
  assert.deepEqual(result.missingRoles, ['main', 'side', 'drink']);
});

test('an actual two-role combo is completed with only the missing role', () => {
  const two = product('two', '板烧鸡腿堡两件套', 1800);
  const menu = [two, ...base];
  const result = run(menu, new Map([...detailsFor(base), ['two', detail(two, comboDetail.rounds.filter(value => value.id !== '2'))]]));
  const candidate = result.candidates.find(value => value.items.some(item => item.productCode === 'two'));
  assert.ok(candidate);
  assert.deepEqual(candidate.items.map(item => item.productCode), ['two', 'side']);
});

test('a sold-out or unavailable product is not a candidate or detail request', () => {
  for (const extra of [{ soldOut: true }, { available: false }, { tags: ['已售完'] }]) {
    const absent = { ...main, ...extra }, menu = [absent, side, drink];
    assert.equal(run(menu, detailsFor(menu)).candidates.length, 0);
    assert.ok(!selectDetailCodes({ menu }).includes('main'));
  }
});

test('a mismatching detail product or missing detail cannot be quoted', () => {
  assert.equal(run(base, new Map([['main', detail({ ...main, productCode: 'wrong' })], ['side', detail(side)], ['drink', detail(drink)]])).candidates.length, 0);
  assert.equal(run(base, new Map()).candidates.length, 0);
});

test('budget shortage preserves all roles rather than deleting a course', () => {
  const result = run(base, detailsFor(base), { intent: 'low_budget', budgetCents: 100 });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].estimatedOverBudget, true);
  assert.equal(result.candidates[0].items.length, 3);
  assert.ok(result.notices.some(message => message.includes('未通过删除')));
});

test('low budget ranks complete menu estimates cheaply but does not assert official affordability', () => {
  const expensive = product('expensive', '巨无霸', 3200), menu = [...base, expensive];
  const result = run(menu, detailsFor(menu), { intent: 'low_budget', budgetCents: 3000 });
  assert.equal(result.candidates[0].items.find(item => item.roles.includes('main')).productCode, 'main');
  assert.equal(result.candidates[0].estimatedOverBudget, false);
  assert.equal(result.candidates[0].budgetStatus, undefined);
});

test('fries preference requires actual fries, not another potato or unrelated small food', () => {
  const hash = product('hash', '薯饼', 300), menu = [main, hash, apple, drink];
  assert.equal(run(menu, detailsFor(menu), { intent: 'fries' }).candidates.length, 0);
  const full = [...menu, side];
  assert.ok(run(full, detailsFor(full), { intent: 'fries' }).candidates.every(candidate => candidate.items.some(item => item.components.some(component => /薯条/u.test(component.name)))));
});

test('fries preference can switch a real combo side choice and retains the actual size', () => {
  const d = detail(combo, [comboDetail.rounds[0], round('2', [choice('apple-small', '苹果片'), choice('fries-small', '小薯条', 0), choice('fries-big', '大薯条', 0, { diffPrice: '+ ¥2' })]), comboDetail.rounds[2]]);
  const result = run([combo], new Map([['combo', d]]), { intent: 'fries' });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].items[0].roundList[1].comboItemList[0].code, 'fries-small');
  assert.ok(result.candidates[0].items[0].specs.some(value => value.includes('小薯条')));
});

test('breakfast requires a current breakfast main and never silently substitutes a lunch burger', () => {
  assert.equal(run(base, detailsFor(base), { intent: 'breakfast' }).candidates.length, 0);
  const breakfast = product('breakfast', '吉士蛋麦满分', 1200), menu = [...base, breakfast];
  const result = run(menu, detailsFor(menu), { intent: 'breakfast' });
  assert.ok(result.candidates.length);
  assert.ok(result.candidates.every(candidate => candidate.items.some(item => item.productCode === 'breakfast')));
});

test('low calorie selects a supported no-sugar drink without making a calorie claim', () => {
  const d = detail(combo, [comboDetail.rounds[0], round('2', [choice('fries', '中薯条'), choice('corn', '玉米杯', 0)]), round('3', [choice('cola', '可乐中杯'), choice('zero', '无糖可口可乐中杯', 0)])]);
  const result = run([combo], new Map([['combo', d]]), { intent: 'low_calorie' });
  assert.equal(result.candidates[0].items[0].roundList[1].comboItemList[0].code, 'corn');
  assert.equal(result.candidates[0].items[0].roundList[2].comboItemList[0].code, 'zero');
  assert.ok(result.candidates[0].warnings.some(message => message.includes('不代表已验证低卡')));
});

test('a zero-quantity option never becomes the default merely because isDefault is true', () => {
  const d = detail(drink, [round('drink-size', [choice('small', '可乐小杯', 1), choice('large', '可乐大杯', 0, { isDefault: true, diffPrice: '+ ¥2' })])]);
  const result = run(base, new Map([...detailsFor(base), ['drink', d]]));
  assert.ok(result.candidates.every(candidate => candidate.items.find(item => item.productCode === 'drink').roundList[0].comboItemList[0].code === 'small'));
});

test('invalid quantity bounds and incomplete multi-select defaults block automatic composition', () => {
  for (const broken of [round('x', [choice('m', '板烧鸡腿堡')], { minQuantity: 2, maxQuantity: 2 }), round('x', [choice('m', '板烧鸡腿堡')], { minQuantity: 1, maxQuantity: 0 }), round('x', [choice('m', '板烧鸡腿堡', 1, { maxQuantity: -1 })])]) {
    const result = run([combo, side, drink], new Map([['combo', detail(combo, [broken])], ['side', detail(side)], ['drink', detail(drink)]]));
    assert.equal(result.candidates.length, 0);
  }
});

test('two mains or two drinks in a default set are not treated as a single-person meal', () => {
  const d = detail(combo, [round('mains', [choice('m', '板烧鸡腿堡', 2, { maxQuantity: 2 })], { minQuantity: 2, maxQuantity: 2 }), ...comboDetail.rounds.slice(1)]);
  assert.equal(run([combo], new Map([['combo', d]])).candidates.length, 0);
});

test('literal inspiration anchors are traceable and system additions are identified', () => {
  const result = run(base, detailsFor(base), { inspirations: [{ matches: [{ productCode: 'side' }, { productCode: 'absent' }] }] });
  assert.deepEqual(result.candidates[0].matchedInspirationCodes, ['side']);
  assert.equal(result.candidates[0].items.find(item => item.productCode === 'side').origin, 'inspiration');
  assert.ok(result.candidates[0].items.filter(item => item.productCode !== 'side').every(item => item.origin === 'system'));
  assert.ok(result.notices.some(message => message.includes('不在当前门店菜单')));
});

test('gold card tags do not imply eligibility, applied discounts or a percentage reduction', () => {
  const gold = { ...combo, tags: ['麦金卡'], displayPriceCents: 2800, originalPriceCents: 5700, conditionalPrice: true };
  const result = run([gold], new Map([['combo', comboDetail]]));
  assert.equal(result.candidates[0].estimatedCents, 5700);
  assert.equal(result.candidates[0].membershipTagged, true);
  assert.match(result.candidates[0].pricingNote, /不代表当前账户已享优惠/u);
  assert.equal(result.candidates[0].discountCents, undefined);
});

test('a conditional display price without a reference original is unknown rather than a cheap user price', () => {
  const gold = { ...combo, tags: ['麦金卡'], displayPriceCents: 100, conditionalPrice: true };
  assert.equal(run([gold], new Map([['combo', comboDetail]])).candidates[0].estimatedCents, null);
});

test('gold card conditions are recognized without a marketing tag and coupons are not mislabeled as gold', () => {
  for (const extra of [{ discountType: '随单购麦金卡优惠' }, { priceCondition: '需要麦金卡权益生效，最终以核价为准' }]) {
    const gold = { ...combo, tags: [], conditionalPrice: true, originalPriceCents: 5700, ...extra };
    const result = run([gold], new Map([['combo', comboDetail]]));
    assert.equal(result.candidates[0].membershipTagged, true);
    assert.match(result.candidates[0].pricingNote, /不代表当前账户已享优惠/u);
    assert.equal(result.candidates[0].estimatedCents, 5700);
  }
  const coupon = { ...combo, offerRef: 'local-coupon', requiresCoupon: true, conditionalPrice: true, tags: [], discountType: '优惠券待核价', priceCondition: '需使用当前账号优惠券' };
  const result = run([coupon], new Map([['combo:local-coupon', detail(coupon, comboDetail.rounds)]]));
  assert.equal(result.candidates[0].membershipTagged, false);
});

test('detail selection reserves each role, ordinary sets and actual account offers within a bounded batch', () => {
  const offer = product('coupon-side', '中薯条买一送一', null, { offerRef: 'opaque-local-reference', offerTitle: '中薯条买一送一', requiresCoupon: true });
  const golds = Array.from({ length: 8 }, (_, index) => product(`gold${index}`, `鸡腿堡四件套${index}`, 100, { tags: ['麦金卡'], conditionalPrice: true, originalPriceCents: 1000 + index }));
  const chosen = selectDetailItems({ menu: [...base, combo, offer, ...golds], limit: 15 });
  assert.ok(chosen.length <= 15);
  for (const code of ['main', 'side', 'drink', 'combo', 'coupon-side']) assert.ok(chosen.some(value => value.productCode === code));
  assert.equal(chosen.find(value => value.productCode === 'coupon-side').offerRef, 'opaque-local-reference');
});

test('coupon references survive into quote baskets and require their own verified details', () => {
  const offered = { ...side, offerRef: 'coupon-ref', requiresCoupon: true, displayPriceCents: null };
  const menu = [...base, offered], details = detailsFor(base);
  assert.ok(run(menu, details).candidates.every(candidate => !candidate.items.some(item => item.offerRef)));
  details.set('side:coupon-ref', detail(offered));
  const result = run(menu, details);
  const candidate = result.candidates.find(value => value.items.some(item => item.offerRef === 'coupon-ref'));
  assert.ok(candidate);
  assert.equal(candidate.items.length, 3);
  assert.equal(candidate.estimatedCents, null);
  assert.equal(candidate.items.filter(item => item.productCode === 'side').length, 1);
});

test('candidate cap reserves an offer comparison and a normal non-gold fallback', () => {
  const offered = { ...side, offerRef: 'coupon-ref', requiresCoupon: true, displayPriceCents: null };
  const mains = Array.from({ length: 6 }, (_, i) => product(`m${i}`, `鸡腿堡${i}`, 1000 + i));
  const menu = [...mains, side, drink, offered], details = detailsFor(menu);
  details.set('side:coupon-ref', detail(offered));
  const result = run(menu, details, { maxCandidates: 3, intent: 'low_budget' });
  assert.equal(result.candidates.length, 3);
  assert.ok(result.candidates.some(candidate => candidate.items.some(item => item.offerRef)));
  assert.ok(result.candidates.some(candidate => candidate.items.every(item => !item.offerRef)));
});

test('candidate cap reserves two distinct current coupons and an ordinary comparison', () => {
  const mains = Array.from({ length: 8 }, (_, i) => product(`m${i}`, `鸡腿堡${i}`, 1000 + i));
  const friesCoupon = product('coupon-fries', '中薯条买一送一', null, { offerRef: 'fries-ref', requiresCoupon: true });
  const snackCoupon = product('coupon-snack', '王牌小食拼', null, { offerRef: 'snack-ref', requiresCoupon: true });
  const menu = [...mains, side, drink, friesCoupon, snackCoupon];
  const details = detailsFor(menu);
  details.set('coupon-fries:fries-ref', detail(friesCoupon, [round('fries', [choice('included-fries', '中薯条', 2, { maxQuantity: 2 })], { minQuantity: 2, maxQuantity: 2 })]));
  details.set('coupon-snack:snack-ref', detail(snackCoupon, [round('side', [choice('included-side', '中薯条')]), round('drink', [choice('included-drink', '可乐中杯')])]));
  for (const cap of [3, 8]) {
    const result = run(menu, details, { maxCandidates: cap, intent: 'fries' });
    assert.equal(result.candidates.length, cap);
    const refs = new Set(result.candidates.flatMap(candidate => candidate.items.flatMap(item => item.offerRef ? [item.offerRef] : [])));
    assert.deepEqual(refs, new Set(['fries-ref', 'snack-ref']));
    assert.ok(result.candidates.some(candidate => candidate.items.every(item => !item.offerRef)));
    assert.ok(result.candidates.every(candidate => candidate.coverage.complete === true));
  }
});

test('a real coupon containing two fries remains one paid SKU completed by main and drink', () => {
  const offered = product('two-fries', '中薯条买一送一', null, { offerRef: 'fries-offer', requiresCoupon: true });
  const d = detail(offered, [round('coupon-fries', [choice('included-fries', '中薯条', 2, { maxQuantity: 2 })], { minQuantity: 2, maxQuantity: 2 })]);
  const result = run([...base, offered], new Map([...detailsFor(base), ['two-fries:fries-offer', d]]));
  const candidate = result.candidates.find(value => value.items.some(item => item.offerRef));
  assert.ok(candidate);
  assert.deepEqual(candidate.coverage, { main: 1, side: 2, drink: 1, complete: true });
  assert.deepEqual(candidate.items.map(item => item.productCode), ['two-fries', 'main', 'drink']);
});

test('a coupon small-food set may really cover side and drink even when its title does not say combo', () => {
  const offered = product('snack-coupon', '王牌小食拼', null, { offerRef: 'snack-ref', requiresCoupon: true });
  const d = detail(offered, [round('s', [choice('fries', '中薯条')]), round('d', [choice('cola', '可乐中杯')])]);
  const result = run([...base, offered], new Map([...detailsFor(base), ['snack-coupon:snack-ref', d]]));
  const candidate = result.candidates.find(value => value.items.some(item => item.offerRef));
  assert.ok(candidate);
  assert.deepEqual(candidate.items.map(item => item.productCode), ['snack-coupon', 'main']);
  assert.equal(candidate.items.find(item => item.productCode === 'snack-coupon').roundList[1].comboItemList[0].code, 'cola');
});

test('bounded detail requests retain two cheap ordinary mains and both current offer refs', () => {
  const second = product('second-main', '麦香鸡', 1650);
  const offers = [product('offer1', '中薯条买一送一', null, { offerRef: 'f' }), product('offer2', '王牌小食拼', null, { offerRef: 's' })];
  const golds = Array.from({ length: 20 }, (_, i) => product(`g${i}`, `鸡腿堡四件套${i}`, 100, { tags: ['麦金卡'] }));
  const selected = selectDetailItems({ menu: [...base, second, ...offers, ...golds], limit: 12 });
  assert.equal(selected.length, 12);
  for (const code of ['main', 'second-main', 'offer1', 'offer2']) assert.ok(selected.some(value => value.productCode === code));
});

test('inputs are not mutated and candidate count is bounded', () => {
  const menu = [...base, apple, water, combo], details = new Map([...detailsFor(menu), ['combo', comboDetail]]);
  const beforeMenu = structuredClone(menu), beforeDetails = structuredClone(details);
  assert.ok(run(menu, details, { maxCandidates: 100 }).candidates.length <= 10);
  assert.deepEqual(menu, beforeMenu); assert.deepEqual(details, beforeDetails);
});
