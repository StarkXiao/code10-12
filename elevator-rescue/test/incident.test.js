import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransition,
  createIncident,
  applyStateEvent,
  recordEscalation,
  recordReassignment,
  evaluateSla,
  legDurations,
} from '../src/incident.js';
import { IncidentState, EventType, EscalationLevel, SLA } from '../src/constants.js';

const T = new Date('2026-09-22T10:00:00+08:00');
const mk = () =>
  createIncident({
    id: 'INC-X', buildingId: 'B', elevatorId: 'E', priority: 'normal',
    alarmSource: 'car_button', at: T,
  });

test('合法推进链：接警 → 派单 → 出发 → 到场 → 救出 → 归档', () => {
  const inc = mk();
  const at = (sec) => new Date(T.getTime() + sec * 1000);
  applyStateEvent(inc, EventType.DISPATCH, at(20), { rescuerId: 'R1' });
  applyStateEvent(inc, EventType.EN_ROUTE, at(40), { rescuerId: 'R1' });
  applyStateEvent(inc, EventType.ON_SITE, at(600), { rescuerId: 'R1' });
  applyStateEvent(inc, EventType.RESCUED, at(900), {});
  applyStateEvent(inc, EventType.CLOSED, at(960), {});

  assert.equal(inc.state, IncidentState.CLOSED);
  assert.deepEqual(inc.timeline.map((e) => e.seq), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(inc.timeline.map((e) => e.type), [
    'alarm', 'dispatch', 'en_route', 'on_site', 'rescued', 'closed',
  ]);
});

test('允许跨级（现场直接报到场），但自动补登派单', () => {
  const inc = mk();
  applyStateEvent(inc, EventType.ON_SITE, new Date(T.getTime() + 500_000), { rescuerId: 'R1' });
  assert.equal(inc.state, IncidentState.ON_SITE);
  assert.equal(inc.rescuerId, 'R1');
  const types = inc.timeline.map((e) => e.type);
  assert.deepEqual(types, ['alarm', 'dispatch', 'on_site']);
  assert.equal(inc.timeline[1].data.backfilled, true, '补登的是第 2 条 dispatch');
});

test('回退被拒绝：到场后不能再点"出发"', () => {
  const inc = mk();
  applyStateEvent(inc, EventType.DISPATCH, T, { rescuerId: 'R1' });
  applyStateEvent(inc, EventType.ON_SITE, T, { rescuerId: 'R1' });
  assert.throws(
    () => applyStateEvent(inc, EventType.EN_ROUTE, T, { rescuerId: 'R1' }),
    /非法状态推进/,
  );
});

test('归档后拒绝一切变更', () => {
  const inc = mk();
  applyStateEvent(inc, EventType.DISPATCH, T, { rescuerId: 'R1' });
  applyStateEvent(inc, EventType.ON_SITE, T, { rescuerId: 'R1' });
  applyStateEvent(inc, EventType.RESCUED, T, {});
  applyStateEvent(inc, EventType.CLOSED, T, {});
  assert.throws(
    () => applyStateEvent(inc, EventType.NOTE, T, {}),
    /已归档/,
  );
  assert.throws(
    () => applyStateEvent(inc, EventType.EN_ROUTE, T, { rescuerId: 'R1' }),
    /已归档|非法状态推进/,
  );
});

test('dispatch 事件自身不触发补登（同一 dispatch 只记一条）', () => {
  const inc = mk();
  applyStateEvent(inc, EventType.DISPATCH, T, { rescuerId: 'R1' });
  assert.equal(inc.timeline.filter((e) => e.type === 'dispatch').length, 1);
  assert.equal(inc.timeline[0].data.backfilled, undefined);
});

test('换救援员必须走改派，状态机直接拒绝他人推进', () => {
  const inc = mk();
  applyStateEvent(inc, EventType.DISPATCH, T, { rescuerId: 'R1' });
  assert.throws(
    () => applyStateEvent(inc, EventType.EN_ROUTE, T, { rescuerId: 'R2' }),
    /请先改派/,
  );
});

test('改派只在派单后/到场前允许，且新旧不能相同', () => {
  const inc = mk();
  assert.throws(() => recordReassignment(inc, T, { rescuerId: 'R9' }), /尚未派单/);
  applyStateEvent(inc, EventType.DISPATCH, T, { rescuerId: 'R1' });
  applyStateEvent(inc, EventType.ON_SITE, T, { rescuerId: 'R1' });
  assert.throws(() => recordReassignment(inc, T, { rescuerId: 'R2' }), /已到场/);

  const inc2 = mk();
  applyStateEvent(inc2, EventType.DISPATCH, T, { rescuerId: 'R1' });
  assert.throws(() => recordReassignment(inc2, T, { rescuerId: 'R1' }), /相同/);
  recordReassignment(inc2, T, { rescuerId: 'R2' });
  assert.equal(inc2.rescuerId, 'R2');
  assert.equal(inc2.state, IncidentState.DISPATCHED, '改派不改变状态');
});

test('升级只升不降，且幂等', () => {
  const inc = mk();
  assert.equal(recordEscalation(inc, T, EscalationLevel.SUPERVISOR, {}), true);
  assert.equal(recordEscalation(inc, T, EscalationLevel.SUPERVISOR, {}), false);
  assert.equal(recordEscalation(inc, T, EscalationLevel.EMERGENCY_CENTER, {}), true);
  assert.equal(recordEscalation(inc, T, EscalationLevel.SUPERVISOR, {}), false);
  assert.equal(inc.escalationLevel, EscalationLevel.EMERGENCY_CENTER);
  assert.equal(inc.timeline.filter((e) => e.type === 'escalation').length, 2);
});

test('SLA 评估：60 秒未派单 → 主管；30 分钟未到场 → 119/120', () => {
  const inc = mk();
  let sla = evaluateSla(inc, new Date(T.getTime() + 61_000));
  assert.equal(sla.ackBreached, true);
  assert.equal(sla.dueLevel, EscalationLevel.SUPERVISOR);

  sla = evaluateSla(inc, new Date(T.getTime() + 31 * 60_000));
  assert.equal(sla.arrivalBreached, true);
  assert.equal(sla.dueLevel, EscalationLevel.EMERGENCY_CENTER);

  // 已派单但未到场：ack 破线不再报，arrival 继续监控
  applyStateEvent(inc, EventType.DISPATCH, new Date(T.getTime() + 30_000), { rescuerId: 'R1' });
  sla = evaluateSla(inc, new Date(T.getTime() + 31 * 60_000));
  assert.equal(sla.ackBreached, false);
  assert.equal(sla.arrivalBreached, true);
});

test('已到场事件不再受 arrival SLA 约束', () => {
  const inc = mk();
  applyStateEvent(inc, EventType.DISPATCH, T, { rescuerId: 'R1' });
  applyStateEvent(inc, EventType.ON_SITE, new Date(T.getTime() + 20 * 60_000), { rescuerId: 'R1' });
  const sla = evaluateSla(inc, new Date(T.getTime() + 60 * 60_000));
  assert.equal(sla.dueLevel, EscalationLevel.NONE);
});

test('节点耗时 legDurations 以接警时刻为零点', () => {
  const inc = mk();
  applyStateEvent(inc, EventType.DISPATCH, new Date(T.getTime() + 30_000), { rescuerId: 'R1' });
  applyStateEvent(inc, EventType.ON_SITE, new Date(T.getTime() + 10 * 60_000), { rescuerId: 'R1' });
  const legs = legDurations(inc);
  assert.equal(legs.dispatchMs, 30_000);
  assert.equal(legs.onSiteMs, 600_000);
  assert.equal(legs.rescuedMs, null);
});

test('canTransition 状态白名单符合 constants 定义', () => {
  assert.equal(canTransition(IncidentState.ALARM_RECEIVED, IncidentState.ON_SITE), true);
  assert.equal(canTransition(IncidentState.ON_SITE, IncidentState.EN_ROUTE), false);
  assert.equal(canTransition(IncidentState.RESCUED, IncidentState.ON_SITE), false);
  assert.equal(SLA.ackDeadlineMs, 60_000);
});
