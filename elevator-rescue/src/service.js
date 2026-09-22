// 业务核心：报警接入 → 监控联动 → 自动派单 → 状态机推进 → 时序记录
// 路由、升级扫描、模拟器都复用这里的操作，保证语义只有一份实现
import { rankCandidates } from './dispatch.js';
import { linkMonitoring } from './monitor.js';

/** 到场 SLA（分钟）：TSG T5002 要求市区 30 分钟内到场 */
export const ARRIVE_SLA_MIN = Number(process.env.ARRIVE_SLA_MIN || 30);
/** 接单超时（毫秒）：派单后超过该时长未接单自动改派 */
export const ACCEPT_TIMEOUT_MS = Number(process.env.ACCEPT_TIMEOUT_MS || 120000);

export const SOURCE_LABELS = {
  car_intercom: '轿厢五方对讲',
  iot_sensor: '物联网监测',
  manual_call: '物业电话',
  passenger_app: '乘客 APP',
};

export class ApiError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const nowIso = () => new Date().toISOString();
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;

function nextId(db, kind, prefix) {
  db.seq[kind] = (db.seq[kind] || 0) + 1;
  return `${prefix}-${String(db.seq[kind]).padStart(4, '0')}`;
}

/** 追加一条时序记录（不可变，只增不改） */
export function pushTimeline(alarm, kind, actor, detail) {
  const ev = { seq: alarm.timeline.length + 1, at: nowIso(), kind, actor, detail };
  alarm.timeline.push(ev);
  return ev;
}

export function getAlarm(db, id) {
  const a = db.alarms.find((x) => x.id === id);
  if (!a) throw new ApiError(404, `报警 ${id} 不存在`);
  return a;
}

export function getDispatch(db, id) {
  const d = db.dispatches.find((x) => x.id === id);
  if (!d) throw new ApiError(404, `调度单 ${id} 不存在`);
  return d;
}

function alarmTarget(db, alarm) {
  const b = db.buildings.find((x) => x.id === alarm.building_id);
  return { lat: b.lat, lng: b.lng };
}

// ---------------------------------------------------------------- 报警接入

export function createAlarm(ctx, input = {}) {
  const { db } = ctx;
  const elevator = db.elevators.find((e) => e.id === (input.elevator_id || input.elevator_code) || e.code === (input.elevator_id || input.elevator_code));
  if (!elevator) throw new ApiError(404, '电梯不存在，请核对电梯编号或注册代码');

  // 先校验入参（400 优先于 409）
  const trapped = Number(input.trapped_count);
  if (!Number.isInteger(trapped) || trapped < 1 || trapped > 30) throw new ApiError(400, '被困人数须为 1-30 的整数');

  // 幂等：同一台电梯同一时间只允许一个进行中的报警，重复上报返回 409 + 已有单号
  const dup = db.alarms.find((a) => a.elevator_id === elevator.id && !['closed', 'cancelled'].includes(a.status));
  if (dup) throw new ApiError(409, `该电梯已有进行中的报警 ${dup.id}，请勿重复派单`, { existing_alarm_id: dup.id });

  const source = SOURCE_LABELS[input.source] ? input.source : 'car_intercom';
  const building = db.buildings.find((b) => b.id === elevator.building_id);
  const alarm = {
    id: nextId(db, 'alarm', 'ALM'),
    elevator_id: elevator.id,
    building_id: building.id,
    source,
    trapped_count: trapped,
    floor_reported: Number.isFinite(+input.floor) && input.floor !== undefined && input.floor !== null ? +input.floor : elevator.current_floor,
    status: 'pending', // pending → dispatched → in_progress → arrived → rescued → closed / cancelled
    priority: 'normal',
    escalated: false,
    created_at: nowIso(),
    closed_at: null,
    cancel_reason: null,
    monitoring: null,
    timeline: [],
  };
  elevator.status = 'alarm';
  pushTimeline(alarm, 'alarm', 'system',
    `轿厢报警接入（${SOURCE_LABELS[source]}）：${building.name} ${elevator.name} 困人 ${trapped} 名，报告楼层 ${alarm.floor_reported}F`);

  // 联动楼宇监控：调取摄像头 + 读取传感器，结果随报警存档
  alarm.monitoring = linkMonitoring(db, elevator, building);
  const s = alarm.monitoring.sensors;
  pushTimeline(alarm, 'monitor', 'system',
    `联动楼宇监控：调取 ${alarm.monitoring.cameras.length} 路摄像头；传感器确认轿厢位于 ${s.car_position_floor}F，门状态「${s.door_state}」，对讲「${s.intercom}」`);

  db.alarms.push(alarm);
  dispatchBest(ctx, alarm, '接警自动派单');
  ctx.save();
  ctx.broadcast('update', { kind: 'alarm', id: alarm.id });
  return alarm;
}

