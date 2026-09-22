/**
 * 端到端演示（不走 HTTP，直接用内存服务 + 可注入时钟）：
 *   场景一：静安中心三菱电梯困人 —— 完整接警/联动/匹配/派单/到场时序
 *   场景二：消防梯困人（52 层）—— 高层资质过滤，最近的人不够资质
 *   场景三：唯一合格救援员被占用且无待命人选 —— 接警即升级主管
 *   场景四：派单后无人到场 —— SLA 扫描升级 119/120
 */
import { Store } from '../src/store.js';
import { Clock, fmtTime, fmtDuration } from '../src/clock.js';
import { DispatchService } from '../src/service.js';
import { cloneSeed } from '../src/seed.js';
import { RescuerStatus } from '../src/constants.js';

const T0 = '2026-09-22T10:00:00+08:00';
const clock = new Clock(T0);
const store = new Store(null, cloneSeed());
const service = new DispatchService(store, clock, { autoDispatch: true });

const line = (s = '') => console.log(s);
const hr = (ch = '─') => line(''.padEnd(78, ch));
const title = (s) => {
  line();
  hr('═');
  line(`  ${s}`);
  hr('═');
};

function printRanking(dispatch) {
  line(`  匹配名单（必需资质：${dispatch.requiredCerts.join('、')}）`);
  for (const c of dispatch.ranking) {
    const tag = c.eligible
      ? `✅ 可派 评分 ${c.score}｜${c.distanceKm}km｜ETA ${c.etaMinutes}分钟`
      : `❌ ${c.reason}`;
    line(`    ${c.name.padEnd(4)}（${c.team}） ${tag}`);
  }
}

function printTimeline(incident) {
  const labels = {
    alarm: '🚨', dispatch: '📋', en_route: '🛻', on_site: '🏗️',
    rescued: '🤝', closed: '📁', monitor: '📹', escalation: '⚠️ ',
    reassignment: '🔁', note: '📝',
  };
  const legs = incident.timeline
    .map((e) => `${labels[e.type] ?? '•'} ${fmtTime(e.at)}  ${e.summary}`)
    .join('\n    ');
  line(`    ${legs}`);
}

function printReport(id) {
  const { incident, legs, sla } = service.incidentReport(id);
  hr();
  line(`  事件 ${incident.id} 时序报告（状态：${incident.state}）`);
  hr();
  printTimeline(incident);
  line(`    ─ 节点耗时（自接警起）：派单 ${fmtDuration(legs.dispatchMs)} ｜ 出发 ${fmtDuration(legs.enRouteMs)} ｜ 到场 ${fmtDuration(legs.onSiteMs)} ｜ 救出 ${fmtDuration(legs.rescuedMs)}`);
  line(`    ─ SLA 余量：派单 ${fmtDuration(sla.ackRemainingMs)} ｜ 到场 ${fmtDuration(sla.arrivalRemainingMs)} ｜ 升级级别 ${incident.escalationLevel}`);
}

// ================= 场景一：完整闭环 =================
title('场景一　静安中心大厦 · 三菱客梯困人（有老人，紧急）');
let { incident: inc1, dispatch: d1 } = await service.receiveAlarm({
  elevatorId: 'ELV-101',
  floor: 12,
  occupants: 3,
  hasVulnerable: true,
  summary: '12 层停梯，轿厢内 3 人含 1 名老人，紧急按钮报警',
  at: T0,
});
line(`  建警 ${inc1.id}　级别 ${inc1.priority}　摄像头联动：${inc1.timeline.find((t) => t.type === 'monitor').summary}`);
printRanking(d1);
line(`  → 自动派单给：${store.get('rescuers', inc1.rescuerId).name}`);

clock.advance(45_000); // 45 秒后出发（派单 SLA 60 秒内）
await service.markEnRoute(inc1.id, {});
clock.advance(8 * 60_000); // 8 分钟后到场
await service.markOnSite(inc1.id, {});
clock.advance(6 * 60_000); // 盘车放人 6 分钟
await service.markRescued(inc1.id, { summary: '盘车平层，开门放人，3 人身体无碍' });
clock.advance(10 * 60_000);
await service.closeIncident(inc1.id, { note: '故障原因为门锁回路接触不良，已复位待复检' });
printReport(inc1.id);

// ================= 场景二：52 层消防梯，资质过滤 =================
title('场景二　陆家嘴金融广场 · 消防梯困人（52 层建筑，需高层资质）');
clock.setNow('2026-09-22T11:00:00+08:00');
let { incident: inc2, dispatch: d2 } = await service.receiveAlarm({
  elevatorId: 'ELV-201',
  floor: 36,
  occupants: 5,
  summary: '36 层急停，5 人被困，无人员受伤',
  at: '2026-09-22T11:00:00+08:00',
});
printRanking(d2);
line(`  → 选中：${store.get('rescuers', inc2.rescuerId).name}（注意：直线最近者若无高层资质会被淘汰）`);
printReport(inc2.id);

