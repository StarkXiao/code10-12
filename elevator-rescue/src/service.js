/**
 * 调度服务：用例编排层。
 * 接警 → 联动监控 → 就近/资质匹配 → 派单 → 时序推进 → SLA 扫描升级。
 * 所有写方法结束后统一 persist；状态机规则全部在 incident.js / dispatcher.js 内。
 */
import {
  IncidentState,
  ACTIVE_STATES,
  Priority,
  RescuerStatus,
  EscalationLevel,
  SLA,
} from './constants.js';
import { requiredCertsFor } from './certifications.js';
import { rankRescuers } from './dispatcher.js';
import { httpError } from './validate.js';
import { resolveAt } from './clock.js';
import {
  createIncident,
  applyStateEvent,
  recordMonitorEvent,
  recordReassignment,
  recordEscalation,
  appendNote,
  evaluateSla,
  legDurations,
} from './incident.js';

export class DispatchService {
  /**
   * @param store Store 实例
   * @param clock Clock 时间源
   * @param options.autoDispatch 接警后是否自动派单（默认 true）
   * @param options.maxConcurrent 每名救援员同时处理上限
   */
  constructor(store, clock, options = {}) {
    this.store = store;
    this.clock = clock;
    this.autoDispatch = options.autoDispatch ?? true;
    this.maxConcurrent = options.maxConcurrent ?? 1;
  }

  // ---------- 资源登记 ----------

  registerBuilding(body) {
    const b = this.store.put('buildings', {
      id: body.id,
      name: body.name,
      address: body.address ?? '',
      lat: body.lat,
      lon: body.lon,
      floorsAboveGround: body.floorsAboveGround ?? null,
      propertyContact: body.propertyContact ?? null,
      propertyPhone: body.propertyPhone ?? null,
    });
    return b;
  }

  registerElevator(body) {
    const building = this.store.get('buildings', body.buildingId);
    if (!building) throw httpError(404, `楼宇不存在：${body.buildingId}`);
    const el = this.store.put('elevators', {
      id: body.id,
      buildingId: body.buildingId,
      brand: body.brand ?? null,
      model: body.model ?? null,
      type: body.type ?? 'passenger', // passenger / freight / fire
      requiresBrandTraining: !!body.requiresBrandTraining,
      lat: body.lat ?? building.lat,
      lon: body.lon ?? building.lon,
      monitoring: body.monitoring ?? true,
    });
    return el;
  }

  registerCamera(body) {
    if (body.elevatorId && !this.store.get('elevators', body.elevatorId)) {
      throw httpError(404, `电梯不存在：${body.elevatorId}`);
    }
    const cam = this.store.put('cameras', {
      id: body.id,
      buildingId: body.buildingId,
      elevatorId: body.elevatorId ?? null,
      name: body.name,
      streamUrl: body.streamUrl ?? null,
      status: body.status ?? 'online',
    });
    return cam;
  }

  registerRescuer(body) {
    const r = this.store.put('rescuers', {
      id: body.id,
      name: body.name,
      team: body.team ?? '',
      phone: body.phone ?? '',
      lat: body.lat,
      lon: body.lon,
      status: body.status ?? RescuerStatus.ON_DUTY,
      rating: body.rating ?? 80,
      certifications: body.certifications ?? [],
    });
    return r;
  }

  /** 救援员实时定位/状态上报 */
  updateRescuer(id, body) {
    const r = this.store.get('rescuers', id);
    if (!r) throw httpError(404, `救援员不存在：${id}`);
    if (body.lat !== undefined) r.lat = Number(body.lat);
    if (body.lon !== undefined) r.lon = Number(body.lon);
    if (body.status) {
      if (!Object.values(RescuerStatus).includes(body.status)) {
        throw httpError(400, `非法救援员状态：${body.status}`);
      }
      r.status = body.status;
    }
    if (body.rating !== undefined) r.rating = Number(body.rating);
    return r;
  }