// ---------------------------------------------------------------- 派单

/** 按「就近 + 资质」选出最优救援人员并派单；排除本报警已试过的救援人员 */
export function dispatchBest(ctx, alarm, reason) {
  const { db } = ctx;
  const tried = db.dispatches.filter((d) => d.alarm_id === alarm.id).map((d) => d.rescuer_id);
  const { eligible } = rankCandidates(db.rescuers, alarmTarget(db, alarm));
  const candidates = eligible.filter((c) => !tried.includes(c.rescuer.id));

  if (candidates.length === 0) {
    alarm.status = 'pending';
    alarm.escalated = true;
    alarm.priority = 'urgent';
    pushTimeline(alarm, 'escalate', 'system', `${reason}失败：无满足「在岗 + 持证有效」条件的救援人员，需人工介入`);
    return null;
  }

  const best = candidates[0];
  const d = {
    id: nextId(db, 'dispatch', 'DSP'),
    alarm_id: alarm.id,
    rescuer_id: best.rescuer.id,
    status: 'dispatched', // dispatched → accepted → en_route → arrived → released → completed / cancelled
    dispatched_at: nowIso(),
    accept_at: null, depart_at: null, arrive_at: null, release_at: null, complete_at: null,
    cancelled_at: null, cancel_reason: null,
    distance_km: r2(best.km),
    eta_minutes: r1(best.eta),
    score: r3(best.score),
    sla_arrive_ok: null,
    // 候选评分明细快照，留档可审计
    candidates_snapshot: candidates.slice(0, 5).map((c) => ({
      rescuer_id: c.rescuer.id, name: c.rescuer.name, cert_level: c.rescuer.cert_level,
      distance_km: r2(c.km), eta_minutes: r1(c.eta), score: r3(c.score),
    })),
  };
  best.rescuer.status = 'busy';
  db.dispatches.push(d);
  alarm.status = 'dispatched';
  pushTimeline(alarm, 'dispatch', 'dispatcher',
    `${reason}：派单给 ${best.rescuer.name}（${best.rescuer.org}，${best.rescuer.cert_level}资质，距离 ${d.distance_km}km，预计 ${d.eta_minutes} 分钟，综合分 ${d.score}）`);
  return d;
}

// ---------------------------------------------------------------- 状态机推进

const must = (cond, msg) => { if (!cond) throw new ApiError(409, msg); };

/** 所有调度单状态推进的公共骨架：取单 → 校验/变更 → 落库 → 广播 */
function transition(ctx, dispatchId, fn) {
  const { db } = ctx;
  const d = getDispatch(db, dispatchId);
  const alarm = getAlarm(db, d.alarm_id);
  const rescuer = db.rescuers.find((r) => r.id === d.rescuer_id);
  fn(db, d, alarm, rescuer);
  ctx.save();
  ctx.broadcast('update', { kind: 'dispatch', id: d.id, alarm_id: alarm.id });
  return d;
}

export function acceptDispatch(ctx, id) {
  return transition(ctx, id, (db, d, alarm, rescuer) => {
    must(d.status === 'dispatched', `当前状态「${d.status}」不可接单`);
    d.status = 'accepted';
    d.accept_at = nowIso();
    alarm.status = 'in_progress';
    pushTimeline(alarm, 'accept', rescuer.name, `${rescuer.name} 已接单，电话回告被困人员保持冷静、切勿扒门`);
  });
}

export function departDispatch(ctx, id) {
  return transition(ctx, id, (db, d, alarm, rescuer) => {
    must(d.status === 'accepted', '接单后才能登记出发');
    d.status = 'en_route';
    d.depart_at = nowIso();
    pushTimeline(alarm, 'depart', rescuer.name, `${rescuer.name} 已出发，携带机房钥匙与盘车工具`);
  });
}

