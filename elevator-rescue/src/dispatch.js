// 调度匹配引擎：硬条件过滤（在岗 + 持证有效）→ 加权评分排序
import { distanceKm, etaMinutes } from './geo.js';

// 资质等级 → 资质分
const CERT_SCORE = { 高级: 1, 中级: 0.7, 初级: 0.4 };

// 评分权重：就近为主，资质与经验为辅
export const WEIGHTS = { distance: 0.6, cert: 0.25, experience: 0.15 };

/**
 * 对救援人员排序。
 * @param {Array} rescuers 全部救援人员
 * @param {{lat:number,lng:number}} target 事发楼宇坐标
 * @returns {{eligible: Array, rejected: Array}} 合格候选人（按综合分降序）与被剔除者（含原因）
 */
export function rankCandidates(rescuers, target, now = new Date()) {
  const eligible = [];
  const rejected = [];
  for (const r of rescuers) {
    // 硬条件：必须在岗、持电梯作业证且证件在有效期内
    const reasons = [];
    if (r.status === 'busy') reasons.push('任务执行中');
    else if (r.status !== 'available') reasons.push('休息中/未在岗');
    if (!r.cert_type) reasons.push('无电梯作业证');
    else if (r.cert_expires_on && new Date(r.cert_expires_on) < now) reasons.push(`证件已于 ${r.cert_expires_on} 过期`);
    if (reasons.length) {
      rejected.push({ rescuer: r, reasons });
      continue;
    }
    const km = distanceKm(r.location, target);
    const eta = etaMinutes(km);
    // 距离分：ETA 0 分钟→1，20 分钟→0.5，单调递减
    const distScore = 1 / (1 + eta / 20);
    const certScore = CERT_SCORE[r.cert_level] ?? 0.2;
    // 经验分：50 次救援封顶
    const expScore = Math.min(1, (r.completed_rescues || 0) / 50);
    const score = WEIGHTS.distance * distScore + WEIGHTS.cert * certScore + WEIGHTS.experience * expScore;
    eligible.push({ rescuer: r, km, eta, score, breakdown: { distance: distScore, cert: certScore, experience: expScore } });
  }
  eligible.sort((a, b) => b.score - a.score);
  return { eligible, rejected };
}
