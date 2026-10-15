/** Pure, bounded composition from the current catalogue and verified details.
 * Menu display prices are a search heuristic. Only a later official quote may
 * establish affordability or an applied membership benefit.
 */
const array = value => Array.isArray(value) ? value : [];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' ? value.slice(0, 300) : '';
const codeOf = value => text(value?.productCode || value?.id);
const norm = value => text(value).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
const ROLES = ['main', 'side', 'drink'];
const LABELS = { main: '主食', side: '小食', drink: '饮料' };
const COMBO = /套餐|组合|随心配|随心选|随心拼|[一二三四五六七八九十两\d]+件套|开心乐园餐/u;
const PARTY = /双人|[二两三四五六七八九十2-9]+人|全家|分享|亲子|七件|7件/u;
const ACCESSORY = /(?:蘸酱|风味酱|番茄酱|沙拉酱)$|玩具|手提袋|包装|餐具|兑换|礼品|周边|纸巾/u;
const DESSERT = /麦旋风|冰淇淋|圆筒|甜筒|新地|圣代|奶昔|(?:苹果|菠萝|香芋|红豆|巧克力|樱花|经典)?派$/u;
const MAIN = /汉堡|鸡腿堡|牛堡|鱼堡|月堡|(?:鸡|牛|鱼|肉|吉士|芝士|蛋|虾|蔬).*堡|麦满分|(?:鸡|牛|鱼|笋|蔬|蛋|肉).*卷|帕尼尼|热香饼|松饼|燕麦粥|皮蛋.*粥|麦香鸡|麦香鱼|巨无霸|不素之霸|米饭|饭碗/u;
const SIDE = /薯条|[小中大]薯$|扭扭薯|薯饼|麦乐鸡|鸡块|鸡柳|鸡翅|鸡排|脆汁鸡|肉骨鸡|玉米杯|苹果片|芝士条|沙拉|蔬菜杯/u;
const DRINK = /可乐|雪碧|咖啡|冰咖|美式|奶铁|拿铁|卡布奇诺|摩卡|牛奶|豆浆|奶茶|红茶|绿茶|乌龙茶|柠檬茶|柠檬红茶|果汁|苹果汁|橙汁|纯悦|矿泉水|饮用水|怡泉|麦炫酷|黄金橙橙|热巧克力|燕麦奶/u;
const BREAKFAST = /早餐|麦满分|热香饼|松饼|粥|早安|早八|早晨|贝果/u;
const FRIES = /薯条|[小中大]薯$|扭扭薯/u;
const LIGHT_SIDE = /苹果片|玉米杯|沙拉|蔬菜杯/u;
const LIGHT_MAIN = /板烧|烤鸡|麦满分|燕麦粥|蔬菜卷/u;
const UNSWEET = /无糖|零度|纯悦|矿泉水|饮用水|纯牛奶|^牛奶|美式|鲜萃咖啡|鲜萃冰咖|黑咖啡|锡兰红茶/u;

