import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviders, HttpMcpClient, ProviderError, buildQuoteItem, coordinates, yuanToCents } from '../scripts/live_providers.mjs';

const tool = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const mcd = data => ({ structuredContent: { success: true, code: 200, data }, content: [] });
const detail = {
  code: 'p1', name: '套餐', supportModify: true,
  modification: { items: [{ values: [{ code: 'salt', selectedQuantity: 0, selectedKey: 'salt-on', unselectedKey: 'salt-off' }] }] },
  rounds: [{ id: 1, name: '饮品', minQuantity: 1, maxQuantity: 1, choices: [
    { code: 'a', name: '红茶', quantity: 1, isDefault: 1, maxQuantity: 1, modification: { items: [{ values: [{ code: 'ice', selectedQuantity: 1, selectedKey: 'ice-on', unselectedKey: 'ice-off' }] }] } },
    { code: 'b', name: '咖啡', quantity: 0, isDefault: 0, maxQuantity: 1 },
  ] }],
};
function mockClients(overrides = {}) {
  const calls = [];
  const clients = Object.fromEntries(['mcd', 'amap', 'xiaohongshu'].map(provider => [provider, {
    initialize: async () => {}, close: async () => {},
    call: async (name, args) => {
      calls.push({ provider, name, args });
      if (overrides[name]) return overrides[name](args);
      switch (name) {
        case 'query-nearby-stores': return mcd([{ storeCode: 's1', storeName: '餐厅', address: '南京东路353号', businessStatus: true, distance: 194, longitude: 0, latitude: 0, reservation: true, reservationTimeOptions: [{ date: '2026-10-15', today: true, reservationOptionText: '完整时段' }] }]);
        case 'query-meals': return mcd({ categories: [{ name: '套餐', meals: [{ code: 'p1', tags: ['推荐'] }] }], meals: { p1: { name: '套餐', currentPrice: '10.5', originalPrice: '12', image: 'https://menu-img.mcd.cn/a.png' } } });
        case 'query-meal-detail': return mcd(detail);
        case 'calculate-price': return mcd({ price: 1050, originalPrice: 1200, discount: 150, productList: [{ productCode: 'p1', productName: '套餐', quantity: 1, subtotal: 1050 }] });
        case 'maps_geo': return tool({ return: [{ province: '上海市', city: '上海市', district: '黄浦区', street: '南京东路', location: '121.48,31.23' }] });
        case 'maps_text_search': return tool({ pois: [] });
        case 'maps_direction_walking': return tool({ route: { origin: args.origin, destination: args.destination, paths: [{ distance: '230', duration: '190', steps: [{ instruction: '沿路向东', distance: '230', duration: '190', road: '南京东路' }] }] } });
        case 'check_login_status': return { content: [{ type: 'text', text: '已登录' }] };
        case 'search_feeds': return tool({ feeds: [{ id: '0123456789abcdef01234567', xsecToken: 'DO-NOT-EXPOSE', noteCard: { displayTitle: '早餐攻略', user: { nickname: '作者' }, interactInfo: { likedCount: '10' }, cover: { urlDefault: 'http://sns-webpic-qc.xhscdn.com/a.jpg' } } }] });
        case 'get_feed_detail': return tool({ data: { note: { noteId: args.feed_id, title: '早餐攻略', desc: '真实正文', imageList: [] } } });
        default: throw new Error('Unexpected tool');
      }
    },
  }]));
  return { clients, calls };
}

test('money converts decimal yuan without floating point guessing', () => {
  assert.equal(yuanToCents('9.5'), 950);
  assert.equal(yuanToCents('10'), 1000);
  assert.equal(yuanToCents('0.01'), 1);
  assert.equal(yuanToCents('10.001'), null);
  assert.equal(yuanToCents(10), null);
  assert.equal(yuanToCents('Free'), null);
});

test('coordinates reject non-coordinate input and zero placeholder', () => {
  assert.equal(coordinates('121.480,31.23'), '121.48,31.23');
  for (const value of ['0,0', '181,31', '121,91', 'https://host', '121,31;1,2']) assert.throws(() => coordinates(value), ProviderError);
});