  // ---------- 接警 ----------

  /**
   * 接收轿厢报警。
   * 流程：校验电梯 → 确定级别 → 建档（alarm 时间线）→ 自动拉起监控 → 自动派单。
   */
  async receiveAlarm(body) {
    const at = resolveAt(body, this.clock);
    const elevator = this.store.get('elevators', body.elevatorId);
    if (!elevator) throw httpError(404, `电梯不存在：${body.elevatorId}`);
    const building = this.store.get('buildings', elevator.buildingId);
    if (!building) throw httpError(409, `电梯 ${elevator.id} 所属楼宇缺失`);

    const hasFire = !!body.hasFire;
    const hasInjury = !!body.hasInjury;
    const hasVulnerable = !!body.hasVulnerable;
    const priority =
      body.priority ??
      (hasFire || hasInjury || hasVulnerable ? Priority.HIGH : Priority.NORMAL);

    const incident = createIncident({
      id: this.store.newId('incidents'),
      buildingId: building.id,
      elevatorId: elevator.id,
      floor: body.floor ?? null,
      occupants: body.occupants ?? null,
      hasVulnerable,
      hasInjury,
      hasFire,
      priority,
      alarmSource: body.alarmSource ?? 'car_button',
      alarmSummary: body.summary ?? '',
      at,
    });
    this.store.put('incidents', incident);

    // 联动楼宇监控：只取该电梯轿厢内的在线摄像头（楼层/大堂摄像头看不到被困者，不做替代）
    const camera =
      this.store
        .list('cameras')
        .filter((c) => c.elevatorId === elevator.id && c.status === 'online')
        .sort((a, b) => a.id.localeCompare(b.id))[0] ?? null;
    if (camera) {
      const streamId = `STRM-${incident.id}`;
      recordMonitorEvent(incident, at, {
        summary: `已联动摄像头 ${camera.name}，实时画面推送值班台`,
        streamId,
        monitorStatus: 'linked',
        data: {
          cameraId: camera.id,
          cameraName: camera.name,
          streamUrl: camera.streamUrl,
          action: 'auto_link_on_alarm',
        },
      });
    } else {
      recordMonitorEvent(incident, at, {
        summary: '该电梯无在线摄像头，已通知物业现场查看',
        monitorStatus: 'unavailable',
        data: { action: 'notify_property' },
      });
    }

    let dispatch = null;
    if (this.autoDispatch) {
      dispatch = this.runDispatch(incident, at);
    }

    await this.store.persist();
    return { incident, dispatch };
  }

  /** 监控中心/视频分析上报（如 AI 识别到火情），只追加监控时间线 */
  async addMonitorEvent(incidentId, body) {
    const incident = this.getIncidentOrThrow(incidentId);
    const at = resolveAt(body, this.clock);
    recordMonitorEvent(incident, at, {
      summary: body.summary ?? '监控中心上报',
      streamId: body.streamId,
      monitorStatus: body.monitorStatus,
      data: body.data ?? { source: body.source ?? 'operator' },
    });
    await this.store.persist();
    return incident;
  }

  // ---------- 派单 ----------

  /** 计算候选名单（不写库），供调度台预览 */
  suggestRescuers(incidentId, body = {}) {
    const incident = this.getIncidentOrThrow(incidentId);
    const at = body.at ? new Date(body.at) : this.clock.now();
    const elevator = this.store.get('elevators', incident.elevatorId);
    const building = this.store.get('buildings', incident.buildingId);
    const requiredCerts = requiredCertsFor(elevator, building);
    return {
      requiredCerts: [...requiredCerts],
      candidates: rankRescuers({
        rescuers: this.store.list('rescuers'),
        target: { lat: elevator.lat, lon: elevator.lon },
        requiredCerts,
        activeIncidentsByRescuer: this.activeCountByRescuer(),
        maxConcurrent: this.maxConcurrent,
        at,
      }),
    };
  }

