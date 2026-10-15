// Pure, menu-grounded text extraction. A note is source material, never an
// instruction or an authority for availability, nutrition, promotions or price.
// This deliberately small parser does not perform fuzzy/semantic substitution.

const INTENTS = {
  low_calorie: '减脂期低卡', low_budget: '低预算', fries: '薯条星人',
  breakfast: '早餐不纠结', new_products: '新品尝鲜', dessert: '甜品脑袋', custom: '自定义偏好',
};
const ALIAS_GROUPS = [
  ['板烧', '板烧鸡腿堡', '板烧鸡腿汉堡'],
  ['麦辣鸡腿堡', '麦辣鸡腿汉堡'],
  ['双吉', '双层吉士汉堡', '吉士双层牛肉堡', '吉士双层牛堡'],
  ['吉士汉堡', '吉士汉堡包'],
  ['麦乐鸡', '麦乐鸡块'],
  ['可乐', '可口可乐'],
  ['零度可乐', '零度可口可乐', '无糖可乐', '无糖可口可乐', '可口可乐零度', '可口可乐无糖'],
  ['小薯', '小薯条', '薯条小份', '小份薯条'],
  ['中薯', '中薯条', '薯条中份', '中份薯条'],
  ['大薯', '大薯条', '薯条大份', '大份薯条'],
  ['甜筒', '圆筒冰淇淋'],
];
const MODIFICATION = /去(?:蛋黄酱|番茄酱|沙拉酱|酱|皮|芝士|吉士|生菜|冰|糖|盐)|不(?:要|加|放)(?:蛋黄酱|番茄酱|沙拉酱|酱|芝士|吉士|生菜|冰|糖|盐)|少(?:酱|冰|糖|盐)|半糖|无盐|酱分开/gu;
const NEGATIVE = /不推荐|不建议|不值得|不要点|不要买|别点|别买|别尝试|不喜欢|不好吃|不好喝|难吃|难喝|踩雷|避雷|不吃|不点|不选|不考虑|失去风味|不搭|负分|拉完了/;
const POSITIVE = /推荐|建议|必点|爱吃|好吃|好喝|最爱|超爱|常点|回购|照着点|我的点法|可以点|我点|搭配|我的餐单|一餐|套餐|组合|点了/;
const REVIEW = /测评|评测|逐个|分别|横评|打分|对比|排名|盘点|vs\b/i;
const ALTERNATIVE = /或者|或是|二选一|任选|(?<![字])或(?![许])/u;
const COMBO = /套餐|组合|随心配|[二两三四五六]件套|[单双]人餐|全家桶/;
const FOOD_LIKE = /(?:堡|麦满分|麦旋风|冰淇淋|薯条|可乐|咖啡|鸡块|豆浆|圣代|红茶|柠檬茶|鸡排|奶昔|鸡翅|鸡腿|派)(?:[（(][^()（）]{0,10}[）)])?$/u;
const LIMITED_TEXT = 30000;

const array = value => Array.isArray(value) ? value : [];
const text = (value, limit = LIMITED_TEXT) => typeof value === 'string' ? value.slice(0, limit) : '';
const unique = values => [...new Set(values)];
const warning = (code, message) => ({ code, message });
const dedupeWarnings = values => [...new Map(values.map(value => [value.code + value.message, value])).values()];
const dedupeUnresolved = values => [...new Map(values.map(value => [value.reason + value.text, value])).values()];