// ================= 场景三：无合格待命人选 → 升级 =================
title('场景三　徐汇苑 · 凌晨值守稀疏，唯一合格救援员被占用 → 升级主管');
const t3 = '2026-09-22T02:00:00+08:00';
clock.setNow(t3);
// 模拟凌晨班：除徐汇站吴刚外，其余站点全部下班
for (const r of store.list('rescuers')) {
  if (r.id !== 'RSC-05') r.status = RescuerStatus.OFF_DUTY;
}
// 先制造一起占用：派给 RSC-05（徐汇唯一有电梯证的待命人）
const occ = await service.receiveAlarm({
  elevatorId: 'ELV-301', floor: 9, occupants: 2, at: t3,
});
line(`  占用事件 ${occ.incident.id} 派给 ${store.get('rescuers', occ.incident.rescuerId).name}`);
// 同楼另一台电梯再报警（ELV-302 无摄像头）
const { incident: inc3b, dispatch: d3 } = await service.receiveAlarm({
  elevatorId: 'ELV-302',
  floor: 2,
  occupants: 1,
  summary: '货梯困人，无监控覆盖',
  at: t3,
});
line(`  监控联动：${inc3b.timeline.find((t) => t.type === 'monitor').summary}`);
printRanking(d3);
line(`  派单结果：${d3.dispatched ? '已派 ' + store.get('rescuers', inc3b.rescuerId).name : '❌ ' + d3.reason}`);
line(`  升级级别：${inc3b.escalationLevel}`);
// 主管电话叫醒机动队韩冰，上岗后由主管人工派单（此前从未派出，走 dispatch 而非改派）
clock.advance(30_000);
store.get('rescuers', 'RSC-08').status = RescuerStatus.ON_DUTY;
await service.dispatch(inc3b.id, { rescuerId: 'RSC-08', at: clock.now().toISOString() });
line(`  主管人工派单：${store.get('rescuers', inc3b.rescuerId).name}`);
printReport(inc3b.id);

// ================= 场景四：到场 SLA 超时 → 119/120 =================
title('场景四　虹桥天地 · 摄像头离线 + 救援员未到场，30 分钟 SLA 升级');
const t4 = '2026-09-22T13:00:00+08:00';
clock.setNow(t4);
// 恢复白天班次
for (const r of store.list('rescuers')) {
  if (!['RSC-07'].includes(r.id)) r.status = RescuerStatus.ON_DUTY;
}
// 白天之前的事件都已闭环（按各自接警时刻推进状态机到归档，释放救援员）
async function quickClose(id, alarmIso, offsetsMin) {
  const i = service.getIncidentOrThrow(id);
  if (i.state === 'dispatched') {
    const base = Date.parse(alarmIso);
    const iso = (m) => new Date(base + m * 60_000).toISOString();
    await service.markEnRoute(id, { at: iso(offsetsMin[0]) });
    await service.markOnSite(id, { at: iso(offsetsMin[1]) });
    await service.markRescued(id, { at: iso(offsetsMin[2]) });
    await service.closeIncident(id, { at: iso(offsetsMin[3]) });
  }
}
await quickClose(inc2.id, '2026-09-22T11:00:00+08:00', [3, 10, 18, 25]);
await quickClose(occ.incident.id, t3, [2, 9, 16, 24]);
await quickClose(inc3b.id, t3, [2, 12, 20, 30]);
// 让虹桥最近的待命人不可达：RSC-07 本就下班；事件会派给其他合格者（距离远）
const { incident: inc4 } = await service.receiveAlarm({
  elevatorId: 'ELV-401', floor: 15, occupants: 2, at: t4,
});
line(`  已派：${store.get('rescuers', inc4.rescuerId)?.name ?? '无'}　监控：${inc4.monitorStatus}`);
// 61 秒未"出发/到场"以外的推进：先看派单 SLA（已自动派单，不触发）
clock.setNow('2026-09-22T13:00:30+08:00');
let sweep = await service.slaSweep({});
line(`  T+30s 扫描：升级 ${sweep.escalated.length} 起`);
// 31 分钟后仍未到场
clock.setNow('2026-09-22T13:31:00+08:00');
sweep = await service.slaSweep({});
line(`  T+31min 扫描：升级 ${sweep.escalated.length} 起 → ${JSON.stringify(sweep.escalated)}`);
const again = await service.slaSweep({});
line(`  重复扫描幂等性校验：再升级 ${again.escalated.length} 起（应为 0）`);
printReport(inc4.id);

// ================= 统计 =================
title('调度统计');
console.log(JSON.stringify(service.stats(), null, 2));
line();
line('演示完成。');
