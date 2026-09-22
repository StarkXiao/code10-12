// 模拟器：演示/联调用，让被派单的救援人员按真实节奏自动推进状态
import { acceptDispatch, arriveDispatch, completeDispatch, departDispatch, releaseDispatch } from './service.js';

const rand = (min, max) => min + Math.random() * (max - min);

/** 依次自动执行：接单 → 出发 → 到场 → 救出 → 闭环（任一步被人工抢先后，后续自动跳过） */
export function simulateRescue(ctx, dispatchId) {
  const steps = [
    [rand(3000, 8000), () => acceptDispatch(ctx, dispatchId)],
    [rand(2000, 5000), () => departDispatch(ctx, dispatchId)],
    [rand(10000, 25000), () => arriveDispatch(ctx, dispatchId)],
    [rand(8000, 15000), () => releaseDispatch(ctx, dispatchId)],
    [rand(3000, 6000), () => completeDispatch(ctx, dispatchId, '模拟救援自动闭环')],
  ];
  let delay = 0;
  for (const [ms, fn] of steps) {
    delay += ms;
    const t = setTimeout(() => { try { fn(); } catch { /* 状态已被人工推进 */ } }, delay);
    t.unref();
  }
}