test('quote preserves default modifications including unselected keys and default round', () => {
  const result = buildQuoteItem({ productCode: 'p1', quantity: 1 }, detail);
  assert.deepEqual(result.modification.values, [{ code: 'salt', key: 'salt-off', quantity: 0 }]);
  assert.deepEqual(result.roundList, [{ round: '1', comboItemList: [{ code: 'a', quantity: 1, modification: { values: [{ code: 'ice', key: 'ice-on', quantity: 1 }] } }] }]);
});

test('quote only accepts current choices, quantity constraints and UI parameter allowlist', () => {
  const request = { productCode: 'p1', quantity: 1, roundList: [{ round: '1', comboItemList: [{ code: 'b', quantity: 1 }] }] };
  assert.equal(buildQuoteItem(request, detail).roundList[0].comboItemList[0].code, 'b');
  for (const bad of [
    { productCode: 'p1', quantity: 0 },
    { productCode: 'p1', quantity: 1, couponId: 'injected' },
    { ...request, roundList: [{ round: '1', comboItemList: [{ code: 'not-current', quantity: 1 }] }] },
    { ...request, roundList: [{ round: '1', comboItemList: [] }] },
    { ...request, roundList: [{ round: '1', comboItemList: [{ code: 'a', quantity: 2 }] }] },
    { ...request, roundList: [{ round: 'unknown', comboItemList: [{ code: 'a', quantity: 1 }] }] },
    { ...request, roundList: [{ round: '1', comboItemList: [{ code: 'a', quantity: 1, modification: { key: 'injected' } }] }] },
    { ...request, roundList: [{ round: '1', comboItemList: [{ code: 'a', quantity: 1 }, { code: 'a', quantity: 1 }] }] },
  ]) assert.throws(() => buildQuoteItem(bad, detail), ProviderError);
});

test('real combo sentinel -1 and isDefault alternatives with zero quantity remain valid', () => {
  const liveShape = { code: 'combo', rounds: [{ id: 1, name: '饮品', minQuantity: 1, maxQuantity: 1, choices: [
    { code: 'iced', quantity: 1, isDefault: 1, maxQuantity: -1 },
    { code: 'hot', quantity: 0, isDefault: 1, maxQuantity: -1 },
  ] }] };
  const result = buildQuoteItem({ productCode: 'combo', quantity: 1 }, liveShape);
  assert.deepEqual(result.roundList, [{ round: '1', comboItemList: [{ code: 'iced', quantity: 1 }] }]);
  const replaced = buildQuoteItem({ productCode: 'combo', quantity: 1, roundList: [{ round: '1', comboItemList: [{ code: 'hot', quantity: 1 }] }] }, liveShape);
  assert.equal(replaced.roundList[0].comboItemList[0].code, 'hot');
});

test('removed live combo choice or changed round returns selection_stale without substitution', () => {
  const current = { code: 'combo', rounds: [{ id: 1, name: '饮品', minQuantity: 1, maxQuantity: 1, choices: [{ code: 'soy-milk', quantity: 1, isDefault: 1, maxQuantity: -1 }] }] };
  const outdatedChoice = { productCode: 'combo', quantity: 1, roundList: [{ round: '1', comboItemList: [{ code: 'iced-coffee', quantity: 1 }] }] };
  assert.throws(() => buildQuoteItem(outdatedChoice, current), error => error.code === 'selection_stale' && error.message.includes('修改规格'));
  assert.throws(() => buildQuoteItem({ ...outdatedChoice, roundList: [{ round: 'old-round', comboItemList: [{ code: 'soy-milk', quantity: 1 }] }] }, current), error => error.code === 'selection_stale');
  assert.throws(() => buildQuoteItem({ ...outdatedChoice, roundList: [] }, current), error => error.code === 'selection_stale');
  assert.throws(() => buildQuoteItem({ ...outdatedChoice, roundList: [null] }, current), error => error.code === 'invalid_input');
});

