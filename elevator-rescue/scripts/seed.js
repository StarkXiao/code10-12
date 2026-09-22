/** 写入/重置基线数据到 data/store.json */
import { Store } from '../src/store.js';
import { cloneSeed } from '../src/seed.js';

const file = process.env.DATA_FILE ?? new URL('../data/store.json', import.meta.url).pathname;
const store = new Store(file, cloneSeed());
await store.persist();
console.log(`✅ 基线数据已写入: ${file}`);
console.log(`   楼宇 ${store.list('buildings').length} / 电梯 ${store.list('elevators').length} / 摄像头 ${store.list('cameras').length} / 救援员 ${store.list('rescuers').length}`);