  /** 对事件执行匹配 + 派单 */
  async dispatch(incidentId, body = {}) {
    const incident = this.getIncidentOrThrow(incidentId);
    const at = resolveAt(body, this.clock);
    const result = this.runDispatch(incident, at, body.rescuerId);
    await this.store.persist();
    return result;
  }

  /**
   * 内部派单：无指定救援员时自动取评分第一；
   * 无合格人选 → 直接升级主管（时间线留 escalation）。
   */
  runDispatch(incident, at, forcedRescuerId = null) {
    const elevator = this.store.get('elevators', incident.elevatorId);
    const building = this.store.get('buildings', incident.buildingId);
    const requiredCerts = requiredCertsFor(elevator, building);
    const ranking = rankRescuers({
      rescuers: this.store.list('rescuers'),
      target: { lat: elevator.lat, lon: elevator.lon },
      requiredCerts,
      activeIncidentsByRescuer: this.activeCountByRescuer(),
      maxConcurrent: this.maxConcurrent,
      at,
    });

    let chosen = forcedRescuerId
      ? ranking.find((c) => c.rescuerId === forcedRescuerId)
      : ranking.find((c) => c.eligible);

    if (forcedRescuerId && chosen && !chosen.eligible) {
      throw httpError(409, `指定救援员不可派出：${chosen.reason ?? '不合格'}`, {
        candidate: chosen,
      });
    }

    if (!chosen || !chosen.eligible) {
      recordEscalation(incident, at, EscalationLevel.SUPERVISOR, {
        summary: '无合格的就近救援员，升级值班主管人工调度',
        reason: 'no_eligible_rescuer',
        data: {
          requiredCerts: [...requiredCerts],
          rejected: ranking
            .filter((c) => !c.eligible)
            .map((c) => ({ rescuerId: c.rescuerId, reason: c.reason })),
        },
      });
      return { dispatched: false, reason: 'no_eligible_rescuer', requiredCerts: [...requiredCerts], ranking };
    }

    const rescuer = this.store.get('rescuers', chosen.rescuerId);
    applyStateEvent(incident, 'dispatch', at, {
      rescuerId: rescuer.id,
      actor: 'dispatcher',
      summary: `派单至 ${rescuer.name}（${rescuer.team}），直线 ${chosen.distanceKm}km，预计 ${chosen.etaMinutes} 分钟到场`,
      data: {
        distanceKm: chosen.distanceKm,
        etaMinutes: chosen.etaMinutes,
        score: chosen.score,
        requiredCerts: [...requiredCerts],
      },
    });
    rescuer.status = RescuerStatus.ASSIGNED;
    return { dispatched: true, candidate: chosen, requiredCerts: [...requiredCerts], ranking };
  }

  /** 改派 */
  async reassign(incidentId, body) {
    const incident = this.getIncidentOrThrow(incidentId);
    const at = resolveAt(body, this.clock);
    const target = this.store.get('rescuers', body.rescuerId);
    if (!target) throw httpError(404, `救援员不存在：${body.rescuerId}`);

    // 新救援员仍需满足资质门槛
    const elevator = this.store.get('elevators', incident.elevatorId);
    const building = this.store.get('buildings', incident.buildingId);
    const suggestion = this.suggestRescuers(incidentId, { at: at.toISOString() });
    const candidate = suggestion.candidates.find((c) => c.rescuerId === target.id);
    if (!candidate?.eligible) {
      throw httpError(409, `改派对象不合格：${candidate?.reason ?? '无候选'}`, { candidate });
    }

    const previousId = incident.rescuerId;
    recordReassignment(incident, at, {
      rescuerId: target.id,
      reason: body.reason ?? 'manual',
    });
    if (previousId && this.canRelease(previousId)) {
      this.store.get('rescuers', previousId).status = RescuerStatus.ON_DUTY;
    }
    target.status = RescuerStatus.ASSIGNED;
    await this.store.persist();
    return { incident, candidate };
  }

