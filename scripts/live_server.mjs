/** Local consumer app. No generic MCP proxy, credentials or private files are served. */
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProviders } from './live_providers.mjs';
import { createMealPlanService } from './meal_plan_service.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const BODY_LIMIT = 64 * 1024;
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
class InputError extends Error {
  constructor(message, code = 'invalid_request', status = 400) { super(message); this.code = code; this.status = status; }
}
function text(value, label, maximum = 160) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum || /[\u0000-\u001f]/.test(value)) throw new InputError(`${label}格式不正确。`);
  return value.trim();
}
function coordinate(value) {
  const result = text(value, '坐标', 60);
  if (!/^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/.test(result)) throw new InputError('坐标格式应为经度,纬度。');
  const [lng, lat] = result.split(',').map(Number);
  if (Math.abs(lng) > 180 || Math.abs(lat) > 90 || (!lng && !lat)) throw new InputError('坐标超出有效范围。');
  return result;
}
function integer(value, label, min = 1, max = 10) {
  if (!Number.isInteger(value) || value < min || value > max) throw new InputError(`${label}须为${min}至${max}的整数。`);
  return value;
}
function basket(value) {
  if (!Array.isArray(value) || !value.length || value.length > 12) throw new InputError('请选择1至12种餐品。');
  return value.map(item => {
    if (!item || typeof item !== 'object') throw new InputError('餐品格式不正确。');
    const output = { productCode: text(item.productCode, '餐品编码', 128), quantity: integer(item.quantity, '餐品份数') };
    if (item.offerRef !== undefined) output.offerRef = text(item.offerRef, '优惠引用', 128);
    if (item.roundList !== undefined) {
      if (!Array.isArray(item.roundList) || item.roundList.length > 16) throw new InputError('套餐选项格式不正确。');
      output.roundList = item.roundList.map(round => {
        if (!round || !Array.isArray(round.comboItemList) || round.comboItemList.length > 32) throw new InputError('套餐选项格式不正确。');
        return { round: text(String(round.round ?? ''), '选配轮次', 128), comboItemList: round.comboItemList.map(choice => ({ code: text(choice?.code, '选项编码', 128), quantity: integer(choice?.quantity, '选项数量', 1, 20) })) };
      });
    }
    return output;
  });
}
async function bodyOf(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new InputError('请使用JSON请求。', 'content_type_required', 415);
  if (Number(req.headers['content-length'] ?? 0) > BODY_LIMIT) throw new InputError('请求内容过大。', 'body_too_large', 413);
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > BODY_LIMIT) throw new InputError('请求内容过大。', 'body_too_large', 413);
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new InputError('JSON内容无法读取。'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('请求须为JSON对象。');
  return body;
}
function commonHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
}
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
function safeError(error) {
  if (error instanceof InputError) return { status: error.status, code: error.code, message: error.message };
  const code = /^[a-z][a-z0-9_]{0,49}$/.test(error?.code ?? '') ? error.code : 'provider_error';
  const messages = {
    not_configured: '接口尚未配置，请检查本机连接。',
    not_logged_in: '小红书会话已失效，请在本机重新扫码。',
    authentication_required: '接口鉴权失败，请检查本机连接。',
    timeout: '查询超时，请稍后重试。',
    provider_unavailable: '数据服务暂时无法完成查询，请稍后重试。',
    provider_rejected: '数据服务未能完成本次查询，请刷新后重试。',
    business_rejected: '门店暂时无法提供所选餐品或搭配，请刷新菜单并重新确认。',
    invalid_response: '数据服务未返回完整有效的结果，请稍后重试。',
    invalid_request: '当前餐品或套餐选项无效，请重新选择。',
    invalid_selection: '套餐选项尚未完整选择，请检查搭配。',
    invalid_input: '当前餐品、份数或套餐选项无效，请检查后重试。',
    selection_required: '请完整选择每轮套餐搭配，并核对选配数量。',
    selection_stale: '门店套餐选项已变化，请点“修改规格 / 份数”重新确认搭配后核价。',
    store_required: '请先查询并选择门店。',
    menu_required: '菜单信息已过期，请刷新当前门店菜单。',
    note_required: '笔记读取信息已过期，请重新搜索后选择笔记。',
    note_unavailable: '该笔记正文暂时无法读取，请换一篇或稍后重试。',
    search_not_ready: '小红书搜索结果尚未就绪，请换一个关键词或稍后重试。',
    location_not_found: '未找到可用坐标，请填写更完整的地点。',
    route_unavailable: '暂未取得步行路线，请核对地点后重试。',
    unknown_store: '请先查询并选择当前门店。',
    unknown_product: '餐品信息已变化，请重新读取门店菜单。',
    no_results: '暂未取得可确认的结果，请换一个关键词。',
    planner_busy: '上一份推荐餐单还在解析中，请稍候完成后再试。',
    job_busy: '上一份推荐餐单还在解析中，请稍候完成后再试。',
    invalid_intent: '请选择一个搜索词条，或填写自己的关键词。',
  };
  return { status: code === 'timeout' ? 504 : 502, code, message: messages[code] ?? '服务暂时不可用，请稍后重试。' };
}

