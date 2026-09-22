# 电梯困人救援调度系统

接收轿厢紧急报警 → 自动联动楼宇监控 → 按**就近 + 资质匹配**选定救援员 → 自动派单 →
全程记录到场时序 → SLA 超时自动升级（值班主管 → 119/120 应急联动）。

零第三方依赖，Node.js ≥ 20.11 内置模块实现（HTTP / JSON 仓储 / node:test）。

---

## 快速开始

```bash
npm run seed     # 写入基线数据：4 栋楼 / 7 台电梯 / 6 个摄像头 / 8 名救援员
npm start        # 启动服务，默认 http://localhost:3000
npm run demo     # 4 个场景的完整业务演示（内存数据，不写文件）
npm test         # 31 项单元 + 集成测试
```

环境变量：`PORT`（默认 3000）、`DATA_FILE`（默认 `data/store.json`）、
`SWEEP_INTERVAL_MS`（SLA 扫描间隔，默认 15s）。

---

## 救援闭环

```
轿厢紧急按钮 / IoT / 电话 / 视频 AI 报警
   │
   ├─ 建警：定级（含老人/儿童/伤员/火情 → high）
   ├─ 联动监控：自动绑定该电梯轿厢内在线摄像头，生成流 ID 推送值班台
   │            （无在线摄像头 → 时间线记录并通知物业，不阻断接警）
   └─ 自动派单：
         硬性过滤：在岗待命 + 全部必需资质有效（证书未过期）+ 未达在手事件上限
         综合评分：100 − 4×距离(km) − 1.5×ETA(分钟) + 2×多余资质数 + 0.2×历史评分
         无合格人选 → 立即升级值班主管（时间线留痕），等待人工派单
   ↓
救援员 App：出发 → 到场（现场可越级上报，系统自动补登派单）
   ↓
盘车放人 → 救出 → 主管归档（归档后救援员恢复待命）
   ↓
SLA 守护（后台每 15 秒扫描，幂等）：
   接警 60 秒未派单 → 值班主管
   接警 30 分钟未到场 → 119/120 应急联动
```

### 状态机（只进不退，可越级、不可回退）

`alarm_received → dispatched → en_route → on_site → rescued → closed`

任何状态变更都写入同一条不可改写的 `timeline`（seq 连续），节点时间戳
（接警/派单/出发/到场/救出/归档）与时间线同源，到场时序报告以此为准。

### 资质规则

- 所有电梯：必须持**电梯作业证**（`elevator_op`）且在有效期内；
- 品牌培训梯（如三菱 NEXIEZ）：加 `brand_training:三菱`；
- 消防梯或建筑 ≥40 层：加 `high_rise`；
- 证书带 `expiresAt`，过期即视为无资质。基线数据中 RSC-06 的电梯证已过期，
  即使他离事发点最近也会被淘汰。

---

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/incidents/alarms` | 接警（联动监控 + 自动派单），支持 `at` 回填时间 |
| GET | `/api/incidents/:id/suggest` | 预览候选救援员评分名单（含淘汰原因） |
| POST | `/api/incidents/:id/dispatch` | （重新）派单，可指定 `rescuerId` 人工派 |
| POST | `/api/incidents/:id/reassign` | 改派（仅 dispatched/en_route 可改派） |
| POST | `/api/incidents/:id/en-route` `/on-site` `/rescued` `/close` | 时序推进 |
| POST | `/api/incidents/:id/monitor` | 监控中心/视频 AI 补报（不改状态） |
| POST | `/api/incidents/:id/notes` | 备注 |
| GET | `/api/incidents` | 列表（`?active=true&state=on_site&rescuerId=...`） |
| GET | `/api/incidents/:id/report` | 时序报告：节点耗时 + SLA 余量 |
| POST | `/api/sla/sweep` | 手动触发一次 SLA 扫描 |
| GET | `/api/stats` | 调度统计（平均派单/到场耗时、破线数、升级数） |
| POST/GET | `/api/buildings` `/api/elevators` `/api/cameras` `/api/rescuers` | 资源登记 |
| POST | `/api/rescuers/:id/location` | 救援员定位/在岗状态上报 |

所有写接口的 `at` 字段可传 ISO 8601 时间（缺省取服务器当前时间），
便于补录和测试超时场景。统一响应包络：`{ ok, data }` / `{ ok:false, error }`。

### 接警示例

```bash
curl -s -X POST http://localhost:3000/api/incidents/alarms \
  -H 'content-type: application/json' \
  -d '{"elevatorId":"ELV-101","floor":12,"occupants":3,"hasVulnerable":true,"summary":"12层停梯含1名老人"}'
```

返回 `data.incident`（含 timeline / streamId / rescuerId）与 `data.dispatch`
（必需资质、评分排序、选中候选）。

---

## 演示场景（`npm run demo`）

1. **静安中心三菱客梯困人**（含老人，紧急）：品牌培训资质过滤，完整闭环 + 时序报告；
2. **陆家嘴 52 层消防梯困人**：无 `high_rise` 资质者（含最近的若干人）全部出局；
3. **凌晨徐汇苑**：唯一合格救援员被占用 → 接警即升级主管 → 主管叫醒机动队人工派单；
4. **虹桥天地摄像头离线 + 救援员未到场**：通知物业 + 30 分钟 SLA 自动升级 119/120，
   并验证重复扫描不产生重复升级。

## 测试

```bash
npm test
```

- `geo.test.js`：haversine 距离、ETA 估算；
- `dispatcher.test.js`：资质/证书过期/下班/容量过滤、就近评分排序、指定不合格人选拒绝；
- `incident.test.js`：状态机越级与回退、补登派单、改派约束、升级只升不降且幂等、SLA 评估；
- `integration.test.js`：完整闭环、监控缺失分支、无人可派升级、SLA 扫描与统计口径。

## 目录

```text
src/
  constants.js     状态机/事件/资质/SLA/评分权重
  clock.js         可注入时间源（演示/测试模拟超时）
  geo.js           haversine + 道路 ETA 估算
  certifications.js 资质要求推导与有效期判定
  dispatcher.js    就近+资质匹配（硬过滤 + 评分排序）
  incident.js      状态机、时间线、SLA 评估、节点耗时
  service.js       用例编排（接警/联动/派单/时序/扫描/统计）
  store.js         JSON 仓储（临时文件 + rename 原子写）
  http.js          零依赖 HTTP 路由
  seed.js          基线数据
scripts/demo.js    四场景演示
test/              node:test 测试
```

## 生产化时的已知边界（有意简化）

- 距离按直线 haversine + 平均车速估算 ETA，真实接入应替换为地图路径规划；
- 监控"联动"是领域记录（摄像头/流 ID/时间线），未对接真实 NVR/RTSP 与 AI 分析回调；
- JSON 文件仓储适用于单机演示，多实例部署需换 Postgres + 行锁/事务；
- 无鉴权层，接入真实调度台需补操作人身份与审计。
