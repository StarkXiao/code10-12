/**
 * 基线数据（可复现演示/测试）：上海城区 4 栋楼、7 台电梯、6 个摄像头、8 名救援员。
 * 证书 expiresAt 用固定日期，演示时取 2026-09-22 当天，均未过期。
 */
import { RescuerStatus } from '../src/constants.js';

const VALID_UNTIL_2027 = '2027-12-31T23:59:59+08:00';
const VALID_UNTIL_2028 = '2028-06-30T23:59:59+08:00';
const EXPIRED_2025 = '2025-12-31T23:59:59+08:00';

export const seedData = {
  buildings: {
    "BLD-001": {
      id: 'BLD-001',
      name: '静安中心大厦',
      address: '上海市静安区南京西路 1266 号',
      lat: 31.2305,
      lon: 121.4485,
      floorsAboveGround: 28,
      propertyContact: '王物业',
      propertyPhone: '021-6288-1001',
    },
    "BLD-002": {
      id: 'BLD-002',
      name: '陆家嘴金融广场',
      address: '上海市浦东新区世纪大道 100 号',
      lat: 31.2397,
      lon: 121.5052,
      floorsAboveGround: 52,
      propertyContact: '李主管',
      propertyPhone: '021-5888-2002',
    },
    "BLD-003": {
      id: 'BLD-003',
      name: '徐汇苑住宅小区',
      address: '上海市徐汇区漕溪北路 88 号',
      lat: 31.1885,
      lon: 121.4365,
      floorsAboveGround: 18,
      propertyContact: '张经理',
      propertyPhone: '021-6438-3003',
    },
    "BLD-004": {
      id: 'BLD-004',
      name: '虹桥天地写字楼',
      address: '上海市闵行区申长路 99 号',
      lat: 31.1942,
      lon: 121.3217,
      floorsAboveGround: 22,
      propertyContact: '陈工',
      propertyPhone: '021-5299-4004',
    },
  },

  elevators: {
    'ELV-101': {
      id: 'ELV-101', buildingId: 'BLD-001', brand: '三菱', model: 'NEXIEZ-LZ',
      type: 'passenger', requiresBrandTraining: true,
      lat: 31.2305, lon: 121.4485, monitoring: true,
    },
    'ELV-102': {
      id: 'ELV-102', buildingId: 'BLD-001', brand: '三菱', model: 'NEXIEZ-LZ',
      type: 'passenger', requiresBrandTraining: true,
      lat: 31.2306, lon: 121.4486, monitoring: true,
    },
    'ELV-201': {
      id: 'ELV-201', buildingId: 'BLD-002', brand: '迅达', model: '5500',
      type: 'fire', requiresBrandTraining: false,
      lat: 31.2397, lon: 121.5052, monitoring: true,
    },
    'ELV-202': {
      id: 'ELV-202', buildingId: 'BLD-002', brand: '通力', model: 'MonoSpace',
      type: 'passenger', requiresBrandTraining: false,
      lat: 31.2398, lon: 121.5053, monitoring: true,
    },
    'ELV-301': {
      id: 'ELV-301', buildingId: 'BLD-003', brand: '日立', model: 'HGP',
      type: 'passenger', requiresBrandTraining: false,
      lat: 31.1885, lon: 121.4365, monitoring: true,
    },
    'ELV-302': {
      id: 'ELV-302', buildingId: 'BLD-003', brand: '日立', model: 'HGP',
      type: 'freight', requiresBrandTraining: false,
      lat: 31.1884, lon: 121.4366, monitoring: false,
    },
    'ELV-401': {
      id: 'ELV-401', buildingId: 'BLD-004', brand: '奥的斯', model: 'Gen2',
      type: 'passenger', requiresBrandTraining: false,
      lat: 31.1942, lon: 121.3217, monitoring: true,
    },
  },

  cameras: {
    'CAM-101': {
      id: 'CAM-101', buildingId: 'BLD-001', elevatorId: 'ELV-101',
      name: '静安1号客梯轿厢', streamUrl: 'rtsp://cams.local/jxa/101', status: 'online',
    },
    'CAM-102': {
      id: 'CAM-102', buildingId: 'BLD-001', elevatorId: 'ELV-102',
      name: '静安2号客梯轿厢', streamUrl: 'rtsp://cams.local/jxa/102', status: 'online',
    },
    'CAM-201': {
      id: 'CAM-201', buildingId: 'BLD-002', elevatorId: 'ELV-201',
      name: '金融广场消防梯轿厢', streamUrl: 'rtsp://cams.local/ljz/201', status: 'online',
    },
    'CAM-202': {
      id: 'CAM-202', buildingId: 'BLD-002', elevatorId: 'ELV-202',
      name: '金融广场客梯轿厢', streamUrl: 'rtsp://cams.local/ljz/202', status: 'online',
    },
    'CAM-301': {
      id: 'CAM-301', buildingId: 'BLD-003', elevatorId: 'ELV-301',
      name: '徐汇苑客梯轿厢', streamUrl: 'rtsp://cams.local/xh/301', status: 'online',
    },
    // ELV-302 故意无摄像头，演示"无在线摄像头"分支
    'CAM-401': {
      id: 'CAM-401', buildingId: 'BLD-004', elevatorId: 'ELV-401',
      name: '虹桥天地客梯轿厢', streamUrl: 'rtsp://cams.local/hq/401', status: 'offline',
    },
  },

  rescuers: {
    // 静安站点：距静安中心约 0.6km，持三菱培训
    'RSC-01': {
      id: 'RSC-01', name: '陈雷', team: '静安维保站', phone: '138-0000-0001',
      lat: 31.2332, lon: 121.4438, status: RescuerStatus.ON_DUTY, rating: 92,
      certifications: [
        { code: 'elevator_op', expiresAt: VALID_UNTIL_2027 },
        { code: 'brand_training:三菱', expiresAt: VALID_UNTIL_2027 },
        { code: 'first_aid', expiresAt: VALID_UNTIL_2028 },
      ],
    },
    'RSC-02': {
      id: 'RSC-02', name: '赵敏', team: '静安维保站', phone: '138-0000-0002',
      lat: 31.2285, lon: 121.4510, status: RescuerStatus.ON_DUTY, rating: 85,
      certifications: [
        { code: 'elevator_op', expiresAt: VALID_UNTIL_2027 },
        { code: 'brand_training:三菱', expiresAt: VALID_UNTIL_2027 },
        { code: 'high_rise', expiresAt: VALID_UNTIL_2028 },
      ],
    },
    // 陆家嘴站点：距金融广场约 0.8km，超高层资质
    'RSC-03': {
      id: 'RSC-03', name: '孙强', team: '浦东应急班', phone: '138-0000-0003',
      lat: 31.2360, lon: 121.5130, status: RescuerStatus.ON_DUTY, rating: 90,
      certifications: [
        { code: 'elevator_op', expiresAt: VALID_UNTIL_2027 },
        { code: 'high_rise', expiresAt: VALID_UNTIL_2028 },
        { code: 'fire_rescue', expiresAt: VALID_UNTIL_2028 },
        { code: 'first_aid', expiresAt: VALID_UNTIL_2027 },
      ],
    },
    'RSC-04': {
      id: 'RSC-04', name: '周婷', team: '浦东应急班', phone: '138-0000-0004',
      lat: 31.2430, lon: 121.5000, status: RescuerStatus.ON_DUTY, rating: 88,
      certifications: [
        { code: 'elevator_op', expiresAt: VALID_UNTIL_2028 },
        { code: 'high_rise', expiresAt: VALID_UNTIL_2028 },
      ],
    },
    // 徐汇站点：距徐汇苑约 1.2km
    'RSC-05': {
      id: 'RSC-05', name: '吴刚', team: '徐汇维保站', phone: '138-0000-0005',
      lat: 31.1820, lon: 121.4440, status: RescuerStatus.ON_DUTY, rating: 81,
      certifications: [
        { code: 'elevator_op', expiresAt: VALID_UNTIL_2027 },
        { code: 'first_aid', expiresAt: VALID_UNTIL_2027 },
      ],
    },
    // 距离很近但电梯作业证已过期：应被资质过滤淘汰
    'RSC-06': {
      id: 'RSC-06', name: '郑涛', team: '静安维保站', phone: '138-0000-0006',
      lat: 31.2309, lon: 121.4478, status: RescuerStatus.ON_DUTY, rating: 70,
      certifications: [
        { code: 'elevator_op', expiresAt: EXPIRED_2025 },
      ],
    },
    // 距虹桥天地约 2km，但今天下班
    'RSC-07': {
      id: 'RSC-07', name: '冯磊', team: '虹桥维保站', phone: '138-0000-0007',
      lat: 31.2020, lon: 121.3380, status: RescuerStatus.OFF_DUTY, rating: 79,
      certifications: [
        { code: 'elevator_op', expiresAt: VALID_UNTIL_2028 },
      ],
    },
    // 机动骨干，离所有点都较远，紧急兜底
    'RSC-08': {
      id: 'RSC-08', name: '韩冰', team: '市级机动队', phone: '138-0000-0008',
      lat: 31.2100, lon: 121.4700, status: RescuerStatus.ON_DUTY, rating: 95,
      certifications: [
        { code: 'elevator_op', expiresAt: VALID_UNTIL_2028 },
        { code: 'high_rise', expiresAt: VALID_UNTIL_2028 },
        { code: 'fire_rescue', expiresAt: VALID_UNTIL_2028 },
        { code: 'first_aid', expiresAt: VALID_UNTIL_2028 },
        { code: 'brand_training:三菱', expiresAt: VALID_UNTIL_2027 },
        { code: 'brand_training:日立', expiresAt: VALID_UNTIL_2027 },
      ],
    },
  },

  incidents: {},
};

export function cloneSeed() {
  return JSON.parse(JSON.stringify(seedData));
}