function roleOf(name, tags = []) {
  const value = norm(name), categories = array(tags).map(norm).join(' ');
  if (!value || ACCESSORY.test(value)) return null;
  if (DESSERT.test(value) || /冰淇淋|甜品/u.test(categories)) return 'dessert';
  if (MAIN.test(value)) return 'main';
  if (SIDE.test(value)) return 'side';
  if (DRINK.test(value) || /冷饮|热饮|饮品|饮料|咖啡/u.test(categories)) return 'drink';
  if (/小食/u.test(categories)) return 'side';
  return null;
}
function priceOf(value) {
  if (value?.conditionalPrice || value?.requiresCoupon || value?.discountType) return Number.isSafeInteger(value.originalPriceCents) && value.originalPriceCents >= 0 ? value.originalPriceCents : null;
  return Number.isSafeInteger(value?.displayPriceCents) && value.displayPriceCents >= 0 ? value.displayPriceCents : null;
}
const itemKey = value => `${codeOf(value)}:${text(value?.offerRef)}`;
function inspirationCodes(values) {
  const result = new Set();
  for (const value of array(values)) {
    if (typeof value === 'string') result.add(value);
    else if (object(value)) {
      if (codeOf(value)) result.add(codeOf(value));
      for (const match of array(value.matches || value.items)) if (codeOf(match)) result.add(codeOf(match));
    }
  }
  return result;
}
function record(raw) {
  const productCode = codeOf(raw), name = text(raw?.name), tags = array(raw?.tags).filter(value => typeof value === 'string').slice(0, 30);
  if (!productCode || !name || raw.available === false || raw.soldOut === true || raw.isSoldOut === true || /售罄|已售完|停售/u.test(tags.join(' '))) return null;
  const combo = COMBO.test(norm(name)) || tags.some(tag => /套餐|随心配/u.test(tag));
  const excluded = ACCESSORY.test(norm(name)) || PARTY.test(norm(name));
  return { productCode, ...(text(raw.offerRef) ? { offerRef: text(raw.offerRef), offerTitle: text(raw.offerTitle) } : {}), name, tags, role: combo ? null : roleOf(name, tags), combo, excluded,
    membershipTagged: tags.some(tag => /麦金卡/u.test(tag)) || /麦金卡/u.test(name + text(raw.discountType) + text(raw.priceCondition)),
    breakfast: BREAKFAST.test(norm(name)), displayPriceCents: priceOf(raw), raw };
}

export function classifyMenu(menu) {
  const items = [], seen = new Set();
  for (const raw of array(Array.isArray(menu) ? menu : menu?.items)) {
    const item = record(raw);
    if (item && !seen.has(itemKey(item))) { seen.add(itemKey(item)); items.push(item); }
  }
  const usable = items.filter(item => !item.excluded);
  return { items, mains: usable.filter(item => item.role === 'main'), sides: usable.filter(item => item.role === 'side'),
    drinks: usable.filter(item => item.role === 'drink'), desserts: usable.filter(item => item.role === 'dessert'),
    combos: usable.filter(item => item.combo), excluded: items.filter(item => item.excluded || !item.role && !item.combo) };
}

function preference(item, intent, anchors) {
  let result = anchors.has(item.productCode) ? 24 : 0;
  const name = norm(item.name);
  if (intent === 'fries' && FRIES.test(name)) result += 30;
  if (intent === 'breakfast') result += item.breakfast || BREAKFAST.test(name) ? 40 : item.role === 'main' ? -30 : 0;
  if (intent === 'low_calorie') {
    if (item.role === 'side' && LIGHT_SIDE.test(name)) result += 30;
    if (item.role === 'main' && LIGHT_MAIN.test(name)) result += 20;
    if (item.role === 'drink' && UNSWEET.test(name)) result += 30;
  }
  if (intent === 'new_products' && /上新|新品|尝鲜|全新/u.test(item.tags.join(' ') + item.name)) result += 25;
  if (item.combo) result += 3;
  return result;
}
function ranked(items, intent, anchors) {
  return [...items].sort((a, b) => {
    const preferenceDifference = preference(b, intent, anchors) - preference(a, intent, anchors);
    // Low-budget candidates still preserve a literal inspiration when possible,
    // but do not let a costly anchor consume every detail slot.
    if (intent !== 'low_budget' && preferenceDifference) return preferenceDifference;
    const priceDifference = (a.displayPriceCents ?? Number.MAX_SAFE_INTEGER) - (b.displayPriceCents ?? Number.MAX_SAFE_INTEGER);
    if (priceDifference) return priceDifference;
    return preferenceDifference || a.productCode.localeCompare(b.productCode);
  });
}