test('menu refresh invalidates old details and a stale choice never reaches official pricing', async () => {
  let updated = false;
  const mock = mockClients({ 'query-meal-detail': () => mcd({ code: 'p1', name: '套餐', rounds: [{ id: 1, name: '饮品', minQuantity: 1, maxQuantity: 1, choices: [{ code: updated ? 'soy-milk' : 'iced-coffee', quantity: 1, isDefault: 1, maxQuantity: -1 }] }] }) });
  const providers = await createProviders({ clients: mock.clients });
  await providers.stores({ city: '上海', location: '南京东路' });
  await providers.menu({ storeCode: 's1' });
  await providers.detail({ storeCode: 's1', productCode: 'p1' });
  const outdated = { storeCode: 's1', items: [{ productCode: 'p1', quantity: 1, roundList: [{ round: '1', comboItemList: [{ code: 'iced-coffee', quantity: 1 }] }] }] };
  await providers.quote(outdated);
  updated = true;
  await providers.menu({ storeCode: 's1' });
  const pricingCalls = mock.calls.filter(call => call.name === 'calculate-price').length;
  await assert.rejects(providers.quote(outdated), error => error.code === 'selection_stale');
  assert.equal(mock.calls.filter(call => call.name === 'calculate-price').length, pricingCalls);
  assert.equal(mock.calls.filter(call => call.name === 'query-meal-detail').length, 2);
  await providers.close();
});

test('provider calls enforce fetched stores/products and never leak XHS tokens', async () => {
  const mock = mockClients();
  const providers = await createProviders({ clients: mock.clients, now: () => Date.parse('2026-10-15T02:00:00Z') });
  await assert.rejects(providers.menu({ storeCode: 's1' }), error => error.code === 'store_required');
  const stores = await providers.stores({ city: '上海', location: '南京东路' });
  assert.equal(stores.stores[0].location, undefined);
  assert.equal(stores.stores[0].reservationTimeOptions[0].reservationOptionText, '完整时段');
  const menu = await providers.menu({ storeCode: 's1' });
  assert.equal(menu.items[0].displayPrice, '10.5');
  assert.equal(menu.items[0].displayPriceCents, 1050);
  await assert.rejects(providers.detail({ storeCode: 's1', productCode: 'unfetched' }), error => error.code === 'menu_required');
  const gotDetail = await providers.detail({ storeCode: 's1', productCode: 'p1' });
  assert.equal(gotDetail.item.rounds[0].choices[0].isDefault, true);
  assert.ok(!JSON.stringify(gotDetail).includes('salt-off'));
  const quote = await providers.quote({ storeCode: 's1', items: [{ productCode: 'p1', quantity: 1 }] });
  assert.equal(quote.totalCents, 1050);
  assert.equal(quote.expiresAt, '2026-10-15T02:05:00.000Z');
  const wire = mock.calls.find(call => call.name === 'calculate-price');
  assert.equal(wire.args.beCode, undefined);
  assert.equal(wire.args.beType, 1);
  assert.equal(wire.args.items[0].modification.values[0].key, 'salt-off');
  const search = await providers.search({ keyword: '麦当劳' });
  const note = await providers.note({ id: search.notes[0].id });
  assert.ok(!JSON.stringify({ search, note }).includes('DO-NOT-EXPOSE'));
  assert.ok(search.notes[0].cover.startsWith('https://'));
  assert.equal(note.note.body, '真实正文');
  assert.equal(mock.calls.find(call => call.name === 'get_feed_detail').args.xsec_token, 'DO-NOT-EXPOSE');
  await assert.rejects(providers.note({ id: '0123456789abcdef99999999' }), error => error.code === 'note_required');
  await providers.close();
});

test('provider rejects business failures, mismatched quote basket, expired menu', async () => {
  let time = 0;
  const mock = mockClients({ 'calculate-price': () => mcd({ price: 1000, productList: [{ productCode: 'other', quantity: 1 }] }) });
  const providers = await createProviders({ clients: mock.clients, now: () => time });
  await providers.stores({ city: '上海', location: '南京东路' });
  await providers.menu({ storeCode: 's1' });
  await assert.rejects(providers.quote({ storeCode: 's1', items: [{ productCode: 'p1', quantity: 1 }] }), error => error.code === 'invalid_response');
  time = 300001;
  await assert.rejects(providers.quote({ storeCode: 's1', items: [{ productCode: 'p1', quantity: 1 }] }), error => error.code === 'menu_required');
  const broken = mockClients({ 'query-nearby-stores': () => ({ structuredContent: { success: false, code: 400, data: [] } }) });
  const bad = await createProviders({ clients: broken.clients });
  await assert.rejects(bad.stores({ city: '上海', location: '南京东路' }), error => error.code === 'business_rejected');
});

