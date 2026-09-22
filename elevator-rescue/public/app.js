// 调度台前端：原生 JS + SSE 实时刷新
const $ = (s) => document.querySelector(s);

const state = {
  meta: null,
  elevators: [],
  rescuers: [],
  alarms: [],
  stats: null,
  selectedId: null,
  detail: null,
  candidates: null,
};

// ---------- 工具 ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (iso) => (iso ? new Date(iso).toLocaleTimeString('zh-CN', { hour12: false }) : '—');
const fmtMin = (n) => (n == null ? '—' : `${n} 分钟`);

const STATUS_LABEL = { pending: '待派单', dispatched: '已派单', in_progress: '救援中', arrived: '已到场', rescued: '已救出', closed: '已闭环', cancelled: '已取消' };
const DISPATCH_LABEL = { dispatched: '待接单', accepted: '已接单', en_route: '赶赴现场', arrived: '已到场', released: '已救出', completed: '已完成', cancelled: '已取消' };
const RESCUER_STATUS = { available: '在岗', busy: '任务中', off_duty: '休息' };
const KIND_ICON = { alarm: '🚨', monitor: '📷', dispatch: '📤', accept: '✅', depart: '🚗', arrive: '📍', release: '🧑‍🤝‍🧑', complete: '🏁', reassign: '🔁', escalate: '⚠️', cancel: '✖️' };

let toastTimer = null;
function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3200);
}

// ---------- 加载 ----------
async function loadBase() {
  const [meta, elevators, rescuers, alarms, stats] = await Promise.all([
    api('/api/meta'), api('/api/elevators'), api('/api/rescuers'), api('/api/alarms'), api('/api/stats'),
  ]);
  Object.assign(state, { meta, elevators, rescuers, alarms, stats });
  renderStats();
  renderAlarmList();
  renderRescuers();
}

async function loadDetail(id) {
  const [detail, candidates] = await Promise.all([
    api(`/api/alarms/${id}`),
    api(`/api/alarms/${id}/candidates`),
  ]);
  state.detail = detail;
  state.candidates = candidates;
  renderDetail();
  renderCandidates();
}

async function refresh() {
  try {
    await loadBase();
    if (state.selectedId && state.alarms.some((a) => a.id === state.selectedId)) {
      await loadDetail(state.selectedId);
    }
  } catch (e) {
    console.error(e);
  }
}

// ---------- 顶栏统计 ----------
function renderStats() {
  const s = state.stats;
  if (!s) return;
  $('#stats').innerHTML = `
    <span class="chip alarm">进行中<b>${s.active}</b></span>
    <span class="chip">今日报警<b>${s.today_total}</b></span>
    <span class="chip">平均到场<b>${fmtMin(s.avg_arrive_min)}</b></span>
    <span class="chip ok">SLA 达标率<b>${s.sla_rate == null ? '—' : s.sla_rate + '%'}</b></span>
    <span class="chip">可用救援<b>${s.rescuers_available}/${s.rescuers_total}</b></span>`;
}

// ---------- 报警列表 ----------
function renderAlarmList() {
  $('#alarmCount').textContent = `（${state.alarms.length}）`;
  const box = $('#alarmList');
  if (!state.alarms.length) {
    box.innerHTML = '<div class="empty">暂无报警</div>';
    return;
  }
  box.innerHTML = state.alarms.map((a) => `
    <div class="alarm-item ${a.id === state.selectedId ? 'selected' : ''}" data-id="${a.id}">
      <div class="top">
        <span class="id">${esc(a.id)}</span>
        <span class="badge ${a.status}">${STATUS_LABEL[a.status] || a.status}</span>
      </div>
      <div class="loc">${esc(a.building?.name)} · ${esc(a.elevator?.name)} · 困 ${a.trapped_count} 人</div>
      <div class="meta">
        <span>🕐 ${fmt(a.created_at)}</span>
        ${a.priority === 'urgent' ? '<span class="badge urgent">紧急</span>' : ''}
        ${a.active_dispatch ? `<span>👷 ${esc(a.active_dispatch.rescuer_id)}</span>` : ''}
      </div>
    </div>`).join('');
  box.querySelectorAll('.alarm-item').forEach((el) => {
    el.onclick = () => selectAlarm(el.dataset.id);
  });
}

