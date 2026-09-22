/**
 * 事件状态机：所有状态变更都必须经此模块，保证：
 * 1. 状态只能单向推进（见 constants.STATE_TRANSITIONS）；
 * 2. 每次变更都在 timeline 留痕，seq 连续、不可改写；
 * 3. 关键节点时间戳（alarmAt/dispatchedAt/enRouteAt/onSiteAt/rescuedAt/closedAt）
 *    与 timeline 同源派生，"到场时序"以此为准。
 */
import {
  IncidentState,
  STATE_TRANSITIONS,
  TERMINAL_STATES,
  EventType,
  EVENT_TARGET_STATE,
  EscalationLevel,
  SLA,
} from './constants.js';
import { httpError } from './validate.js';

const STATE_RANK = {
  [IncidentState.ALARM_RECEIVED]: 0,
  [IncidentState.DISPATCHED]: 1,
  [IncidentState.EN_ROUTE]: 2,
  [IncidentState.ON_SITE]: 3,
  [IncidentState.RESCUED]: 4,
  [IncidentState.CLOSED]: 5,
};

export function createIncident(input) {
  const now = input.at;
  const incident = {
    id: input.id,
    buildingId: input.buildingId,
    elevatorId: input.elevatorId,
    floor: input.floor ?? null,
    occupants: input.occupants ?? null, // 被困人数
    hasVulnerable: !!input.hasVulnerable, // 老人/儿童/孕妇/病患
    hasInjury: !!input.hasInjury,
    hasFire: !!input.hasFire,
    priority: input.priority,
    alarmSource: input.alarmSource, // car_button / iot / phone / video
    alarmSummary: input.alarmSummary ?? '',
    state: IncidentState.ALARM_RECEIVED,
    rescuerId: null,
    cameraId: input.cameraId ?? null,
    monitorStatus: input.monitorStatus ?? 'pending', // pending / linked
    streamId: null,
    escalationLevel: EscalationLevel.NONE,
    // 节点时间戳
    alarmAt: now.toISOString(),
    dispatchedAt: null,
    enRouteAt: null,
    onSiteAt: null,
    rescuedAt: null,
    closedAt: null,
    escalatedAt: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    timeline: [],
  };
  appendTimeline(incident, EventType.ALARM, now, {
    summary: input.alarmSummary || '轿厢紧急报警',
    data: {
      alarmSource: input.alarmSource,
      floor: incident.floor,
      occupants: incident.occupants,
      hasVulnerable: incident.hasVulnerable,
      hasInjury: incident.hasInjury,
      hasFire: incident.hasFire,
    },
  });
  return incident;
}

/** 是否允许从 from 跳到 to（允许跨级，但不允许回退） */
export function canTransition(from, to) {
  if (from === to) return false;
  if (STATE_RANK[to] <= STATE_RANK[from]) return false;
  return STATE_TRANSITIONS[from]?.has(to) ?? false;
}

/**
 * 应用一个推进状态的事件（dispatch/en_route/on_site/rescued/closed）。
 * 现场可能跳过 app 操作，所以 en_route/on_site 带 rescuerId 而此前未派单时，
 * 自动补登一条 dispatch 记录（时序上以同一时刻记）。
 */
export function applyStateEvent(incident, eventType, at, payload = {}) {
  if (TERMINAL_STATES.has(incident.state)) {
    throw httpError(409, `事件已归档（${incident.id}），不能再变更状态`);
  }
  const target = EVENT_TARGET_STATE[eventType];
  if (!target) throw httpError(400, `${eventType} 不是状态推进事件`);

  // 现场可能跳过 app 操作：未派单却直接收到出发/到场回报时，
  // 自动补登一条 dispatch（dispatch 事件自身不补登，否则会重复记账）。
  if (
    eventType !== EventType.DISPATCH &&
    STATE_RANK[target] >= STATE_RANK[IncidentState.DISPATCHED] &&
    !incident.rescuerId
  ) {
    if (!payload.rescuerId) {
      throw httpError(409, '尚未派单，无法推进到该状态');
    }
    recordDispatch(incident, payload.rescuerId, at, {
      summary: '补登派单（随现场状态一并确认）',
      backfilled: true,
    });
  }

  if (!canTransition(incident.state, target)) {
    throw httpError(
      409,
      `非法状态推进：${incident.state} → ${target}（事件 ${eventType}）`,
    );
  }

  switch (eventType) {
    case EventType.DISPATCH:
      if (!payload.rescuerId) throw httpError(400, '派单必须指定救援员');
      recordDispatch(incident, payload.rescuerId, at, payload);
      break;
    case EventType.EN_ROUTE:
      assertSameRescuer(incident, payload.rescuerId);
      incident.enRouteAt = at.toISOString();
      appendTimeline(incident, EventType.EN_ROUTE, at, payload);
      break;
    case EventType.ON_SITE:
      assertSameRescuer(incident, payload.rescuerId);
      incident.onSiteAt = at.toISOString();
      appendTimeline(incident, EventType.ON_SITE, at, payload);
      break;
    case EventType.RESCUED:
      incident.rescuedAt = at.toISOString();
      appendTimeline(incident, EventType.RESCUED, at, {
        ...payload,
        data: { occupantsReleased: payload.occupantsReleased ?? incident.occupants ?? true },
      });
      break;
    case EventType.CLOSED:
      incident.closedAt = at.toISOString();
      appendTimeline(incident, EventType.CLOSED, at, payload);
      break;
  }

  incident.state = target;
  incident.updatedAt = at.toISOString();
  return incident;
}