test('gold card menu advertisements remain conditional and never replace official account quote', async () => {
  const mock = mockClients({
    'query-meals': () => mcd({ categories: [{ name: '套餐', meals: [{ code: 'p1', tags: ['麦金卡'] }] }], meals: { p1: {
      name: '板烧鸡腿堡四件套', currentPrice: '28', originalPrice: '57', discountType: '随单购麦金卡优惠', canWithOrder: true,
      withOrder: { cardId: 'DO-NOT-PURCHASE', membershipCode: 'DO-NOT-EXPOSE', specId: 'CARD-SPEC' },
    } } }),
    'calculate-price': () => mcd({ price: 5700, originalPrice: 5700, discount: 0, productList: [{ productCode: 'p1', productName: '板烧鸡腿堡四件套', quantity: 1, subtotal: 5700 }] }),
    'query-store-coupons': () => mcd([]),
  });
  const providers = await createProviders({ clients: mock.clients });
  await providers.stores({ city: '上海', location: '南京东路' });
  const menu = await providers.menu({ storeCode: 's1' });
  assert.equal(menu.items[0].displayPriceCents, 2800);
  assert.equal(menu.items[0].originalPriceCents, 5700);
  assert.equal(menu.items[0].conditionalPrice, true);
  assert.equal(menu.items[0].canWithOrder, true);
  assert.equal(menu.items[0].discountType, '随单购麦金卡优惠');
  const offers = await providers.offers({ storeCode: 's1' });
  assert.equal(offers.membership.status, 'unverified');
  assert.equal(offers.conditionalMenuItems[0].displayPriceCents, 2800);
  const quote = await providers.quote({ storeCode: 's1', items: [{ productCode: 'p1', quantity: 1 }] });
  assert.equal(quote.totalCents, 5700);
  assert.equal(quote.discountCents, 0);
  assert.equal(quote.discountEvidence.confirmedCents, 0);
  assert.equal(quote.discountEvidence.membershipAttributionVerified, false);
  assert.equal(mock.calls.find(call => call.name === 'calculate-price').args.withOrder, undefined);
  assert.ok(!JSON.stringify({ menu, offers, quote }).includes('DO-NOT-'));
  await providers.close();
});