async function selectAlarm(id) {
  state.selectedId = id;
  renderAlarmList();
  try {
    await loadDetail(id);
  } catch (e) {
    toast(e.message, 'err');
  }
}

// ---------- 详情 ----------
function renderDetail() {
  const card = $('#detailCard');
  const d = state.detail;
  if (!d) return;
  const { alarm, elevator, building, dispatches, active_dispatch, durations, arrival_sequence } = d;
  const sla = dispatches.find((x) => x.sla_arrive_ok !== null);

  card.innerHTML = `
    <div class="detail-head">
      <span class="id">${esc(alarm.id)}</span>
      <span class="badge ${alarm.status}">${STATUS_LABEL[alarm.status]}</span>
      ${alarm.priority === 'urgent' ? '<span class="badge urgent">紧急</span>' : ''}
      ${sla ? `<span class="badge ${sla.sla_arrive_ok ? 'arrived' : 'urgent'}">到场 SLA ${sla.sla_arrive_ok ? '达标' : '超时'}</span>` : ''}
    </div>
    <div class="detail-sub">
      ${esc(building?.name)}（${esc(building?.address)}）· ${esc(elevator?.name)}（注册代码 ${esc(elevator?.code)}）·
      困 ${alarm.trapped_count} 人 · 报告 ${alarm.floor_reported}F · 来源 ${esc(state.meta.sources[alarm.source] || alarm.source)}
    </div>
    <div class="durations">
      <div class="duration-box"><div class="v">${fmtMin(durations.accept_min)}</div><div class="k">报警→接单</div></div>
      <div class="duration-box ${sla && !sla.sla_arrive_ok ? 'sla-bad' : 'sla-ok'}"><div class="v">${fmtMin(durations.arrive_min)}</div><div class="k">报警→到场（SLA ${state.meta.sla_min}′）</div></div>
      <div class="duration-box"><div class="v">${fmtMin(durations.release_min)}</div><div class="k">到场→救出</div></div>
      <div class="duration-box"><div class="v">${fmtMin(durations.total_min)}</div><div class="k">全程</div></div>
    </div>

    ${active_dispatch ? renderActiveDispatch(active_dispatch) : ''}
    ${!['closed', 'cancelled'].includes(alarm.status) ? '<button class="btn sm" id="btnCancel">取消报警（误报）</button>' : ''}

    <h3 class="sec">到场时序</h3>
    <div class="durations">${arrival_sequence.map((s) => `
      <div class="duration-box"><div class="v" style="font-size:13px">${fmt(s.at)}</div><div class="k">${esc(s.label)}</div></div>`).join('')}
    </div>

    <h3 class="sec">事件时间线</h3>
    <ul class="timeline">${alarm.timeline.map((ev) => `
      <li class="${ev.kind === 'escalate' ? 'urgent' : ''}">
        <span class="dot">${KIND_ICON[ev.kind] || '•'}</span>
        <div class="t">${fmt(ev.at)} · ${esc(ev.actor)}</div>
        <div class="d">${esc(ev.detail)}</div>
      </li>`).join('')}
    </ul>

    <h3 class="sec">楼宇监控联动</h3>
    ${renderMonitoring(alarm.monitoring)}

    <h3 class="sec">调度记录（${dispatches.length}）</h3>
    ${dispatches.map(renderDispatchRecord).join('') || '<div class="empty">无</div>'}
  `;

  // 绑定动作按钮
  card.querySelectorAll('[data-act]').forEach((btn) => {
    btn.onclick = () => dispatchAction(active_dispatch.id, btn.dataset.act);
  });
  const btnReassign = $('#btnReassign');
  if (btnReassign) btnReassign.onclick = () => reassign(active_dispatch.id);
  const btnCancel = $('#btnCancel');
  if (btnCancel) btnCancel.onclick = () => cancelAlarm(alarm.id);
}

