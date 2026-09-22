/**
 * 地理计算：WGS84/GCJ02 经纬度只用于本系统内的相对距离比较，
 * 采用 haversine 公式（球面距离），城市尺度误差可接受。
 */

const EARTH_RADIUS_KM = 6371;
const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * 两点间球面距离，单位 km，保留 3 位小数（约 1 米精度）。
 */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(EARTH_RADIUS_KM * c * 1000) / 1000;
}

/**
 * 由直线距离估算道路行程时间（分钟）：按平均通行速度上浮 30% 绕行系数。
 * 真实系统应替换为地图 API 的路径规划。
 */
export function estimateEtaMinutes(distanceKm, avgSpeedKmh = 30, detourFactor = 1.3) {
  if (distanceKm <= 0.05) return 1; // 已在楼内
  return Math.max(1, Math.round(((distanceKm * detourFactor) / avgSpeedKmh) * 60));
}