test('store-scoped opaque offers allow only cached coupon products and hide raw credentials', async () => {
  let time = Date.parse('2026-10-15T02:00:00Z');
  const mock = mockClients({
    'query-nearby-stores': () => mcd([{ storeCode: 's1', storeName: '餐厅一' }, { storeCode: 's2', storeName: '餐厅二' }]),
    'query-store-coupons': () => mcd([{ couponId: 'SECRET-COUPON-ID', couponCode: 'SECRET-COUPON-CODE', title: '中薯条买一送一', tradeDateTime: '2026-10-12 10:30:00-2026-10-16 23:59:59', products: [{ productCode: 'coupon-fries', productName: '中薯条买一送一' }] }]),
    'query-meal-detail': ({ code }) => mcd(code === 'coupon-fries' ? { code, name: '中薯条买一送一', rounds: [{ id: 1, name: '中薯条', minQuantity: 2, maxQuantity: 2, choices: [{ code: 'fries', name: '中薯条', quantity: 2, isDefault: 1, maxQuantity: -1 }] }] } : detail),
    'calculate-price': ({ items }) => mcd({ price: 1350, originalPrice: 2800, discount: 1450, productList: items.map(item => ({ productCode: item.productCode, productName: '中薯条买一送一', quantity: item.quantity, subtotal: 1350 })) }),
  });
  const providers = await createProviders({ clients: mock.clients, now: () => time });
  await providers.stores({ city: '上海', location: '南京东路' });
  const offers = await providers.offers({ storeCode: 's1' });
  const eligible = offers.eligibleItems[0];
  assert.equal(eligible.name, '中薯条买一送一');
  assert.equal(eligible.displayPriceCents, null);
  assert.equal(eligible.conditionalPrice, true);
  assert.equal(offers.membership.status, 'unverified');
  assert.equal((await providers.offers({ storeCode: 's1' })).eligibleItems[0].offerRef, eligible.offerRef);
  assert.equal(mock.calls.filter(call => call.name === 'query-store-coupons').length, 1);
  await assert.rejects(providers.detail({ storeCode: 's1', productCode: eligible.id }), error => error.code === 'menu_required');
  await assert.rejects(providers.detail({ storeCode: 's2', productCode: eligible.id, offerRef: eligible.offerRef }), error => error.code === 'selection_stale');
  await assert.rejects(providers.detail({ storeCode: 's1', productCode: 'p1', offerRef: eligible.offerRef }), error => error.code === 'selection_stale');
  const gotDetail = await providers.detail({ storeCode: 's1', productCode: eligible.id, offerRef: eligible.offerRef });
  assert.equal(gotDetail.item.offerRef, eligible.offerRef);
  const quote = await providers.quote({ storeCode: 's1', items: [{ productCode: eligible.id, quantity: 1, offerRef: eligible.offerRef }] });
  assert.equal(quote.totalCents, 1350);
  assert.equal(quote.discountEvidence.confirmedCents, 1450);
  assert.equal(quote.appliedOffers[0].title, '中薯条买一送一');
  assert.equal(quote.selections[0].offerRef, eligible.offerRef);
  const wire = mock.calls.find(call => call.name === 'calculate-price');
  assert.equal(wire.args.items[0].couponId, 'SECRET-COUPON-ID');
  assert.equal(wire.args.items[0].couponCode, 'SECRET-COUPON-CODE');
  assert.equal(wire.args.items[0].roundList[0].comboItemList[0].quantity, 2);
  assert.ok(!JSON.stringify({ offers, gotDetail, quote }).includes('SECRET-COUPON'));
  for (const injected of [
    { couponId: 'SECRET-COUPON-ID' }, { couponCode: 'SECRET-COUPON-CODE' }, { withOrder: { cardId: 'buy-card' } },
  ]) await assert.rejects(providers.quote({ storeCode: 's1', items: [{ productCode: eligible.id, quantity: 1, offerRef: eligible.offerRef, ...injected }] }), error => error.code === 'invalid_input');
  const callsBeforeExpiry = mock.calls.filter(call => call.name === 'calculate-price').length;
  time += 300000;
  await assert.rejects(providers.quote({ storeCode: 's1', items: [{ productCode: eligible.id, quantity: 1, offerRef: eligible.offerRef }] }), error => error.code === 'selection_stale');
  assert.equal(mock.calls.filter(call => call.name === 'calculate-price').length, callsBeforeExpiry);
  const refreshed = await providers.offers({ storeCode: 's1' });
  assert.notEqual(refreshed.eligibleItems[0].offerRef, eligible.offerRef);
  await providers.close();
});

test('unknown coupon validity or missing credentials is visible but cannot enter pricing', async () => {
  const mock = mockClients({ 'query-store-coupons': () => mcd([
    { couponId: 'id', couponCode: 'code', title: '未知时段', tradeDateTime: '任意时间', products: [{ productCode: 'p2', productName: '小食' }] },
    { title: '没有券凭证', tradeDateTime: '2026-10-12 10:30:00-2026-10-16 23:59:59', products: [{ productCode: 'p3', productName: '饮料' }] },
    { couponId: 'id', couponCode: 'code', title: '过期优惠', tradeDateTime: '2026-09-12 10:30:00-2026-09-16 23:59:59', products: [{ productCode: 'p4', productName: '饮料' }] },
  ]) });
  const providers = await createProviders({ clients: mock.clients, now: () => Date.parse('2026-10-15T02:00:00Z') });
  await providers.stores({ city: '上海', location: '南京东路' });
  const offers = await providers.offers({ storeCode: 's1' });
  assert.equal(offers.coupons.length, 3);
  assert.equal(offers.eligibleItems.length, 0);
  assert.ok(offers.coupons.every(coupon => coupon.eligible === false));
  await assert.rejects(providers.detail({ storeCode: 's1', productCode: 'p2', offerRef: offers.coupons[0].id }), error => error.code === 'selection_stale');
  assert.ok(!mock.calls.some(call => call.name === 'query-meal-detail' || call.name === 'calculate-price'));
  await providers.close();
});