export function selectDetailItems({ menu, intent = 'custom', inspirations = [], limit = 15 } = {}) {
  const catalog = classifyMenu(menu), anchors = inspirationCodes(inspirations), selected = [];
  limit = Math.max(3, Math.min(18, Number.isInteger(limit) ? limit : 15));
  const add = item => { if (item && !selected.some(value => itemKey(value) === itemKey(item)) && selected.length < limit) selected.push({ productCode: item.productCode, ...(item.offerRef ? { offerRef: item.offerRef } : {}) }); };
  const rolePools = [catalog.mains, catalog.sides, catalog.drinks].map(pool => ranked(pool, intent, anchors));
  // Reserve each role before spending queries on incomplete or unavailable sets.
  for (const pool of rolePools) add(pool[0]);
  add(rolePools[0][1]);
  // Reserve both actual-account offer entries before a long list of sets can
  // consume the bounded detail budget.
  for (const item of ranked(catalog.items.filter(item => item.offerRef && !item.excluded), intent, anchors).slice(0, 2)) add(item);
  const combos = ranked(catalog.combos, intent, anchors);
  for (const item of combos.slice(0, 5)) add(item);
  add(combos.find(item => !item.membershipTagged && !item.raw.conditionalPrice && !item.raw.requiresCoupon));
  const tagged = combos.find(item => item.membershipTagged); add(tagged);
  // Redeemed-account offers are separate controlled catalogue entries, not a
  // discount invented from a promotion headline.
  for (const pool of rolePools) for (const item of pool.slice(1, 3)) add(item);
  for (const item of catalog.items.filter(item => anchors.has(item.productCode) && !item.excluded)) add(item);
  for (const item of combos.slice(5)) add(item);
  for (const pool of rolePools) for (const item of pool.slice(3)) add(item);
  return selected;
}
export function selectDetailCodes(options = {}) { return [...new Set(selectDetailItems(options).map(item => item.productCode))]; }

