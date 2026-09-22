import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineKm, estimateEtaMinutes } from '../src/geo.js';

test('haversine：同点距离为 0', () => {
  assert.equal(haversineKm(31.23, 121.45, 31.23, 121.45), 0);
});

test('haversine：上海人民广场到静安寺约 2.5~3.0km，且对称', () => {
  const d = haversineKm(31.2334, 121.4715, 31.2244, 121.4448);
  assert.ok(d > 2.5 && d < 3.0, `实际 ${d}`);
  assert.equal(d, haversineKm(31.2244, 121.4448, 31.2334, 121.4715));
});

test('ETA：同楼（≤50m）给 1 分钟，远距离随距离增长', () => {
  assert.equal(estimateEtaMinutes(0), 1);
  assert.equal(estimateEtaMinutes(0.03), 1);
  const near = estimateEtaMinutes(2);
  const far = estimateEtaMinutes(20);
  assert.ok(far > near);
});
