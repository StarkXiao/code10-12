/**
 * 资质域：判断救援员证书是否有效，以及某台电梯要求的最低资质集合。
 */
import { Certification } from './constants.js';

/** 厂家专项培训在资质列表中的编码：brand_training:三菱 等 */
export function brandCert(brand) {
  return `${Certification.BRAND_TRAINING}:${brand}`;
}

export function certOf(code) {
  return code.startsWith(`${Certification.BRAND_TRAINING}:`)
    ? Certification.BRAND_TRAINING
    : code;
}

/**
 * 该电梯困人救援所需的必需资质：
 * - 永远要求电梯作业证；
 * - 品牌电梯（requiresBrandTraining）要求对应厂家专项培训；
 * - 超高层（消防电梯/40 层以上）附加高层救援资质。
 */
export function requiredCertsFor(elevator, building) {
  const required = new Set([Certification.ELEVATOR_OP]);
  if (elevator.requiresBrandTraining && elevator.brand) {
    required.add(brandCert(elevator.brand));
  }
  const floors = building?.floorsAboveGround ?? 0;
  if (elevator.type === 'fire' || floors >= 40) {
    required.add(Certification.HIGH_RISE);
  }
  return required;
}

/**
 * 救援员在指定时刻是否持有全部必需资质，且证书未过期。
 * certifications: [{ code, expiresAt: ISO|null }]
 */
export function holdsAllCerts(rescuer, required, at = new Date()) {
  const atMs = at.getTime();
  const held = new Set();
  for (const c of rescuer.certifications ?? []) {
    if (c.expiresAt && new Date(c.expiresAt).getTime() < atMs) continue; // 过期作废
    held.add(c.code);
  }
  for (const req of required) {
    if (!held.has(req)) return false;
  }
  return true;
}

/** 超出必需资质的有效证书数量（派单加分项） */
export function extraCertCount(rescuer, required, at = new Date()) {
  const atMs = at.getTime();
  let n = 0;
  for (const c of rescuer.certifications ?? []) {
    if (c.expiresAt && new Date(c.expiresAt).getTime() < atMs) continue;
    if (!required.has(c.code)) n += 1;
  }
  return n;
}