function detailMap(values) {
  if (values instanceof Map) return values;
  if (Array.isArray(values)) return new Map(values.map(value => { const item = value?.item || value; return [itemKey({ ...item, offerRef: value.offerRef || item.offerRef }), item]; }));
  return new Map(Object.entries(object(values) ? values : {}).map(([key, value]) => [key, value?.item || value]));
}
function deltaOf(choice) {
  const value = text(choice.diffPrice).match(/([+-]?)\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)/u);
  return value ? Math.round(Number(value[2]) * 100) * (value[1] === '-' ? -1 : 1) : null;
}
function choiceRank(choice, intent, current) {
  const name = norm(choice.name), role = roleOf(name);
  let score = 0;
  if (intent === 'fries' && FRIES.test(name)) score += 100;
  if (intent === 'breakfast' && BREAKFAST.test(name)) score += 80;
  if (intent === 'low_calorie') {
    if (role === 'drink' && UNSWEET.test(name)) score += 100;
    if (role === 'side' && LIGHT_SIDE.test(name)) score += 100;
    if (role === 'main' && LIGHT_MAIN.test(name)) score += 80;
  }
  if (current.has(choice.id)) score += 5;
  if (role) score += 1;
  return score;
}
function validDetail(item, detail) {
  if (!object(detail) || codeOf(detail) !== item.productCode || !Array.isArray(detail.rounds) || detail.rounds.length > 16 || detail.available === false || detail.soldOut === true) return false;
  const seen = new Set();
  return detail.rounds.every(round => {
    if (!object(round) || typeof round.id !== 'string' || !round.id || seen.has(round.id) || !Array.isArray(round.choices) || round.choices.length > 100 || !Number.isSafeInteger(round.minQuantity) || !Number.isSafeInteger(round.maxQuantity) || round.minQuantity < 0 || round.maxQuantity < round.minQuantity || round.maxQuantity > 10) return false;
    seen.add(round.id); const choices = new Set();
    return round.choices.every(choice => {
      if (!object(choice) || typeof choice.id !== 'string' || !choice.id || choices.has(choice.id) || !text(choice.name) || !Number.isSafeInteger(choice.maxQuantity) || choice.maxQuantity < 0 || choice.maxQuantity > 10 || choice.quantity !== undefined && (!Number.isSafeInteger(choice.quantity) || choice.quantity < 0 || choice.quantity > 10)) return false;
      choices.add(choice.id); return true;
    });
  });
}
function buildVariant(item, detail, intent, usePreference) {
  if (!validDetail(item, detail)) return null;
  const selectedRounds = [], components = [], warnings = [];
  for (const round of detail.rounds) {
    const available = round.choices.filter(choice => choice.maxQuantity > 0 && choice.available !== false && choice.soldOut !== true && !/售罄|已售完/u.test(choice.name));
    let selected = available.flatMap(choice => {
      const quantity = choice.quantity === undefined ? choice.isDefault === true ? 1 : 0 : choice.quantity;
      return quantity > 0 && quantity <= choice.maxQuantity ? [{ choice, quantity }] : [];
    });
    const count = () => selected.reduce((sum, value) => sum + value.quantity, 0);
    const defaultValid = count() >= round.minQuantity && count() <= round.maxQuantity;
    const previous = new Set(selected.map(value => value.choice.id));
    const ordered = [...available].sort((a, b) => choiceRank(b, intent, previous) - choiceRank(a, intent, previous) || (deltaOf(a) ?? 99999) - (deltaOf(b) ?? 99999) || a.id.localeCompare(b.id));
    if (usePreference && round.maxQuantity === 1 && round.minQuantity === 1 && ordered.length) selected = [{ choice: ordered[0], quantity: 1 }];
    else if (!defaultValid) {
      // Select only legal, current options. Multi-select defaults without a clear
      // complete selection remain unresolved; do not invent their quantities.
      if (round.minQuantity === 1 && round.maxQuantity === 1 && ordered.length) selected = [{ choice: ordered[0], quantity: 1 }];
      else return null;
    }
    if (count() < round.minQuantity || count() > round.maxQuantity || selected.some(value => value.quantity > value.choice.maxQuantity)) return null;
    selectedRounds.push({ round, selected });
    for (const value of selected) components.push({ code: value.choice.id, name: text(value.choice.name), role: roleOf(value.choice.name), quantity: value.quantity, included: true });
  }
  if (!detail.rounds.length) {
    if (item.combo) return null; // A name or marketing tag cannot prove contents.
    components.push({ code: item.productCode, name: text(detail.name) || item.name, role: roleOf(detail.name || item.name, item.tags), quantity: 1, included: false });
  } else if (!item.combo && item.role && !components.some(component => component.role)) {
    // Modifier-only rounds (e.g. sauce, ice) are not an extra food purchase.
    components.push({ code: item.productCode, name: text(detail.name) || item.name, role: item.role, quantity: 1, included: false });
  }
  const coverage = Object.fromEntries(ROLES.map(role => [role, components.filter(component => component.role === role).reduce((sum, component) => sum + component.quantity, 0)]));
  if (!coverage.main && !coverage.side && !coverage.drink || coverage.main > 1 || coverage.drink > 1) return null;
  if (detail.supportModify || selectedRounds.some(({ selected }) => selected.some(value => value.choice.supportModify))) warnings.push('使用当前门店的默认特调；去酱、去料、少冰等未自动执行。');
  const roundList = selectedRounds.map(({ round, selected }) => ({ round: round.id, comboItemList: selected.map(value => ({ code: value.choice.id, quantity: value.quantity })) }));
  return { productCode: item.productCode, ...(item.offerRef ? { offerRef: item.offerRef, offerTitle: item.offerTitle } : {}), name: text(detail.name) || item.name, quantity: 1, roundList,
    specs: selectedRounds.flatMap(({ round, selected }) => selected.map(value => `${round.name}：${value.choice.name}${value.quantity > 1 ? ` × ${value.quantity}` : ''}`)),
    selectionSnapshot: selectedRounds.map(({ round, selected }) => ({ id: round.id, name: text(round.name), choices: selected.map(value => ({ id: value.choice.id, name: text(value.choice.name), quantity: value.quantity })) })),
    components, roles: ROLES.filter(role => coverage[role] > 0), coverage,
    displayPriceCents: item.displayPriceCents, membershipTagged: item.membershipTagged, tags: item.tags, warnings,
    combo: item.combo || !!item.offerRef && detail.rounds.length > 0 || ROLES.filter(role => coverage[role] > 0).length > 1 || coverage.side > 1,
    breakfast: item.breakfast || components.some(component => component.role === 'main' && BREAKFAST.test(norm(component.name))) };
}
function signature(items) {
  return JSON.stringify(items.map(item => [itemKey(item), item.roundList]).sort((a, b) => a[0].localeCompare(b[0])));
}
function itemScore(item, intent, anchors) {
  const base = preference({ ...item, role: item.roles.length === 1 ? item.roles[0] : null }, intent, anchors);
  return base + item.components.reduce((sum, component) => sum + (intent === 'fries' && FRIES.test(norm(component.name)) ? 30 : intent === 'low_calorie' && (component.role === 'drink' && UNSWEET.test(norm(component.name)) || component.role === 'side' && LIGHT_SIDE.test(norm(component.name)) || component.role === 'main' && LIGHT_MAIN.test(norm(component.name))) ? 20 : 0), 0);
}