test('coupon quotes expire no later than the opaque reference cache or the coupon validity', async () => {
  const base = Date.parse('2026-10-15T02:00:00Z');
  for (const [validUntil, ageSeconds, expectedSeconds] of [
    ['2026-10-16 23:59:59', 290, 300],
    ['2026-10-15 10:01:00', 50, 60],
  ]) {
    let time = base;
    const mock = mockClients({
      'query-store-coupons': () => mcd([{ couponId: 'private-id', couponCode: 'private-code', title: '小食优惠', tradeDateTime: `2026-10-12 10:30:00-${validUntil}`, products: [{ productCode: 'coupon', productName: '小食' }] }]),
      'query-meal-detail': ({ code }) => mcd({ code, name: '小食', rounds: [] }),
      'calculate-price': () => mcd({ price: 500, originalPrice: 1000, discount: 500, productList: [{ productCode: 'coupon', productName: '小食', quantity: 1, subtotal: 500 }] }),
    });
    const providers = await createProviders({ clients: mock.clients, now: () => time });
    await providers.stores({ city: '上海', location: '南京东路' });
    const offers = await providers.offers({ storeCode: 's1' });
    time += ageSeconds * 1000;
    const quote = await providers.quote({ storeCode: 's1', items: [{ productCode: 'coupon', quantity: 1, offerRef: offers.eligibleItems[0].offerRef }] });
    assert.equal(quote.expiresAt, new Date(base + expectedSeconds * 1000).toISOString());
    assert.ok(Date.parse(quote.expiresAt) > time);
    assert.ok(quote.validityNote.includes('剩余有效期'));
    await providers.close();
  }
});

test('a coupon expiring while official pricing is in flight never produces a fresh quote', async () => {
  let time = Date.parse('2026-10-15T02:00:00Z');
  const mock = mockClients({
    'query-store-coupons': () => mcd([{ couponId: 'private-id', couponCode: 'private-code', title: '小食优惠', tradeDateTime: '2026-10-12 10:30:00-2026-10-16 23:59:59', products: [{ productCode: 'coupon', productName: '小食' }] }]),
    'query-meal-detail': ({ code }) => mcd({ code, name: '小食', rounds: [] }),
    'calculate-price': () => { time += 15000; return mcd({ price: 500, productList: [{ productCode: 'coupon', productName: '小食', quantity: 1, subtotal: 500 }] }); },
  });
  const providers = await createProviders({ clients: mock.clients, now: () => time });
  await providers.stores({ city: '上海', location: '南京东路' });
  const offers = await providers.offers({ storeCode: 's1' });
  time += 290000;
  await assert.rejects(providers.quote({ storeCode: 's1', items: [{ productCode: 'coupon', quantity: 1, offerRef: offers.eligibleItems[0].offerRef }] }), error => error.code === 'selection_stale');
  await providers.close();
});

test('route returns actual measurements and steps without inventing map geometry', async () => {
  const mock = mockClients();
  const providers = await createProviders({ clients: mock.clients });
  const place = await providers.geocode({ city: '上海', location: '南京东路' });
  assert.equal(place.location, '121.48,31.23');
  const route = await providers.route({ origin: place.location, destination: '121.49,31.24' });
  assert.equal(route.distanceMeters, 230);
  assert.equal(route.durationSeconds, 190);
  assert.equal(route.geometryAvailable, false);
  assert.equal(route.steps[0].instruction, '沿路向东');
});

test('landmark geocoding resolves exact POI names, verifies city, and exposes alternatives', async () => {
  const mock = mockClients({
    maps_text_search: () => tool({ pois: [
      { id: 'wrong-city', name: '南京路步行街' }, { id: 'east-1', name: '南京路步行街' }, { id: 'east-2', name: '南京路步行街' }, { id: 'hotel', name: '南京路步行街酒店' },
    ] }),
    maps_search_detail: ({ id }) => tool({ id, name: '南京路步行街', city: id === 'wrong-city' ? '南京市' : '上海市', location: id === 'east-2' ? '121.482374,31.236534' : '121.479494,31.235983', address: id === 'east-2' ? '黄浦区' : '南京东路558号' }),
  });
  const providers = await createProviders({ clients: mock.clients });
  const result = await providers.geocode({ city: '上海', location: '南京路步行街' });
  assert.equal(result.resolution, 'poi');
  assert.equal(result.location, '121.479494,31.235983');
  assert.equal(result.places.length, 2);
  assert.equal(result.ambiguous, true);
  assert.ok(result.formattedAddress.includes('南京东路558号'));
  assert.ok(!mock.calls.some(call => call.name === 'maps_geo'));
  assert.equal(mock.calls.filter(call => call.name === 'maps_search_detail').length, 3);
  assert.ok(!mock.calls.some(call => call.args.id === 'hotel'));
});

