/**
 * 领域常量：状态机、资质字典、事件标签、SLA 阈值。
 * 全部以 TSG T7001 / 《电梯维护保养规则》常见救援要求建模，仅用于本调度系统。
 */

/** 事件状态：严格单向推进，见 STATE_ORDER */
export const IncidentState = Object.freeze({
  ALARM_RECEIVED: 'alarm_received', // 已接警
  DISPATCHED: 'dispatched', // 已派单
  EN_ROUTE: 'en_route', // 救援员已出发
  ON_SITE: 'on_site', // 已到场
  RESCUED: 'rescued', // 被困人员已救出
  CLOSED: 'closed', // 事件归档
});

/**
 * 允许的状态推进。键为当前状态，值为可进入的下一状态集合。
 * 允许跳过中间态（如到场确认时救援员没点"出发"），但绝不允许回退。
 */
export const STATE_TRANSITIONS = Object.freeze({
  [IncidentState.ALARM_RECEIVED]: new Set([
    IncidentState.DISPATCHED,
    IncidentState.EN_ROUTE,
    IncidentState.ON_SITE,
  ]),
  [IncidentState.DISPATCHED]: new Set([
    IncidentState.EN_ROUTE,
    IncidentState.ON_SITE,
    IncidentState.CLOSED, // 现场开门即解除、无需救出节点时可直接归档
  ]),
  [IncidentState.EN_ROUTE]: new Set([IncidentState.ON_SITE, IncidentState.CLOSED]),
  [IncidentState.ON_SITE]: new Set([
    IncidentState.RESCUED,
    IncidentState.CLOSED,
  ]),
  [IncidentState.RESCUED]: new Set([IncidentState.CLOSED]),
  [IncidentState.CLOSED]: new Set(),
});

/** 终态：不允许再追加状态变更 */
export const TERMINAL_STATES = new Set([IncidentState.CLOSED]);

/** 仍在救援进行中的状态（SLA 监控只看这些） */
export const ACTIVE_STATES = new Set([
  IncidentState.ALARM_RECEIVED,
  IncidentState.DISPATCHED,
  IncidentState.EN_ROUTE,
  IncidentState.ON_SITE,
]);

/**
 * 时间线条目类型。type 同时决定是否携带状态推进：
 * - 带状态：alarm / dispatch / en_route / on_site / rescued / closed
 * - 仅记录：monitor / escalation / note / reassignment
 */
export const EventType = Object.freeze({
  ALARM: 'alarm',
  DISPATCH: 'dispatch',
  EN_ROUTE: 'en_route',
  ON_SITE: 'on_site',
  RESCUED: 'rescued',
  CLOSED: 'closed',
  MONITOR: 'monitor',
  ESCALATION: 'escalation',
  REASSIGNMENT: 'reassignment',
  NOTE: 'note',
});

/** 事件类型 → 进入的状态（仅记录型事件不推进状态） */
export const EVENT_TARGET_STATE = Object.freeze({
  [EventType.ALARM]: IncidentState.ALARM_RECEIVED,
  [EventType.DISPATCH]: IncidentState.DISPATCHED,
  [EventType.EN_ROUTE]: IncidentState.EN_ROUTE,
  [EventType.ON_SITE]: IncidentState.ON_SITE,
  [EventType.RESCUED]: IncidentState.RESCUED,
  [EventType.CLOSED]: IncidentState.CLOSED,
});

/** 时间线中文标签（报告/演示输出用） */
export const EVENT_LABELS = Object.freeze({
  [EventType.ALARM]: '接警',
  [EventType.DISPATCH]: '派单',
  [EventType.EN_ROUTE]: '救援员出发',
  [EventType.ON_SITE]: '到场',
  [EventType.RESCUED]: '救出被困人员',
  [EventType.CLOSED]: '事件归档',
  [EventType.MONITOR]: '监控联动',
  [EventType.ESCALATION]: '超时升级',
  [EventType.REASSIGNMENT]: '改派',
  [EventType.NOTE]: '备注',
});

/** 救援员资质字典 */
export const Certification = Object.freeze({
  ELEVATOR_OP: 'elevator_op', // 电梯作业（特种设备作业人员证）
  FIRST_AID: 'first_aid', // 急救（红十字会急救证）
  FIRE_RESCUE: 'fire_rescue', // 消防救援
  HIGH_RISE: 'high_rise', // 高层/超高层救援
  BRAND_TRAINING: 'brand_training', // 厂家专项培训（带品牌前缀存库）
});

export const CERT_LABELS = Object.freeze({
  [Certification.ELEVATOR_OP]: '电梯作业证',
  [Certification.FIRST_AID]: '急救证',
  [Certification.FIRE_RESCUE]: '消防救援',
  [Certification.HIGH_RISE]: '高层救援',
  [Certification.BRAND_TRAINING]: '厂家专项培训',
});

/** 救援员在岗状态 */
export const RescuerStatus = Object.freeze({
  ON_DUTY: 'on_duty', // 在岗待命
  ASSIGNED: 'assigned', // 已被派单
  EN_ROUTE: 'en_route', // 出勤途中
  ON_SCENE: 'on_scene', // 在现场
  OFF_DUTY: 'off_duty', // 下班
});

/** 报警级别 */
export const Priority = Object.freeze({
  NORMAL: 'normal',
  HIGH: 'high', // 有伤员 / 火情 / 特殊人群
});

export const PRIORITY_LABELS = Object.freeze({
  [Priority.NORMAL]: '普通',
  [Priority.HIGH]: '紧急',
});

/** 升级级别 */
export const EscalationLevel = Object.freeze({
  NONE: 'none',
  SUPERVISOR: 'supervisor', // 值班主管
  EMERGENCY_CENTER: 'emergency_center', // 119 / 120 应急联动
});

/**
 * SLA（服务时限），单位毫秒：
 * - ackDeadlineMs：接警后须完成派单/确认的时限
 * - arrivalDeadlineMs：接警后救援员须到场的时限（参考维保合同 30 分钟到场要求）
 * 升级策略：ack 超时 → 主管；arrival 超时 → 119/120 应急联动。
 */
export const SLA = Object.freeze({
  ackDeadlineMs: 60 * 1000,
  arrivalDeadlineMs: 30 * 60 * 1000,
});

/**
 * 派单评分权重（分越高越优先派出）：
 * - 距离：每公里扣分
 * - ETA：每分钟扣分（与距离冗余，因为交通速度不同）
 * - 资质匹配：超出必需资质每项加分（留有余力）
 * - 历史评分：0-100 直接折算
 */
export const DISPATCH_WEIGHTS = Object.freeze({
  perKm: 4,
  perEtaMinute: 1.5,
  bonusPerExtraCert: 2,
  ratingScale: 0.2, // 评分 100 → 20 分
});

/** 平均道路通行速度（km/h），用于由直线距离估算 ETA；实际可接入路况服务替换 */
export const AVG_SPEED_KMH = 30;
