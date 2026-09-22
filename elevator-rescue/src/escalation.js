// 升级扫描：接单超时自动改派、到场超时升级紧急
import { ACCEPT_TIMEOUT_MS, ARRIVE_SLA_MIN, pushTimeline, reassignDispatch } from './service.js';

export function startEscalation(ctx) {
  const timer = setInterval(() => {
    const now = Date.now();
    let dirty = false;

    // 派单后超时未接单 → 自动改派下一位候选人
    for (const d of [...ctx.db.dispatches]) {
      if (d.status === 'dispatched' && now - new Date(d.dispatched_at).getTime() > ACCEPT_TIMEOUT_MS) {
        try {
          reassignDispatch(ctx, d.id, `接单超时（${Math.round(ACCEPT_TIMEOUT_MS / 1000)} 秒未响应），系统自动改派`);
        } catch { /* 状态已被人工推进，跳过 */ }
      }
    }

    // 报警后超过 SLA 仍未到场 → 升级紧急
    for (const a of ctx.db.alarms) {
      if (['closed', 'cancelled'].includes(a.status) || a.escalated) continue;
      const arrived = ['arrived', 'rescued'].includes(a.status);
      if (!arrived && now - new Date(a.created_at).getTime() > ARRIVE_SLA_MIN * 60000) {
        a.escalated = true;
        a.priority = 'urgent';
        pushTimeline(a, 'escalate', 'system', `报警后 ${ARRIVE_SLA_MIN} 分钟仍未到场，事件升级为紧急，已通知值班主管`);
        dirty = true;
      }
    }

    if (dirty) {
      ctx.save();
      ctx.broadcast('update', { kind: 'escalation' });
    }
  }, 5000);
  timer.unref();
  return timer;
}