function renderActiveDispatch(d) {
  const next = { dispatched: ['accept', '接单'], accepted: ['depart', '出发'], en_route: ['arrive', '到场'], arrived: ['release', '救出'], released: ['complete', '闭环'] }[d.status];
  return `
    <div class="dispatch-box">
      <div class="row1">
        <span class="who">👷 ${esc(d.rescuer?.name)}（${esc(d.rescuer?.org)}）</span>
        <span class="badge ${d.status === 'dispatched' ? 'pending' : 'dispatched'}">${DISPATCH_LABEL[d.status]}</span>
      </div>
      <div class="kv">调度单 ${esc(d.id)} · 距离 ${d.distance_km}km · 预计 ${d.eta_minutes} 分钟 · 综合分 ${d.score} · 📞 ${esc(d.rescuer?.phone)}</div>
      <div class="actions">
        ${next ? `<button class="btn primary sm" data-act="${next[0]}">${next[1]}</button>` : ''}
        ${['dispatched', 'accepted', 'en_route'].includes(d.status) ? '<button class="btn sm" id="btnReassign">改派</button>' : ''}
      </div>
    </div>`;
}

function renderDispatchRecord(d) {
  const times = [
    ['派单', d.dispatched_at], ['接单', d.accept_at], ['出发', d.depart_at],
    ['到场', d.arrive_at], ['救出', d.release_at], ['闭环', d.complete_at],
  ].filter(([, v]) => v).map(([k, v]) => `${k} ${fmt(v)}`).join(' · ');
  return `
    <div class="dispatch-box">
      <div class="row1">
        <span class="who">${esc(d.id)} · ${esc(d.rescuer?.name || d.rescuer_id)}</span>
        <span class="badge ${d.status === 'cancelled' ? 'cancelled' : d.status === 'completed' ? 'rescued' : 'pending'}">${DISPATCH_LABEL[d.status]}</span>
      </div>
      <div class="kv">${times}${d.cancel_reason ? ` · 取消原因：${esc(d.cancel_reason)}` : ''}</div>
      ${d.candidates_snapshot?.length ? `<div class="kv">候选快照：${d.candidates_snapshot.map((c) => `${esc(c.name)} ${c.score}`).join(' / ')}</div>` : ''}
    </div>`;
}

function renderMonitoring(m) {
  if (!m) return '<div class="empty">未联动</div>';
  const cams = m.cameras.map((c) => `
    <div class="cam">
      <img src="${c.snapshot_url}?t=${Date.now()}" alt="${esc(c.name)}" loading="lazy">
      <div class="n">${esc(c.name)}${c.online ? '' : '（离线）'}</div>
    </div>`).join('');
  const s = m.sensors;
  return `
    <div class="cams">${cams}</div>
    <table class="sensors">
      <tr><td>轿厢位置</td><td>${s.car_position_floor}F</td></tr>
      <tr><td>门状态</td><td>${esc(s.door_state)}</td></tr>
      <tr><td>故障码</td><td>${esc(s.fault_code)}</td></tr>
      <tr><td>曳引机电源</td><td>${esc(s.traction_power)}</td></tr>
      <tr><td>五方对讲</td><td>${esc(s.intercom)}</td></tr>
      <tr><td>联动时间</td><td>${fmt(m.linked_at)}</td></tr>
    </table>`;
}

