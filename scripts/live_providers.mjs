// Server-side, read-only adapters. Credentials and XHS access tokens never leave
// this module. No fixture import or estimated-price fallback is permitted here.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runFile = promisify(execFile);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const privateDirectory = path.join(project, 'private');
const MAX_RESPONSE = 8 * 1024 * 1024;
const TTL = 5 * 60 * 1000;
const ALLOWED = {
  mcd: new Set(['query-nearby-stores', 'query-meals', 'query-meal-detail', 'calculate-price', 'query-store-coupons']),
  xiaohongshu: new Set(['check_login_status', 'search_feeds', 'get_feed_detail']),
  amap: new Set(['maps_geo', 'maps_text_search', 'maps_search_detail', 'maps_direction_walking']),
};
const SOURCE_NAMES = { mcd: '麦当劳官方 MCP', xiaohongshu: '小红书 MCP', amap: '高德地图 MCP' };
const OPTIONAL_TOOLS = new Set(['query-store-coupons']);

export class ProviderError extends Error {
  constructor(code, message, provider = undefined) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.provider = provider;
  }
}
const fail = (code, message, provider) => { throw new ProviderError(code, message, provider); };
const cleanText = (value, limit = 500) => typeof value === 'string' ? value.slice(0, limit) : '';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const array = value => Array.isArray(value) ? value : [];
const envelope = (provider, data, time = Date.now()) => ({ source: SOURCE_NAMES[provider], queriedAt: new Date(time).toISOString(), mode: 'live', ...data });
const numeric = value => value !== '' && value != null && Number.isFinite(Number(value)) ? Number(value) : null;
const validDiscount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const conditionalMenuPrice = meal => meal?.canWithOrder === true || /麦金卡|随单购|开卡|购卡|会员专享/.test(cleanText(meal?.discountType, 100));
const membershipEvidence = () => ({ name: '麦金卡', status: 'unverified', evidence: [
  '当前官方 MCP 未返回会员身份、开卡状态或权益有效期，无法确认麦金卡资格。',
  '菜单中的“随单购麦金卡优惠”是附条件展示价，不能证明账号已有该权益。',
], pricingRule: '仅将官方核价返回的实际优惠计入推荐；不会自动购卡或假定金卡折扣。' });
function couponPeriod(value) {
  if (typeof value !== 'string') return null;
  const times = value.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g);
  if (times?.length !== 2) return null;
  const [start, end] = times.map(time => Date.parse(time.replace(' ', 'T') + '+08:00'));
  return Number.isFinite(start) && Number.isFinite(end) && start <= end ? { start, end } : null;
}

function inputText(value, name, maximum = 100) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f]/u.test(value)) fail('invalid_input', `${name}格式不正确。`);
  return value.trim();
}
export function coordinates(value) {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/.test(value)) fail('invalid_input', '请使用有效的经纬度。');
  const [lng, lat] = value.split(',').map(Number);
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90 || lng === 0 && lat === 0) fail('invalid_input', '经纬度超出范围。');
  return `${lng},${lat}`;
}
function validCoordinates(value) {
  try { return coordinates(value); } catch { return null; }
}
function safeImage(value, provider) {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) return undefined;
    const host = url.hostname.toLowerCase();
    if (provider === 'mcd' && host !== 'menu-img.mcd.cn') return undefined;
    if (provider === 'xiaohongshu' && !(host.endsWith('.xhscdn.com') || host === 'xhscdn.com')) return undefined;
    url.protocol = 'https:';
    return url.href;
  } catch { return undefined; }
}
export function yuanToCents(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, decimal = ''] = value.split('.');
  const result = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
  return Number.isSafeInteger(result) ? result : null;
}

// An authenticated helper is captured privately. Neither stderr nor the thrown
// exec error is forwarded: it can contain credentials or process arguments.
async function loadHeaders(provider) {
  const environmentToken = process.env[provider === 'mcd' ? 'MCD_MCP_TOKEN' : 'XHS_MCP_AUTH_TOKEN']?.trim();
  if (environmentToken) {
    if (/[\r\n]/.test(environmentToken)) fail('not_configured', '本机凭证格式无效。', provider);
    return { Authorization: `Bearer ${environmentToken}` };
  }
  const helper = provider === 'mcd' ? 'Read-McdHeaders.ps1' : 'Read-XhsMcpHeaders.ps1';
  try {
    let powershell = process.env.POWERSHELL_BIN;
    if (!powershell) {
      const bundled = path.join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native', 'powershell', 'pwsh.exe');
      try { await access(bundled); powershell = bundled; } catch { powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'; }
    }
    const result = await runFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(privateDirectory, helper)], {
      encoding: 'utf8', windowsHide: true, timeout: 50000, maxBuffer: 16384,
    });
    const parsed = JSON.parse(result.stdout);
    if (!object(parsed) || typeof parsed.Authorization !== 'string' || !/^Bearer [^\r\n]+$/.test(parsed.Authorization)) throw new Error();
    return { Authorization: parsed.Authorization };
  } catch { fail('not_configured', `${SOURCE_NAMES[provider]} 的本机凭证或启动配置不可用。`, provider); }
}

