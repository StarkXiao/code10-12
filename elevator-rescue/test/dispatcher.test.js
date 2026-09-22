import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Clock } from '../src/clock.js';
import { DispatchService } from '../src/service.js';
import { cloneSeed } from '../src/seed.js';
import { rankRescuers } from '../src/dispatcher.js';
import { requiredCertsFor } from '../src/certifications.js';
import { RescuerStatus } from '../src/constants.js';

const AT = new Date('2026-09-22T10:00:00+08:00');

function makeService() {
  const store = new Store(null, cloneSeed());
  const clock = new Clock(AT);
  const service = new DispatchService(store, clock, { autoDispatch: false });
  return { store, clock, service };
}

test('资质过滤：过期电梯证的救援员（RSC-06）不可派，尽管他离得最近', async () => {
  const { service } = makeService();
  const { incident } = await service.receiveAlarm({ elevatorId: 'ELV-101', at: AT.toISOString() });
  const { candidates, requiredCerts } = service.suggestRescuers(incident.id, { at: AT.toISOString() });

  assert.ok(requiredCerts.includes('elevator_op'));
  assert.ok(requiredCerts.includes('brand_training:三菱'));

  const expired = candidates.find((c) => c.rescuerId === 'RSC-06');
  assert.equal(expired.eligible, false);
  assert.match(expired.reason, /资质|过期/);

  const eligible = candidates.filter((c) => c.eligible).map((c) => c.rescuerId);
  assert.deepEqual(eligible.sort(), ['RSC-01', 'RSC-02', 'RSC-08']);
});

test('就近排序：合格者按距离/ETA 综合评分，陈雷（0.6km）排在韩冰（机动队，远）之前', async () => {
  const { service } = makeService();
  const { incident } = await service.receiveAlarm({ elevatorId: 'ELV-101', at: AT.toISOString() });
  const { candidates } = service.suggestRescuers(incident.id, { at: AT.toISOString() });
  const eligible = candidates.filter((c) => c.eligible);
  assert.equal(eligible[0].rescuerId, 'RSC-01');
  assert.ok(eligible[0].distanceKm < eligible.at(-1).distanceKm);
});

test('超高层（52 层）消防梯：无高层资质者全部出局，孙强（浦东应急班）胜出', async () => {
  const { service } = makeService();
  const { incident } = await service.receiveAlarm({ elevatorId: 'ELV-201', at: AT.toISOString() });
  const { candidates, requiredCerts } = service.suggestRescuers(incident.id, { at: AT.toISOString() });

  assert.ok(requiredCerts.includes('high_rise'));
  const eligible = candidates.filter((c) => c.eligible);
  // 赵敏持高层证但在静安、无消防证；孙强最近且资质最全，排第一
  assert.equal(eligible[0].rescuerId, 'RSC-03');
  assert.deepEqual(
    eligible.map((c) => c.rescuerId).sort(),
    ['RSC-02', 'RSC-03', 'RSC-04', 'RSC-08'],
  );
});

test('下班救援员（RSC-07）即使在附近也不参与派单', async () => {
  const { service } = makeService();
  const { incident } = await service.receiveAlarm({ elevatorId: 'ELV-401', at: AT.toISOString() });
  const { candidates } = service.suggestRescuers(incident.id, { at: AT.toISOString() });
  const feng = candidates.find((c) => c.rescuerId === 'RSC-07');
  assert.equal(feng.eligible, false);
  assert.equal(feng.reason, '已下班');
});

test('容量约束：救援员在手事件达到上限后不再命中，第二起派给次优者', async () => {
  const { service } = makeService();
  const a = await service.receiveAlarm({ elevatorId: 'ELV-101', at: AT.toISOString() });
  await service.dispatch(a.incident.id, {});
  assert.equal(a.incident.rescuerId, 'RSC-01');

  const b = await service.receiveAlarm({ elevatorId: 'ELV-102', at: AT.toISOString() });
  await service.dispatch(b.incident.id, {});
  assert.equal(b.incident.rescuerId, 'RSC-02', 'RSC-01 已占用，应改派赵敏');
});

test('指定不合格救援员派单应 409，并返回拒绝原因', async () => {
  const { service } = makeService();
  const { incident } = await service.receiveAlarm({ elevatorId: 'ELV-101', at: AT.toISOString() });
  await assert.rejects(
    () => service.dispatch(incident.id, { rescuerId: 'RSC-06', at: AT.toISOString() }),
    (err) => err.statusCode === 409,
  );
});

test('rankRescuers 入参契约：必需资质为空集合时所有在岗者均合格', () => {
  const rows = rankRescuers({
    rescuers: [
      { id: 'a', name: '甲', lat: 31.23, lon: 121.45, status: RescuerStatus.ON_DUTY, rating: 80, certifications: [] },
      { id: 'b', name: '乙', lat: 31.30, lon: 121.50, status: RescuerStatus.ON_DUTY, rating: 80, certifications: [] },
    ],
    target: { lat: 31.23, lon: 121.45 },
    requiredCerts: new Set(),
    at: AT,
  });
  assert.deepEqual(rows.filter((r) => r.eligible).map((r) => r.rescuerId), ['a', 'b']);
});

test('电梯必需资质：普通客梯只要电梯证；品牌梯 + 超高层分别叠加', () => {
  const { store } = makeService();
  const low = requiredCertsFor(store.get('elevators', 'ELV-301'), store.get('buildings', 'BLD-003'));
  assert.deepEqual([...low], ['elevator_op']);

  const brand = requiredCertsFor(store.get('elevators', 'ELV-101'), store.get('buildings', 'BLD-001'));
  assert.ok(brand.has('brand_training:三菱'));

  const highRise = requiredCertsFor(store.get('elevators', 'ELV-201'), store.get('buildings', 'BLD-002'));
  assert.ok(highRise.has('high_rise'));
});