function recordDispatch(incident, rescuerId, at, payload = {}) {
  incident.rescuerId = rescuerId;
  incident.dispatchedAt = at.toISOString();
  appendTimeline(incident, EventType.DISPATCH, at, {
    ...payload,
    data: { rescuerId, backfilled: !!payload.backfilled, ...(payload.data ?? {}) },
  });
}

function assertSameRescuer(incident, rescuerId) {
  if (rescuerId && incident.rescuerId && rescuerId !== incident.rescuerId) {
    throw httpError(409, `该事件已派给 ${incident.rescuerId}，请先改派`);
  }
}

/** 监控联动：只记录，不改状态 */
export function recordMonitorEvent(incident, at, payload) {
  appendTimeline(incident, EventType.MONITOR, at, {
    summary: payload.summary,
    data: payload.data ?? {},
  });
  if (payload.streamId) incident.streamId = payload.streamId;
  if (payload.monitorStatus) incident.monitorStatus = payload.monitorStatus;
  incident.updatedAt = at.toISOString();
}

/** 改派：状态不变，记录新旧救援员 */
export function recordReassignment(incident, at, payload) {
  if (!payload.rescuerId) throw httpError(400, '改派必须指定新救援员');
  if (incident.state === IncidentState.ALARM_RECEIVED) {
    throw httpError(409, '尚未派单，应直接派单而非改派');
  }
  if (incident.state === IncidentState.ON_SITE) {
    throw httpError(409, '救援员已到场，不能改派');
  }
  const previous = incident.rescuerId;
  if (previous === payload.rescuerId) throw httpError(409, '新救援员与当前救援员相同');
  incident.rescuerId = payload.rescuerId;
  incident.dispatchedAt = at.toISOString();
  appendTimeline(incident, EventType.REASSIGNMENT, at, {
    summary: payload.summary || `改派：${previous} → ${payload.rescuerId}`,
    data: { fromRescuerId: previous, toRescuerId: payload.rescuerId, reason: payload.reason ?? null },
  });
  incident.updatedAt = at.toISOString();
}

/**
 * 升级：只升不降。ack 超时 → 主管；arrival 超时 → 应急中心（可跨过主管）。
 */
export function recordEscalation(incident, at, level, payload = {}) {
  const order = {
    [EscalationLevel.NONE]: 0,
    [EscalationLevel.SUPERVISOR]: 1,
    [EscalationLevel.EMERGENCY_CENTER]: 2,
  };
  if (order[level] <= order[incident.escalationLevel]) {
    return false; // 已处于更高或同级升级，忽略
  }
  incident.escalationLevel = level;
  incident.escalatedAt = at.toISOString();
  appendTimeline(incident, EventType.ESCALATION, at, {
    summary: payload.summary || `升级至${level === EscalationLevel.SUPERVISOR ? '值班主管' : '119/120 应急联动'}`,
    data: { level, reason: payload.reason ?? null, ...(payload.data ?? {}) },
  });
  incident.updatedAt = at.toISOString();
  return true;
}

export function appendNote(incident, at, payload) {
  appendTimeline(incident, EventType.NOTE, at, payload);
  incident.updatedAt = at.toISOString();
}

function appendTimeline(incident, type, at, payload = {}) {
  incident.timeline.push({
    seq: incident.timeline.length + 1,
    type,
    at: at.toISOString(),
    actor: payload.actor ?? 'system',
    summary: payload.summary ?? '',
    data: payload.data ?? {},
  });
}

/**
 * SLA 评估（纯函数，不写状态）：
 * 返回当前时刻应触发的升级级别与是否已破线。
 */
export function evaluateSla(incident, at) {
  const atMs = at.getTime();
  const rank = STATE_RANK[incident.state];
  const alarmMs = new Date(incident.alarmAt).getTime();

  const ackBreached =
    rank < STATE_RANK[IncidentState.DISPATCHED] &&
    atMs - alarmMs > SLA.ackDeadlineMs;

  const arrivalBreached =
    rank < STATE_RANK[IncidentState.ON_SITE] &&
    atMs - alarmMs > SLA.arrivalDeadlineMs;

  let dueLevel = EscalationLevel.NONE;
  if (arrivalBreached) dueLevel = EscalationLevel.EMERGENCY_CENTER;
  else if (ackBreached) dueLevel = EscalationLevel.SUPERVISOR;

  return {
    ackBreached,
    arrivalBreached,
    dueLevel,
    ackRemainingMs: SLA.ackDeadlineMs - (atMs - alarmMs),
    arrivalRemainingMs: SLA.arrivalDeadlineMs - (atMs - alarmMs),
  };
}

/** 节点间耗时（毫秒），用于到场时序报告 */
export function legDurations(incident) {
  const t = (iso) => (iso ? new Date(iso).getTime() : null);
  const alarm = t(incident.alarmAt);
  const pick = (iso) => {
    const v = t(iso);
    return v === null ? null : v - alarm;
  };
  return {
    dispatchMs: pick(incident.dispatchedAt),
    enRouteMs: pick(incident.enRouteAt),
    onSiteMs: pick(incident.onSiteAt),
    rescuedMs: pick(incident.rescuedAt),
    closedMs: pick(incident.closedAt),
  };
}