async function readRpcResponse(response, id) {
  const type = response.headers.get('content-type')?.split(';')[0].trim();
  if (!['application/json', 'text/event-stream'].includes(type)) fail('invalid_response', '数据服务返回了不支持的响应格式。');
  let size = 0;
  let buffer = '';
  let event = [];
  let events = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const reader = response.body.getReader();
  const match = message => {
    if (!object(message) || message.jsonrpc !== '2.0') fail('invalid_response', '数据服务返回了无效协议消息。');
    if (message.method) {
      if ('id' in message) fail('unsupported_response', '数据服务请求了此页面不支持的交互。');
      return { matched: false };
    }
    if (message.id !== id) return { matched: false };
    if (message.error || !('result' in message)) fail('provider_rejected', '数据服务拒绝了本次只读查询。');
    return { matched: true, value: message.result };
  };
  const line = value => {
    if (value === '') {
      if (++events > 1024) fail('response_limit', '数据服务响应事件过多。');
      const text = event.join('\n'); event = [];
      return text.trim() ? match(JSON.parse(text)) : { matched: false };
    }
    if (value.startsWith('data:')) event.push(value.slice(5).replace(/^ /, ''));
    return { matched: false };
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE) fail('response_limit', '数据服务响应超过大小限制。');
      buffer += decoder.decode(chunk.value, { stream: true });
      if (type === 'text/event-stream') {
        // Normalize CRLF while preserving a trailing CR until the next chunk.
        let end;
        while ((end = buffer.search(/[\r\n]/)) !== -1) {
          if (buffer[end] === '\r' && end === buffer.length - 1) break;
          const value = buffer.slice(0, end);
          const width = buffer[end] === '\r' && buffer[end + 1] === '\n' ? 2 : 1;
          buffer = buffer.slice(end + width);
          const found = line(value);
          if (found.matched) return found.value;
        }
      }
    }
    buffer += decoder.decode();
    if (type === 'application/json') {
      const found = match(JSON.parse(buffer.replace(/^\ufeff/, '')));
      if (found.matched) return found.value;
    }
    fail('incomplete_response', '数据响应未完整到达，请重新发起查询。');
  } finally { await reader.cancel().catch(() => {}); }
}

export class HttpMcpClient {
  constructor(provider, options = {}) {
    if (!['mcd', 'xiaohongshu'].includes(provider)) fail('invalid_provider', '不支持的数据服务。');
    this.provider = provider;
    this.endpoint = provider === 'mcd' ? 'https://mcp.mcd.cn' : 'http://127.0.0.1:18060/mcp';
    this.headerLoader = options.headerLoader || loadHeaders;
    this.fetch = options.fetch || globalThis.fetch;
    this.sequence = 0;
    this.version = '2025-03-26';
    this.headers = undefined;
    this.session = undefined;
    this.tools = new Map();
    this.initializing = null;
    this.tail = Promise.resolve();
  }
  async rpc(method, params, notification = false) {
    const id = ++this.sequence;
    const headers = { ...this.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this.version) headers['MCP-Protocol-Version'] = this.version;
    if (this.session) headers['Mcp-Session-Id'] = this.session;
    const response = await this.fetch(this.endpoint, {
      method: 'POST', redirect: 'error', headers,
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, ...(params ? { params } : {}) }),
      signal: AbortSignal.timeout(this.provider === 'xiaohongshu' ? 130000 : 45000),
    });
    if (!response.ok) fail(response.status === 401 || response.status === 403 ? 'authentication_required' : 'provider_unavailable', `${SOURCE_NAMES[this.provider]} 暂时无法完成查询。`, this.provider);
    const session = response.headers.get('Mcp-Session-Id');
    if (session !== null) {
      if (!/^[\x21-\x7e]{1,512}$/.test(session)) fail('invalid_response', '数据服务会话无效。', this.provider);
      this.session = session;
    }
    if (notification) { await response.body?.cancel(); return; }
    return readRpcResponse(response, id);
  }
  async initialize() {
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      this.headers = await this.headerLoader(this.provider);
      const initialized = await this.rpc('initialize', { protocolVersion: this.version, capabilities: {}, clientInfo: { name: 'social-to-meal-live', version: '0.3.0' } });
      if (!['2025-03-26', '2025-06-18', '2025-11-25'].includes(initialized?.protocolVersion)) fail('unsupported_protocol', '数据服务协议版本不受支持。', this.provider);
      this.version = initialized.protocolVersion;
      await this.rpc('notifications/initialized', undefined, true);
      let cursor;
      for (let page = 0; page < 5; page++) {
        const result = await this.rpc('tools/list', cursor ? { cursor } : {});
        for (const tool of array(result.tools)) if (ALLOWED[this.provider].has(tool.name)) this.tools.set(tool.name, tool);
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
        if (page === 4) fail('response_limit', '数据服务工具列表超过限制。', this.provider);
      }
      for (const name of ALLOWED[this.provider]) if (!OPTIONAL_TOOLS.has(name) && !this.tools.has(name)) fail('missing_tool', `${SOURCE_NAMES[this.provider]} 缺少必需的只读工具。`, this.provider);
    })();
    try { await this.initializing; } catch (error) { this.initializing = null; throw error; }
  }
  async call(name, args) {
    if (!ALLOWED[this.provider].has(name)) fail('tool_not_allowed', '页面不允许调用该工具。', this.provider);
    const work = this.tail.then(async () => {
      try {
        await this.initialize();
        if (!this.tools.has(name)) fail('missing_tool', `${SOURCE_NAMES[this.provider]} 当前未提供该只读工具。`, this.provider);
        return await this.rpc('tools/call', { name, arguments: args });
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        fail('provider_unavailable', `${SOURCE_NAMES[this.provider]} 查询失败或超时，请重试。`, this.provider);
      }
    });
    this.tail = work.catch(() => {});
    return work;
  }
  async close() { this.headers = undefined; this.session = undefined; }
}

