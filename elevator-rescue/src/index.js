/**
 * 服务入口：加载 JSON 仓储（无文件时写入基线数据），启动 HTTP + SLA 定时扫描。
 */
import { Store } from './store.js';
import { Clock } from './clock.js';
import { DispatchService } from './service.js';
import { createHttpServer } from './http.js';
import { cloneSeed } from './seed.js';
import { SLA } from './constants.js';

const PORT = Number(process.env.PORT ?? 3000);
const DATA_FILE = process.env.DATA_FILE ?? new URL('../data/store.json', import.meta.url).pathname;
const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS ?? 15_000);

const existing = await Store.open(DATA_FILE, cloneSeed());
// 首次启动（无文件且 incidents/资源为空）时把基线落盘
if (existing.list('buildings').length === 0) {
  const seeded = new Store(DATA_FILE, cloneSeed());
  await seeded.persist();
}
const store = await Store.open(DATA_FILE, cloneSeed());
const clock = new Clock();
const service = new DispatchService(store, clock, { autoDispatch: true });
const server = createHttpServer(service);

server.listen(PORT, () => {
  console.log(`🚨 电梯困人救援调度系统已启动: http://localhost:${PORT}`);
  console.log(`   数据文件: ${DATA_FILE}`);
  console.log(`   SLA: 派单 ${SLA.ackDeadlineMs / 1000}s / 到场 ${SLA.arrivalDeadlineMs / 60000}min`);
});

// 周期 SLA 扫描（幂等，升级不会重复记录）
const timer = setInterval(() => {
  service
    .slaSweep()
    .then((r) => {
      if (r.escalated.length) {
        console.warn(`[SLA] ${new Date().toISOString()} 升级 ${r.escalated.length} 起:`, r.escalated);
      }
    })
    .catch((err) => console.error('[SLA sweep]', err));
}, SWEEP_INTERVAL_MS);
timer.unref();

const shutdown = () => {
  console.log('\n关闭中…');
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
