import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nowIso, shortHash, stableStringify } from "./fingerprint.ts";

export interface LineRow {
	id: string;
	title?: string;
	parent_line?: string;
	forked_from_run?: string;
	/** active | paused：连续失败达到阈值后熔断，需显式 resume 才能继续登记 run */
	status: string;
	note?: string;
	consecutive_failures?: number;
	paused_reason?: string;
	created_at: string;
}

export interface RunRow {
	run_key: string;
	line_id: string;
	title?: string;
	/** 绑定的研究假设（H-0001 形式）；方向层据此聚合证据 */
	hypothesis_id?: string;
	stage?: string;
	model?: string;
	endpoint?: string;
	endpoint_fingerprint?: string;
	config_fingerprint?: string;
	status: string;
	fail_class?: string;
	note?: string;
	/** 评测复现命令（JSON：script/args/tolerance），供独立复核重跑 */
	eval_spec?: string;
	/** pending | verified | mismatch —— 独立复核结果 */
	verification?: string;
	verification_note?: string;
	verified_at?: string;
	/** 评测脚本内容哈希（快照时记录），用于漂移检测 */
	script_hash?: string;
	/** 输入快照采集时间 */
	snapshot_at?: string;
	started_at: string;
	finished_at?: string;
}

export interface MetricRow {
	id: number;
	run_key: string;
	name: string;
	value: number;
	stage?: string;
	context?: string;
	/** 修订序号，从 1 开始；旧版本保留为历史，不被覆盖 */
	revision?: number;
	/** 被哪条新记录取代（null 表示当前生效版本） */
	superseded_by?: number | null;
	/** 修订原因 */
	revise_reason?: string;
	recorded_at: string;
}

export interface ArtifactRow {
	id: number;
	run_key: string;
	rel_path: string;
	kind?: string;
	checksum?: string;
	recorded_at: string;
}

/** 科研判断：结论必须携带证据，证据可推翻判断 */
export interface ClaimRow {
	id: number;
	statement: string;
	line_id?: string;
	evidence?: string;
	/** 结构化方向断言：{metric, lineA, lineB, direction: "A>B"|"B>A"}，供对比工具自动核对 */
	check_json?: string;
	status: "open" | "supported" | "refuted";
	verdict_note?: string;
	created_at: string;
	resolved_at?: string;
}

export interface ClaimInput {
	statement: string;
	lineId?: string;
	/** 证据引用：run_key、工件路径或其它 claim 编号（C3 形式） */
	evidence?: string[];
	/** 可自动核验的方向断言 */
	check?: { metric: string; lineA: string; lineB: string; direction: "A>B" | "B>A" };
}

/** worker：绑定一条实验线的 headless pi 执行进程（router/worker 编排） */
export interface WorkerRow {
	id: number;
	line_id: string;
	task: string;
	status: "running" | "reported" | "failed";
	report?: string;
	pid?: number;
	exit_code?: number;
	created_at: string;
	finished_at?: string;
}

/** 研究假设：方向层的一等对象。proposed（已提议）→ queued（已过闸门可派发）
 *  → running（派发中）→ supported|refuted|killed（终态）；stale 表示证据条件已失效 */
export interface HypothesisRow {
	id: string;
	line_id?: string;
	parent_run?: string;
	parent_hypothesis?: string;
	statement: string;
	/** 若假设成立，哪个指标变化多少 */
	prediction: string;
	/** 哪个观测结果能区分此假设与备择解释 */
	discriminator: string;
	prior: number;
	expected_gain?: number;
	eval_ref?: string;
	anchor_ref?: string;
	held_out_spec?: string;
	budget_cap?: number;
	kill_after?: number;
	/** claim_conflict | residual | cross_line | saturation | human */
	provenance: string;
	provenance_ref?: string;
	status: string;
	rank_score?: number;
	/** 排序分量 JSON，供事后核对打分依据 */
	rank_components?: string;
	decided_run?: string;
	decision_note?: string;
	created_at: string;
	decided_at?: string;
}

export interface HypothesisInput {
	statement: string;
	prediction: string;
	discriminator: string;
	prior?: number;
	expectedGain?: number;
	lineId?: string;
	parentRun?: string;
	parentHypothesis?: string;
	evalRef?: string;
	anchorRef?: string;
	heldOutSpec?: string;
	budgetCap?: number;
	killAfter?: number;
	provenance: string;
	provenanceRef?: string;
}

/** 新颖性检查：检索证据入账，verdict 由会话内模型判定后写入 */
export interface NoveltyCheckRow {
	id: number;
	hypothesis_id: string;
	query: string;
	/** 检索来源与候选 JSON */
	sources?: string;
	/** novel | adjacent | duplicate | insufficient */
	verdict: string;
	/** 证据论文列表 JSON */
	evidence_ids?: string;
	checked_by?: string;
	checked_at: string;
}

/** 提问闸门产生的问题：只问会改变下一步动作的问题，附默认答案 */
export interface QuestionRow {
	id: number;
	hypothesis_id?: string;
	brief_ref?: string;
	field: string;
	question: string;
	default_answer?: string;
	answer?: string;
	/** open | answered | defaulted */
	status: string;
	asked_at: string;
	resolved_at?: string;
}

/** 评测器：某条线的评测脚本及其质量度量（噪声底、审计漏检率） */
export interface EvaluatorRow {
	id: string;
	line_id?: string;
	script_path?: string;
	script_hash?: string;
	metric_names?: string;
	/** JSON：每个指标的 {n, mean, sd}，来自同配置重复 run 实测 */
	noise_floor?: string;
	anchor_id?: string;
	audit_miss_rate?: number;
	last_audit_at?: string;
}

/** 派发记录：一个 dispatch 或 review 角色会话在进度表上的一行 */
export interface DispatchRow {
	id: number;
	line_id?: string;
	hypothesis_id?: string;
	session?: string;
	stage: string;
	/** 显式声明的父阶段：阶段间的上下文分叉关系以此为准 */
	parent_stage?: string;
	goal?: string;
	pid?: number;
	/** running | completed | failed | gate_blocked | gateway_unreachable | stale */
	status: string;
	exit_code?: number;
	summary?: string;
	log_path?: string;
	started_at: string;
	finished_at?: string;
}

/** 锚：改进信号所依附的、模型改不动的对象 */
export interface AnchorRow {
	id: string;
	/** held_out_split | hidden_scenarios | fixed_budget | external_verifier | human_rubric | sealed_env */
	kind: string;
	/** strong | medium | weak */
	strength: string;
	definition_path?: string;
	/** JSON：{git?, net?, hiddenTests?} 封闭等级 */
	sealing_level?: string;
	note?: string;
}

export interface RunInput {
	lineId: string;
	title?: string;
	stage?: string;
	model?: string;
	endpoint?: string;
	config?: unknown;
	note?: string;
	/** 绑定研究假设：dispatch --hypothesis 派发的 run 必须携带 */
	hypothesisId?: string;
}

export interface MetricInput {
	stage?: string;
	context?: string;
	/** 更正已存在的同名指标时必填；旧值保留为历史版本 */
	reviseReason?: string;
}

export type FailClass = "infra_error" | "format_violation" | "semantic_fail";

/** 连续失败熔断阈值：同一线累计 3 次 failed 自动暂停 */
export const FAILURE_BREAKER_THRESHOLD = 3;

