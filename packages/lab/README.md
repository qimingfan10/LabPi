# @earendil-works/pi-lab

Research experiment discipline for pi: experiment ledger, evidence-linked claims, completion gates, paired statistics, task pools, and router/worker orchestration.

## Router/worker 编排（吸收自 dsh-superagent-prototype）

多方向实验的两个老问题——方向多了管理不过来、不同方向的数据混在一起——由四个机制解决：

1. **每方向一个 worker 进程**：`lab_worker_spawn` 为一条实验线派生一个 headless pi 进程（独立会话与目录），绑定该线并锁定账本写入——串线在接口层被拒绝，单一写入者保证数据不混杂。
2. **router 只路由不执行**：主会话派生 worker 后继续自己的工作，worker 结束把报告回传账本；`lab_worker_collect` 收取报告与该线生命周期内的账本增量，router 据此决定采纳、再派生或放弃。
3. **WorkerSlots 限流**：活跃 worker 默认上限 3，超限的 spawn 被拒绝并提示先收取。
4. **waitsForPerson**：需要人决策或环境不可用的 worker 如实落 failed 并回传原因，等待 router 裁定，禁止编造数据。

状态卡每轮注入活跃 worker 与待收取清单；交互模式内 `/workers` 命令展示路由视图。worker 内禁止再派生 worker（`LAB_NO_SPAWN`），编排只有一层。

## 核心模块

| 文件 | 职责 |
| --- | --- |
| store.ts | 实验账本：lines、runs、metrics、artifacts、claims、workers（node:sqlite） |
| recall.ts | 指标轨迹检索与实验线认知摘要 |
| resilient.ts | 可靠 LLM 调用底座（探活回退、失败三分类、审计） |
| stats.ts | Wilcoxon 符号秩（n≤16 精确枚举）、配对 t、胜平负 |
| compare.ts | 实验线与逐场景配对对比，含未决判断方向核对 |
| pool.ts | 任务池校验、难度带双向筛选、分布统计 |
| eval.ts | Python 评测脚本编排（独立子进程、硬超时、解释器探测） |
| worker.ts | router/worker 进程编排 |
