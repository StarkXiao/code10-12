import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Clock } from '../src/clock.js';
import { DispatchService } from '../src/service.js';
import { cloneSeed } from '../src/seed.js';
import { IncidentState, EscalationLevel, RescuerStatus } from '../src/constants.js';

const T0 = '2026-09-22T10:00:00+08:00';
function makeService() {
  const store = new Store(null, cloneSeed());
  const clock = new Clock(T0);
  const service = new DispatchService(store, clock, { autoDispatch: true });
  return { store, clock, service };
}

test('完整闭环：接警自动联动监控 + 自动派单 → 救出 → 归档，时序与状态正确', async () => {
  const { service, store } = makeService();
  const { incident, dispatch } = await service.receiveAlarm({
    elevatorId: 'ELV-101', floor: 12, occupants: 3, hasVulnerable: true,
    summary: '困人', at: T0,
  });

  assert.equal(incident.priority, 'high', '含老人自动定紧急');
  assert.equal(incident.state, IncidentState.DISPATCHED, '自动派单完成');
  assert.equal(dispatch.dispatched, true);
  assert.equal(incident.rescuerId, 'RSC-01');
  assert.equal(incident.monitorStatus, 'linked');
  assert.ok(incident.streamId.startsWith('STRM-'));
  assert.equal(store.get('rescuers', 'RSC-01').status, RescuerStatus.ASSIGNED);

  await service.markEnRoute(incident.id, { at: '2026-09-22T10:00:45+08:00' });
  await service.markOnSite(incident.id, { at: '2026-09-22T10:08:00+08:00' });
  await service.markRescued(incident.id, { at: '2026-09-22T10:15:00+08:00' });
  await service.closeIncident(incident.id, { at: '2026-09-22T10:20:00+08:00' });

  const fresh = service.getIncidentOrThrow(incident.id);
  assert.equal(fresh.state, IncidentState.CLOSED);
  const report = service.incidentReport(incident.id);
  assert.equal(report.legs.onSiteMs, 8 * 60_000);
  assert.equal(report.legs.rescuedMs, 15 * 60_000);
  assert.equal(store.get('rescuers', 'RSC-01').status, RescuerStatus.ON_DUTY, '归档后恢复待命');
});

test('无摄像头电梯：联动转为通知物业，不阻断接警', async () => {
  const { service } = makeService();
  const { incident } = await service.receiveAlarm({ elevatorId: 'ELV-302', at: T0 });
  assert.equal(incident.monitorStatus, 'unavailable');
  assert.match(incident.timeline.find((t) => t.type === 'monitor').summary, /物业/);
});

test('无合格救援员：接警即升级主管，事件仍处接警态', async () => {
  const { service, store } = makeService();
  for (const r of store.list('rescuers')) r.status = RescuerStatus.OFF_DUTY;
  const { incident, dispatch } = await service.receiveAlarm({ elevatorId: 'ELV-301', at: T0 });
  assert.equal(dispatch.dispatched, false);
  assert.equal(incident.escalationLevel, EscalationLevel.SUPERVISOR);
  assert.equal(incident.state, IncidentState.ALARM_RECEIVED);
});

test('SLA 扫描：超时升级且重复扫描幂等；到场后不再升级', async () => {
  const { service } = makeService();
  const { incident } = await service.receiveAlarm({ elevatorId: 'ELV-401', at: T0 });

  // 已自动派单，31 分钟未到场 → 应急中心
  let r = await service.slaSweep({ at: '2026-09-22T10:31:00+08:00' });
  assert.equal(r.escalated.length, 1);
  assert.equal(r.escalated[0].level, EscalationLevel.EMERGENCY_CENTER);
  assert.equal(service.getIncidentOrThrow(incident.id).escalationLevel, EscalationLevel.EMERGENCY_CENTER);

  const again = await service.slaSweep({ at: '2026-09-22T10:32:00+08:00' });
  assert.equal(again.escalated.length, 0, '同级升级不重复记录');

  await service.markOnSite(incident.id, { at: '2026-09-22T10:35:00+08:00' });
  const late = await service.slaSweep({ at: '2026-09-22T12:00:00+08:00' });
  assert.equal(late.escalated.length, 0, '到场后脱离 arrival SLA');
});

test('未派单事件 60 秒后扫描升级主管', async () => {
  const { store, service } = makeService();
  service.autoDispatch = false;
  for (const r of store.list('rescuers')) r.status = RescuerStatus.OFF_DUTY;
  const { incident } = await service.receiveAlarm({ elevatorId: 'ELV-301', at: T0 });
  assert.equal(incident.state, IncidentState.ALARM_RECEIVED);

  const r = await service.slaSweep({ at: '2026-09-22T10:01:01+08:00' });
  assert.equal(r.escalated[0].level, EscalationLevel.SUPERVISOR);
});

test('改派：旧救援员释放回待命，新救援员上岗，时间线留痕', async () => {
  const { service, store } = makeService();
  const { incident } = await service.receiveAlarm({ elevatorId: 'ELV-101', at: T0 });
  assert.equal(incident.rescuerId, 'RSC-01');

  await service.reassign(incident.id, { rescuerId: 'RSC-02', reason: '陈雷堵车', at: T0 });
  assert.equal(incident.rescuerId, 'RSC-02');
  assert.equal(store.get('rescuers', 'RSC-01').status, RescuerStatus.ON_DUTY);
  assert.equal(store.get('rescuers', 'RSC-02').status, RescuerStatus.ASSIGNED);
  assert.ok(incident.timeline.some((e) => e.type === 'reassignment'));
});

test('监控中心补报火情：时间线增加 monitor 条目，状态不变', async () => {
  const { service } = makeService();
  const { incident } = await service.receiveAlarm({ elevatorId: 'ELV-101', at: T0 });
  const before = incident.state;
  await service.addMonitorEvent(incident.id, {
    source: 'video_ai', summary: 'AI 识别轿厢内疑似烟雾，值班员已复核',
    data: { confidence: 0.91 }, at: '2026-09-22T10:00:20+08:00',
  });
  const fresh = service.getIncidentOrThrow(incident.id);
  assert.equal(fresh.state, before);
  assert.ok(fresh.timeline.some((e) => e.type === 'monitor' && /烟雾/.test(e.summary)));
});

test('统计口径：平均到场、升级数、破线数随闭环更新', async () => {
  const { service } = makeService();
  const { incident } = await service.receiveAlarm({ elevatorId: 'ELV-101', at: T0 });
  await service.markOnSite(incident.id, { at: '2026-09-22T10:40:00+08:00' }); // 到场超时
  await service.markRescued(incident.id, { at: '2026-09-22T10:50:00+08:00' });
  await service.closeIncident(incident.id, { at: '2026-09-22T11:00:00+08:00' });

  const stats = service.stats();
  assert.equal(stats.total, 1);
  assert.equal(stats.closed, 1);
  assert.equal(stats.arrivalBreachedClosed, 1);
  assert.equal(stats.avgArrivalMs, 40 * 60_000);
});
