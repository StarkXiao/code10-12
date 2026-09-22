/** 请求校验小工具：抛错带 statusCode，由 HTTP 层统一转 400 */

export function requireFields(body, fields) {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === '');
  if (missing.length) {
    throw httpError(400, `缺少必填字段：${missing.join('、')}`);
  }
}

export function httpError(statusCode, message, extra = {}) {
  return Object.assign(new Error(message), { statusCode }, extra);
}

export function asInt(v, name) {
  const n = Number(v);
  if (!Number.isInteger(n)) throw httpError(400, `${name} 必须是整数`);
  return n;
}

export function asCoord(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw httpError(400, `${name} 必须是数字`);
  return n;
}