export function normalizeFoodText(value) {
  return text(value).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

function normalizeWithPositions(value) {
  let normalized = ''; const positions = [];
  for (let index = 0; index < value.length;) {
    const character = String.fromCodePoint(value.codePointAt(index));
    const result = normalizeFoodText(character);
    normalized += result;
    for (let count = 0; count < result.length; count++) positions.push(index);
    index += character.length;
  }
  positions.push(value.length);
  return { normalized, positions };
}

function itemAliases(name) {
  const result = new Set([normalizeFoodText(name)]);
  const normalizedName = normalizeFoodText(name);
  // Some official catalogue entries are a family name. Explicit size aliases
  // retain a size hint; the service must verify the actual product detail/round.
  if (normalizedName === '薯条') for (const size of ['小', '中', '大']) {
    result.add(size + '薯'); result.add(size + '薯条'); result.add(size + '份薯条'); result.add('薯条' + size + '份');
  }
  if (['可乐', '可口可乐', '无糖可口可乐', '无糖可乐'].includes(normalizedName)) for (const size of ['小杯', '中杯', '大杯']) {
    result.add(size + normalizedName); result.add(normalizedName + size);
  }
  // Size labels are reordered, not discarded: a small drink cannot silently
  // become a medium one. The size-free spelling is an explicitly ambiguous key.
  const size = name.match(/^(.*?)[（(](小杯|中杯|大杯|小份|中份|大份)[）)]$/u)
    || name.match(/^(.*?)(小杯|中杯|大杯|小份|中份|大份)$/u);
  if (size) {
    const base = normalizeFoodText(size[1]);
    result.add(normalizeFoodText(size[2]) + base); result.add(base);
    if (base === '薯条') {
      result.add(size[2][0] + '薯'); result.add(size[2][0] + '薯条');
    }
    for (const group of ALIAS_GROUPS) if (group.some(alias => normalizeFoodText(alias) === base)) {
      for (const alias of group) { result.add(normalizeFoodText(size[2] + alias)); result.add(normalizeFoodText(alias)); }
    }
  }
  for (const group of ALIAS_GROUPS) if (group.some(alias => result.has(normalizeFoodText(alias)))) {
    // A sized product may inherit a generic alias, but never a differently sized
    // one. Menu indexing keeps the resulting ambiguity visible to the caller.
    for (const alias of group) result.add(normalizeFoodText(alias));
  }
  return [...result].filter(alias => alias.length >= 2);
}

export function buildMenuIndex(menu) {
  const byCode = new Map();
  for (const raw of array(Array.isArray(menu) ? menu : menu?.items)) {
    const productCode = String(raw?.productCode ?? raw?.id ?? '');
    const name = text(raw?.name, 200).trim();
    if (productCode && name && !byCode.has(productCode)) byCode.set(productCode, { productCode, name });
  }
  const aliases = new Map();
  for (const item of byCode.values()) for (const alias of itemAliases(item.name)) {
    if (!aliases.has(alias)) aliases.set(alias, []);
    aliases.get(alias).push(item);
  }
  return { items: [...byCode.values()], aliases };
}

function mentionsIn(value, index) {
  const { normalized, positions } = normalizeWithPositions(value);
  const spans = [];
  for (const [alias, candidates] of index.aliases) {
    let from = 0;
    while (from < normalized.length) {
      const start = normalized.indexOf(alias, from);
      if (start === -1) break;
      const end = start + alias.length;
      const before = normalized.slice(Math.max(0, start - 5), start);
      const specificity = before.match(/(?:无糖|零度|双层)$/u)?.[0];
      // The inner word 可乐 is not evidence for a sugar-free drink when the
      // catalogue only offers regular 可乐. Do not weaken the requested variant.
      if (!specificity || candidates.every(item => normalizeFoodText(item.name).includes(specificity))) {
        spans.push({ start: positions[start], end: positions[end - 1] + 1, length: alias.length, candidates });
      }
      from = start + Math.max(1, alias.length);
    }
  }
  spans.sort((left, right) => right.length - left.length || left.start - right.start);
  const selected = [];
  for (const span of spans) {
    const same = selected.find(other => span.start === other.start && span.end === other.end);
    if (same) {
      same.candidates = [...new Map([...same.candidates, ...span.candidates].map(item => [item.productCode, item])).values()];
    } else if (!selected.some(other => span.start < other.end && span.end > other.start)) selected.push(span);
  }
  return selected.sort((left, right) => left.start - right.start);
}

function clausesAround(value, occurrence) {
  const before = value.slice(0, occurrence.start);
  const after = value.slice(occurrence.end);
  const start = Math.max(before.lastIndexOf('，'), before.lastIndexOf(','), before.lastIndexOf('：'), before.lastIndexOf(':')) + 1;
  const next = after.search(/[，,:：]/u);
  return { before: before.slice(start), after: next === -1 ? after : after.slice(0, next) };
}

function sentiment(value, occurrence) {
  const clause = clausesAround(value, occurrence);
  const local = (clause.before + clause.after).replace(/不踩雷|不难吃|不难喝|不腻|不辣/gu, '');
  if (NEGATIVE.test(local)) return 'negative';
  return POSITIVE.test(value) ? 'recommendation' : 'mention';
}

function shortEvidence(value, occurrence, maximum = 96) {
  value = value.trim();
  if (value.length <= maximum) return value;
  const start = Math.max(0, Math.min((occurrence?.start || 0) - 20, value.length - maximum));
  return (start ? '…' : '') + value.slice(start, start + maximum) + (start + maximum < value.length ? '…' : '');
}

function number(value) {
  if (/^\d{1,2}$/u.test(value)) return Number(value);
  return ({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 })[value];
}

function quantityAt(value, occurrence) {
  const before = value.slice(Math.max(0, occurrence.start - 12), occurrence.start);
  const after = value.slice(occurrence.end, occurrence.end + 12);
  const prefix = before.match(/([0-9]{1,2}|[一二两三四五六七八九十])\s*(?:份|个|杯|套|盒)\s*$/u);
  const suffix = after.match(/^\s*(?:[xX×*]\s*([0-9]{1,2})|([0-9]{1,2}|[一二两三四五六七八九十])\s*(?:份|个|杯|套|盒))/u);
  const quantities = [prefix?.[1], suffix?.[1] || suffix?.[2]].filter(Boolean).map(number);
  if (!quantities.length) return { quantity: 1, explicit: false };
  if (quantities.some(item => !Number.isInteger(item) || item < 1 || item > 10) || new Set(quantities).size > 1) return { quantity: 1, explicit: true, invalid: true };
  return { quantity: quantities[0], explicit: true };
}

function hintValues(value) {
  const hints = [];
  for (const matched of value.matchAll(MODIFICATION)) hints.push({ text: matched[0], type: 'modification', value: matched[0] });
  for (const matched of value.matchAll(/(?:饮料|饮品|配餐|薯条)?(?:换成|改成|换|选择)([^，,。！？!?；;\n+＋]{2,24})/gu)) {
    const before = value.slice(Math.max(0, matched.index - 3), matched.index);
    if (/不要|别|不建议|不推荐/u.test(before)) continue;
    const choice = matched[1].replace(/(?:即可|就行|最好|吧|哦|呀)[！!。]*$/u, '').trim();
    hints.push({ text: matched[0], type: 'choice', value: choice });
  }
  for (const matched of value.matchAll(/小杯|中杯|大杯|小份|中份|大份/gu)) hints.push({ text: matched[0], type: 'size', value: matched[0] });
  for (const matched of value.matchAll(/(?:小|中|大)薯(?:条)?/gu)) hints.push({ text: matched[0], type: 'size', value: matched[0][0] + '份' });
  for (const matched of value.matchAll(/(?:([0-9]{1,2}|[一二两三四五六七八九十])\s*块\s*麦乐鸡(?:块)?|麦乐鸡(?:块)?\s*([0-9]{1,2}|[一二两三四五六七八九十])\s*块)/gu)) {
    hints.push({ text: matched[0], type: 'size', value: String(number(matched[1] || matched[2])) + '块' });
  }
  return [...new Map(hints.map(hint => [hint.type + hint.value, hint])).values()];
}

function choiceOccurrence(value, occurrence) {
  const before = value.slice(Math.max(0, occurrence.start - 15), occurrence.start);
  return /(?:饮料|饮品|配餐|薯条)?(?:换成|改成|换|选择)[^，,。！？!?；;\n+＋]{0,8}$/u.test(before);
}

function unknownFoods(value, mentions) {
  const unresolved = [];
  // Only food-shaped fragments in explicit lists are surfaced. Arbitrary prose
  // and quantities/prices are never turned into invented menu products.
  for (const raw of value.split(/[+＋、，,：:\n]/u)) {
    let fragment = raw.trim().replace(/^[\s\d.、①②③④⑤⑥-]*(?:推荐|必点|搭配|再加|加上|我点|点了|点|一份|一杯|一个)[:：\s]*/u, '').replace(/\s*(?:[xX×*]\s*\d+|[0-9一二两三四五六七八九十]+\s*(?:份|个|杯|套|盒))$/u, '');
    fragment = fragment.replace(/(?:很好吃|好吃|好喝|不错|必点|推荐|不推荐|不好吃|不好喝|不要点|别点|避雷|踩雷).*$/u, '').trim();
    if (fragment.length < 2 || fragment.length > 22 || !FOOD_LIKE.test(fragment)) continue;
    if (mentions.some(mention => raw.includes(value.slice(mention.start, mention.end)))) continue;
    unresolved.push({ text: fragment, reason: 'current_menu_missing', message: '原文提到的餐品未能与当前门店菜单确认对应；没有自动替换。' });
  }
  return unresolved;
}

function ungroundedExtras(value, mentions, index) {
  const unresolved = [];
  const categories = [
    [/雪糕|冰激凌|冰淇淋/gu, /冰淇淋|新地|麦旋风|圣代|甜筒/u],
    [/汉堡/gu, /汉堡|堡/u],
    [/饮料|饮品/gu, /可乐|咖啡|茶|奶|豆浆|水/u],
  ];
  for (const [expression, candidates] of categories) for (const match of value.matchAll(expression)) {
    if (mentions.some(mention => mention.start <= match.index && mention.end >= match.index + match[0].length)) continue;
    // A field label followed by an actual choice is not an unspecified drink.
    if (/^(?:饮料|饮品)$/u.test(match[0]) && /^(?:换|选|改)/u.test(value.slice(match.index + match[0].length))) continue;
    unresolved.push({ text: match[0], reason: 'unspecified_category', message: '原文只写泛称，不能擅定当前菜单的具体产品或规格。', candidates: index.items.filter(item => candidates.test(item.name)).slice(0, 12) });
  }
  for (const match of value.matchAll(/绝味鸭脖|鸭脖|海白菜|藕片|卤味|甜酸酱|蒜蓉辣酱|番茄酱|芝麻酱/gu)) {
    if (mentions.some(mention => mention.start <= match.index && mention.end >= match.index + match[0].length)) continue;
    unresolved.push({ text: match[0], reason: 'current_menu_missing', message: '原文配料或外部食品未在当前门店菜单中确认有售，未从餐单中悄悄省略或自动替换。' });
  }
  return unresolved;
}

function sourceSegments(content) {
  const lines = content.split(/\n+/u), result = [];
  let block = '';
  for (const line of lines) {
    if (/^【[^】]{1,45}】/u.test(line.trim())) {
      if (block) result.push(block.trim());
      block = line;
    } else if (block) block += '\n' + line;
    else result.push(...line.split(/[。！？!?；;]+/u).map(value => value.trim()).filter(Boolean));
  }
  if (block) result.push(block.trim());
  return result.slice(0, 160);
}

function withoutHashtags(value) {
  // Topic labels are discovery metadata, not a readable recommendation. Do not
  // manufacture a food plan from a picture caption that is only hashtags.
  return value.replace(/#[^#\n]{1,100}(?:\[话题\])?#/gu, '').trim();
}

function normalizeIntent(value) {
  const raw = typeof value === 'string' ? value : value?.id || value?.key || value?.label || value?.keyword || 'custom';
  const key = Object.hasOwn(INTENTS, raw) ? raw : Object.keys(INTENTS).find(item => raw.includes(INTENTS[item]) || INTENTS[item].includes(raw)) || 'custom';
  return { key, label: INTENTS[key] };
}

function sourceOf(note) {
  let url = '';
  try {
    const parsed = new URL(note?.url || '');
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && /(^|\.)(xiaohongshu\.com|xhslink\.com)$/u.test(parsed.hostname)) url = parsed.href;
  } catch { /* The absence of a public URL is not permission to invent one. */ }
  return { id: text(note?.id || note?.noteId, 80), title: text(note?.title, 200), url, ...(typeof note?.author === 'string' ? { author: text(note.author, 80) } : {}) };
}

function sourceWarnings(value, intent, budgetCents) {
  const warnings = [];
  if (/[¥￥]\s*\d|\d+(?:\.\d+)?\s*(?:元|块钱)/u.test(value)) warnings.push(warning('note_price_not_quote', '笔记中的金额仅是作者描述，未作为当前门店价格；以实时官方核价为准。'));
  const promotionText = value.replace(/不用券|无需券|不需要券|无券|无需会员|不用会员/gu, '');
  if (/优惠券|领券|用券|券后|会员|学生价|学生认证|团购|直播间|优惠码|大神卡|早餐卡|金卡|新人价|新客|积分兑换|专享价/u.test(promotionText)) warnings.push(warning('promotion_eligibility', '笔记提到优惠或身份资格，当前未核验领取、账户资格及有效期；官方试算不代表已获得该优惠。'));
  if (intent.key === 'low_calorie' || /(?:\d\s*(?:kcal|千卡|大卡)|热量|卡路里|低卡|减脂|高蛋白)/iu.test(value)) warnings.push(warning('nutrition_unverified', '当前菜单没有完整的官方营养数据，无法确认热量、减脂适用性或营养是否完整；不将“低卡”作为已验证结论。'));
  if (intent.key === 'low_budget') warnings.push(warning('budget_not_lowest', '按当前门店实时核价判断预算；未穷举全部组合及账户优惠，不承诺最低价。'));
  if (budgetCents !== undefined && (!Number.isSafeInteger(budgetCents) || budgetCents < 0)) warnings.push(warning('invalid_budget', '预算格式无效；未根据该预算筛选餐单。'));
  if (/前者|后者|上面那个|下面那个/u.test(value) && NEGATIVE.test(value)) warnings.push(warning('reference_ambiguous', '原文用前者、后者等指代评价，无法可靠对应具体餐品，请核对原文。'));
  return warnings;
}

function intentScore(draft, intent) {
  const names = draft.matches.map(item => item.name).join(' ');
  if (intent.key === 'fries') return /薯条|薯/u.test(names) ? 2 : 0;
  if (intent.key === 'breakfast') return /麦满分|早餐|脆薯饼|油条|豆浆|早安/u.test(names) ? 2 : 0;
  if (intent.key === 'dessert') return /麦旋风|圣代|冰淇淋|甜筒|派|奶昔/u.test(names) ? 2 : 0;
  return 0;
}

export function parseRecommendation({ note = {}, menu = [], intent = 'custom', budgetCents } = {}) {
  const selectedIntent = normalizeIntent(intent);
  const source = sourceOf(note);
  const title = text(note.title, 200).trim(), rawBody = text(note.body || note.desc).trim();
  const body = withoutHashtags(rawBody);
  const index = buildMenuIndex(menu);
  const warnings = sourceWarnings(title + '\n' + body, selectedIntent, budgetCents);
  const unresolved = [];
  if (!index.items.length) return { version: '1.0', intent: selectedIntent, drafts: [], unresolved: [{ text: '', reason: 'menu_empty', message: '当前门店没有可用于匹配的真实菜单。' }], warnings, needsConfirmation: true };
  if (!title && !body) return { version: '1.0', intent: selectedIntent, drafts: [], unresolved: [{ text: '', reason: 'note_empty', message: '尚未读取到笔记正文。' }], warnings, needsConfirmation: true };
  if (rawBody && !body) warnings.push(warning('caption_only', '正文仅有话题标签，图片里的点法尚未读取，不能从标签推断餐单。'));

  // Prefer body evidence: a list in a clickbait/review title cannot override a
  // rejection in the body. Title-only extraction remains explicitly tentative.
  const bodyMentions = mentionsIn(body, index);
  const titleOnly = bodyMentions.length === 0;
  const content = titleOnly ? title + (body ? '\n' + body : '') : body;
  if (titleOnly) warnings.push(warning('title_only_match', '餐品名称主要来自标题，正文未确认点法，请核对原文后再采用。'));
  const segments = sourceSegments(content);
  const sectionedReview = /^【[^】]{1,45}】/mu.test(content);
  const rejected = new Set(), conflicted = new Set(), observed = new Map();
  const prepared = segments.map(value => {
    const section = /^【[^】]{1,45}】/u.test(value);
    const lowRating = section && ((value.match(/⭐/gu) || []).length > 0 && (value.split('\n')[0].match(/⭐/gu) || []).length <= 2);
    const highRating = section && (value.split('\n')[0].match(/⭐/gu) || []).length >= 4;
    const rejectedSection = section && (lowRating || NEGATIVE.test(value));
    const mentions = mentionsIn(value, index).map(occurrence => ({ ...occurrence, sentiment: rejectedSection ? 'negative' : highRating ? 'recommendation' : sentiment(value, occurrence) }));
    for (const occurrence of mentions) if (occurrence.candidates.length === 1) {
      const code = occurrence.candidates[0].productCode;
      if (!observed.has(code)) observed.set(code, new Set());
      observed.get(code).add(occurrence.sentiment);
      if (occurrence.sentiment === 'negative') rejected.add(code);
    }
    return { value, mentions };
  });
  for (const [code, sentiments] of observed) if (sentiments.has('negative') && sentiments.has('recommendation')) conflicted.add(code);
  if (!sectionedReview) for (const code of conflicted) unresolved.push({ text: index.items.find(item => item.productCode === code)?.name || '', reason: 'conflicting_opinion', message: '原文对同一餐品同时出现推荐和否定，未自动采用。' });

  const groups = [];
  let explicitList = null;
  for (const { value, mentions } of prepared) {
    const hints = hintValues(value);
    const modifications = hints.filter(hint => hint.type === 'modification');
    const alternative = ALTERNATIVE.test(value);
    const header = /(?:一餐这样点|这一餐|这餐点|我的餐单|照着点|点单清单|点法|搭配如下|推荐搭配)[:：]?$/u.test(value);
    const current = [];
    const comboPresent = mentions.some(occurrence => occurrence.candidates.length === 1 && COMBO.test(occurrence.candidates[0].name));
    const previousCombos = groups.at(-1)?.matches.filter(item => COMBO.test(item.name)) || [];
    const boundOptionsOnly = !comboPresent && previousCombos.length === 1 && hints.length && /^(?:饮料|饮品|配餐|薯条)?(?:换|改成|选择|去|少|不加)/u.test(value);
    const localUnresolved = [...unknownFoods(value, mentions), ...ungroundedExtras(value, mentions, index)].filter(item => !((comboPresent || boundOptionsOnly) && /^(?:饮料|饮品|配餐|薯条)?(?:换|改成|选择)/u.test(item.text)));
    unresolved.push(...localUnresolved);
    if (boundOptionsOnly) {
      const combo = previousCombos[0];
      combo.roundHints.push(...hints);
      if (modifications.length) combo._unresolved.push({ text: modifications.map(hint => hint.text).join('、'), reason: 'modification_unverified', message: '原文特调尚未验证支持，未自动执行。' });
      if (alternative) combo._unresolved.push({ text: shortEvidence(value), reason: 'alternative_choice', message: '原文提供多个配餐选项，需要选择具体规格。' });
      combo.evidence.push(shortEvidence(value));
      groups.at(-1).evidence.push({ text: shortEvidence(value), productCode: combo.productCode, kind: 'recommendation' });
      continue;
    }
    for (const occurrence of mentions) {
      if (occurrence.sentiment === 'negative') continue;
      if (comboPresent && choiceOccurrence(value, occurrence) && !COMBO.test(occurrence.candidates[0]?.name || '')) continue;
      if (occurrence.candidates.length !== 1) {
        const textValue = value.slice(occurrence.start, occurrence.end);
        const ambiguity = { text: textValue, reason: 'ambiguous_menu_match', message: '当前菜单存在多个同名或不同规格餐品，未自动选择。', candidates: occurrence.candidates.map(item => ({ ...item })) };
        unresolved.push(ambiguity); localUnresolved.push(ambiguity); continue;
      }
      const item = occurrence.candidates[0];
      if (!sectionedReview && rejected.has(item.productCode)) continue;
      const quantity = quantityAt(value, occurrence);
      const evidence = shortEvidence(value, occurrence);
      const previous = mentions.filter(mention => mention.end <= occurrence.start).at(-1);
      const next = mentions.find(mention => mention.start >= occurrence.end);
      const localText = value.slice(Math.max(previous?.end || 0, occurrence.start - 8), Math.min(next?.start ?? value.length, occurrence.end + 12));
      const associatedHints = comboPresent ? (COMBO.test(item.name) ? hints : hintValues(localText).filter(hint => hint.type !== 'choice')) : hintValues(localText);
      const matchUnresolved = [];
      if (quantity.invalid) matchUnresolved.push({ text: evidence, reason: 'quantity_unsupported', message: '原文份数超出 1–10 份或前后冲突，暂以 1 份展示，必须确认后核价。' });
      if (modifications.length) matchUnresolved.push({ text: modifications.map(hint => hint.text).join('、'), reason: 'modification_unverified', message: '原文含去酱、去配料、冰糖盐等特调，当前未验证门店支持，未自动执行。' });
      if (alternative && hints.some(hint => hint.type === 'choice')) matchUnresolved.push({ text: evidence, reason: 'alternative_choice', message: '原文提供多个配餐选项，需要先选择具体规格。' });
      current.push({ ...item, quantity: quantity.quantity, roundHints: associatedHints, evidence: [evidence], _sentiment: occurrence.sentiment, _unresolved: matchUnresolved });
    }
    const uniqueCurrent = [...new Map(current.map(item => [item.productCode, item])).values()];
    if (header && !REVIEW.test(value)) {
      explicitList = { matches: uniqueCurrent, unresolved: localUnresolved, evidence: uniqueCurrent.map(item => ({ text: item.evidence[0], productCode: item.productCode, kind: item._sentiment })), explicit: true };
      groups.push(explicitList); continue;
    }
    // "饮品换成…" can follow a combo sentence. Attach it to the last named
    // combo, never add another paid drink or apply it to unrelated products.
    if (!uniqueCurrent.length && hints.length && /^(?:饮料|饮品|配餐|薯条)?(?:换|改成|选择|去|少|不加)/u.test(value)) {
      const previous = groups.at(-1);
      const combos = previous?.matches.filter(item => COMBO.test(item.name)) || [];
      if (combos.length === 1) {
        combos[0].roundHints.push(...hints);
        if (modifications.length) combos[0]._unresolved.push({ text: modifications.map(hint => hint.text).join('、'), reason: 'modification_unverified', message: '原文特调尚未验证支持，未自动执行。' });
        if (alternative) combos[0]._unresolved.push({ text: shortEvidence(value), reason: 'alternative_choice', message: '原文提供多个配餐选项，需要选择具体规格。' });
        combos[0].evidence.push(shortEvidence(value));
        previous.evidence.push({ text: shortEvidence(value), productCode: combos[0].productCode, kind: 'recommendation' });
      } else unresolved.push({ text: shortEvidence(value), reason: 'unbound_option', message: '原文规格要求没有明确对应到某一餐品。' });
      continue;
    }
    if (!uniqueCurrent.length) continue;
    const explicitBundle = !alternative && !REVIEW.test(value) && (/[+＋]/u.test(value) || /搭配|配上|加上|一餐|这餐|点法|餐单|一起点|这一套/u.test(value));
    if (explicitList && !REVIEW.test(value) && !alternative) {
      explicitList.matches.push(...uniqueCurrent); explicitList.unresolved.push(...localUnresolved);
      explicitList.evidence.push(...uniqueCurrent.map(item => ({ text: item.evidence[0], productCode: item.productCode, kind: item._sentiment })));
    } else if (explicitBundle) groups.push({ matches: uniqueCurrent, unresolved: localUnresolved, evidence: uniqueCurrent.map(item => ({ text: item.evidence[0], productCode: item.productCode, kind: item._sentiment })), explicit: true });
    else {
      explicitList = null;
      for (const match of uniqueCurrent) groups.push({ matches: [match], unresolved: localUnresolved, evidence: [{ text: match.evidence[0], productCode: match.productCode, kind: match._sentiment }], explicit: false });
    }
  }

  const allDrafts = [];
  // A step-by-step eating recipe is one connected procedure. Do not show its
  // "plain fries" step as a complete version of a recipe requiring unspecified
  // ice cream. Explicitly separated rated reviews remain independent instead.
  const relatedRecipeUnresolved = !sectionedReview && /教程|第[一二三四五六七八九十0-9]+口|第[一二三四五六七八九十0-9]+步/u.test(title + '\n' + body) ? unresolved : [];
  for (const group of groups) {
    const matches = [...new Map(group.matches.map(item => [item.productCode, item])).values()];
    if (!matches.length) continue;
    const localWarnings = [...warnings];
    const localUnresolved = dedupeUnresolved([...group.unresolved, ...relatedRecipeUnresolved, ...matches.flatMap(item => item._unresolved)]);
    if (!group.explicit && matches.some(item => item._sentiment === 'mention')) localWarnings.push(warning('mention_requires_review', '原文只是提到餐品，未明确推荐或给出完整点法，请确认后采用。'));
    if (!group.explicit) localWarnings.push(warning('single_item_reference', '这是一项餐品参考；没有把独立测评拼成整餐，也不代表营养完整。'));
    const unresolvedCritical = localUnresolved.length > 0;
    const needsConfirmation = unresolvedCritical || titleOnly || localWarnings.some(item => ['promotion_eligibility', 'nutrition_unverified', 'reference_ambiguous', 'mention_requires_review'].includes(item.code));
    allDrafts.push({
      id: 'draft-' + (allDrafts.length + 1),
      title: matches.length > 1 ? '原文搭配 · ' + matches.slice(0, 2).map(item => item.name).join(' + ') : matches[0].name + ' · 原文参考',
      rationale: group.explicit ? '按原文明示的搭配匹配当前门店菜单，份数仅在原文明确时采用。' : '仅采用原文与当前门店菜单可明确对应的单品，不自行补齐整餐。',
      evidence: [...new Map(group.evidence.map(item => [item.text + item.productCode, item])).values()].slice(0, 4),
      matches: matches.slice(0, 12).map(({ _sentiment, _unresolved, ...item }) => ({ ...item, roundHints: [...new Map(item.roundHints.map(hint => [hint.type + hint.value, hint])).values()] })),
      unresolved: localUnresolved,
      warnings: dedupeWarnings(localWarnings), needsConfirmation, source,
    });
  }
  const bySelection = new Map();
  for (const draft of allDrafts) {
    const signature = JSON.stringify(draft.matches.map(item => [item.productCode, item.quantity, item.roundHints]));
    const prior = bySelection.get(signature);
    if (!prior || draft.unresolved.length < prior.unresolved.length || draft.unresolved.length === prior.unresolved.length && prior.evidence.every(item => item.kind === 'mention') && draft.evidence.some(item => item.kind === 'recommendation')) bySelection.set(signature, draft);
  }
  const distinct = [...bySelection.values()];
  distinct.sort((left, right) => intentScore(right, selectedIntent) - intentScore(left, selectedIntent));
  if (distinct.length > 3) warnings.push(warning('candidate_limit', '本次仅展示最相关的 3 个原文候选；没有将其合并成一份餐单。'));
  if (!distinct.length) unresolved.push({ text: shortEvidence(title || body), reason: 'no_confirmed_recommendation', message: '未找到可明确采用且当前门店有售的推荐餐品；没有生成替代餐品。' });
  const finalUnresolved = dedupeUnresolved([...unresolved, ...distinct.flatMap(draft => draft.unresolved)]);
  return { version: '1.0', intent: selectedIntent, drafts: distinct.slice(0, 3), unresolved: finalUnresolved, warnings: dedupeWarnings(warnings), needsConfirmation: finalUnresolved.length > 0 || distinct.some(draft => draft.needsConfirmation) };
}