test('postal addresses use address geocoding; unresolved landmarks carry uncertainty notice', async () => {
  const mock = mockClients();
  const providers = await createProviders({ clients: mock.clients });
  const exact = await providers.geocode({ city: '上海', location: '南京东路３５３号' });
  assert.equal(exact.resolution, 'geocode');
  assert.equal(exact.ambiguous, false);
  assert.ok(!mock.calls.some(call => call.name === 'maps_text_search'));
  const uncertain = await providers.geocode({ city: '上海', location: '无同名地点' });
  assert.equal(uncertain.resolution, 'geocode');
  assert.equal(uncertain.ambiguous, true);
  assert.ok(uncertain.resolutionNote.includes('未确认同名地点'));
});

function rpcFetch({ sse = false, redirect = false } = {}) {
  let sequence = 0;
  const calls = [];
  const fakeFetch = async (endpoint, options) => {
    calls.push({ endpoint, options });
    assert.equal(options.redirect, 'error');
    if (redirect) return new Response('', { status: 302 });
    const request = JSON.parse(options.body);
    if (!('id' in request)) return new Response('', { status: 202 });
    let result;
    if (request.method === 'initialize') result = { protocolVersion: '2025-03-26' };
    else if (request.method === 'tools/list') result = { tools: ['query-nearby-stores', 'query-meals', 'query-meal-detail', 'calculate-price'].map(name => ({ name })) };
    else result = { content: [{ type: 'text', text: '{}' }] };
    const message = JSON.stringify({ jsonrpc: '2.0', id: request.id, result });
    sequence++;
    if (sse) {
      const text = `: keepalive\r\ndata: ${message}\r\n\r\n`;
      const bytes = new TextEncoder().encode(text);
      const stream = new ReadableStream({ start(controller) { for (let offset = 0; offset < bytes.length; offset += 3) controller.enqueue(bytes.slice(offset, offset + 3)); controller.close(); } });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'Mcp-Session-Id': 'test-session' } });
    }
    return new Response(message, { headers: { 'content-type': 'application/json', 'Mcp-Session-Id': 'test-session' } });
  };
  return { fakeFetch, calls };
}

test('HTTP MCP client negotiates sessions, reads split SSE and enforces fixed tool/endpoint', async () => {
  const mock = rpcFetch({ sse: true });
  const client = new HttpMcpClient('mcd', { fetch: mock.fakeFetch, headerLoader: async () => ({ Authorization: 'Bearer LOCAL-TEST-ONLY' }) });
  await client.call('query-nearby-stores', { beType: 1, searchType: 2 });
  assert.ok(mock.calls.every(call => call.endpoint === 'https://mcp.mcd.cn'));
  assert.equal(mock.calls.at(-1).options.headers['Mcp-Session-Id'], 'test-session');
  await assert.rejects(client.call('create-order', {}), error => error.code === 'tool_not_allowed');
});

test('HTTP MCP client rejects redirect, RPC mismatch, and hides raw transport error', async () => {
  const redirect = rpcFetch({ redirect: true });
  const client = new HttpMcpClient('mcd', { fetch: redirect.fakeFetch, headerLoader: async () => ({}) });
  await assert.rejects(client.call('query-meals', {}), error => error instanceof ProviderError && error.code === 'provider_unavailable');
  const throwing = new HttpMcpClient('mcd', { fetch: async () => { throw new Error('SECRET-QUERY'); }, headerLoader: async () => ({}) });
  await assert.rejects(throwing.call('query-meals', {}), error => !error.message.includes('SECRET-QUERY') && error.code === 'provider_unavailable');
});