export function arriveDispatch(ctx, id) {
  return transition(ctx, id, (db, d, alarm, rescuer) => {
    must(d.status === 'accepted' || d.status === 'en_route', '接单后才能登记到场');
    d.status = 'arrived';
    d.arrive_at = nowIso();
    const elapsed = (new Date(d.arrive_at) - new Date(alarm.created_at)) / 60000;
    d.sla_arrive_ok = elapsed <= ARRIVE_SLA_MIN;
    alarm.status = 'arrived';
    pushTimeline(alarm, 'arrive', rescuer.name,
      `${rescuer.name} 到场（报警后 ${r1(elapsed)} 分钟，${ARRIVE_SLA_MIN} 分钟到场 SLA ${d.sla_arrive_ok ? '达标' : '超时'}），开始现场处置`);
    if (!d.sla_arrive_ok && !alarm.escalated) {
      alarm.escalated = true;
      alarm.priority = 'urgent';
      pushTimeline(alarm, 'escalate', 'system', `到场超过 ${ARRIVE_SLA_MIN} 分钟，事件升级为紧急`);
    }
  });
}

export function releaseDispatch(ctx, id, releasedCount) {
  return transition(ctx, id, (db, d, alarm, rescuer) => {
    must(d.status === 'arrived', '到场后才能登记救出');
    const n = Number.isInteger(+releasedCount) && +releasedCount > 0 ? +releasedCount : alarm.trapped_count;
    d.status = 'released';
    d.release_at = nowIso();
    d.released_count = n;
    alarm.status = 'rescued';
    const cost = (new Date(d.release_at) - new Date(d.arrive_at)) / 60000;
    pushTimeline(alarm, 'release', rescuer.name, `盘车平层开门，救出 ${n} 名被困人员（现场处置 ${r1(cost)} 分钟），人员状态良好`);
  });
}

export function completeDispatch(ctx, id, note) {
  return transition(ctx, id, (db, d, alarm, rescuer) => {
    must(d.status === 'released', '救出人员后才能闭环');
    d.status = 'completed';
    d.complete_at = nowIso();
    d.note = note || null;
    alarm.status = 'closed';
    alarm.closed_at = d.complete_at;
    rescuer.status = 'available';
    rescuer.completed_rescues = (rescuer.completed_rescues || 0) + 1;
    const elevator = db.elevators.find((e) => e.id === alarm.elevator_id);
    if (elevator) elevator.status = 'normal';
    pushTimeline(alarm, 'complete', rescuer.name, `救援闭环${note ? `：${note}` : ''}；电梯须经维保复检后方可恢复运行`);
  });
}

/** 改派：作废当前调度单，释放救援人员，自动派给下一位候选人 */
export function reassignDispatch(ctx, id, reason) {
  const { db } = ctx;
  const d = getDispatch(db, id);
  must(['dispatched', 'accepted', 'en_route'].includes(d.status), `当前状态「${d.status}」不可改派`);
  const alarm = getAlarm(db, d.alarm_id);
  const rescuer = db.rescuers.find((r) => r.id === d.rescuer_id);
  d.status = 'cancelled';
  d.cancelled_at = nowIso();
  d.cancel_reason = reason || '人工改派';
  if (rescuer && rescuer.status === 'busy') rescuer.status = 'available';
  pushTimeline(alarm, 'reassign', 'dispatcher', `改派：${d.cancel_reason}（原救援 ${rescuer?.name || '未知'}）`);
  dispatchBest(ctx, alarm, '改派重新派单');
  ctx.save();
  ctx.broadcast('update', { kind: 'dispatch', id: d.id, alarm_id: alarm.id });
  return d;
}

export function cancelAlarm(ctx, id, reason) {
  const { db } = ctx;
  const alarm = getAlarm(db, id);
  must(!['closed', 'cancelled'].includes(alarm.status), '报警已结束，不能取消');
  for (const d of db.dispatches.filter((x) => x.alarm_id === alarm.id && !['completed', 'cancelled'].includes(x.status))) {
    d.status = 'cancelled';
    d.cancelled_at = nowIso();
    d.cancel_reason = '报警取消';
    const r = db.rescuers.find((x) => x.id === d.rescuer_id);
    if (r && r.status === 'busy') r.status = 'available';
  }
  alarm.status = 'cancelled';
  alarm.cancel_reason = reason || '误报/取消';
  alarm.closed_at = nowIso();
  const elevator = db.elevators.find((e) => e.id === alarm.elevator_id);
  if (elevator) elevator.status = 'normal';
  pushTimeline(alarm, 'cancel', 'dispatcher', `报警取消：${alarm.cancel_reason}`);
  ctx.save();
  ctx.broadcast('update', { kind: 'alarm', id: alarm.id });
  return alarm;
}