/** 执行锁默认租期：写入时自动续期，进程死亡后到期可被接管 */
export const DEFAULT_LOCK_TTL_MS = 90 * 60_000;

/** 假设状态机：合法迁移边；terminal 态不支持再迁移 */
export const HYPOTHESIS_TRANSITIONS: Record<string, string[]> = {
	proposed: ["queued", "killed", "stale"],
	queued: ["running", "proposed", "killed", "stale"],
	running: ["supported", "refuted", "killed", "queued", "stale"],
	supported: [],
	refuted: [],
	killed: [],
	stale: ["queued", "proposed", "killed"],
};

/** 执行锁：同一实验线同时只允许一个持有者写入 */
export interface LockRow {
	line_id: string;
	holder: string;
	pid?: number;
	acquired_at: string;
	renewed_at: string;
	ttl_ms: number;
}

/** 活动日志：账本上每一次变更动作的统一留痕 */
export interface ActivityRow {
	id: number;
	ts: string;
	actor: string;
	action: string;
	line_id?: string;
	run_key?: string;
	claim_id?: number;
	worker_id?: number;
	detail?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lines (
  id TEXT PRIMARY KEY,
  title TEXT,
  parent_line TEXT,
  forked_from_run TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  paused_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  run_key TEXT PRIMARY KEY,
  line_id TEXT NOT NULL REFERENCES lines(id),
  title TEXT,
  stage TEXT,
  model TEXT,
  endpoint TEXT,
  endpoint_fingerprint TEXT,
  config_fingerprint TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  fail_class TEXT,
  note TEXT,
  eval_spec TEXT,
  verification TEXT,
  verification_note TEXT,
  verified_at TEXT,
  script_hash TEXT,
  snapshot_at TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_line ON runs(line_id);
CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_key TEXT NOT NULL REFERENCES runs(run_key),
  name TEXT NOT NULL,
  value REAL NOT NULL,
  stage TEXT,
  context TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  superseded_by INTEGER,
  revise_reason TEXT,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metrics_run ON metrics(run_key);
CREATE INDEX IF NOT EXISTS idx_metrics_name ON metrics(name);
CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_key TEXT NOT NULL REFERENCES runs(run_key),
  rel_path TEXT NOT NULL,
  kind TEXT,
  checksum TEXT,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_key);
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  statement TEXT NOT NULL,
  line_id TEXT,
  evidence TEXT,
  check_json TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  verdict_note TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS workers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_id TEXT NOT NULL REFERENCES lines(id),
  task TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  report TEXT,
  pid INTEGER,
  exit_code INTEGER,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_workers_line ON workers(line_id);
CREATE TABLE IF NOT EXISTS line_locks (
  line_id TEXT PRIMARY KEY REFERENCES lines(id),
  holder TEXT NOT NULL,
  pid INTEGER,
  acquired_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  ttl_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  line_id TEXT,
  run_key TEXT,
  claim_id INTEGER,
  worker_id INTEGER,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_activity_line ON activity(line_id);
CREATE INDEX IF NOT EXISTS idx_activity_run ON activity(run_key);
CREATE TABLE IF NOT EXISTS hypotheses (
  id TEXT PRIMARY KEY,
  line_id TEXT,
  parent_run TEXT,
  parent_hypothesis TEXT,
  statement TEXT NOT NULL,
  prediction TEXT NOT NULL,
  discriminator TEXT NOT NULL,
  prior REAL NOT NULL DEFAULT 0.5,
  expected_gain REAL,
  eval_ref TEXT,
  anchor_ref TEXT,
  held_out_spec TEXT,
  budget_cap REAL,
  kill_after INTEGER NOT NULL DEFAULT 3,
  provenance TEXT NOT NULL,
  provenance_ref TEXT,
  status TEXT NOT NULL DEFAULT 'proposed',
  rank_score REAL,
  rank_components TEXT,
  decided_run TEXT,
  decision_note TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_hypotheses_line ON hypotheses(line_id);
CREATE INDEX IF NOT EXISTS idx_hypotheses_status ON hypotheses(status);
CREATE TABLE IF NOT EXISTS novelty_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hypothesis_id TEXT NOT NULL REFERENCES hypotheses(id),
  query TEXT NOT NULL,
  sources TEXT,
  verdict TEXT NOT NULL,
  evidence_ids TEXT,
  checked_by TEXT,
  checked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_novelty_hypothesis ON novelty_checks(hypothesis_id);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hypothesis_id TEXT,
  brief_ref TEXT,
  field TEXT NOT NULL,
  question TEXT NOT NULL,
  default_answer TEXT,
  answer TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  asked_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_questions_hypothesis ON questions(hypothesis_id);
CREATE TABLE IF NOT EXISTS evaluators (
  id TEXT PRIMARY KEY,
  line_id TEXT,
  script_path TEXT,
  script_hash TEXT,
  metric_names TEXT,
  noise_floor TEXT,
  anchor_id TEXT,
  audit_miss_rate REAL,
  last_audit_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_evaluators_line ON evaluators(line_id);
CREATE TABLE IF NOT EXISTS anchors (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  strength TEXT NOT NULL,
  definition_path TEXT,
  sealing_level TEXT,
  note TEXT
);
CREATE TABLE IF NOT EXISTS dispatches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_id TEXT,
  hypothesis_id TEXT,
  session TEXT,
  stage TEXT NOT NULL,
  parent_stage TEXT,
  goal TEXT,
  pid INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  exit_code INTEGER,
  summary TEXT,
  log_path TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_dispatches_stage ON dispatches(stage);
CREATE INDEX IF NOT EXISTS idx_dispatches_status ON dispatches(status);
`;

export class LabRegistry {
	readonly db: DatabaseSync;
	readonly runsRoot: string;

	constructor(opts: { dbPath: string; runsRoot: string }) {
		mkdirSync(opts.runsRoot, { recursive: true });
		this.runsRoot = opts.runsRoot;
		this.db = new DatabaseSync(opts.dbPath);
		this.db.exec("PRAGMA journal_mode = WAL;");
		// 多角色评审等场景下多个 router 进程并发写账本：写锁竞争时等待而不是报 BUSY
		this.db.exec("PRAGMA busy_timeout = 10000;");
		this.db.exec(SCHEMA);
		this.migrate();
	}

	/** 老账本补齐新列：CREATE TABLE IF NOT EXISTS 不会给已存在的表加字段 */
	private migrate(): void {
		const add = (table: string, column: string, ddl: string) => {
			const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
			if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
		};
		add("lines", "consecutive_failures", "consecutive_failures INTEGER NOT NULL DEFAULT 0");
		add("lines", "paused_reason", "paused_reason TEXT");
		add("runs", "eval_spec", "eval_spec TEXT");
		add("runs", "verification", "verification TEXT");
		add("runs", "verification_note", "verification_note TEXT");
		add("runs", "verified_at", "verified_at TEXT");
		add("runs", "script_hash", "script_hash TEXT");
		add("runs", "snapshot_at", "snapshot_at TEXT");
		add("metrics", "revision", "revision INTEGER NOT NULL DEFAULT 1");
		add("metrics", "superseded_by", "superseded_by INTEGER");
		add("metrics", "revise_reason", "revise_reason TEXT");
		add("runs", "hypothesis_id", "hypothesis_id TEXT");
		add("dispatches", "parent_stage", "parent_stage TEXT");
	}

	close(): void {
		this.db.close();
	}

	createLine(
		id: string,
		opts: { title?: string; parentLine?: string; forkedFromRun?: string; note?: string } = {},
	): LineRow {
		if (this.getLine(id)) throw new Error(`实验线已存在: ${id}`);
		this.db
			.prepare(
				`INSERT INTO lines (id, title, parent_line, forked_from_run, status, note, created_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
			)
			.run(id, opts.title ?? null, opts.parentLine ?? null, opts.forkedFromRun ?? null, opts.note ?? null, nowIso());
		this.act("line.create", { lineId: id }, opts.title ?? "");
		return this.getLine(id)!;
	}

	forkLine(
		newId: string,
		from: { lineId?: string; runKey?: string },
		note?: string,
	): { line: LineRow; inheritedRuns: number } {
		let parentLine: string | undefined;
		let forkedFromRun: string | undefined;
		if (from.runKey) {
			const run = this.getRun(from.runKey);
			if (!run) throw new Error(`fork 来源 run 不存在: ${from.runKey}`);
			parentLine = run.line_id;
			forkedFromRun = run.run_key;
		} else if (from.lineId) {
			if (!this.getLine(from.lineId)) throw new Error(`fork 来源线不存在: ${from.lineId}`);
			parentLine = from.lineId;
		} else {
			throw new Error("fork 需要 lineId 或 runKey 之一");
		}
		const line = this.createLine(newId, { parentLine, forkedFromRun, note });
		this.act("line.fork", { lineId: newId }, `from ${forkedFromRun ?? parentLine ?? ""}`);
		let inheritedRuns = 0;
		if (forkedFromRun !== undefined && parentLine !== undefined) {
			const cnt = this.db
				.prepare(
					`SELECT COUNT(*) AS n FROM runs WHERE line_id = ? AND started_at <= (SELECT started_at FROM runs WHERE run_key = ?)`,
				)
				.get(parentLine, forkedFromRun) as unknown as { n: number };
			inheritedRuns = Number(cnt.n);
		}
		return { line, inheritedRuns };
	}

	getLine(id: string): LineRow | undefined {
		return this.db.prepare(`SELECT * FROM lines WHERE id = ?`).get(id) as unknown as LineRow | undefined;
	}

	listLines(): LineRow[] {
		return this.db.prepare(`SELECT * FROM lines ORDER BY created_at`).all() as unknown as LineRow[];
	}

	registerRun(input: RunInput): RunRow {
		const line = this.getLine(input.lineId);
		if (!line) throw new Error(`实验线不存在: ${input.lineId}`);
		if (line.status === "paused") {
			throw new Error(
				`实验线「${input.lineId}」已熔断暂停（${line.paused_reason ?? "连续失败"}）。先排查失败原因，再 lab_line_resume 显式恢复。`,
			);
		}
		if (input.hypothesisId) {
			const hyp = this.getHypothesis(input.hypothesisId);
			if (!hyp) throw new Error(`假设不存在: ${input.hypothesisId}`);
			if (hyp.status !== "queued" && hyp.status !== "running") {
				throw new Error(`假设 ${input.hypothesisId} 状态为 ${hyp.status}，只有 queued 或 running 的假设可登记 run`);
			}
		}
		// 执行锁：同线只允许一个进程持有写入权；同进程重入即续期
		this.acquireLineLock(input.lineId);
		const seqRow = this.db
			.prepare(`SELECT COUNT(*) AS n FROM runs WHERE line_id = ?`)
			.get(input.lineId) as unknown as { n: number };
		const seq = Number(seqRow.n) + 1;
		const runKey = `${input.lineId}-${String(seq).padStart(3, "0")}`;
		const configFp = input.config !== undefined ? shortHash(stableStringify(input.config)) : null;
		const endpointFp = input.endpoint ? shortHash(input.endpoint) : null;
		this.db
			.prepare(
				`INSERT INTO runs (run_key, line_id, title, stage, model, endpoint, endpoint_fingerprint,
                           config_fingerprint, status, note, hypothesis_id, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
			)
			.run(
				runKey,
				input.lineId,
				input.title ?? null,
				input.stage ?? null,
				input.model ?? null,
				input.endpoint ?? null,
				endpointFp,
				configFp,
				input.note ?? null,
				input.hypothesisId ?? null,
				nowIso(),
			);
		mkdirSync(this.runDir(runKey), { recursive: true });
		mkdirSync(join(this.runDir(runKey), "logs"), { recursive: true });
		mkdirSync(join(this.runDir(runKey), "results"), { recursive: true });
		if (input.config !== undefined) {
			this.attachJsonArtifact(runKey, "config.json", input.config, "config");
		}
		this.act(
			"run.register",
			{ lineId: input.lineId, runKey },
			`stage=${input.stage ?? "-"} model=${input.model ?? "-"}`,
		);
		return this.getRun(runKey)!;
	}

	updateRun(runKey: string, patch: { status?: string; failClass?: FailClass | null; note?: string }): RunRow {
		const run = this.getRun(runKey);
		if (!run) throw new Error(`run 不存在: ${runKey}`);
		const nextStatus = patch.status ?? run.status;
		this.db
			.prepare(`UPDATE runs SET status = ?, fail_class = ?, note = ?, finished_at = ? WHERE run_key = ?`)
			.run(
				nextStatus,
				patch.failClass === undefined ? (run.fail_class ?? null) : (patch.failClass ?? null),
				patch.note ?? run.note ?? null,
				nextStatus !== "running" ? (nowIso() as string) : (run.finished_at ?? null),
				runKey,
			);
		if (patch.status && patch.status !== run.status) {
			this.act(
				"run.status",
				{ lineId: run.line_id, runKey },
				`${run.status}→${patch.status}${patch.failClass ? ` (${patch.failClass})` : ""}`,
			);
			if (patch.status === "failed") this.noteLineFailure(run.line_id, patch.failClass ?? null);
			if (patch.status === "completed") this.resetLineFailures(run.line_id);
			if (patch.status !== "running") this.maybeReleaseLineLock(run.line_id);
		}
		return this.getRun(runKey) as RunRow;
	}

	/** 连续失败熔断：同一线累计失败达到阈值即暂停登记，避免在坏环境里继续烧时间 */
	private noteLineFailure(lineId: string, failClass: FailClass | null): void {
		const line = this.getLine(lineId);
		if (!line) return;
		const n = Number(line.consecutive_failures ?? 0) + 1;
		const paused = n >= FAILURE_BREAKER_THRESHOLD;
		this.db
			.prepare(`UPDATE lines SET consecutive_failures = ?, status = ?, paused_reason = ? WHERE id = ?`)
			.run(
				n,
				paused ? "paused" : line.status,
				paused ? `连续 ${n} 次 failed（最近一次 ${failClass ?? "未分类"}）` : (line.paused_reason ?? null),
				lineId,
			);
		if (paused) this.act("line.breaker", { lineId }, `连续 ${n} 次 failed，线暂停`);
	}

	private resetLineFailures(lineId: string): void {
		this.db
			.prepare(`UPDATE lines SET consecutive_failures = 0, paused_reason = NULL WHERE id = ? AND status = 'active'`)
			.run(lineId);
	}

	resumeLine(lineId: string, note?: string): LineRow {
		const line = this.getLine(lineId);
		if (!line) throw new Error(`实验线不存在: ${lineId}`);
		this.db
			.prepare(`UPDATE lines SET status = 'active', consecutive_failures = 0, paused_reason = ? WHERE id = ?`)
			.run(note ? `resumed: ${note}` : null, lineId);
		this.act("line.resume", { lineId }, note ?? "");
		return this.getLine(lineId)!;
	}

	/** 记录评测复现命令：独立复核据此重跑，执行者不能自证 */
	setRunEvalSpec(
		runKey: string,
		spec: { script: string; args?: string[]; tolerance?: number; timeoutSec?: number },
	): RunRow {
		const run = this.getRun(runKey);
		if (!run) throw new Error(`run 不存在: ${runKey}`);
		this.db.prepare(`UPDATE runs SET eval_spec = ? WHERE run_key = ?`).run(JSON.stringify(spec), runKey);
		this.act("run.eval_spec", { lineId: run.line_id, runKey }, spec.script);
		return this.getRun(runKey)!;
	}

	setSnapshotMeta(runKey: string, scriptHash: string, snapshotAt: string): RunRow {
		const run = this.getRun(runKey);
		if (!run) throw new Error(`run 不存在: ${runKey}`);
		this.db
			.prepare(`UPDATE runs SET script_hash = ?, snapshot_at = ? WHERE run_key = ?`)
			.run(scriptHash, snapshotAt, runKey);
		this.act("run.snapshot", { lineId: run.line_id, runKey }, `script_hash=${scriptHash.slice(0, 12)}`);
		return this.getRun(runKey)!;
	}

	setVerification(runKey: string, status: "verified" | "mismatch" | "unverified" | "drift", note: string): RunRow {
		const run = this.getRun(runKey);
		if (!run) throw new Error(`run 不存在: ${runKey}`);
		this.db
			.prepare(`UPDATE runs SET verification = ?, verification_note = ?, verified_at = ? WHERE run_key = ?`)
			.run(status, note, nowIso(), runKey);
		this.act(status === "drift" ? "run.drift" : "run.verify", { lineId: run.line_id, runKey }, `${status}: ${note}`);
		return this.getRun(runKey)!;
	}

	getRun(runKey: string): RunRow | undefined {
		return this.db.prepare(`SELECT * FROM runs WHERE run_key = ?`).get(runKey) as unknown as RunRow | undefined;
	}

	listRuns(lineId?: string): RunRow[] {
		if (lineId) {
			return this.db
				.prepare(`SELECT * FROM runs WHERE line_id = ? ORDER BY started_at`)
				.all(lineId) as unknown as RunRow[];
		}
		return this.db.prepare(`SELECT * FROM runs ORDER BY started_at`).all() as unknown as RunRow[];
	}

	recordMetric(runKey: string, name: string, value: number, opts: MetricInput = {}): MetricRow {
		if (!this.getRun(runKey)) throw new Error(`run 不存在: ${runKey}`);
		const latest = this.db
			.prepare(
				`SELECT * FROM metrics WHERE run_key = ? AND name = ? AND superseded_by IS NULL ORDER BY id DESC LIMIT 1`,
			)
			.get(runKey, name) as unknown as (MetricRow & { superseded_by: number | null }) | undefined;
		if (latest) {
			// 账本不可覆盖：同名指标重复写入需要修订理由，旧值保留为历史版本
			if (!opts.reviseReason) {
				throw new Error(
					`指标 ${name} 已记录（值 ${latest.value}）。账本条目不可覆盖——如需更正请提供 revise_reason（说明更正原因），旧值将保留为历史版本。`,
				);
			}
			const insert = this.db
				.prepare(
					`INSERT INTO metrics (run_key, name, value, stage, context, revision, revise_reason, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					runKey,
					name,
					value,
					opts.stage ?? latest.stage ?? null,
					opts.context ?? latest.context ?? null,
					Number(latest.revision ?? 1) + 1,
					opts.reviseReason,
					nowIso(),
				);
			const newId = Number(insert.lastInsertRowid);
			this.db.prepare(`UPDATE metrics SET superseded_by = ? WHERE id = ?`).run(newId, latest.id);
			const run = this.getRun(runKey);
			if (run) this.touchLock(run.line_id);
			this.act(
				"metric.revise",
				{ lineId: run?.line_id, runKey },
				`${name}: ${latest.value}→${value}（r${Number(latest.revision ?? 1) + 1}，${opts.reviseReason}）`,
			);
			return this.getMetric(newId);
		}
		this.db
			.prepare(`INSERT INTO metrics (run_key, name, value, stage, context, recorded_at) VALUES (?, ?, ?, ?, ?, ?)`)
			.run(runKey, name, value, opts.stage ?? null, opts.context ?? null, nowIso());
		const row = this.db
			.prepare(`SELECT * FROM metrics WHERE run_key = ? AND name = ? ORDER BY id DESC LIMIT 1`)
			.get(runKey, name) as unknown as MetricRow;
		const run = this.getRun(runKey);
		if (run) this.touchLock(run.line_id);
		this.act("metric.record", { lineId: run?.line_id, runKey }, `${name}=${value}`);
		return row;
	}

	private getMetric(id: number): MetricRow {
		return this.db.prepare(`SELECT * FROM metrics WHERE id = ?`).get(id) as unknown as MetricRow;
	}

	/** 同名指标的全部历史版本（含被取代的旧值），用于审计更正过程 */
	metricHistory(runKey: string, name: string): MetricRow[] {
		return this.db
			.prepare(`SELECT * FROM metrics WHERE run_key = ? AND name = ? ORDER BY id`)
			.all(runKey, name) as unknown as MetricRow[];
	}

	listMetrics(
		filter: { lineId?: string; runKey?: string; name?: string; stage?: string } = {},
		opts: { includeHistory?: boolean } = {},
	): MetricRow[] {
		const conds: string[] = [];
		const params: string[] = [];
		if (!opts.includeHistory) conds.push("m.superseded_by IS NULL");
		if (filter.runKey) {
			conds.push("m.run_key = ?");
			params.push(filter.runKey);
		}
		if (filter.lineId) {
			conds.push("r.line_id = ?");
			params.push(filter.lineId);
		}
		if (filter.name) {
			conds.push("m.name = ?");
			params.push(filter.name);
		}
		if (filter.stage) {
			conds.push("m.stage = ?");
			params.push(filter.stage);
		}
		const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
		return this.db
			.prepare(
				`SELECT m.*, r.line_id, r.model, r.endpoint FROM metrics m JOIN runs r ON r.run_key = m.run_key ${where} ORDER BY m.recorded_at, m.id`,
			)
			.all(...params) as unknown as MetricRow[];
	}

	runDir(runKey: string): string {
		return join(this.runsRoot, runKey);
	}

	attachJsonArtifact(runKey: string, relPath: string, data: unknown, kind = "result"): ArtifactRow {
		const abs = join(this.runDir(runKey), relPath);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, stableStringify(data), "utf-8");
		return this.attachArtifact(runKey, relPath, kind);
	}

	attachArtifact(runKey: string, relPath: string, kind = "other"): ArtifactRow {
		const run = this.getRun(runKey);
		if (!run) throw new Error(`run 不存在: ${runKey}`);
		const abs = join(this.runDir(runKey), relPath);
		const checksum = shortHash(readFileSync(abs).toString("base64"));
		this.db
			.prepare(`INSERT INTO artifacts (run_key, rel_path, kind, checksum, recorded_at) VALUES (?, ?, ?, ?, ?)`)
			.run(runKey, relPath, kind, checksum, nowIso());
		this.touchLock(run.line_id);
		this.act("artifact.attach", { lineId: run.line_id, runKey }, `${relPath} (${kind})`);
		return this.db
			.prepare(`SELECT * FROM artifacts WHERE run_key = ? AND rel_path = ? ORDER BY id DESC LIMIT 1`)
			.get(runKey, relPath) as unknown as ArtifactRow;
	}

	listArtifacts(runKey: string): ArtifactRow[] {
		return this.db
			.prepare(`SELECT * FROM artifacts WHERE run_key = ? ORDER BY id`)
			.all(runKey) as unknown as ArtifactRow[];
	}

	// ---------- 科研判断（claims）----------

	addClaim(input: ClaimInput): ClaimRow {
		if (!input.statement?.trim()) throw new Error("判断陈述不能为空");
		this.db
			.prepare(
				`INSERT INTO claims (statement, line_id, evidence, check_json, status, created_at)
         VALUES (?, ?, ?, ?, 'open', ?)`,
			)
			.run(
				input.statement,
				input.lineId ?? null,
				input.evidence?.length ? JSON.stringify(input.evidence) : null,
				input.check ? JSON.stringify(input.check) : null,
				nowIso(),
			);
		const claim = this.db.prepare(`SELECT * FROM claims ORDER BY id DESC LIMIT 1`).get() as unknown as ClaimRow;
		this.act("claim.add", { lineId: input.lineId, claimId: claim.id }, input.statement.slice(0, 120));
		return claim;
	}

	getClaim(id: number): ClaimRow | undefined {
		return this.db.prepare(`SELECT * FROM claims WHERE id = ?`).get(id) as unknown as ClaimRow | undefined;
	}

	listClaims(filter: { status?: string; lineId?: string } = {}): ClaimRow[] {
		const conds: string[] = [];
		const params: string[] = [];
		if (filter.status) {
			conds.push("status = ?");
			params.push(filter.status);
		}
		if (filter.lineId) {
			conds.push("line_id = ?");
			params.push(filter.lineId);
		}
		const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
		return this.db.prepare(`SELECT * FROM claims ${where} ORDER BY id`).all(...params) as unknown as ClaimRow[];
	}

	resolveClaim(id: number, verdict: "supported" | "refuted", note?: string): ClaimRow {
		const claim = this.getClaim(id);
		if (!claim) throw new Error(`判断不存在: C${id}`);
		this.db
			.prepare(`UPDATE claims SET status = ?, verdict_note = ?, resolved_at = ? WHERE id = ?`)
			.run(verdict, note ?? null, nowIso(), id);
		this.act("claim.resolve", { lineId: claim.line_id, claimId: id }, `${verdict}: ${note ?? ""}`);
		return this.getClaim(id)!;
	}

	// ---------- 方向层：假设账本 ----------

	private nextSeqId(prefix: string, table: string, width: number): string {
		const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as unknown as { n: number };
		return `${prefix}-${String(Number(row.n) + 1).padStart(width, "0")}`;
	}

	addHypothesis(input: HypothesisInput): HypothesisRow {
		if (!input.statement?.trim()) throw new Error("假设陈述不能为空");
		if (!input.prediction?.trim()) throw new Error("假设必须给出预测（若成立，哪个指标变化多少）");
		if (!input.discriminator?.trim()) throw new Error("假设必须给出判别条件（哪个观测能区分此假设与备择解释）");
		if (!input.provenance?.trim()) throw new Error("假设必须注明来源（claim_conflict|residual|cross_line|saturation|human）");
		const id = this.nextSeqId("H", "hypotheses", 4);
		this.db
			.prepare(
				`INSERT INTO hypotheses (id, line_id, parent_run, parent_hypothesis, statement, prediction, discriminator,
				   prior, expected_gain, eval_ref, anchor_ref, held_out_spec, budget_cap, kill_after,
				   provenance, provenance_ref, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`,
			)
			.run(
				id,
				input.lineId ?? null,
				input.parentRun ?? null,
				input.parentHypothesis ?? null,
				input.statement,
				input.prediction,
				input.discriminator,
				input.prior ?? 0.5,
				input.expectedGain ?? null,
				input.evalRef ?? null,
				input.anchorRef ?? null,
				input.heldOutSpec ?? null,
				input.budgetCap ?? null,
				input.killAfter ?? 3,
				input.provenance,
				input.provenanceRef ?? null,
				nowIso(),
			);
		this.act("hypothesis.create", { lineId: input.lineId }, `${id} ${input.statement.slice(0, 100)}`);
		return this.getHypothesis(id)!;
	}

	getHypothesis(id: string): HypothesisRow | undefined {
		return this.db.prepare(`SELECT * FROM hypotheses WHERE id = ?`).get(id) as unknown as HypothesisRow | undefined;
	}

	listHypotheses(
		filter: { lineId?: string; status?: string; limit?: number } = {},
	): HypothesisRow[] {
		const conds: string[] = [];
		const params: (string | number)[] = [];
		if (filter.lineId) {
			conds.push("line_id = ?");
			params.push(filter.lineId);
		}
		if (filter.status) {
			conds.push("status = ?");
			params.push(filter.status);
		}
		const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
		const limit = Math.min(filter.limit ?? 200, 1000);
		params.push(limit);
		return this.db
			.prepare(`SELECT * FROM hypotheses ${where} ORDER BY rank_score DESC, created_at LIMIT ?`)
			.all(...params) as unknown as HypothesisRow[];
	}

	/** 状态迁移：只允许假设状态机定义的边，非法迁移直接报错 */
	updateHypothesis(
		id: string,
		patch: {
			status?: string;
			lineId?: string | null;
			evalRef?: string | null;
			anchorRef?: string | null;
			heldOutSpec?: string | null;
			budgetCap?: number | null;
			killAfter?: number;
			expectedGain?: number | null;
			decisionNote?: string;
		},
	): HypothesisRow {
		const hyp = this.getHypothesis(id);
		if (!hyp) throw new Error(`假设不存在: ${id}`);
		if (patch.status && patch.status !== hyp.status) {
			const allowed = HYPOTHESIS_TRANSITIONS[hyp.status] ?? [];
			if (!allowed.includes(patch.status)) {
				throw new Error(`假设状态迁移非法: ${hyp.status}→${patch.status}（允许: ${allowed.join(", ") || "无"}）`);
			}
		}
		const next = {
			status: patch.status ?? hyp.status,
			line_id: patch.lineId === undefined ? hyp.line_id : patch.lineId,
			eval_ref: patch.evalRef === undefined ? hyp.eval_ref : patch.evalRef,
			anchor_ref: patch.anchorRef === undefined ? hyp.anchor_ref : patch.anchorRef,
			held_out_spec: patch.heldOutSpec === undefined ? hyp.held_out_spec : patch.heldOutSpec,
			budget_cap: patch.budgetCap === undefined ? hyp.budget_cap : patch.budgetCap,
			kill_after: patch.killAfter ?? hyp.kill_after,
			expected_gain: patch.expectedGain === undefined ? hyp.expected_gain : patch.expectedGain,
			decision_note: patch.decisionNote ?? hyp.decision_note,
		};
		this.db
			.prepare(
				`UPDATE hypotheses SET status = ?, line_id = ?, eval_ref = ?, anchor_ref = ?, held_out_spec = ?,
				   budget_cap = ?, kill_after = ?, expected_gain = ?, decision_note = ? WHERE id = ?`,
			)
			.run(
				next.status,
				next.line_id ?? null,
				next.eval_ref ?? null,
				next.anchor_ref ?? null,
				next.held_out_spec ?? null,
				next.budget_cap ?? null,
				next.kill_after ?? 3,
				next.expected_gain ?? null,
				next.decision_note ?? null,
				id,
			);
		if (patch.status && patch.status !== hyp.status) {
			this.act("hypothesis.status", { lineId: hyp.line_id ?? undefined }, `${id} ${hyp.status}→${patch.status}`);
		}
		return this.getHypothesis(id)!;
	}

	setHypothesisRank(id: string, score: number, components: unknown): HypothesisRow {
		const hyp = this.getHypothesis(id);
		if (!hyp) throw new Error(`假设不存在: ${id}`);
		this.db
			.prepare(`UPDATE hypotheses SET rank_score = ?, rank_components = ? WHERE id = ?`)
			.run(score, JSON.stringify(components), id);
		return this.getHypothesis(id)!;
	}

	/** 判定假设：supported 必须附已验证的 run，证据一并入账 */
	decideHypothesis(
		id: string,
		decision: "supported" | "refuted" | "killed",
		opts: { runKey?: string; note?: string } = {},
	): HypothesisRow {
		const hyp = this.getHypothesis(id);
		if (!hyp) throw new Error(`假设不存在: ${id}`);
		const allowed = HYPOTHESIS_TRANSITIONS[hyp.status] ?? [];
		if (!allowed.includes(decision)) {
			throw new Error(`假设状态迁移非法: ${hyp.status}→${decision}（允许: ${allowed.join(", ") || "无"}）`);
		}
		if (decision === "supported") {
			if (!opts.runKey) throw new Error("supported 必须给出支撑该判断的 run_key");
			const run = this.getRun(opts.runKey);
			if (!run) throw new Error(`run 不存在: ${opts.runKey}`);
			if (run.verification !== "verified") {
				throw new Error(`run ${opts.runKey} 的复核状态为 ${run.verification ?? "未复核"}，不能作为支撑证据`);
			}
		}
		this.db
			.prepare(`UPDATE hypotheses SET status = ?, decided_run = ?, decision_note = ?, decided_at = ? WHERE id = ?`)
			.run(decision, opts.runKey ?? null, opts.note ?? null, nowIso(), id);
		this.act(
			"hypothesis.decide",
			{ lineId: hyp.line_id ?? undefined, runKey: opts.runKey },
			`${id} ${decision}${opts.note ? `: ${opts.note}` : ""}`,
		);
		return this.getHypothesis(id)!;
	}

	// ---------- 方向层：新颖性检查 ----------

	addNoveltyCheck(input: {
		hypothesisId: string;
		query: string;
		sources?: unknown;
		verdict: "novel" | "adjacent" | "duplicate" | "insufficient";
		evidenceIds?: unknown;
		checkedBy?: string;
	}): NoveltyCheckRow {
		if (!this.getHypothesis(input.hypothesisId)) throw new Error(`假设不存在: ${input.hypothesisId}`);
		this.db
			.prepare(
				`INSERT INTO novelty_checks (hypothesis_id, query, sources, verdict, evidence_ids, checked_by, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.hypothesisId,
				input.query,
				input.sources === undefined ? null : JSON.stringify(input.sources),
				input.verdict,
				input.evidenceIds === undefined ? null : JSON.stringify(input.evidenceIds),
				input.checkedBy ?? null,
				nowIso(),
			);
		const row = this.db
			.prepare(`SELECT * FROM novelty_checks ORDER BY id DESC LIMIT 1`)
			.get() as unknown as NoveltyCheckRow;
		this.act("novelty.check", {}, `${input.hypothesisId} ${input.verdict} (${input.query.slice(0, 80)})`);
		return row;
	}

	listNoveltyChecks(hypothesisId: string): NoveltyCheckRow[] {
		return this.db
			.prepare(`SELECT * FROM novelty_checks WHERE hypothesis_id = ? ORDER BY id DESC`)
			.all(hypothesisId) as unknown as NoveltyCheckRow[];
	}

	latestNoveltyCheck(hypothesisId: string): NoveltyCheckRow | undefined {
		return this.db
			.prepare(`SELECT * FROM novelty_checks WHERE hypothesis_id = ? ORDER BY id DESC LIMIT 1`)
			.get(hypothesisId) as unknown as NoveltyCheckRow | undefined;
	}

	// ---------- 方向层：提问闸门 ----------

	addQuestion(input: {
		hypothesisId?: string;
		briefRef?: string;
		field: string;
		question: string;
		defaultAnswer?: string;
	}): QuestionRow {
		this.db
			.prepare(
				`INSERT INTO questions (hypothesis_id, brief_ref, field, question, default_answer, status, asked_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?)`,
			)
			.run(
				input.hypothesisId ?? null,
				input.briefRef ?? null,
				input.field,
				input.question,
				input.defaultAnswer ?? null,
				nowIso(),
			);
		const row = this.db.prepare(`SELECT * FROM questions ORDER BY id DESC LIMIT 1`).get() as unknown as QuestionRow;
		this.act("question.ask", {}, `${input.field}: ${input.question.slice(0, 100)}`);
		return row;
	}

	answerQuestion(id: number, answer: string, defaulted = false): QuestionRow {
		const q = this.db.prepare(`SELECT * FROM questions WHERE id = ?`).get(id) as unknown as QuestionRow | undefined;
		if (!q) throw new Error(`问题不存在: Q${id}`);
		this.db
			.prepare(`UPDATE questions SET answer = ?, status = ?, resolved_at = ? WHERE id = ?`)
			.run(answer, defaulted ? "defaulted" : "answered", nowIso(), id);
		this.act("question.answer", {}, `Q${id} ${defaulted ? "defaulted" : "answered"}: ${answer.slice(0, 100)}`);
		return this.db.prepare(`SELECT * FROM questions WHERE id = ?`).get(id) as unknown as QuestionRow;
	}

	listQuestions(filter: { hypothesisId?: string; status?: string; limit?: number } = {}): QuestionRow[] {
		const conds: string[] = [];
		const params: (string | number)[] = [];
		if (filter.hypothesisId) {
			conds.push("hypothesis_id = ?");
			params.push(filter.hypothesisId);
		}
		if (filter.status) {
			conds.push("status = ?");
			params.push(filter.status);
		}
		const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
		const limit = Math.min(filter.limit ?? 100, 500);
		params.push(limit);
		return this.db
			.prepare(`SELECT * FROM questions ${where} ORDER BY id DESC LIMIT ?`)
			.all(...params) as unknown as QuestionRow[];
	}

	// ---------- 方向层：评测器与锚 ----------

	addEvaluator(input: {
		id?: string;
		lineId?: string;
		scriptPath?: string;
		scriptHash?: string;
		metricNames?: unknown;
		anchorId?: string;
	}): EvaluatorRow {
		const id = input.id ?? this.nextSeqId("EV", "evaluators", 4);
		if (this.getEvaluator(id)) throw new Error(`评测器已存在: ${id}`);
		this.db
			.prepare(
				`INSERT INTO evaluators (id, line_id, script_path, script_hash, metric_names, anchor_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				input.lineId ?? null,
				input.scriptPath ?? null,
				input.scriptHash ?? null,
				input.metricNames === undefined ? null : JSON.stringify(input.metricNames),
				input.anchorId ?? null,
			);
		this.act("evaluator.register", { lineId: input.lineId }, id);
		return this.getEvaluator(id)!;
	}

	getEvaluator(id: string): EvaluatorRow | undefined {
		return this.db.prepare(`SELECT * FROM evaluators WHERE id = ?`).get(id) as unknown as EvaluatorRow | undefined;
	}

	listEvaluators(filter: { lineId?: string } = {}): EvaluatorRow[] {
		if (filter.lineId) {
			return this.db
				.prepare(`SELECT * FROM evaluators WHERE line_id = ? ORDER BY id`)
				.all(filter.lineId) as unknown as EvaluatorRow[];
		}
		return this.db.prepare(`SELECT * FROM evaluators ORDER BY id`).all() as unknown as EvaluatorRow[];
	}

	updateEvaluatorAudit(id: string, patch: { noiseFloor?: unknown; missRate?: number }): EvaluatorRow {
		const ev = this.getEvaluator(id);
		if (!ev) throw new Error(`评测器不存在: ${id}`);
		this.db
			.prepare(`UPDATE evaluators SET noise_floor = ?, audit_miss_rate = ?, last_audit_at = ? WHERE id = ?`)
			.run(
				patch.noiseFloor === undefined ? (ev.noise_floor ?? null) : JSON.stringify(patch.noiseFloor),
				patch.missRate === undefined ? (ev.audit_miss_rate ?? null) : patch.missRate,
				nowIso(),
				id,
			);
		this.act("evaluator.audit", { lineId: ev.line_id ?? undefined }, `${id} noise=${patch.noiseFloor ? "set" : "-"} miss=${patch.missRate ?? "-"}`);
		return this.getEvaluator(id)!;
	}

	addAnchor(input: {
		id?: string;
		kind: string;
		strength: string;
		definitionPath?: string;
		sealingLevel?: unknown;
		note?: string;
	}): AnchorRow {
		const id = input.id ?? this.nextSeqId("AN", "anchors", 3);
		if (this.getAnchor(id)) throw new Error(`锚已存在: ${id}`);
		this.db
			.prepare(`INSERT INTO anchors (id, kind, strength, definition_path, sealing_level, note) VALUES (?, ?, ?, ?, ?, ?)`)
			.run(
				id,
				input.kind,
				input.strength,
				input.definitionPath ?? null,
				input.sealingLevel === undefined ? null : JSON.stringify(input.sealingLevel),
				input.note ?? null,
			);
		this.act("anchor.register", {}, `${id} ${input.kind} ${input.strength}`);
		return this.getAnchor(id)!;
	}

	getAnchor(id: string): AnchorRow | undefined {
		return this.db.prepare(`SELECT * FROM anchors WHERE id = ?`).get(id) as unknown as AnchorRow | undefined;
	}

	listAnchors(kind?: string): AnchorRow[] {
		if (kind) {
			return this.db.prepare(`SELECT * FROM anchors WHERE kind = ? ORDER BY id`).all(kind) as unknown as AnchorRow[];
		}
		return this.db.prepare(`SELECT * FROM anchors ORDER BY id`).all() as unknown as AnchorRow[];
	}

	// ---------- 派发进度表：每次 dispatch/review 在账本留一行，progress 据此渲染 ----------

	addDispatch(input: {
		lineId?: string;
		hypothesisId?: string;
		session?: string;
		stage: string;
		parentStage?: string;
		goal?: string;
		logPath?: string;
	}): number {
		const r = this.db
			.prepare(
				`INSERT INTO dispatches (line_id, hypothesis_id, session, stage, parent_stage, goal, status, log_path, started_at)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
			)
			.run(
				input.lineId ?? null,
				input.hypothesisId ?? null,
				input.session ?? null,
				input.stage,
				input.parentStage ?? null,
				input.goal ?? null,
				input.logPath ?? null,
				nowIso(),
			);
		this.act("dispatch.start", { lineId: input.lineId }, `${input.stage}: ${(input.goal ?? "").slice(0, 100)}`);
		return Number(r.lastInsertRowid);
	}

	updateDispatch(
		id: number,
		patch: { status?: string; exitCode?: number | null; pid?: number | null; summary?: string },
	): void {
		const row = this.db.prepare(`SELECT * FROM dispatches WHERE id = ?`).get(id) as
			| { status: string }
			| undefined;
		if (!row) throw new Error(`派发记录不存在: D${id}`);
		const status = patch.status ?? row.status;
		const terminal = ["completed", "failed", "gate_blocked", "gateway_unreachable", "stale"].includes(status);
		this.db
			.prepare(
				`UPDATE dispatches SET status = ?, exit_code = ?, pid = COALESCE(?, pid), summary = ?, finished_at = ? WHERE id = ?`,
			)
			.run(
				status,
				patch.exitCode === undefined ? null : patch.exitCode,
				patch.pid === undefined ? null : patch.pid,
				patch.summary ?? null,
				terminal ? nowIso() : null,
				id,
			);
		this.act("dispatch.finish", {}, `D${id} ${status}${patch.summary ? `: ${patch.summary.slice(0, 100)}` : ""}`);
	}

	listDispatches(filter: { status?: string; lineId?: string; limit?: number } = {}): DispatchRow[] {
		const conds: string[] = [];
		const params: (string | number)[] = [];
		if (filter.status) {
			conds.push("status = ?");
			params.push(filter.status);
		}
		if (filter.lineId) {
			conds.push("line_id = ?");
			params.push(filter.lineId);
		}
		const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
		const limit = Math.min(filter.limit ?? 100, 1000);
		params.push(limit);
		return this.db
			.prepare(`SELECT * FROM dispatches ${where} ORDER BY id DESC LIMIT ?`)
			.all(...params) as unknown as DispatchRow[];
	}

	// ---------- workers（router/worker 编排）----------

	addWorker(lineId: string, task: string, pid?: number): WorkerRow {
		if (!this.getLine(lineId)) throw new Error(`实验线不存在: ${lineId}`);
		this.db
			.prepare(`INSERT INTO workers (line_id, task, status, pid, created_at) VALUES (?, ?, 'running', ?, ?)`)
			.run(lineId, task, pid ?? null, nowIso());
		const worker = this.db.prepare(`SELECT * FROM workers ORDER BY id DESC LIMIT 1`).get() as unknown as WorkerRow;
		this.act("worker.spawn", { lineId, workerId: worker.id }, task.slice(0, 120));
		return worker;
	}

	getWorker(id: number): WorkerRow | undefined {
		return this.db.prepare(`SELECT * FROM workers WHERE id = ?`).get(id) as unknown as WorkerRow | undefined;
	}

	listWorkers(filter: { lineId?: string; status?: string } = {}): WorkerRow[] {
		const conds: string[] = [];
		const params: string[] = [];
		if (filter.lineId) {
			conds.push("line_id = ?");
			params.push(filter.lineId);
		}
		if (filter.status) {
			conds.push("status = ?");
			params.push(filter.status);
		}
		const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
		return this.db.prepare(`SELECT * FROM workers ${where} ORDER BY id`).all(...params) as unknown as WorkerRow[];
	}

	countRunningWorkers(): number {
		const row = this.db.prepare(`SELECT COUNT(*) AS n FROM workers WHERE status = 'running'`).get() as unknown as {
			n: number;
		};
		return Number(row.n);
	}

	finishWorker(id: number, status: "reported" | "failed", report: string, exitCode: number | null): WorkerRow {
		const worker = this.getWorker(id);
		this.db
			.prepare(`UPDATE workers SET status = ?, report = ?, exit_code = ?, finished_at = ? WHERE id = ?`)
			.run(status, report, exitCode, nowIso(), id);
		if (worker) {
			this.act("worker.finish", { lineId: worker.line_id, workerId: id }, `${status} exit=${exitCode}`);
			this.maybeReleaseLineLock(worker.line_id);
		}
		return this.getWorker(id)!;
	}

	// ---------- 执行锁：同一实验线同时只允许一个进程写入 ----------

	private actor(): string {
		return `${process.env.LAB_LINE_ID ? "worker" : "router"}:pid${process.pid}`;
	}

	private act(
		action: string,
		refs: { lineId?: string; runKey?: string; claimId?: number; workerId?: number } = {},
		detail?: string,
	): void {
		this.db
			.prepare(
				`INSERT INTO activity (ts, actor, action, line_id, run_key, claim_id, worker_id, detail)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				nowIso(),
				this.actor(),
				action,
				refs.lineId ?? null,
				refs.runKey ?? null,
				refs.claimId ?? null,
				refs.workerId ?? null,
				detail ?? null,
			);
	}

	getLineLock(lineId: string): LockRow | undefined {
		return this.db.prepare(`SELECT * FROM line_locks WHERE line_id = ?`).get(lineId) as unknown as
			| LockRow
			| undefined;
	}

	listLineLocks(): LockRow[] {
		return this.db.prepare(`SELECT * FROM line_locks ORDER BY acquired_at`).all() as unknown as LockRow[];
	}

	private static lockExpired(row: LockRow): boolean {
		return Date.now() - Date.parse(row.renewed_at) > row.ttl_ms;
	}

	/** 占线：同持有者重入即续期；他人持锁且未过期则拒绝；过期锁自动接管 */
	acquireLineLock(lineId: string, opts: { holder?: string; ttlMs?: number } = {}): LockRow {
		if (!this.getLine(lineId)) throw new Error(`实验线不存在: ${lineId}`);
		const holder = opts.holder ?? `pid:${process.pid}`;
		const ttlMs = opts.ttlMs ?? DEFAULT_LOCK_TTL_MS;
		const row = this.getLineLock(lineId);
		if (row && row.holder !== holder && !LabRegistry.lockExpired(row)) {
			const heldSec = Math.round((Date.now() - Date.parse(row.renewed_at)) / 1000);
			throw new Error(
				`实验线「${lineId}」正被 ${row.holder} 占用（心跳 ${heldSec}s 前，租期 ${Math.round(row.ttl_ms / 60000)} 分钟）。等待其结束；确认占用进程已死后用 forceReleaseLineLock 释放。`,
			);
		}
		const now = nowIso();
		if (row && row.holder === holder) {
			this.db.prepare(`UPDATE line_locks SET renewed_at = ?, ttl_ms = ? WHERE line_id = ?`).run(now, ttlMs, lineId);
		} else {
			if (row) this.act("lock.steal", { lineId }, `旧持有者 ${row.holder} 心跳过期，由 ${holder} 接管`);
			this.db
				.prepare(
					`INSERT INTO line_locks (line_id, holder, pid, acquired_at, renewed_at, ttl_ms) VALUES (?, ?, ?, ?, ?, ?)
					 ON CONFLICT(line_id) DO UPDATE SET holder = excluded.holder, pid = excluded.pid,
					   acquired_at = excluded.acquired_at, renewed_at = excluded.renewed_at, ttl_ms = excluded.ttl_ms`,
				)
				.run(lineId, holder, process.pid, now, now, ttlMs);
			this.act(row ? "lock.steal_done" : "lock.acquire", { lineId }, holder);
		}
		return this.getLineLock(lineId)!;
	}

	/** 写入时顺带续期：只续自己持有的锁，锁不存在则静默跳过 */
	private touchLock(lineId: string): void {
		this.db
			.prepare(`UPDATE line_locks SET renewed_at = ? WHERE line_id = ? AND holder = ?`)
			.run(nowIso(), lineId, `pid:${process.pid}`);
	}

	renewLineLock(lineId: string, holder: string): boolean {
		const r = this.db
			.prepare(`UPDATE line_locks SET renewed_at = ? WHERE line_id = ? AND holder = ?`)
			.run(nowIso(), lineId, holder);
		return Number(r.changes) > 0;
	}

	releaseLineLock(lineId: string, holder: string, note?: string): boolean {
		const r = this.db.prepare(`DELETE FROM line_locks WHERE line_id = ? AND holder = ?`).run(lineId, holder);
		if (Number(r.changes) > 0) {
			this.act("lock.release", { lineId }, note ?? holder);
			return true;
		}
		return false;
	}

	/** 强制释放：仅用于确认占用进程已死的场景，动作进活动日志 */
	forceReleaseLineLock(lineId: string, note: string): boolean {
		const row = this.getLineLock(lineId);
		if (!row) return false;
		this.db.prepare(`DELETE FROM line_locks WHERE line_id = ?`).run(lineId);
		this.act("lock.force_release", { lineId }, `${row.holder} ${note}`);
		return true;
	}

	/** 线上既无进行中的 run 也无进行中的 worker 时释放锁 */
	maybeReleaseLineLock(lineId: string): boolean {
		const lock = this.getLineLock(lineId);
		if (!lock) return false;
		const runs = this.db
			.prepare(`SELECT COUNT(*) AS n FROM runs WHERE line_id = ? AND status = 'running'`)
			.get(lineId) as unknown as { n: number };
		const workers = this.db
			.prepare(`SELECT COUNT(*) AS n FROM workers WHERE line_id = ? AND status = 'running'`)
			.get(lineId) as unknown as { n: number };
		if (Number(runs.n) > 0 || Number(workers.n) > 0) return false;
		this.db.prepare(`DELETE FROM line_locks WHERE line_id = ?`).run(lineId);
		this.act("lock.release", { lineId }, "线内无进行中的 run 与 worker");
		return true;
	}

	// ---------- 活动日志 ----------

	listActivity(filter: { lineId?: string; runKey?: string; action?: string; limit?: number } = {}): ActivityRow[] {
		const conds: string[] = [];
		const params: (string | number)[] = [];
		if (filter.lineId) {
			conds.push("line_id = ?");
			params.push(filter.lineId);
		}
		if (filter.runKey) {
			conds.push("run_key = ?");
			params.push(filter.runKey);
		}
		if (filter.action) {
			conds.push("action = ?");
			params.push(filter.action);
		}
		const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
		const limit = Math.min(filter.limit ?? 50, 500);
		params.push(limit);
		const rows = this.db
			.prepare(`SELECT * FROM activity ${where} ORDER BY id DESC LIMIT ?`)
			.all(...params) as unknown as ActivityRow[];
		return rows.reverse();
	}
}
