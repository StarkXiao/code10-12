// 楼宇监控联动：报警触发时自动调取相关摄像头与传感器读数
// 摄像头画面为模拟快照（SVG），真实部署时替换为流媒体网关地址即可

/** 汇聚事发电梯的摄像头（轿厢内/厅门）与楼宇级摄像头（机房/大堂），并读取传感器状态 */
export function linkMonitoring(db, elevator, building) {
  const cams = db.cameras.filter(
    (c) => c.elevator_id === elevator.id || (c.building_id === building.id && !c.elevator_id)
  );
  return {
    linked_at: new Date().toISOString(),
    cameras: cams.map((c) => ({
      id: c.id,
      name: c.name,
      location_desc: c.location_desc,
      stream_url: c.stream_url,
      online: c.online,
      snapshot_url: `/api/monitoring/snapshot/${c.id}`,
    })),
    sensors: {
      car_position_floor: elevator.current_floor, // 轿厢位置（平层感应）
      door_state: elevator.door_state,            // 门回路状态
      in_service: elevator.status !== 'fault',    // 是否运行中
      fault_code: elevator.fault_code || '无',     // 最近故障码
      traction_power: '正常',                      // 曳引机电源
      intercom: '已接通',                          // 五方对讲
    },
  };
}

const esc = (s) => String(s).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));

/** 生成一帧模拟监控画面（SVG），带摄像头名称、时间戳与 REC 标识 */
export function renderSnapshot(cam) {
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  if (!cam.online) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <rect width="640" height="360" fill="#20242a"/>
  <text x="320" y="170" text-anchor="middle" fill="#8a939e" font-size="22" font-family="monospace">信号丢失</text>
  <text x="320" y="205" text-anchor="middle" fill="#5a636e" font-size="14" font-family="monospace">${esc(cam.name)} · 设备离线</text>
  <text x="24" y="336" fill="#5a636e" font-size="14" font-family="monospace">${ts}</text>
</svg>`;
  }
  const scanlines = Array.from(
    { length: 12 },
    (_, i) => `<line x1="0" y1="${i * 30}" x2="640" y2="${i * 30}" stroke="#ffffff" stroke-opacity="0.03"/>`
  ).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#1a2430"/><stop offset="1" stop-color="#0a0f16"/>
  </linearGradient></defs>
  <rect width="640" height="360" fill="url(#g)"/>
  ${scanlines}
  <line x1="320" y1="150" x2="320" y2="210" stroke="#7fff9f" stroke-opacity="0.35"/>
  <line x1="290" y1="180" x2="350" y2="180" stroke="#7fff9f" stroke-opacity="0.35"/>
  <circle cx="42" cy="38" r="8" fill="#e33"/>
  <text x="58" y="44" fill="#ffffff" font-size="18" font-family="monospace">REC</text>
  <text x="320" y="182" text-anchor="middle" fill="#5a6b7d" font-size="14" font-family="monospace">SIMULATED FEED · 模拟监控画面</text>
  <text x="24" y="336" fill="#9fb3c8" font-size="15" font-family="monospace">${esc(cam.name)} · ${esc(cam.location_desc)}</text>
  <text x="616" y="336" text-anchor="end" fill="#9fb3c8" font-size="15" font-family="monospace">${ts}</text>
</svg>`;
}
