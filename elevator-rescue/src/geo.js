// 地理计算：球面距离与预计到达时间（ETA）

/** Haversine 球面距离（公里）。a/b 均为 { lat, lng } */
export function distanceKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la = toRad(a.lat);
  const lb = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** 按城区平均车速折算预计到达分钟数，默认 30km/h，可用 AVG_SPEED_KMH 调整 */
export function etaMinutes(km, speedKmh = Number(process.env.AVG_SPEED_KMH || 30)) {
  return (km / speedKmh) * 60;
}