export async function createLiveServer({ providers, host = '127.0.0.1', port = 0, webRoot = path.join(directory, '..', 'web') } = {}) {
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('The local account app must bind to loopback.');
  if (!providers) providers = await createProviders();
  const csrfToken = randomBytes(32).toString('hex');
  const stores = new Map();
  const mealPlans = createMealPlanService({ providers });
  let boundPort;
  function requireCsrf(req) {
    const token = req.headers['x-csrf-token'];
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(csrfToken))) throw new InputError('页面连接已更新，请刷新后重试。', 'csrf_required', 403);
  }
  function requireStore(code) {
    const id = text(code, '门店编码', 128);
    const store = stores.get(id);
    if (!store) throw new InputError('请先查询并选择门店。', 'unknown_store');
    return store;
  }
  const server = http.createServer(async (req, res) => {
    commonHeaders(res);
    try {
      const hosts = new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`]);
      if (!hosts.has(req.headers.host)) throw new InputError('仅允许本机页面连接。', 'forbidden_host', 403);
      const origin = req.headers.origin;
      const origins = new Set([...hosts].map(value => `http://${value}`));
      if (origin && !origins.has(origin)) throw new InputError('页面来源不被允许。', 'forbidden_origin', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new InputError('不接受跨站请求。', 'forbidden_origin', 403);
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && url.pathname === '/api/status') {
        const state = await providers.status();
        return json(res, 200, { ok: true, mode: 'live', ...state, csrfToken, channel: '到店自取', orderType: 1, beType: 1 });
      }
      if (req.method === 'GET' && staticFiles.has(url.pathname) && !url.search) {
        const [filename, type] = staticFiles.get(url.pathname);
        const content = await readFile(path.join(webRoot, filename));
        res.writeHead(200, { 'Content-Type': type });
        return res.end(content);
      }
      const planMatch = /^\/api\/meal-plans\/([a-f0-9]{32,64})$/.exec(url.pathname);
      if (req.method === 'GET' && planMatch && !url.search) {
        requireCsrf(req);
        const job = mealPlans.get(planMatch[1]);
        if (!job) throw new InputError('餐单任务不存在或已过期，请重新生成。', 'job_not_found', 404);
        return json(res, 200, { ok: true, job });
      }
      const routes = new Set(['/api/location','/api/stores','/api/search','/api/note','/api/menu','/api/item','/api/quote','/api/route','/api/meal-plans']);
      if (req.method !== 'POST' || !routes.has(url.pathname) || url.search) throw new InputError('接口不存在。', 'not_found', 404);
      requireCsrf(req);
      const body = await bodyOf(req);
      let result;
      switch (url.pathname) {
        case '/api/location':
          result = await providers.geocode({ city: text(body.city, '城市', 50), location: text(body.location, '出发点') });
          if (result.location) coordinate(result.location);
          break;
        case '/api/stores': {
          const city = text(body.city, '城市', 50);
          result = await providers.stores({ city, location: text(body.location, '地点') });
          stores.clear();
          for (const store of result.stores ?? []) if (store.id && store.address) stores.set(String(store.id), { ...store, city });
          break;
        }
        case '/api/search':
          result = await providers.search({ keyword: text(body.keyword, '关键词', 80) }); break;
        case '/api/note':
          result = await providers.note({ id: text(body.id, '笔记编号', 128) }); break;
        case '/api/menu':
          requireStore(body.storeCode); result = await providers.menu({ storeCode: body.storeCode }); break;
        case '/api/item':
          requireStore(body.storeCode); result = await providers.detail({ storeCode: body.storeCode, productCode: text(body.productCode, '餐品编码', 128), ...(body.offerRef !== undefined ? { offerRef: text(body.offerRef, '优惠引用', 128) } : {}) }); break;
        case '/api/meal-plans': {
          const store = requireStore(body.storeCode);
          const intent = text(body.intent, '词条', 30);
          if (!['low_calorie','low_budget','fries','breakfast','new_products','dessert','custom'].includes(intent)) throw new InputError('请选择有效的搜索词条。', 'invalid_intent');
          const args = { storeCode: store.id, intent, keyword: text(body.keyword, '关键词', 80) };
          if (body.budgetCents !== undefined && body.budgetCents !== null) args.budgetCents = integer(body.budgetCents, '预算（分）', 0, 999900);
          if (body.noteIds !== undefined) {
            if (!Array.isArray(body.noteIds) || body.noteIds.length < 1 || body.noteIds.length > 3) throw new InputError('每次最多选择3篇笔记。');
            args.noteIds = [...new Set(body.noteIds.map(id => text(id, '笔记编号', 128)))];
          }
          result = mealPlans.start(args);
          break;
        }
        case '/api/quote': {
          requireStore(body.storeCode);
          const items = basket(body.items);
          result = await providers.quote({ storeCode: body.storeCode, items });
          if (!Number.isSafeInteger(result.totalCents) || result.totalCents < 0) throw new Error('Invalid provider price.');
          const now = Date.now();
          const quotedAt = result.quotedAt ?? result.queriedAt;
          const quotedTime = typeof quotedAt === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(quotedAt) ? Date.parse(quotedAt) : NaN;
          if (!Number.isFinite(quotedTime) || quotedTime > now + 30000 || quotedTime + 300000 <= now) throw new Error('Invalid or expired quote time.');
          const suppliedExpiry = Date.parse(result.expiresAt);
          if (result.expiresAt !== undefined && (!Number.isFinite(suppliedExpiry) || suppliedExpiry <= now)) throw new Error('Invalid or expired provider deadline.');
          result = { ...result, storeCode: body.storeCode, channel: '到店自取', beType: 1, orderType: 1,
            basket: items, quotedAt, expiresAt: new Date(Math.min(quotedTime + 300000, now + 300000, Number.isFinite(suppliedExpiry) ? suppliedExpiry : Infinity)).toISOString() };
          break;
        }
        case '/api/route': {
          const store = requireStore(body.storeCode);
          const originCoordinate = coordinate(body.origin);
          const destination = await providers.geocode({ city: store.city, location: store.address });
          const destinationCoordinate = coordinate(destination.location);
          result = await providers.route({ origin: originCoordinate, destination: destinationCoordinate });
          const navigation = new URL('https://uri.amap.com/navigation');
          navigation.search = new URLSearchParams({ from: `${originCoordinate},出发点`, to: `${destinationCoordinate},${store.name}`, mode: 'walk', src: 'mcd-social-to-meal', callnative: '1' }).toString();
          result = { ...result, destination: { location: destinationCoordinate, formattedAddress: destination.formattedAddress, queryAddress: store.address, source: '高德地址解析' },
            navigationUrl: navigation.href, locationNotice: '门店位置由官方门店地址经高德解析，请核对终点地址。' };
          break;
        }
      }
      return json(res, 200, { ok: true, ...result });
    } catch (error) {
      const safe = safeError(error);
      if (!res.headersSent) json(res, safe.status, { ok: false, error: { code: safe.code, message: safe.message, retryable: safe.status >= 500 } });
      else res.end();
    }
  });
  server.requestTimeout = 150000;
  server.headersTimeout = 15000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  boundPort = server.address().port;
  const url = `http://${host === '::1' ? '[::1]' : host}:${boundPort}`;
  return { server, address: server.address(), url, close: async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await mealPlans.close?.();
    await providers.close?.();
  } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
  const port = Number(option('--port') ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { process.stderr.write('Invalid local port.\n'); process.exit(2); }
  try {
    const app = await createLiveServer({ host: option('--host') ?? '127.0.0.1', port });
    process.stdout.write(`麦麦种草落地 · 真实数据版\nLocal: ${app.url}\n`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
  } catch { process.stderr.write('Unable to start local live app. Check the configured MCP services and local port.\n'); process.exitCode = 1; }
}
