// HTTP 路由：API 端点定义（薄层，业务逻辑都在 service.js）
import {
  ACCEPT_TIMEOUT_MS, ARRIVE_SLA_MIN, ApiError, SOURCE_LABELS,
  acceptDispatch, alarmDetail, arriveDispatch, cancelAlarm, completeDispatch,
  computeStats, createAlarm, departDispatch, getAlarm, getDispatch,
  reassignDispatch, releaseDispatch,
} from './service.js';
import { rankCandidates } from './dispatch.js';
import { renderSnapshot } from './monitor.js';
import { simulateRescue } from './simulate.js';

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

export function createRouter(ctx) {
  const { db } = ctx;
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const regex = new RegExp('^' + pattern.replace(/:[^/]+/g, (m) => {
      keys.push(m.slice(1));
      return '([^/]+)';
    }) + '$');
    routes.push({ method, regex, keys, handler });
  };

  // ---- 基础 ----
  route('GET', '/api/health', () => ({ ok: true, ts: new Date().toISOString() }));
  route('GET', '/api/meta', () => ({
    sources: SOURCE_LABELS,
    sla_min: ARRIVE_SLA_MIN,
    accept_timeout_ms: ACCEPT_TIMEOUT_MS,
  }));

  // ---- 档案 ----
  route('GET', '/api/buildings', () => db.buildings);
  route('GET', '/api/elevators', () => db.elevators.map((e) => ({
    ...e,
    building: db.buildings.find((b) => b.id === e.building_id) || null,
  })));
  route('GET', '/api/rescuers', () => db.rescuers);
  route('PATCH', '/api/rescuers/:id', ({ params, body }) => {
    const r = db.rescuers.find((x) => x.id === params.id);
    if (!r) throw new ApiError(404, '救援人员不存在');
    if (body.status !== undefined) {
      if (!['available', 'off_duty'].includes(body.status)) throw new ApiError(400, '状态只能是 available / off_duty');
      if (r.status === 'busy') throw new ApiError(409, '任务执行中，不能修改在岗状态');
      r.status = body.status;
    }
    if (body.location !== undefined) {
      const { lat, lng } = body.location || {};
      if (typeof lat !== 'number' || typeof lng !== 'number') throw new ApiError(400, '位置须为 { lat, lng } 数值');
      r.location = { lat, lng };
    }
    ctx.save();
    ctx.broadcast('update', { kind: 'rescuer', id: r.id });
    return r;
  });

  // ---- 报警 ----
  route('GET', '/api/alarms', ({ query }) => {
    const status = query.get('status');
    let list = [...db.alarms].sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (status) list = list.filter((a) => a.status === status);
    return list.slice(0, 100).map((a) => ({
      ...a,
      timeline: undefined,
      monitoring: undefined,
      elevator: db.elevators.find((e) => e.id === a.elevator_id) || null,
      building: db.buildings.find((b) => b.id === a.building_id) || null,
      active_dispatch: db.dispatches.find((d) => d.alarm_id === a.id && !['completed', 'cancelled'].includes(d.status)) || null,
    }));
  });

  route('POST', '/api/alarms', ({ body, res }) => {
    const alarm = createAlarm(ctx, body);
    if (body.simulate) {
      const d = db.dispatches.find((x) => x.alarm_id === alarm.id && x.status === 'dispatched');
      if (d) simulateRescue(ctx, d.id);
    }
    sendJson(res, 201, alarmDetail(db, alarm.id));
    return undefined;
  });

  route('GET', '/api/alarms/:id', ({ params }) => alarmDetail(db, params.id));
  route('POST', '/api/alarms/:id/cancel', ({ params, body }) => cancelAlarm(ctx, params.id, body.reason));

  route('GET', '/api/alarms/:id/monitoring', ({ params }) => {
    const a = getAlarm(db, params.id);
    return a.monitoring || { linked_at: null, cameras: [], sensors: null };
  });

  // 实时候选评分（调度台「候选评分」面板）
  route('GET', '/api/alarms/:id/candidates', ({ params }) => {
    const alarm = getAlarm(db, params.id);
    const building = db.buildings.find((b) => b.id === alarm.building_id);
    const { eligible, rejected } = rankCandidates(db.rescuers, { lat: building.lat, lng: building.lng });
    const tried = db.dispatches.filter((d) => d.alarm_id === alarm.id).map((d) => d.rescuer_id);
    return {
      eligible: eligible.map((c) => ({
        rescuer: c.rescuer,
        distance_km: Math.round(c.km * 100) / 100,
        eta_minutes: Math.round(c.eta * 10) / 10,
        score: Math.round(c.score * 1000) / 1000,
        breakdown: c.breakdown,
        already_tried: tried.includes(c.rescuer.id),
      })),
      rejected: rejected.map((x) => ({ rescuer: x.rescuer, reasons: x.reasons })),
    };
  });

  // ---- 调度单状态机 ----
  route('GET', '/api/dispatches', ({ query }) => {
    const alarmId = query.get('alarm_id');
    let list = [...db.dispatches].sort((a, b) => b.dispatched_at.localeCompare(a.dispatched_at));
    if (alarmId) list = list.filter((d) => d.alarm_id === alarmId);
    return list.slice(0, 100).map((d) => ({
      ...d,
      rescuer: db.rescuers.find((r) => r.id === d.rescuer_id) || null,
    }));
  });
  route('POST', '/api/dispatches/:id/accept', ({ params }) => acceptDispatch(ctx, params.id));
  route('POST', '/api/dispatches/:id/depart', ({ params }) => departDispatch(ctx, params.id));
  route('POST', '/api/dispatches/:id/arrive', ({ params }) => arriveDispatch(ctx, params.id));
  route('POST', '/api/dispatches/:id/release', ({ params, body }) => releaseDispatch(ctx, params.id, body.released_count));
  route('POST', '/api/dispatches/:id/complete', ({ params, body }) => completeDispatch(ctx, params.id, body.note));
  route('POST', '/api/dispatches/:id/reassign', ({ params, body }) => reassignDispatch(ctx, params.id, body.reason));

  // ---- 监控联动 ----
  route('GET', '/api/monitoring/snapshot/:cameraId', ({ params, res }) => {
    const cam = db.cameras.find((c) => c.id === params.cameraId);
    if (!cam) throw new ApiError(404, '摄像头不存在');
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
    res.end(renderSnapshot(cam));
    return undefined;
  });

  // ---- 统计 ----
  route('GET', '/api/stats', () => computeStats(db));

  // ---- SSE 实时推送 ----
  route('GET', '/api/events', ({ res }) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    ctx.hub.add(res);
    return undefined;
  });

  return async function handle(req, res, pathname, query) {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      const body = req.method === 'GET' ? {} : await readBody(req);
      try {
        const result = await r.handler({ params, query, body, req, res });
        if (result !== undefined) sendJson(res, 200, result);
      } catch (e) {
        if (e instanceof ApiError) sendJson(res, e.status, { error: e.message, ...e.extra });
        else {
          console.error('[api]', e);
          sendJson(res, 500, { error: '服务器内部错误' });
        }
      }
      return;
    }
    sendJson(res, 404, { error: '接口不存在' });
  };
}