export function composeCandidates({ menu, details, intent = 'custom', budgetCents, inspirations = [], maxCandidates = 8 } = {}) {
  const catalog = classifyMenu(menu), detailIndex = detailMap(details), anchors = inspirationCodes(inspirations), variants = [], notices = [];
  const presentCodes = new Set(catalog.items.map(item => item.productCode));
  if ([...anchors].some(code => !presentCodes.has(code))) notices.push('部分笔记餐品不在当前门店菜单中；未将其作为可点餐品。');
  for (const item of catalog.items.filter(value => !value.excluded)) {
    const rawDetail = detailIndex.get(itemKey(item)) || (!item.offerRef ? detailIndex.get(item.productCode) : null);
    const detail = rawDetail?.item || rawDetail;
    for (const preferred of [true, false]) {
      const variant = buildVariant(item, detail, intent, preferred);
      if (variant && !variants.some(value => signature([value]) === signature([variant]))) variants.push(variant);
    }
  }
  const missingRoles = ROLES.filter(role => !variants.some(item => item.coverage[role] > 0));
  if (missingRoles.length) notices.push(`当前已核验菜单缺少${missingRoles.map(role => LABELS[role]).join('、')}，不能自动生成完整一餐；请刷新菜单或改选门店。`);
  const sortVariants = values => [...values].sort((a, b) => itemScore(b, intent, anchors) - itemScore(a, intent, anchors) || (a.displayPriceCents ?? 99999999) - (b.displayPriceCents ?? 99999999));
  const singles = Object.fromEntries(ROLES.map(role => [role, sortVariants(variants.filter(item => item.coverage[role] === 1 && ROLES.every(other => other === role || !item.coverage[other]))).slice(0, 5)]));
  const generated = [], seen = new Set();
  function add(items) {
    const coverage = Object.fromEntries(ROLES.map(role => [role, items.reduce((sum, item) => sum + item.coverage[role], 0)]));
    if (coverage.main !== 1 || coverage.side < 1 || coverage.drink !== 1 || new Set(items.map(item => item.productCode)).size !== items.length) return;
    const allComponents = items.flatMap(item => item.components);
    if (intent === 'fries' && !allComponents.some(component => component.role === 'side' && FRIES.test(norm(component.name)))) return;
    if (intent === 'breakfast' && !items.some(item => item.breakfast && item.coverage.main)) return;
    const key = signature(items); if (seen.has(key)) return; seen.add(key);
    const matched = [...anchors].filter(code => items.some(item => item.productCode === code || item.components.some(component => component.code === code)));
    const membershipTagged = items.some(item => item.membershipTagged);
    const priceKnown = items.every(item => item.displayPriceCents !== null);
    const estimatedCents = priceKnown ? items.reduce((sum, item) => sum + item.displayPriceCents, 0) : null;
    const warnings = [...new Set(items.flatMap(item => item.warnings))];
    if (intent === 'low_calorie') warnings.push('按板烧、果蔬小食和无糖饮品等方向搭配；未取得完整营养数据，不代表已验证低卡或减脂效果。');
    if (intent === 'dessert') warnings.push('甜品偏好用于餐后选择；完整一餐仍保留主食、小食和饮料。');
    const origin = item => anchors.has(item.productCode) || item.components.some(component => anchors.has(component.code)) ? 'inspiration' : 'system';
    const publicItems = items.map(({ displayPriceCents, tags, combo, breakfast, warnings, coverage: itemCoverage, ...item }) => ({ ...item, origin: origin(item) }));
    generated.push({ title: `${items.find(item => item.coverage.main)?.components.find(component => component.role === 'main')?.name || '主食'}完整一餐`,
      rationale: '根据所选词条，从当前门店菜单搭配主食、小食和饮料；笔记仅提供灵感，缺少的部分由系统补齐。',
      items: publicItems, coverage: { ...coverage, complete: true }, estimatedCents, estimateOnly: true,
      estimatedOverBudget: Number.isSafeInteger(budgetCents) && estimatedCents !== null ? estimatedCents > budgetCents : null,
      membershipTagged, pricingNote: membershipTagged ? '含麦金卡标签餐品；标签不代表当前账户已享优惠，优惠资格和最终价格以官方核价为准。' : '菜单展示价仅用于候选排序，最终价格以当前门店官方核价为准。',
      warnings, unresolved: [], matchedInspirationCodes: matched,
      _score: items.reduce((sum, item) => sum + itemScore(item, intent, anchors), 0),
      _combo: items.some(item => item.combo), _offer: items.some(item => item.offerRef), _key: key });
  }
  // A verified complete set is one paid SKU. Missing roles are filled only by
  // separately sold current products; included children never become paid rows.
  for (const combo of sortVariants(variants.filter(item => item.combo)).slice(0, 16)) {
    const missing = ROLES.filter(role => !combo.coverage[role]);
    const expand = (index, items) => {
      if (index === missing.length) { add(items); return; }
      for (const item of singles[missing[index]].slice(0, 3)) if (item.productCode !== combo.productCode) expand(index + 1, [...items, item]);
    };
    expand(0, [combo]);
  }
  for (const main of singles.main) for (const side of singles.side) for (const drink of singles.drink) add([main, side, drink]);
  generated.sort((a, b) => {
    if (a.estimatedOverBudget !== b.estimatedOverBudget && a.estimatedOverBudget !== null && b.estimatedOverBudget !== null) return a.estimatedOverBudget ? 1 : -1;
    if (intent !== 'low_budget' && a._score !== b._score) return b._score - a._score;
    const cost = (a.estimatedCents ?? Number.MAX_SAFE_INTEGER) - (b.estimatedCents ?? Number.MAX_SAFE_INTEGER);
    return cost || b._score - a._score || Number(b._combo) - Number(a._combo) || a.items.length - b.items.length || a._key.localeCompare(b._key);
  });
  maxCandidates = Math.max(1, Math.min(10, Number.isSafeInteger(maxCandidates) ? maxCandidates : 8));
  const chosen = generated.slice(0, maxCandidates);
  if (maxCandidates >= 3) {
    // Compare different current coupons, rather than spending both offer slots
    // on the same coupon paired with two different mains.
    const offerCandidates = new Map();
    for (const candidate of generated) for (const item of candidate.items) {
      if (item.offerRef && !offerCandidates.has(item.offerRef) && offerCandidates.size < 2) offerCandidates.set(item.offerRef, candidate);
    }
    const reserved = [...new Set([...offerCandidates.values(), generated.find(candidate => !candidate.membershipTagged && !candidate._offer)].filter(Boolean))];
    for (const candidate of reserved) if (!chosen.includes(candidate)) {
      let index = chosen.length - 1;
      while (index >= 0 && reserved.includes(chosen[index])) index--;
      if (chosen.length < maxCandidates) chosen.push(candidate);
      else if (index >= 0) chosen[index] = candidate;
    }
  }
  const candidates = chosen.map(({ _score, _combo, _offer, _key, ...candidate }) => candidate);
  if (!candidates.length && !missingRoles.length) notices.push(intent === 'fries' ? '当前已核验选项中无法组成含薯条的完整一餐；未用单份薯条替代。' : intent === 'breakfast' ? '当前已核验选项没有早餐主食，未使用午晚餐冒充早餐。' : '当前套餐规格暂不能组成主食、小食和饮料齐全的一餐，请刷新菜单或手动选择。');
  if (candidates.length && Number.isSafeInteger(budgetCents) && candidates.every(candidate => candidate.estimatedOverBudget === true)) notices.push('完整一餐的菜单展示价均高于当前预算；仍需官方核价确认，未通过删除主食、小食或饮料凑预算。');
  return { candidates, notices, missingRoles };
}
