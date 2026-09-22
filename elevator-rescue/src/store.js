// 数据存取：JSON 文件持久化（原子写入）+ 首次启动种子数据
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

export function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch {
      console.warn('[store] db.json 损坏，重新初始化');
    }
  }
  const db = seed();
  saveDb(db);
  return db;
}

export function saveDb(db) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE); // 原子替换，避免写一半损坏
}

function seed() {
  const buildings = [
    { id: 'B1', name: '星光中心', address: '文三路 100 号', lat: 30.2741, lng: 120.1551, property_phone: '0571-88000001' },
    { id: 'B2', name: '云栖公寓', address: '文二路 260 号', lat: 30.2812, lng: 120.1478, property_phone: '0571-88000002' },
    { id: 'B3', name: '滨江大厦', address: '江南大道 88 号', lat: 30.2648, lng: 120.1619, property_phone: '0571-88000003' },
  ];

  const elevators = [
    { id: 'E1', building_id: 'B1', name: '1#客梯', code: '3010330101001001', type: '客梯', floors: 28, current_floor: 12, door_state: '关门到位', fault_code: null, status: 'normal' },
    { id: 'E2', building_id: 'B1', name: '2#货梯', code: '3010330101001002', type: '货梯', floors: 28, current_floor: 3, door_state: '关门到位', fault_code: null, status: 'normal' },
    { id: 'E3', building_id: 'B2', name: '1#客梯', code: '3010330101002001', type: '客梯', floors: 18, current_floor: 7, door_state: '关门到位', fault_code: null, status: 'normal' },
    { id: 'E4', building_id: 'B2', name: '2#客梯', code: '3010330101002002', type: '客梯', floors: 18, current_floor: 15, door_state: '关门到位', fault_code: null, status: 'normal' },
    { id: 'E5', building_id: 'B3', name: '1#客梯', code: '3010330101003001', type: '客梯', floors: 32, current_floor: 21, door_state: '门区异常', fault_code: 'E48 门锁回路断开', status: 'normal' },
    { id: 'E6', building_id: 'B3', name: '2#客梯', code: '3010330101003002', type: '客梯', floors: 32, current_floor: 9, door_state: '关门到位', fault_code: null, status: 'normal' },
  ];

  // 每台电梯：轿厢内 + 厅门联动摄像头；每栋楼：机房 + 大堂摄像头
  const cameras = [];
  let camSeq = 0;
  const addCam = (building_id, elevator_id, name, location_desc, online = true) => {
    camSeq += 1;
    cameras.push({
      id: `C${camSeq}`, building_id, elevator_id, name, location_desc,
      stream_url: `rtsp://10.10.0.${10 + camSeq}:554/stream1`, online,
    });
  };
  for (const e of elevators) {
    addCam(e.building_id, e.id, `${e.name} 轿厢内摄像头`, '轿厢内顶部');
    addCam(e.building_id, e.id, `${e.name} 厅门摄像头`, '厅门（按轿厢位置联动楼层）');
  }
  for (const b of buildings) {
    addCam(b.id, null, `${b.name} 机房摄像头`, '电梯机房', b.id !== 'B3'); // B3 机房摄像头离线，演示异常态
    addCam(b.id, null, `${b.name} 大堂摄像头`, '一层大堂');
  }

  // 救援人员：持证（特种设备作业人员证-电梯修理 T）+ 资质等级 + 实时位置 + 在岗状态
  const rescuers = [
    { id: 'R1', name: '张伟', phone: '13905710001', org: '迅安电梯维保', cert_type: 'T（电梯修理）', cert_level: '高级', cert_no: 'TS3301001001', cert_expires_on: '2028-06-30', status: 'available', location: { lat: 30.275, lng: 120.156 }, completed_rescues: 47 },
    { id: 'R2', name: '李强', phone: '13905710002', org: '迅安电梯维保', cert_type: 'T（电梯修理）', cert_level: '中级', cert_no: 'TS3301001002', cert_expires_on: '2027-03-31', status: 'available', location: { lat: 30.27, lng: 120.15 }, completed_rescues: 23 },
    { id: 'R3', name: '王芳', phone: '13905710003', org: '迅安电梯维保', cert_type: 'T（电梯修理）', cert_level: '中级', cert_no: 'TS3301001003', cert_expires_on: '2027-09-30', status: 'off_duty', location: { lat: 30.26, lng: 120.14 }, completed_rescues: 31 },
    { id: 'R4', name: '赵磊', phone: '13905710004', org: '恒达电梯服务', cert_type: 'T（电梯修理）', cert_level: '初级', cert_no: 'TS3301001004', cert_expires_on: '2026-12-31', status: 'available', location: { lat: 30.278, lng: 120.149 }, completed_rescues: 5 },
    { id: 'R5', name: '陈杰', phone: '13905710005', org: '恒达电梯服务', cert_type: 'T（电梯修理）', cert_level: '中级', cert_no: 'TS3301001005', cert_expires_on: '2025-12-31', status: 'available', location: { lat: 30.273, lng: 120.154 }, completed_rescues: 18 },
    { id: 'R6', name: '刘洋', phone: '13905710006', org: '恒达电梯服务', cert_type: 'T（电梯修理）', cert_level: '高级', cert_no: 'TS3301001006', cert_expires_on: '2028-03-31', status: 'busy', location: { lat: 30.266, lng: 120.163 }, completed_rescues: 52 },
    { id: 'R7', name: '孙鹏', phone: '13905710007', org: '快梯应急救援队', cert_type: 'T（电梯修理）', cert_level: '中级', cert_no: 'TS3301001007', cert_expires_on: '2027-06-30', status: 'available', location: { lat: 30.282, lng: 120.147 }, completed_rescues: 12 },
    { id: 'R8', name: '周敏', phone: '13905710008', org: '快梯应急救援队', cert_type: 'T（电梯修理）', cert_level: '高级', cert_no: 'TS3301001008', cert_expires_on: '2028-09-30', status: 'available', location: { lat: 30.29, lng: 120.17 }, completed_rescues: 40 },
  ];

  return {
    seq: { alarm: 0, dispatch: 0 },
    buildings, elevators, cameras, rescuers,
    alarms: [],
    dispatches: [],
  };
}