class AmapClient {
  constructor() { this.connecting = null; this.client = null; }
  async initialize() {
    if (!this.connecting) this.connecting = (async () => {
      const base = path.join(privateDirectory, 'amap-runtime', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist');
      const [{ Client }, { StdioClientTransport }] = await Promise.all([
        import(pathToFileURL(path.join(base, 'client', 'index.js')).href),
        import(pathToFileURL(path.join(base, 'client', 'stdio.js')).href),
      ]);
      this.transport = new StdioClientTransport({ command: process.execPath, args: [path.join(privateDirectory, 'Start-AmapMcp.cjs')], stderr: 'pipe' });
      this.client = new Client({ name: 'social-to-meal-live', version: '0.3.0' }, { capabilities: {} });
      const timer = setTimeout(() => this.transport.close().catch(() => {}), 40000);
      try {
        await this.client.connect(this.transport);
        // Credential wrapper already redacts key material; discard diagnostics.
        this.transport.stderr?.on('data', () => {});
        const result = await this.client.listTools();
        for (const name of ALLOWED.amap) if (!array(result.tools).some(tool => tool.name === name)) fail('missing_tool', '高德 MCP 缺少必需的地图工具。', 'amap');
      } finally { clearTimeout(timer); }
    })();
    try { await this.connecting; } catch { this.connecting = null; await this.close(); fail('not_configured', '高德地图 MCP 的本机配置不可用。', 'amap'); }
  }
  async call(name, args) {
    if (!ALLOWED.amap.has(name)) fail('tool_not_allowed', '页面不允许调用该地图工具。', 'amap');
    try {
      await this.initialize();
      return await this.client.callTool({ name, arguments: args }, undefined, { timeout: 40000 });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      fail('provider_unavailable', '高德地图查询失败或超时，请重试。', 'amap');
    }
  }
  async close() { await this.client?.close().catch(() => {}); this.client = null; this.connecting = null; }
}

export function parseTool(result, provider) {
  if (!object(result) || result.isError) fail('provider_rejected', `${SOURCE_NAMES[provider]} 未能完成本次查询。`, provider);
  if (object(result.structuredContent)) return result.structuredContent;
  for (const block of array(result.content)) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue;
    try { return JSON.parse(block.text); } catch { /* Some MCPs include prose before a JSON object. */ }
    // Parse complete balanced objects, never execute text or markdown as code.
    const text = block.text;
    for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
      let depth = 0, quoted = false, escaped = false;
      for (let end = start; end < text.length; end++) {
        const character = text[end];
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') quoted = false;
        } else if (character === '"') quoted = true;
        else if (character === '{') depth++;
        else if (character === '}' && --depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, end + 1));
            if (provider !== 'mcd' || 'success' in parsed && 'data' in parsed) return parsed;
          } catch { /* Continue searching a later JSON object. */ }
          break;
        }
      }
    }
  }
  fail('invalid_response', `${SOURCE_NAMES[provider]} 返回的数据无法识别。`, provider);
}
function mcdData(result) {
  const payload = parseTool(result, 'mcd');
  if (payload.success !== true || payload.code !== 200 || !('data' in payload)) fail('business_rejected', '麦当劳当前无法提供所选门店或餐品，请刷新后重试。', 'mcd');
  return payload.data;
}
function defaultModification(modification) {
  const values = [];
  for (const group of array(modification?.items)) for (const option of array(group.values)) {
    const quantity = option.selectedQuantity ?? 0;
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 100) fail('invalid_response', '餐品默认特调数据不完整，请重新读取餐品。', 'mcd');
    const key = quantity > 0 ? option.selectedKey : option.unselectedKey;
    if (quantity > 0 && !key) fail('invalid_response', '餐品默认特调缺少有效编码。', 'mcd');
    if (key) {
      if (typeof option.code !== 'string' || !option.code || typeof key !== 'string' || /[\r\n]/.test(key)) fail('invalid_response', '餐品默认特调编码无效。', 'mcd');
      values.push({ code: option.code, key, quantity });
    }
  }
  return values.length ? { values } : undefined;
}