// ---------------------------------------------------------------- 查询组装

export function alarmDetail(db, id) {
  const alarm = getAlarm(db, id);
  const elevator = db.elevators.find((e) => e.id === alarm.elevator_id);
  const building = db.buildings.find((b) => b.id === alarm.building_id);
  const dispatches = db.dispatches
    .filter((d) => d.alarm_id === id)
    .map((d) => ({ ...d, rescuer: db.rescuers.find((r) => r.id === d.rescuer_id) || null }));
  const used = dispatches.find((d) => d.arrive_at)
    || dispatches.find((d) => d.status !== 'cancelled')
    || dispatches[dispatches.length - 1] || null;
  return {
    alarm,
    elevator,
    building,
    dispatches,
    active_dispatch: dispatches.find((d) => !['completed', 'cancelled'].includes(d.status)) || null,
    durations: computeDurations(alarm, used),
    arrival_sequence: arrivalSequence(alarm, used),
  };
}

/** 关键耗时（分钟）：报警→接单、报警→到场、到场→救出、全程 */
function computeDurations(alarm, d) {
  const t = (s) => (s ? new Date(s).getTime() : null);
  const mins = (a, b) => (a != null && b != null ? r1((b - a) / 60000) : null);
  const created = t(alarm.created_at);
  return {
    accept_min: d ? mins(created, t(d.accept_at)) : null,
    arrive_min: d ? mins(created, t(d.arrive_at)) : null,
    release_min: d ? mins(t(d.arrive_at), t(d.release_at)) : null,
    total_min: mins(created, t(alarm.closed_at)),
  };
}

/** 到场时序：报警 → 派单 → 接单 → 出发 → 到场 → 救出 → 闭环 的关键时刻 */
function arrivalSequence(alarm, d) {
  const seq = [{ key: 'alarm', label: '报警接入', at: alarm.created_at }];
  if (d) {
    seq.push({ key: 'dispatch', label: '派单', at: d.dispatched_at });
    if (d.accept_at) seq.push({ key: 'accept', label: '接单', at: d.accept_at });
    if (d.depart_at) seq.push({ key: 'depart', label: '出发', at: d.depart_at });
    if (d.arrive_at) seq.push({ key: 'arrive', label: '到场', at: d.arrive_at });
    if (d.release_at) seq.push({ key: 'release', label: '救出', at: d.release_at });
    if (d.complete_at) seq.push({ key: 'complete', label: '闭环', at: d.complete_at });
  }
  return seq;
}

export function computeStats(db) {
  const today = new Date().toISOString().slice(0, 10);
  const alarms = db.alarms;
  const alarmById = Object.fromEntries(alarms.map((a) => [a.id, a]));
  const active = alarms.filter((a) => !['closed', 'cancelled'].includes(a.status));
  const arrived = db.dispatches.filter((d) => d.arrive_at);
  const arriveMins = arrived.map((d) => (new Date(d.arrive_at) - new Date(alarmById[d.alarm_id].created_at)) / 60000);
  const releases = db.dispatches.filter((d) => d.arrive_at && d.release_at);
  const avg = (arr) => (arr.length ? r1(arr.reduce((s, x) => s + x, 0) / arr.length) : null);
  const slaOk = arrived.filter((d) => d.sla_arrive_ok).length;
  return {
    today_total: alarms.filter((a) => a.created_at.slice(0, 10) === today).length,
    active: active.length,
    closed_total: alarms.filter((a) => a.status === 'closed').length,
    avg_arrive_min: avg(arriveMins),
    sla_total: arrived.length,
    sla_ok: slaOk,
    sla_rate: arrived.length ? Math.round((slaOk / arrived.length) * 100) : null,
    avg_release_min: avg(releases.map((d) => (new Date(d.release_at) - new Date(d.arrive_at)) / 60000)),
    rescuers_available: db.rescuers.filter((r) => r.status === 'available').length,
    rescuers_total: db.rescuers.length,
  };
}