  // ---------- 到场时序推进 ----------

  async markEnRoute(incidentId, body = {}) {
    const incident = this.getIncidentOrThrow(incidentId);
    const at = resolveAt(body, this.clock);
    applyStateEvent(incident, 'en_route', at, {
      rescuerId: incident.rescuerId,
      actor: body.actor ?? 'rescuer_app',
      summary: body.summary ?? '救援员已出发',
    });
    const r = this.store.get('rescuers', incident.rescuerId);
    if (r) r.status = RescuerStatus.EN_ROUTE;
    await this.store.persist();
    return incident;
  }

  async markOnSite(incidentId, body = {}) {
    const incident = this.getIncidentOrThrow(incidentId);
    const at = resolveAt(body, this.clock);
    applyStateEvent(incident, 'on_site', at, {
      rescuerId: incident.rescuerId,
      actor: body.actor ?? 'rescuer_app',
      summary: body.summary ?? '救援员已到场',
      data: {
        alarmToDispatchMs: legDurations(incident).dispatchMs, // 参数先于 apply 求值，此刻到场点尚未写入
        ...(body.data ?? {}),
      },
    });
    const r = this.store.get('rescuers', incident.rescuerId);
    if (r) r.status = RescuerStatus.ON_SCENE;
    await this.store.persist();
    return incident;
  }

  async markRescued(incidentId, body = {}) {
    const incident = this.getIncidentOrThrow(incidentId);
    const at = resolveAt(body, this.clock);
    applyStateEvent(incident, 'rescued', at, {
      actor: body.actor ?? 'rescuer_app',
      summary: body.summary ?? '被困人员已安全救出',
      occupantsReleased: body.occupantsReleased,
      data: { injuryNoted: body.injuryNoted ?? incident.hasInjury },
    });
    await this.store.persist();
    return incident;
  }

  async closeIncident(incidentId, body = {}) {
    const incident = this.getIncidentOrThrow(incidentId);
    const at = resolveAt(body, this.clock);
    applyStateEvent(incident, 'closed', at, {
      actor: body.actor ?? 'supervisor',
      summary: body.summary ?? '事件归档',
      data: { reportNote: body.note ?? '' },
    });
    const r = this.store.get('rescuers', incident.rescuerId);
    if (r) r.status = RescuerStatus.ON_DUTY;
    await this.store.persist();
    return incident;
  }

  async addNote(incidentId, body) {
    const incident = this.getIncidentOrThrow(incidentId);
    const at = resolveAt(body, this.clock);
    appendNote(incident, at, {
      actor: body.actor ?? 'operator',
      summary: body.summary ?? '',
      data: body.data ?? {},
    });
    await this.store.persist();
    return incident;
  }

  // ---------- SLA 扫描 ----------

  /**
   * 定时任务（默认每分钟）扫描全部进行中事件：
   * 超过派单时限未派 → 主管；超过到场时限未到场 → 119/120。
   * 幂等：同级/低级升级不重复记录。
   */
  async slaSweep(body = {}) {
    const at = body.at ? new Date(body.at) : this.clock.now();
    const actions = [];
    for (const incident of this.store.list('incidents')) {
      if (!ACTIVE_STATES.has(incident.state)) continue;
      const sla = evaluateSla(incident, at);
      if (sla.dueLevel === EscalationLevel.NONE) continue;
      const raised = recordEscalation(incident, at, sla.dueLevel, {
        summary:
          sla.arrivalBreached
            ? `接警已超过 ${SLA.arrivalDeadlineMs / 60000} 分钟仍未到场，联动 119/120`
            : `接警已超过 ${SLA.ackDeadlineMs / 1000} 秒仍未派单，升级值班主管`,
        reason: sla.arrivalBreached ? 'arrival_sla' : 'ack_sla',
        data: {
          ackRemainingMs: sla.ackRemainingMs,
          arrivalRemainingMs: sla.arrivalRemainingMs,
        },
      });
      if (raised) actions.push({ incidentId: incident.id, level: sla.dueLevel });
    }
    if (actions.length) await this.store.persist();
    return { scannedAt: at.toISOString(), escalated: actions };
  }

