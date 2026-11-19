# @earendil-works/pi-lab

Research experiment discipline for pi: experiment ledger, evidence-linked claims, completion gates, paired statistics, task pools, and router/worker orchestration.

## Router/worker 编排（吸收自 dsh-superagent-prototype）

多方向实验的两个老问题——方向多了管理不过来、不同方向的数据混在一起——由四个机制解决：

1. **每方向一个 worker 进程**：`lab_worker_spawn` 为一条实验线派生一个 headless pi 进程（独立会话与目录），绑定该线并锁定账本写入——串线在接口层被拒绝，单一写入者保证数据不混杂。
2. **router 只路由不执行**：主会话派生 worker 后继续自己的工作，worker 结束把报告回传账本；`lab_worker_collect` 收取报告与该线生命周期内的账本增量，router 据此决定采纳、再派生或放弃。
3. **并发无内建上限**：同时活跃的 worker 数由机器与网关承载决定；需要限流时由调用方显式传 maxWorkers。
4. **waitsForPerson**：需要人决策或环境不可用的 worker 如实落 failed 并回传原因，等待 router 裁定，禁止编造数据。

状态卡每轮注入活跃 worker 与待收取清单；交互模式内 `/workers` 命令展示路由视图。worker 内禁止再派生 worker（`LAB_NO_SPAWN`），编排只有一层。

## 治理：验收阶梯、独立复核、不可逆与熔断

科研账本最怕两件事：执行者自己给自己打分，以及失败被反复重试掩盖。四个机制对应四条教训：

1. **验收阶梯，机器先于模型**：评测脚本自己输出的结构化结果（`RESULT_JSON`）→ 与账本逐项比对（容差内）→ 配对显著性检验 → 判断。机器能验证的环节不交给 LLM 判断。
2. **独立复核（选手不当裁判）**：`lab_eval_run_python` 执行成功即登记复现命令；`lab_verify_run` 用脚本重跑一遍，把重跑数值与账本指标比对。对不上落 `mismatch`，该 run 在复核通过前不能被标完成。没有复现命令的 run 要标完成，必须声明 `evidence_class="manual"` 并在 note 写明证据来源，账本以 `unverified` 永久标记——允许人工路径存在，但不允许它伪装成脚本证据。
3. **账本不可覆盖**：同名指标重复写入必须提供 `revise_reason`，旧值保留为历史版本（`revision` + `superseded_by`），默认查询只看当前生效版本。
4. **连续失败熔断**：同一实验线累计 3 次 failed 自动置为 `paused`，登记新 run 与派生 worker 均被拒绝，需 `lab_line_resume` 说明已排查什么才恢复。状态卡只报需要处理的事项（熔断线、复核不一致、待收取 worker、未决判断），正常状态折叠成一行。
5. **执行锁**：同一实验线同时只允许一个进程写入。`registerRun` 自动占线（持有者为本进程 pid），同进程重入即续期；其他进程占线未过期时被拒，并给出持有者与心跳时间；进程死亡后租期（默认 90 分钟）到期可被接管。run 进入终态且线内无进行中 worker 时自动释放，也可 `forceReleaseLineLock` 人工清理。跨进程并行因此只能跨线，不能同线。
6. **活动日志**：账本每次变更写一条 `activity`：创建/分叉线、登记 run、状态流转、指标记录与修订、工件挂载、判断增删与裁定、复核结论、worker 存亡、锁的获取/接管/释放、熔断触发。`lab_activity` 按线、run、动作类型查询，用于排障与写实验记录。
7. **输入快照与漂移检测**：`lab_eval_run_python` 成功即把评测脚本复制到 `runs/<run_key>/snapshot/src/`，并记录脚本 sha256、数据文件哈希、Python 环境指纹（解释器 + pip freeze 哈希）与 git 状态（commit + 未提交改动），清单写入 `snapshot/manifest.json`。复核前先比对当前脚本哈希与登记值：不一致落 `drift`（代码已漂移，重跑不可比），而不是误判为数据造假；哈希一致时优先用快照副本重跑。漂移的 run 不能标完成，状态卡与 collect 均会提示。

## 核心模块

| 文件 | 职责 |
| --- | --- |
| store.ts | 实验账本：lines、runs、metrics、artifacts、claims、workers、line_locks、activity（node:sqlite） |
| recall.ts | 指标轨迹检索与实验线认知摘要 |
| resilient.ts | 可靠 LLM 调用底座（探活回退、失败三分类、审计） |
| stats.ts | Wilcoxon 符号秩（n≤16 精确枚举）、配对 t、胜平负 |
| compare.ts | 实验线与逐场景配对对比，含未决判断方向核对 |
| pool.ts | 任务池校验、难度带双向筛选、分布统计 |
| eval.ts | Python 评测脚本编排（独立子进程、硬超时、解释器探测） |
| verify.ts | 独立复核：重跑评测命令，重跑结果与账本指标逐项比对；漂移检测优先于数值比对 |
| snapshot.ts | 输入快照：脚本副本、数据/环境/git 指纹清单，供回溯与漂移判定 |
| worker.ts | router/worker 进程编排 |
