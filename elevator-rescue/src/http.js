/**
 * 极简 HTTP 路由层（零依赖）：JSON 收发 + 路径参数 + 统一错误格式。
 */
import { createServer } from 'node:http';
import { httpError } from './validate.js';

export function createHttpServer(service) {
  const routes = [];

  const route = (method, pattern, handler) => {
    // pattern 形如 /api/incidents/:id
    const keys = [];
    const rx = new RegExp(
      `^${pattern.replace(/:[^/]+/g, (m) => {
        keys.push(m.slice(1));
        return '([^/]+)';
      })}$`,
    );
    routes.push({ method, rx, keys, handler });
  };

  // ---------- 资源 ----------
  route('POST', '/api/buildings', (req) => service.registerBuilding(req.body));
  route('GET', '/api/buildings', () => service.store.list('buildings'));
  route('POST', '/api/elevators', (req) => service.registerElevator(req.body));
  route('GET', '/api/elevators', () => service.store.list('elevators'));
  route('POST', '/api/cameras', (req) => service.registerCamera(req.body));
  route('GET', '/api/cameras', () => service.store.list('cameras'));
  route('POST', '/api/rescuers', (req) => service.registerRescuer(req.body));
  route('GET', '/api/rescuers', () => service.store.list('rescuers'));
  route('POST', '/api/rescuers/:id/location', (req, p) =>
    service.updateRescuer(p.id, req.body));

  // ---------- 接警 / 监控 ----------
  route('POST', '/api/incidents/alarms', (req) => service.receiveAlarm(req.body));
  route('POST', '/api/incidents/:id/monitor', (req, p) =>
    service.addMonitorEvent(p.id, req.body));
  route('POST', '/api/incidents/:id/notes', (req, p) =>
    service.addNote(p.id, req.body));

  // ---------- 派单 ----------
  route('GET', '/api/incidents/:id/suggest', (req, p) =>
    service.suggestRescuers(p.id, req.body));
  route('POST', '/api/incidents/:id/dispatch', (req, p) =>
    service.dispatch(p.id, req.body));
  route('POST', '/api/incidents/:id/reassign', (req, p) =>
    service.reassign(p.id, req.body));

  // ---------- 时序推进 ----------
  route('POST', '/api/incidents/:id/en-route', (req, p) =>
    service.markEnRoute(p.id, req.body));
  route('POST', '/api/incidents/:id/on-site', (req, p) =>
    service.markOnSite(p.id, req.body));
  route('POST', '/api/incidents/:id/rescued', (req, p) =>
    service.markRescued(p.id, req.body));
  route('POST', '/api/incidents/:id/close', (req, p) =>
    service.closeIncident(p.id, req.body));

  // ---------- 查询 ----------
  route('GET', '/api/incidents', (req) => service.listIncidents(req.query));
  route('GET', '/api/incidents/:id', (req, p) => service.getIncidentOrThrow(p.id));
  route('GET', '/api/incidents/:id/report', (req, p) => service.incidentReport(p.id));

  // ---------- SLA / 统计 ----------
  route('POST', '/api/sla/sweep', (req) => service.slaSweep(req.body));
  route('GET', '/api/stats', () => service.stats());

  route('GET', '/api/health', () => ({ ok: true, ts: new Date().toISOString() }));

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      req.query = Object.fromEntries(url.searchParams);
      req.body = await readJson(req);

      const found = routes.find((r) => {
        if (r.method !== req.method) return false;
        req.params = matchPath(r, url.pathname);
        return req.params !== null;
      });

      if (!found) {
        return send(res, 404, { error: `无此接口：${req.method} ${url.pathname}` });
      }
      const result = await found.handler(req, req.params);
      return send(res, 200, { ok: true, data: result });
    } catch (err) {
      const status = err.statusCode ?? 500;
      if (status >= 500) console.error('[server]', err);
      return send(res, status, { ok: false, error: err.message || String(err) });
    }
  });
}

function matchPath(routeDef, pathname) {
  const m = routeDef.rx.exec(pathname);
  if (!m) return null;
  const params = {};
  routeDef.keys.forEach((k, i) => {
    params[k] = decodeURIComponent(m[i + 1]);
  });
  return params;
}

async function readJson(req) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return {};
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, '请求体不是合法 JSON');
  }
}

function send(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}
