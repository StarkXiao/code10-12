# 电梯困人救援调度系统（elevator-rescue-dispatch）

接收轿厢报警 → 联动楼宇监控 → 按「就近 + 资质」自动匹配救援人员 → 全程记录到场时序。

零依赖（纯 Node.js 内置模块），无需安装数据库，`node server.js` 即可运行。

```bash
node server.js          # 打开 http://localhost:8080
npm test                # 53 项端到端冒烟断言（独立数据目录，不碰运行数据）
```

首次启动自动写入种子数据（3 栋楼 / 6 台电梯 / 18 路摄像头 / 8 名救援人员，含证件过期、休息中、任务中等边界情形）到 `data/db.json`。

---

## 闭环流程

```
轿厢报警接入（五方对讲/物联网/物业电话/APP）
  → 联动楼宇监控：调取轿厢内/厅门/机房/大堂摄像头 + 读取轿厢位置、门状态、故障码
  → 自动派单：硬过滤（在岗 + 持证有效）→ 加权评分 → 派给最优者
  → 接单 → 出发 → 到场（校验 30 分钟 SLA）→ 救出 → 闭环
  → 超时未接单自动改派下一位；SLA 超时事件升级紧急
```

打开调度台后点「🚨 触发困人报警」（勾选模拟自动推进），约 30-60 秒可看到完整闭环在页面上实时演进（SSE 推送）。

## 匹配算法（就近 + 资质）

**硬条件**（不满足直接过滤并记录原因）：在岗状态 `available`、持电梯作业证（T）、证件在有效期内。

**加权评分**（`src/dispatch.js`）：

| 因子 | 权重 | 计算 |
| --- | --- | --- |
| 就近 | 0.60 | Haversine 距离 → 按 30km/h 折算 ETA → `1/(1+ETA/20)` |
| 资质 | 0.25 | 高级 1.0 / 中级 0.7 / 初级 0.4 |
| 经验 | 0.15 | 历史救援次数 / 50 封顶 |

每次派单把候选评分明细快照（`candidates_snapshot`）留档，调度依据可审计、可回放。改派时自动排除本报警已试过的人员。

## 到场时序

每个报警记录 7 个关键时刻：**报警接入 → 派单 → 接单 → 出发 → 到场 → 救出 → 闭环**（`arrival_sequence`），并计算四段耗时：报警→接单、报警→到场（对 30 分钟 SLA 判定）、到场→救出、全程。所有状态变更同时写入只增不改的事件时间线（`timeline`）。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/alarms` | 轿厢报警接入（同电梯进行中报警幂等去重，409 返回已有单号；`simulate:true` 自动演示） |
| GET | `/api/alarms` / `:id` | 列表 / 详情（时序、耗时、调度记录、监控联动） |
| POST | `/api/alarms/:id/cancel` | 取消报警（误报），进行中调度单一并作废 |
| GET | `/api/alarms/:id/candidates` | 实时候选评分（合格者降序 + 被过滤者及原因） |
| GET | `/api/alarms/:id/monitoring` | 联动监控回放（摄像头 + 传感器快照） |
| POST | `/api/dispatches/:id/{accept,depart,arrive,release,complete}` | 调度单状态机推进（非法流转 409） |
| POST | `/api/dispatches/:id/reassign` | 改派：作废当前单，自动派给下一位候选人 |
| GET/PATCH | `/api/rescuers` / `:id` | 救援人员档案 / 在岗状态与位置上报 |
| GET | `/api/elevators` `/api/buildings` `/api/stats` `/api/meta` | 档案与统计 |
| GET | `/api/monitoring/snapshot/:cameraId` | 模拟监控画面（SVG） |
| GET | `/api/events` | SSE 实时推送 |

## 配置（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 8080 | 服务端口 |
| `DATA_DIR` | `./data` | 数据目录 |
| `ARRIVE_SLA_MIN` | 30 | 到场 SLA（分钟），超时自动升级紧急 |
| `ACCEPT_TIMEOUT_MS` | 120000 | 接单超时，超时自动改派 |
| `AVG_SPEED_KMH` | 30 | ETA 折算用的城区平均车速 |

## 设计取舍

- **零依赖**：JSON 文件原子写持久化（写 tmp 再 rename），演示与单机部署足够；上量后可把 `src/store.js` 换成 SQLite/Postgres，业务层（`service.js`）不用动。
- **业务语义只有一份**：路由、超时扫描（`escalation.js`）、模拟器（`simulate.js`）都调用 `service.js` 的同一组状态机函数，不会出现"接口能到、定时器走不通"的分叉。
- **监控画面为模拟快照**：`snapshot_url` 返回带时间戳的 SVG；真实部署把 `renderSnapshot` 换成流媒体网关抓帧即可，联动数据结构不变。
- **未做鉴权**：定位是内网调度台演示；生产需在 `server.js` 的 `/api/` 入口前加鉴权中间件。

## 目录

```
server.js            # 入口：HTTP + 静态托管 + 路由 + 升级扫描
src/
  service.js         # 业务核心：报警/派单/状态机/时序/统计
  dispatch.js        # 匹配引擎：硬过滤 + 加权评分
  monitor.js         # 楼宇监控联动 + 模拟快照
  escalation.js      # 接单超时改派、SLA 超时升级
  simulate.js        # 演示用自动推进
  store.js           # JSON 持久化 + 种子数据
  geo.js  sse.js     # 距离/ETA、SSE 推送
public/              # 调度台单页（原生 JS + SSE）
test/smoke.mjs       # 53 项端到端断言
```