// Builds only parameters validated against the fetched current detail. The UI
// never supplies raw modification keys, coupons, order parameters or beCodes.
export function buildQuoteItem(request, detail) {
  if (!object(request) || Object.keys(request).some(key => !['productCode', 'quantity', 'roundList'].includes(key))) fail('invalid_input', '餐篮含有不支持的参数。');
  if (String(request.productCode) !== String(detail.code)) fail('invalid_input', '餐品编码与详情不一致。');
  const quantity = request.quantity;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) fail('invalid_input', '单份餐品数量须为 1 至 10。');
  const result = { productCode: String(detail.code), quantity };
  const modification = defaultModification(detail.modification);
  if (modification) result.modification = modification;
  const rounds = array(detail.rounds);
  if (request.roundList !== undefined && !Array.isArray(request.roundList)) fail('invalid_input', '套餐选配格式无效。');
  const provided = request.roundList;
  if (provided) {
    if (provided.some(round => !object(round) || !['string', 'number'].includes(typeof round.round) || Object.keys(round).some(key => !['round', 'comboItemList'].includes(key)) || !Array.isArray(round.comboItemList))) fail('invalid_input', '套餐选配参数无效。');
    if (new Set(provided.map(round => String(round.round))).size !== provided.length) fail('invalid_input', '套餐选配存在重复轮次。');
    if (provided.length !== rounds.length) fail('selection_stale', '门店的套餐选配轮次已变化，请重新打开“修改规格 / 份数”确认搭配。', 'mcd');
  }
  const roundList = [];
  for (const round of rounds) {
    const chosen = provided?.find(item => String(item.round) === String(round.id));
    if (provided && !chosen) fail('selection_stale', '门店的套餐选配轮次已变化，请重新打开“修改规格 / 份数”确认搭配。', 'mcd');
    if (chosen && (!object(chosen) || Object.keys(chosen).some(key => !['round', 'comboItemList'].includes(key)) || !Array.isArray(chosen.comboItemList))) fail('invalid_input', '套餐选配参数无效。');
    // Live data can mark multiple alternatives isDefault=1 while assigning
    // quantity=0 to an unselected alternative. Positive quantity is decisive.
    const selections = chosen ? chosen.comboItemList : array(round.choices)
      .filter(choice => typeof choice.quantity === 'number' ? choice.quantity > 0 : choice.isDefault === 1)
      .map(choice => ({ code: String(choice.code), quantity: choice.quantity > 0 ? choice.quantity : 1 }));
    if (selections.length > 30 || new Set(selections.map(item => String(item.code))).size !== selections.length) fail('invalid_input', '套餐选配存在重复或过多商品。');
    const comboItemList = [];
    let count = 0;
    for (const selection of selections) {
      if (!object(selection) || Object.keys(selection).some(key => !['code', 'quantity'].includes(key))) fail('invalid_input', '套餐商品参数无效。');
      const choice = array(round.choices).find(item => String(item.code) === String(selection.code));
      if (!choice) fail('selection_stale', '所选配餐已不在门店当前可选项中，请重新打开“修改规格 / 份数”确认搭配。', 'mcd');
      // McD uses -1 for an unbounded individual choice. The round constraint
      // still applies, together with this app's maximum of ten per choice.
      const choiceMaximum = choice && choice.maxQuantity >= 0 ? choice.maxQuantity : 10;
      if (!Number.isInteger(selection.quantity) || selection.quantity < 1 || selection.quantity > Math.min(choiceMaximum, 10)) fail('invalid_input', '套餐商品数量不在当前可选范围。');
      count += selection.quantity;
      const item = { code: String(choice.code), quantity: selection.quantity };
      const selectedModification = defaultModification(choice.modification);
      if (selectedModification) item.modification = selectedModification;
      comboItemList.push(item);
    }
    if (count < Math.max(round.minQuantity ?? 0, 0) || count > (round.maxQuantity >= 0 ? round.maxQuantity : 30)) fail('selection_required', `请确认“${cleanText(round.name, 80)}”的选配数量。`);
    roundList.push({ round: String(round.id), comboItemList });
  }
  if (roundList.length) result.roundList = roundList;
  return result;
}