// ---------- 调度动作 ----------
async function dispatchAction(id, act) {
  try {
    await api(`/api/dispatches/${id}/${act}`, { method: 'POST', body: {} });
    toast('操作成功', 'ok');
    await refresh();
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function reassign(id) {
  const reason = prompt('改派原因：', '人工改派');
  if (reason === null) return;
  try {
    await api(`/api/dispatches/${id}/reassign`, { method: 'POST', body: { reason } });
    toast('已改派', 'ok');
    await refresh();
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function cancelAlarm(id) {
  const reason = prompt('取消原因：', '物业现场确认为误报');
  if (reason === null) return;
  try {
    await api(`/api/alarms/${id}/cancel`, { method: 'POST', body: { reason } });
    toast('报警已取消', 'ok');
    await refresh();
  } catch (e) {
    toast(e.message, 'err');
  }
}

// ---------- 救援人员 ----------
function renderRescuers() {
  const box = $('#rescuerList');
  box.innerHTML = state.rescuers.map((r) => {
    const expired = new Date(r.cert_expires_on) < new Date();
    return `
    <div class="rescuer">
      <div class="info">
        <div class="name">${esc(r.name)} <span class="muted">${esc(r.cert_level)} · ${esc(r.org)}</span></div>
        <div class="sub">证 ${esc(r.cert_no)} · 有效期 ${esc(r.cert_expires_on)}${expired ? ' <span class="expired">已过期</span>' : ''} · 救援 ${r.completed_rescues} 次</div>
      </div>
      <span class="badge ${r.status === 'available' ? 'available' : r.status === 'busy' ? 'busy' : 'off_duty'}">${RESCUER_STATUS[r.status]}</span>
      ${r.status !== 'busy' ? `<button class="btn sm" data-rid="${r.id}" data-st="${r.status === 'available' ? 'off_duty' : 'available'}">${r.status === 'available' ? '离岗' : '上岗'}</button>` : ''}
    </div>`;
  }).join('');
  box.querySelectorAll('[data-rid]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        await api(`/api/rescuers/${btn.dataset.rid}`, { method: 'PATCH', body: { status: btn.dataset.st } });
        await refresh();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

// ---------- 候选评分 ----------
function renderCandidates() {
  const box = $('#candidateList');
  const c = state.candidates;
  if (!c) return;
  const max = c.eligible[0]?.score || 1;
  box.innerHTML = `
    ${c.eligible.map((x) => `
      <div class="cand">
        <div class="row1">
          <span>${esc(x.rescuer.name)} <span class="tag">${esc(x.rescuer.cert_level)}</span>${x.already_tried ? ' <span class="tag">已试过</span>' : ''}</span>
          <span class="score">${x.score.toFixed(3)}</span>
        </div>
        <div class="bar"><i style="width:${Math.round((x.score / max) * 100)}%"></i></div>
        <div class="sub">${x.distance_km.toFixed(2)}km · 预计 ${x.eta_minutes.toFixed(1)} 分钟 · 距离分 ${x.breakdown.distance.toFixed(2)} / 资质分 ${x.breakdown.cert.toFixed(2)} / 经验分 ${x.breakdown.experience.toFixed(2)}</div>
      </div>`).join('') || '<div class="empty">无合格候选人</div>'}
    ${c.rejected.length ? `<h3 class="sec">被过滤（${c.rejected.length}）</h3>` + c.rejected.map((x) => `
      <div class="cand rejected">
        <div class="row1"><span>${esc(x.rescuer.name)}</span><span class="tag">${x.reasons.map(esc).join('；')}</span></div>
      </div>`).join('') : ''}`;
}

// ---------- 模拟报警表单 ----------
function initForm() {
  $('#fElevator').innerHTML = state.elevators.map((e) =>
    `<option value="${e.id}">${esc(e.building?.name)} · ${esc(e.name)}（${e.current_floor}F）</option>`).join('');
  $('#fSource').innerHTML = Object.entries(state.meta.sources).map(([k, v]) =>
    `<option value="${k}">${esc(v)}</option>`).join('');

  $('#alarmForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const body = {
      elevator_id: $('#fElevator').value,
      trapped_count: Number($('#fTrapped').value),
      source: $('#fSource').value,
      simulate: $('#fSimulate').checked,
    };
    const floor = $('#fFloor').value;
    if (floor) body.floor = Number(floor);
    try {
      const detail = await api('/api/alarms', { method: 'POST', body });
      toast(`报警 ${detail.alarm.id} 已接入并自动派单`, 'ok');
      state.selectedId = detail.alarm.id;
      await refresh();
    } catch (e) {
      toast(e.message, 'err');
    }
  };
}

// ---------- 启动 ----------
function startClock() {
  const el = $('#clock');
  const tick = () => { el.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }); };
  tick();
  setInterval(tick, 1000);
}

function startSse() {
  let timer = null;
  const es = new EventSource('/api/events');
  es.addEventListener('update', () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 200); // 防抖，连续事件合并刷新
  });
  es.onerror = () => console.warn('SSE 断开，浏览器将自动重连');
}

(async function main() {
  startClock();
  try {
    await loadBase();
    initForm();
    // 默认选中第一个进行中的报警
    const active = state.alarms.find((a) => !['closed', 'cancelled'].includes(a.status));
    if (active) await selectAlarm(active.id);
    startSse();
  } catch (e) {
    toast(`初始化失败：${e.message}`, 'err');
  }
})();