  // ---------- 查询 / 统计 ----------

  listIncidents(query = {}) {
    let rows = this.store.list('incidents');
    if (query.state) rows = rows.filter((i) => i.state === query.state);
    if (query.active === 'true' || query.active === true) {
      rows = rows.filter((i) => ACTIVE_STATES.has(i.state));
    }
    if (query.rescuerId) rows = rows.filter((i) => i.rescuerId === query.rescuerId);
    return rows.sort((a, b) => b.alarmAt.localeCompare(a.alarmAt));
  }

  getIncidentOrThrow(id) {
    const incident = this.store.get('incidents', id);
    if (!incident) throw httpError(404, `事件不存在：${id}`);
    return incident;
  }

  incidentReport(id) {
    const incident = this.getIncidentOrThrow(id);
    return {
      incident,
      legs: legDurations(incident),
      sla: evaluateSla(incident, this.clock.now()),
    };
  }

  /** 调度统计口径 */
  stats() {
    const rows = this.store.list('incidents');
    const total = rows.length;
    const closed = rows.filter((i) => i.state === IncidentState.CLOSED);
    const active = rows.filter((i) => ACTIVE_STATES.has(i.state));
    const onSite = rows.filter((i) => i.state === IncidentState.ON_SITE);
    const escalated = rows.filter((i) => i.escalationLevel !== EscalationLevel.NONE);
    const ackBreached = rows.filter((i) => {
      const legs = legDurations(i);
      return (
        legs.dispatchMs !== null
          ? legs.dispatchMs > SLA.ackDeadlineMs
          : ACTIVE_STATES.has(i.state) &&
            this.clock.nowMs() - new Date(i.alarmAt).getTime() > SLA.ackDeadlineMs
      );
    });
    const arrivalBreachedClosed = closed.filter((i) => {
      const legs = legDurations(i);
      return legs.onSiteMs !== null && legs.onSiteMs > SLA.arrivalDeadlineMs;
    });

    const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);
    const dispatchLegs = closed.map((i) => legDurations(i).dispatchMs).filter((v) => v !== null);
    const arrivalLegs = closed.map((i) => legDurations(i).onSiteMs).filter((v) => v !== null);
    const rescueLegs = closed
      .map((i) => {
        const l = legDurations(i);
        return l.onSiteMs !== null && l.rescuedMs !== null ? l.rescuedMs - l.onSiteMs : null;
      })
      .filter((v) => v !== null);

    return {
      total,
      active: active.length,
      onSite: onSite.length,
      closed: closed.length,
      escalated: escalated.length,
      ackBreached: ackBreached.length,
      arrivalBreachedClosed: arrivalBreachedClosed.length,
      avgDispatchMs: avg(dispatchLegs),
      avgArrivalMs: avg(arrivalLegs),
      avgRescueAfterArrivalMs: avg(rescueLegs),
      slaArrivalMinutes: SLA.arrivalDeadlineMs / 60000,
      slaAckSeconds: SLA.ackDeadlineMs / 1000,
    };
  }

  /** 每名救援员在手的进行中事件数（派单容量约束） */
  activeCountByRescuer() {
    const map = new Map();
    for (const i of this.store.list('incidents')) {
      if (i.rescuerId && ACTIVE_STATES.has(i.state)) {
        map.set(i.rescuerId, (map.get(i.rescuerId) ?? 0) + 1);
      }
    }
    return map;
  }

  /** 旧救援员名下是否还有别的进行中事件（决定改派后能否恢复待命） */
  canRelease(rescuerId) {
    return !this.store
      .list('incidents')
      .some((i) => i.rescuerId === rescuerId && ACTIVE_STATES.has(i.state));
  }
}
