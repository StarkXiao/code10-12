/**
 * JSON 文件仓储：
 * - 数据量小（楼宇/电梯/救援员/事件），单文件足够；
 * - 写操作走"写临时文件 + rename"原子替换，避免半写损坏；
 * - 进程内直接持有对象引用，写时整体序列化。
 *
 * file 为 null 时退化为纯内存模式（测试用）。
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const COLLECTIONS = ['buildings', 'elevators', 'cameras', 'rescuers', 'incidents'];

export class Store {
  constructor(file, seedData = null) {
    this.file = file;
    this.data = seedData ?? emptyData();
  }

  static async open(file, seedData = null) {
    const store = new Store(file, seedData);
    if (file) {
      try {
        const raw = await readFile(file, 'utf8');
        store.data = JSON.parse(raw);
        for (const c of COLLECTIONS) {
          if (!store.data[c]) store.data[c] = {};
        }
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        // 首次启动：使用 seed（可能为 null），稍后 persist 落盘
      }
    }
    return store;
  }

  get(collections, id) {
    return this.data[collections]?.[id] ?? null;
  }

  list(collection) {
    return Object.values(this.data[collection] ?? {});
  }

  put(collection, record) {
    if (!record.id) record.id = rid(collection);
    this.data[collection][record.id] = record;
    return record;
  }

  /** 生成新 id 但先不落库 */
  newId(collection) {
    return rid(collection);
  }

  async persist() {
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    await rename(tmp, this.file);
  }
}

function emptyData() {
  return Object.fromEntries(COLLECTIONS.map((c) => [c, {}]));
}

function rid(collection) {
  const prefix = {
    buildings: 'BLD',
    elevators: 'ELV',
    cameras: 'CAM',
    rescuers: 'RSC',
    incidents: 'INC',
  }[collection];
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}
