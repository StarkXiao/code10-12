/**
 * 时间源：生产环境取系统时钟；测试/演示可注入固定时间，便于模拟超时。
 */
export class Clock {
  constructor(initialNow) {
    this.offset = initialNow ? new Date(initialNow).getTime() - Date.now() : 0;
  }

  now() {
    return new Date(Date.now() + this.offset);
  }

  nowMs() {
    return Date.now() + this.offset;
  }

  /** 把基准时间拨到指定时刻（测试用） */
  setNow(t) {
    this.offset = new Date(t).getTime() - Date.now();
  }

  /** 相对当前时间推进毫秒数（测试用） */
  advance(ms) {
    this.offset += ms;
  }
}

/** 解析请求里可覆盖的 at 字段（ISO 字符串），缺省取时钟当前时间 */
export function resolveAt(body, clock) {
  if (body && typeof body.at === 'string' && body.at.trim()) {
    const t = Date.parse(body.at);
    if (Number.isNaN(t)) {
      throw Object.assign(new Error('at 必须是合法的 ISO 8601 时间'), {
        statusCode: 400,
      });
    }
    return new Date(t);
  }
  return clock.now();
}

export function ms(isoOrDate) {
  return isoOrDate instanceof Date
    ? isoOrDate.getTime()
    : new Date(isoOrDate).getTime();
}

export function fmtTime(d) {
  const date = d instanceof Date ? d : new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/** 毫秒耗时 → "12分34秒" 中文 */
export function fmtDuration(msValue) {
  if (msValue == null) return '—';
  const totalSec = Math.max(0, Math.round(msValue / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}秒`;
  return `${m}分${s}秒`;
}