export async function createProviders(options = {}) {
  const clients = options.clients || { mcd: new HttpMcpClient('mcd'), xiaohongshu: new HttpMcpClient('xiaohongshu'), amap: new AmapClient() };
  const now = options.now || Date.now;
  const knownStores = new Map();
  const menus = new Map();
  const details = new Map();
  const notes = new Map();
  const offers = new Map();
  const getStore = code => {
    const store = knownStores.get(code);
    if (!store || now() - store.time > 30 * 60 * 1000) fail('store_required', '请先搜索并选择当前门店。');
    return store;
  };
  const getOffer = (storeCode, productCode, offerRef) => {
    if (typeof offerRef !== 'string' || !/^[a-f0-9-]{36}$/i.test(offerRef)) fail('invalid_input', '优惠引用无效。');
    const cached = offers.get(storeCode);
    const offer = cached?.entries.get(offerRef);
    if (!offer?.eligible || now() - cached.time >= TTL || now() < offer.period.start || now() > offer.period.end || !offer.products.has(productCode)) fail('selection_stale', '当前优惠已过期或不适用这份餐品，请刷新门店优惠后重新搭配。', 'mcd');
    return offer;
  };
  const getProduct = (storeCode, productCode, offerRef = undefined) => {
    getStore(storeCode);
    if (offerRef !== undefined) return getOffer(storeCode, productCode, offerRef).products.get(productCode);
    const menu = menus.get(storeCode);
    if (!menu || now() - menu.time > TTL || !menu.products.has(productCode)) fail('menu_required', '菜单已变化或尚未读取，请先刷新门店菜单。');
    return menu.products.get(productCode);
  };
  async function getDetail(storeCode, productCode, useCache = false, offerRef = undefined) {
    getProduct(storeCode, productCode, offerRef);
    const key = `${storeCode}:${productCode}:${offerRef || ''}`;
    if (useCache && details.has(key) && now() - details.get(key).time < TTL) return details.get(key).raw;
    const raw = mcdData(await clients.mcd.call('query-meal-detail', { storeCode, orderType: 1, beType: 1, code: productCode }));
    if (!object(raw) || String(raw.code) !== productCode) fail('invalid_response', '麦当劳餐品详情与所选商品不一致。', 'mcd');
    details.set(key, { raw, time: now() });
    return raw;
  }
  const api = {
    async status() {
      const entries = await Promise.all(Object.entries(clients).map(async ([name, client]) => {
        try {
          await client.initialize?.();
          if (name === 'xiaohongshu') {
            const result = await client.call('check_login_status', {});
            if (result.isError) throw new Error();
            const text = array(result.content).filter(block => block.type === 'text').map(block => block.text).join('\n');
            if (!/已登录|登录成功|"is_logged_in"\s*:\s*true/.test(text)) return [name, { connected: true, loggedIn: false, status: 'login_required', message: '请在本机重新扫码登录小红书。' }];
          }
          return [name, { connected: true, ...(name === 'xiaohongshu' ? { loggedIn: true } : {}), status: 'ready' }];
        } catch { return [name, { connected: false, status: 'unavailable', message: `${SOURCE_NAMES[name]} 暂不可用，请检查本机配置。` }]; }
      }));
      return { mode: 'live', queriedAt: new Date(now()).toISOString(), providers: Object.fromEntries(entries) };
    },
    async geocode({ city, location }) {
      city = inputText(city, '城市', 40); location = inputText(location, '出发地点', 160);
      const normalizedInput = location.normalize('NFKC');
      const landmark = !/\d+\s*(?:号|弄|栋|幢|座|室|楼)/u.test(normalizedInput);
      if (landmark) {
        // The installed official text-search adapter omits coordinates. Resolve
        // only exact named POIs via its detail tool, checking the actual city.
        // This avoids interpreting a pedestrian-street landmark as another road.
        const cityName = value => cleanText(value, 80).normalize('NFKC').replace(/\s/g, '').replace(/市$/, '');
        const name = value => {
          let result = cleanText(value, 200).normalize('NFKC').replace(/\s/g, '');
          for (const prefix of [city, cityName(city)]) if (prefix && result.startsWith(prefix)) { result = result.slice(prefix.length); break; }
          return result;
        };
        try {
          const search = parseTool(await clients.amap.call('maps_text_search', { keywords: location, city }), 'amap');
          const matches = array(search.pois).filter(poi => typeof poi.id === 'string' && name(poi.name) === name(location)).slice(0, 3);
          const results = await Promise.allSettled(matches.map(async poi => {
            const detail = parseTool(await clients.amap.call('maps_search_detail', { id: poi.id }), 'amap');
            if (detail.id !== poi.id || name(detail.name) !== name(location) || cityName(detail.city) !== cityName(city) || !validCoordinates(detail.location)) return null;
            return { id: poi.id, name: cleanText(detail.name, 200), location: validCoordinates(detail.location), city: cleanText(detail.city, 80),
              address: cleanText(detail.address, 300), formattedAddress: `${cleanText(detail.city, 80)}${cleanText(detail.address, 300)} · ${cleanText(detail.name, 200)}`, level: '兴趣点',
            };
          }));
          const places = results.filter(result => result.status === 'fulfilled' && result.value).map(result => result.value);
          if (places.length) return envelope('amap', { location: places[0].location, formattedAddress: places[0].formattedAddress, places,
            resolution: 'poi', ambiguous: places.length > 1,
            resolutionNote: places.length > 1 ? '高德找到多个同名地点，当前采用首个结果，请核对具体地址。' : '已匹配高德同名地点，请核对具体地址。',
          }, now());
        } catch { /* Use a real address geocoder below, with an explicit uncertainty notice. */ }
      }
      const raw = parseTool(await clients.amap.call('maps_geo', { address: city + location, city }), 'amap');
      const places = array(raw.return).filter(place => validCoordinates(place.location)).slice(0, 8).map(place => ({
        location: validCoordinates(place.location), city: cleanText(place.city, 40) || city, district: cleanText(place.district, 40), level: cleanText(place.level, 40),
        formattedAddress: [place.province, place.city !== place.province ? place.city : '', place.district, place.street, typeof place.number === 'string' ? place.number : ''].filter(value => typeof value === 'string' && value).join('') || city + location,
      }));
      if (!places.length) fail('location_not_found', '高德未找到可用坐标，请填写更完整的地点。', 'amap');
      return envelope('amap', { location: places[0].location, formattedAddress: places[0].formattedAddress, places,
        resolution: 'geocode', ambiguous: landmark || new Set(places.map(place => place.location)).size > 1,
        resolutionNote: landmark ? '未确认同名地点，当前为地址解析结果，请核对城市、区县和具体地址。' : '请核对高德解析的具体地址。',
      }, now());
    },
    async stores({ city, location }) {
      city = inputText(city, '城市', 40); location = inputText(location, '出发地点', 160);
      const raw = mcdData(await clients.mcd.call('query-nearby-stores', { city, keyword: location, searchType: 2, beType: 1 }));
      if (!Array.isArray(raw)) fail('invalid_response', '麦当劳门店列表格式无效。', 'mcd');
      const stores = raw.filter(store => typeof store.storeCode === 'string' && typeof store.storeName === 'string').slice(0, 30).map(store => {
        const normalized = { id: store.storeCode, storeCode: store.storeCode, name: cleanText(store.storeName), address: cleanText(store.address),
          open: typeof store.businessStatus === 'boolean' ? store.businessStatus : null, businessStartTime: cleanText(store.businessStartTime, 20), businessEndTime: cleanText(store.businessEndTime, 20),
          distanceMeters: numeric(store.distance), reservation: store.reservation === true,
          reservationTimeOptions: array(store.reservationTimeOptions).map(option => ({ date: cleanText(option.date, 20), today: option.today === true, reservationOptionText: cleanText(option.reservationOptionText, 2000) })),
        };
        const coordinate = validCoordinates(`${store.longitude},${store.latitude}`);
        if (coordinate) normalized.location = coordinate;
        knownStores.set(store.storeCode, { ...normalized, city, time: now() });
        return normalized;
      });
      return envelope('mcd', { stores, orderType: 1, beType: 1, fulfillment: '到店自取' }, now());
    },
    async search({ keyword }) {
      keyword = inputText(keyword, '搜索关键词', 100);
      const raw = parseTool(await clients.xiaohongshu.call('search_feeds', { keyword }), 'xiaohongshu');
      if (!Array.isArray(raw.feeds)) fail('search_not_ready', '小红书搜索结果尚未准备好，请稍后重试。', 'xiaohongshu');
      const results = raw.feeds.filter(feed => /^[a-f0-9]{24}$/i.test(feed.id) && feed.xsecToken && feed.noteCard?.displayTitle).slice(0, 20).map(feed => {
        const card = feed.noteCard;
        const item = { id: feed.id, title: cleanText(card.displayTitle, 200), author: cleanText(card.user?.nickname || card.user?.nickName, 80),
          likes: cleanText(String(card.interactInfo?.likedCount ?? ''), 30), url: `https://www.xiaohongshu.com/explore/${feed.id}`,
          cover: safeImage(card.cover?.urlDefault || card.cover?.urlPre || card.cover?.url, 'xiaohongshu'), type: cleanText(card.type, 30),
        };
        notes.set(feed.id, { token: feed.xsecToken, time: now(), item });
        return item;
      });
      // Access tokens are kept only in this bounded, expiring server-side map.
      for (const [id, value] of notes) if (now() - value.time > 30 * 60 * 1000) notes.delete(id);
      while (notes.size > 200) notes.delete(notes.keys().next().value);
      return envelope('xiaohongshu', { keyword, notes: results }, now());
    },
    async note({ id }) {
      id = inputText(id, '笔记编号', 40);
      const known = notes.get(id);
      if (!known || now() - known.time > 30 * 60 * 1000) fail('note_required', '请从当前搜索结果中选择笔记。');
      const raw = parseTool(await clients.xiaohongshu.call('get_feed_detail', { feed_id: id, xsec_token: known.token, load_all_comments: false }), 'xiaohongshu');
      const note = raw.data?.note || raw.note;
      if (!object(note) || note.noteId !== id || !(note.title || note.desc)) fail('note_unavailable', '该笔记正文暂时无法读取，请换一篇或稍后重试。', 'xiaohongshu');
      return envelope('xiaohongshu', { note: { ...known.item, title: cleanText(note.title, 200) || known.item.title, body: cleanText(note.desc, 30000),
        author: cleanText(note.user?.nickname || note.user?.nickName, 80) || known.item.author,
        likes: cleanText(String(note.interactInfo?.likedCount ?? known.item.likes), 30),
        images: array(note.imageList).map(image => safeImage(image.urlDefault || image.urlPre || image.url, 'xiaohongshu')).filter(Boolean).slice(0, 9),
      } }, now());
    },
    async menu({ storeCode }) {
      storeCode = inputText(storeCode, '门店编号', 40); getStore(storeCode);
      const raw = mcdData(await clients.mcd.call('query-meals', { storeCode, orderType: 1, beType: 1 }));
      if (!object(raw?.meals) || !Array.isArray(raw.categories)) fail('invalid_response', '麦当劳菜单数据暂不可用。', 'mcd');
      const products = new Map();
      for (const [id, meal] of Object.entries(raw.meals)) if (object(meal) && typeof meal.name === 'string') products.set(id, meal);
      menus.set(storeCode, { products, time: now() });
      // A refreshed menu starts a new catalogue snapshot. Old details may retain
      // choices that have just sold out; never reuse those for the new snapshot.
      for (const key of details.keys()) if (key.startsWith(`${storeCode}:`)) details.delete(key);
      const tags = new Map();
      const categories = raw.categories.map(category => ({ name: cleanText(category.name, 100), ids: array(category.meals).map(meal => {
        const id = String(meal.code); tags.set(id, array(meal.tags).filter(tag => typeof tag === 'string').map(tag => cleanText(tag, 80))); return id;
      }).filter(id => products.has(id)) }));
      const items = [...products].map(([id, meal]) => ({ id, productCode: id, name: cleanText(meal.name, 200), image: safeImage(meal.image, 'mcd'),
        displayPrice: typeof meal.currentPrice === 'string' ? meal.currentPrice : null, displayPriceCents: yuanToCents(meal.currentPrice),
        originalPrice: typeof meal.originalPrice === 'string' ? meal.originalPrice : null, originalPriceCents: yuanToCents(meal.originalPrice), tags: tags.get(id) || [],
        discountType: cleanText(meal.discountType, 100), canWithOrder: meal.canWithOrder === true, conditionalPrice: conditionalMenuPrice(meal),
        priceCondition: conditionalMenuPrice(meal) ? '该展示价附带会员或随单购条件；不自动购卡，须以当前账号官方核价确认。' : '',
      }));
      return envelope('mcd', { storeCode, items, categories, priceType: '门店菜单展示价，最终金额以实时核价为准' }, now());
    },
    async offers({ storeCode }) {
      storeCode = inputText(storeCode, '门店编号', 40); getStore(storeCode);
      let cached = offers.get(storeCode);
      if (!cached || now() - cached.time >= TTL) {
        const raw = mcdData(await clients.mcd.call('query-store-coupons', { storeCode, orderType: 1, beType: 1 }));
        if (!Array.isArray(raw)) fail('invalid_response', '麦当劳门店优惠列表格式无效。', 'mcd');
        const entries = new Map();
        for (const coupon of raw.slice(0, 100)) {
          if (!object(coupon) || typeof coupon.title !== 'string') continue;
          const period = couponPeriod(coupon.tradeDateTime);
          // Dates and item-bound credentials are both required before a coupon
          // can enter a price calculation. Unknown conditions remain visible.
          const validCredentials = typeof coupon.couponId === 'string' && coupon.couponId.length > 0 && coupon.couponId.length <= 1024 && !/[\r\n]/.test(coupon.couponId)
            && typeof coupon.couponCode === 'string' && coupon.couponCode.length > 0 && coupon.couponCode.length <= 1024 && !/[\r\n]/.test(coupon.couponCode);
          const products = new Map(array(coupon.products).filter(product => typeof product?.productCode === 'string' && product.productCode.length <= 80 && product.productCode && typeof product.productName === 'string').map(product => [product.productCode, { name: cleanText(product.productName, 200) }]));
          entries.set(randomUUID(), { title: cleanText(coupon.title, 200), validTime: cleanText(coupon.tradeDateTime, 150), period, products,
            eligible: validCredentials && period !== null && now() >= period.start && now() <= period.end,
            ...(validCredentials ? { couponId: coupon.couponId, couponCode: coupon.couponCode } : {}),
          });
        }
        cached = { time: now(), entries }; offers.set(storeCode, cached);
        for (const [code, value] of offers) if (now() - value.time > TTL) offers.delete(code);
      }
      const currentlyEligible = coupon => coupon.eligible && now() >= coupon.period.start && now() <= coupon.period.end;
      const coupons = [...cached.entries].map(([id, coupon]) => ({ id, title: coupon.title, validTime: coupon.validTime, eligible: currentlyEligible(coupon),
        products: [...coupon.products].map(([productCode, product]) => ({ id: productCode, productCode, name: product.name })),
        applicationNote: currentlyEligible(coupon) ? '可作为当前门店优惠券餐品提交官方核价，实际金额以核价结果为准。' : '有效期或使用条件尚未验证，暂不计入搭配。',
      }));
      const eligibleItems = [...cached.entries].flatMap(([offerRef, coupon]) => currentlyEligible(coupon) ? [...coupon.products].map(([productCode, product]) => ({
        id: productCode, productCode, name: product.name, tags: ['当前账号优惠券'], offerRef, offerTitle: coupon.title,
        displayPrice: null, displayPriceCents: null, originalPrice: null, originalPriceCents: null, discountType: '优惠券待核价', conditionalPrice: true, requiresCoupon: true,
        priceCondition: '仅使用当前账号、当前门店已查询的优惠券；最终以官方核价确认。',
      })) : []);
      const menu = menus.get(storeCode);
      const conditionalMenuItems = menu && now() - menu.time < TTL ? [...menu.products].filter(([, meal]) => conditionalMenuPrice(meal)).map(([productCode, meal]) => ({ productCode, name: cleanText(meal.name, 200), discountType: cleanText(meal.discountType, 100), displayPriceCents: yuanToCents(meal.currentPrice), originalPriceCents: yuanToCents(meal.originalPrice) })) : [];
      return envelope('mcd', { storeCode, orderType: 1, beType: 1, membership: membershipEvidence(), coupons, eligibleItems, conditionalMenuItems,
        expiresAt: new Date(cached.time + TTL).toISOString(), pricingNote: '仅把当前门店、到店自取场景的官方实时报价计入预算；麦金卡标签和可用券不代表优惠已生效，不自动购卡。',
      }, cached.time);
    },
    async detail({ storeCode, productCode, offerRef }) {
      storeCode = inputText(storeCode, '门店编号', 40); productCode = inputText(productCode, '餐品编号', 80);
      const raw = await getDetail(storeCode, productCode, false, offerRef);
      return envelope('mcd', { storeCode, item: { id: String(raw.code), productCode: String(raw.code), name: cleanText(raw.name, 200), image: safeImage(raw.image, 'mcd'), supportModify: raw.supportModify === true,
        ...(offerRef ? { offerRef, offerTitle: getOffer(storeCode, productCode, offerRef).title } : {}),
        rounds: array(raw.rounds).map(round => ({ id: String(round.id), name: cleanText(round.name, 120), minQuantity: Math.max(round.minQuantity ?? 0, 0), maxQuantity: round.maxQuantity >= 0 ? round.maxQuantity : 30,
          choices: array(round.choices).map(choice => ({ id: String(choice.code), name: cleanText(choice.name, 150), quantity: typeof choice.quantity === 'number' ? choice.quantity : undefined, isDefault: choice.isDefault === 1, maxQuantity: choice.maxQuantity >= 0 ? choice.maxQuantity : Math.min(round.maxQuantity > 0 ? round.maxQuantity : 10, 10), diffPrice: cleanText(choice.diffPrice, 40), supportModify: choice.supportModify === true })),
        })), modificationNote: raw.supportModify ? '当前使用默认特调；如需了解特调，请查看商品说明。' : '',
      } }, now());
    },
    async quote({ storeCode, items }) {
      storeCode = inputText(storeCode, '门店编号', 40); getStore(storeCode);
      if (!Array.isArray(items) || items.length < 1 || items.length > 12 || new Set(items.map(item => item?.productCode)).size !== items.length) fail('invalid_input', '请选择 1 至 12 种不重复餐品。');
      const requests = [];
      const appliedOffers = [];
      const offerExpiries = [];
      for (const item of items) {
        if (!object(item) || Object.keys(item).some(key => !['productCode', 'quantity', 'roundList', 'offerRef'].includes(key))) fail('invalid_input', '餐篮含有不支持的参数。');
        const productCode = inputText(item?.productCode, '餐品编号', 80);
        const { offerRef, ...selection } = item;
        const request = buildQuoteItem(selection, await getDetail(storeCode, productCode, true, offerRef));
        if (offerRef !== undefined) {
          const offer = getOffer(storeCode, productCode, offerRef);
          request.couponId = offer.couponId; request.couponCode = offer.couponCode;
          appliedOffers.push({ offerRef, title: offer.title, productCode });
          offerExpiries.push(offers.get(storeCode).time + TTL, offer.period.end);
        }
        requests.push(request);
      }
      const data = mcdData(await clients.mcd.call('calculate-price', { storeCode, orderType: 1, beType: 1, items: requests, needTableware: false }));
      if (!Number.isSafeInteger(data?.price) || data.price < 0) fail('invalid_response', '麦当劳未返回有效的最终应付金额。', 'mcd');
      const productList = array(data.productList);
      if (productList.length !== requests.length || requests.some(request => !productList.some(product => product.productCode === request.productCode && product.quantity === request.quantity))) fail('invalid_response', '核价返回餐篮与所选餐品不一致，请刷新餐篮。', 'mcd');
      const timestamp = now();
      const expiresAt = Math.min(timestamp + TTL, ...offerExpiries);
      if (expiresAt <= timestamp) fail('selection_stale', '当前优惠在核价过程中已到期，请刷新门店优惠后重新搭配。', 'mcd');
      return envelope('mcd', { storeCode, currency: 'CNY', totalCents: data.price,
        originalCents: validDiscount(data.originalPrice), discountCents: validDiscount(data.discount),
        discountEvidence: { basis: 'official_calculate_price', confirmedCents: validDiscount(data.discount), attribution: 'unspecified', membershipAttributionVerified: false,
          note: '实际优惠以本次官方核价返回为准；未将优惠归因为已验证的麦金卡权益，未购卡。' }, appliedOffers,
        items: productList.map(product => ({ productCode: product.productCode, name: cleanText(product.productName, 200), quantity: product.quantity, subtotalCents: product.subtotal, originalSubtotalCents: validDiscount(product.originalSubtotal) })),
        selections: requests.map((request, index) => ({ productCode: request.productCode, quantity: request.quantity, ...(items[index].offerRef ? { offerRef: items[index].offerRef } : {}), ...(request.roundList ? { roundList: request.roundList.map(round => ({ round: round.round, comboItemList: round.comboItemList.map(item => ({ code: item.code, quantity: item.quantity })) })) } : {}) })),
        expiresAt: new Date(expiresAt).toISOString(), validityNote: appliedOffers.length ? '此报价为查询快照，有效期不超过 5 分钟或所用优惠的剩余有效期；结算以麦当劳官方确认为准。' : '此报价为查询快照，5 分钟后需重新核价；结算以麦当劳官方确认为准。',
      }, timestamp);
    },
    async route({ origin, destination }) {
      origin = coordinates(origin); destination = coordinates(destination);
      const raw = parseTool(await clients.amap.call('maps_direction_walking', { origin, destination }), 'amap');
      const route = raw.route;
      const selected = array(route?.paths)[0];
      if (!selected || numeric(selected.distance) === null || numeric(selected.duration) === null) fail('route_unavailable', '高德暂未返回有效步行路线。', 'amap');
      return envelope('amap', { origin, destination, distanceMeters: Number(selected.distance), durationSeconds: Number(selected.duration),
        steps: array(selected.steps).map(step => ({ instruction: cleanText(step.instruction, 500), road: cleanText(step.road, 100), distanceMeters: numeric(step.distance), durationSeconds: numeric(step.duration), orientation: cleanText(step.orientation, 50) })),
        navigationUrl: `https://uri.amap.com/navigation?from=${encodeURIComponent(origin)}&to=${encodeURIComponent(destination)}&mode=walk&coordinate=gaode&src=social-to-meal&callnative=1`,
        geometryAvailable: false,
      }, now());
    },
    async close() { await Promise.allSettled(Object.values(clients).map(client => client.close?.())); notes.clear(); details.clear(); menus.clear(); offers.clear(); knownStores.clear(); },
  };
  return api;
}
