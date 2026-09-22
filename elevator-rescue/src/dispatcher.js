/**
 * 派单匹配：在"有资质"的前提下按"就近"排序。
 *
 * 过滤（硬性条件，缺一不可）：
 *   1. 在岗（on_duty）；
 *   2. 持有所需的全部未过期资质；
 *   3. 未达同时处理事件上限（默认 1，紧急时可放 2）。
 *
 * 排序（评分，分越高越优先）：
 *   - 距离越近越高（每公里 -4）
 *   - 预计到场越快越高（每分钟 -1.5）
 *   - 多余资质每项 +2
 *   - 历史评分（0-100）×0.2
 */
import { DISPATCH_WEIGHTS, AVG_SPEED_KMH, RescuerStatus } from './constants.js';
import { haversineKm, estimateEtaMinutes } from './geo.js';
import { holdsAllCerts, extraCertCount } from './certifications.js';

/**
 * @param rescuers 全部救援员
 * @param target {lat, lon} 事发电梯坐标
 * @param requiredCerts Set<string> 必需资质
 * @param activeIncidentsByRescuer Map<rescuerId, number> 当前在手事件数
 * @param at 评估时刻（验证书有效期）
 */
export function rankRescuers({
  rescuers,
  target,
  requiredCerts,
  activeIncidentsByRescuer = new Map(),
  maxConcurrent = 1,
  at = new Date(),
}) {
  const candidates = [];

  for (const r of rescuers) {
    const reject = rejectReason(r, target, requiredCerts, activeIncidentsByRescuer, maxConcurrent, at);
    const distanceKm = haversineKm(r.lat, r.lon, target.lat, target.lon);
    const etaMinutes = estimateEtaMinutes(distanceKm, AVG_SPEED_KMH);

    if (reject) {
      candidates.push({
        rescuerId: r.id, name: r.name, team: r.team, phone: r.phone,
        eligible: false, reason: reject, distanceKm, etaMinutes,
      });
      continue;
    }

    const extras = extraCertCount(r, requiredCerts, at);
    const score =
      100 -
      distanceKm * DISPATCH_WEIGHTS.perKm -
      etaMinutes * DISPATCH_WEIGHTS.perEtaMinute +
      extras * DISPATCH_WEIGHTS.bonusPerExtraCert +
      (r.rating ?? 0) * DISPATCH_WEIGHTS.ratingScale;

    candidates.push({
      rescuerId: r.id,
      name: r.name,
      team: r.team,
      phone: r.phone,
      eligible: true,
      distanceKm,
      etaMinutes,
      extraCerts: extras,
      rating: r.rating ?? 0,
      score: Math.round(score * 10) / 10,
    });
  }

  candidates.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    return b.score - a.score;
  });
  return candidates;
}

function rejectReason(r, target, requiredCerts, activeMap, maxConcurrent, at) {
  if (r.status === RescuerStatus.OFF_DUTY) return '已下班';
  if (r.status !== RescuerStatus.ON_DUTY) return '当前状态非待命';
  if (!holdsAllCerts(r, requiredCerts, at)) return '资质不符或证书过期';
  const active = activeMap.get(r.id) ?? 0;
  if (active >= maxConcurrent) return `已在处理 ${active} 起事件`;
  if (typeof r.lat !== 'number' || typeof r.lon !== 'number') return '缺少定位';
  return null;
}
