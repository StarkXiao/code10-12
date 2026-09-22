// 冒烟测试：启动真实服务，走完整闭环
// 报警接入 → 监控联动 → 自动派单 → 接单/出发/到场/救出/闭环 → 时序与 SLA 校验
// 另覆盖：幂等去重、非法状态流转、改派、取消、模拟自动推进、统计、SSE、持久化
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = 8123;
const BASE = `http://localhost:${PORT}`;

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

async function req(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('服务启动超时');
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elev-rescue-'));
const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

try {
  await waitHealth();
  console.log('服务已启动，开始冒烟测试\n');

  // ---- 1. 基础档案 ----
  console.log('▶ 基础档案');
  const meta = await req('GET', '/api/meta');
  check('meta 返回 SLA=30 分钟', meta.data.sla_min === 30);
  const elevators = await req('GET', '/api/elevators');
  check('种子电梯 6 台', elevators.data.length === 6);
  const rescuers = await req('GET', '/api/rescuers');
  check('种子救援人员 8 名', rescuers.data.length === 8);

  // ---- 2. 报警接入 + 监控联动 + 自动派单 ----
  console.log('▶ 报警接入 / 监控联动 / 自动派单');
  const e1 = elevators.data[0];
  const created = await req('POST', '/api/alarms', { elevator_id: e1.id, trapped_count: 3, source: 'car_intercom' });
  check('创建报警返回 201', created.status === 201, JSON.stringify(created.data));
  const alarmId = created.data.alarm.id;
  check('报警编号 ALM-0001', alarmId === 'ALM-0001');
  check('监控联动：摄像头 ≥ 4 路', created.data.alarm.monitoring.cameras.length >= 4);
  check('监控联动：传感器有轿厢位置', typeof created.data.alarm.monitoring.sensors.car_position_floor === 'number');
  check('时序含 报警/监控/派单 三条', ['alarm', 'monitor', 'dispatch'].every((k) => created.data.alarm.timeline.some((ev) => ev.kind === k)));
  const d1 = created.data.active_dispatch;
  check('已自动派单', !!d1 && d1.status === 'dispatched');
  check('派单含距离/ETA/评分', d1.distance_km > 0 && d1.eta_minutes > 0 && d1.score > 0);
  check('候选快照已留档', Array.isArray(d1.candidates_snapshot) && d1.candidates_snapshot.length > 0);

  // 幂等：同电梯重复报警 → 409
  const dup = await req('POST', '/api/alarms', { elevator_id: e1.id, trapped_count: 2 });
  check('同电梯重复报警返回 409', dup.status === 409);
  check('409 携带已有报警号', dup.data.existing_alarm_id === alarmId);
  // 参数校验
  const bad = await req('POST', '/api/alarms', { elevator_id: e1.id, trapped_count: 0 });
  check('被困人数 0 返回 400', bad.status === 400);

  // 被派单者变为任务中
  const rAfter = await req('GET', '/api/rescuers');
  const assigned = rAfter.data.find((r) => r.id === d1.rescuer_id);
  check('被派单救援人员转为任务中', assigned.status === 'busy');

  // ---- 3. 候选评分（就近 + 资质过滤）----
  console.log('▶ 候选评分');
  const cand = await req('GET', `/api/alarms/${alarmId}/candidates`);
  const rejectedNames = cand.data.rejected.map((x) => x.rescuer.name);
  check('证件过期者被过滤（陈杰）', rejectedNames.includes('陈杰'));
  check('休息中者被过滤（王芳）', rejectedNames.includes('王芳'));
  check('任务中者被过滤（刘洋 + 被派单者）', rejectedNames.includes('刘洋') && !cand.data.eligible.some((x) => x.rescuer.id === d1.rescuer_id));
  const scores = cand.data.eligible.map((x) => x.score);
  check('候选人按评分降序', scores.every((s, i) => i === 0 || scores[i - 1] >= s));

  // ---- 4. 状态机：非法流转被拒 ----
  console.log('▶ 状态机校验');
  const early = await req('POST', `/api/dispatches/${d1.id}/arrive`);
  check('未接单直接到场返回 409', early.status === 409);

  // ---- 5. 完整闭环 ----
  console.log('▶ 接单 → 出发 → 到场 → 救出 → 闭环');
  check('接单', (await req('POST', `/api/dispatches/${d1.id}/accept`)).status === 200);
  check('出发', (await req('POST', `/api/dispatches/${d1.id}/depart`)).status === 200);
  check('到场', (await req('POST', `/api/dispatches/${d1.id}/arrive`)).status === 200);
  check('救出', (await req('POST', `/api/dispatches/${d1.id}/release`, { released_count: 3 })).status === 200);
  check('闭环', (await req('POST', `/api/dispatches/${d1.id}/complete`, { note: '冒烟测试' })).status === 200);

  const detail1 = await req('GET', `/api/alarms/${alarmId}`);
  const done = detail1.data.dispatches.find((x) => x.id === d1.id);
  check('报警已闭环', detail1.data.alarm.status === 'closed');
  check('到场 SLA 达标标记', done.sla_arrive_ok === true);
  const kinds = detail1.data.alarm.timeline.map((ev) => ev.kind);
  const expectSeq = ['alarm', 'monitor', 'dispatch', 'accept', 'depart', 'arrive', 'release', 'complete'];
  check('时序事件齐全且有序', expectSeq.every((k, i) => kinds.indexOf(k) !== -1 && kinds.indexOf(k) === kinds.findIndex((x, j) => expectSeq[j] === k && j <= i)));
  check('时序时间戳单调不减', detail1.data.alarm.timeline.every((ev, i, arr) => i === 0 || arr[i - 1].at <= ev.at));
  check('到场时序 7 个关键时刻齐全', detail1.data.arrival_sequence.length === 7);
  check('耗时统计：报警→到场 ≥ 0', detail1.data.durations.arrive_min >= 0);
  check('救出人数已记录', done.released_count === 3);

  const rFinal = await req('GET', '/api/rescuers');
  const freed = rFinal.data.find((r) => r.id === d1.rescuer_id);
  check('闭环后救援人员释放且次数 +1', freed.status === 'available' && freed.completed_rescues === assigned.completed_rescues + 1);
  const elevAfter = (await req('GET', '/api/elevators')).data.find((e) => e.id === e1.id);
  check('电梯恢复常态', elevAfter.status === 'normal');

  // ---- 6. 改派 ----
  console.log('▶ 改派');
  const e2 = elevators.data[1];
  const a2 = await req('POST', '/api/alarms', { elevator_id: e2.id, trapped_count: 1, source: 'iot_sensor' });
  const d2 = a2.data.active_dispatch;
  const re = await req('POST', `/api/dispatches/${d2.id}/reassign`, { reason: '电话无人接听' });
  check('改派返回 200', re.status === 200);
  const detail2 = await req('GET', `/api/alarms/${a2.data.alarm.id}`);
  const d2all = detail2.data.dispatches;
  check('原调度单已作废', d2all.find((x) => x.id === d2.id).status === 'cancelled');
  const d2new = detail2.data.active_dispatch;
  check('已派给下一位候选人', !!d2new && d2new.rescuer_id !== d2.rescuer_id);
  check('时序含改派记录', detail2.data.alarm.timeline.some((ev) => ev.kind === 'reassign'));

  // ---- 7. 取消报警 ----
  console.log('▶ 取消');
  const cx = await req('POST', `/api/alarms/${a2.data.alarm.id}/cancel`, { reason: '物业确认误报' });
  check('取消返回 200', cx.status === 200);
  const detail2b = await req('GET', `/api/alarms/${a2.data.alarm.id}`);
  check('报警状态为已取消', detail2b.data.alarm.status === 'cancelled');
  check('进行中的调度单一并取消', detail2b.data.dispatches.every((x) => ['cancelled'].includes(x.status)));

  // ---- 8. 模拟自动推进 ----
  console.log('▶ 模拟救援自动推进（约 30-60 秒）');
  const e3 = elevators.data[2];
  const a3 = await req('POST', '/api/alarms', { elevator_id: e3.id, trapped_count: 2, simulate: true });
  check('模拟报警已创建', a3.status === 201);
  let closed = null;
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    const det = await req('GET', `/api/alarms/${a3.data.alarm.id}`);
    if (det.data.alarm.status === 'closed') { closed = det.data; break; }
  }
  check('模拟流程自动闭环', !!closed);
  if (closed) {
    const ks = closed.alarm.timeline.map((ev) => ev.kind);
    check('模拟时序完整', ['accept', 'depart', 'arrive', 'release', 'complete'].every((k) => ks.includes(k)));
  }

  // ---- 9. 统计 / 监控 / SSE / 持久化 ----
  console.log('▶ 统计与杂项');
  const stats = await req('GET', '/api/stats');
  check('今日报警 3 起', stats.data.today_total === 3, JSON.stringify(stats.data));
  check('SLA 统计分子分母齐全', stats.data.sla_total >= 2 && stats.data.sla_ok >= 2);
  check('平均到场时长已计算', typeof stats.data.avg_arrive_min === 'number');

  const mon = await req('GET', `/api/alarms/${alarmId}/monitoring`);
  check('监控联动接口可回放', mon.data.cameras.length >= 4);
  const snap = await fetch(`${BASE}${mon.data.cameras[0].snapshot_url}`);
  check('监控快照返回 SVG', snap.status === 200 && (snap.headers.get('content-type') || '').includes('svg'));
  check('快照内容含摄像头名', (await snap.text()).includes('摄像头'));

  const es = await fetch(`${BASE}/api/events`);
  check('SSE 通道可建立', es.status === 200 && (es.headers.get('content-type') || '').includes('event-stream'));
  await es.body.cancel();

  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  check('数据已持久化到 db.json', raw.alarms.length === 3 && raw.dispatches.length >= 4);

  const notFound = await req('GET', '/api/alarms/ALM-9999');
  check('未知报警返回 404', notFound.status === 404);
} catch (e) {
  failed++;
  console.error('测试执行异常：', e);
} finally {
  child.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
