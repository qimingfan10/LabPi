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

export interface RunInput {
	lineId: string;
	title?: string;
	stage?: string;
	model?: string;
	endpoint?: string;
	config?: unknown;
	note?: string;
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
`;

export class LabRegistry {
	readonly db: DatabaseSync;
	readonly runsRoot: string;

	constructor(opts: { dbPath: string; runsRoot: string }) {
		mkdirSync(opts.runsRoot, { recursive: true });
		this.runsRoot = opts.runsRoot;
		this.db = new DatabaseSync(opts.dbPath);
		this.db.exec("PRAGMA journal_mode = WAL;");
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
		add("metrics", "revision", "revision INTEGER NOT NULL DEFAULT 1");
		add("metrics", "superseded_by", "superseded_by INTEGER");
		add("metrics", "revise_reason", "revise_reason TEXT");
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
                           config_fingerprint, status, note, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
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

	setVerification(runKey: string, status: "verified" | "mismatch" | "unverified", note: string): RunRow {
		const run = this.getRun(runKey);
		if (!run) throw new Error(`run 不存在: ${runKey}`);
		this.db
			.prepare(`UPDATE runs SET verification = ?, verification_note = ?, verified_at = ? WHERE run_key = ?`)
			.run(status, note, nowIso(), runKey);
		this.act("run.verify", { lineId: run.line_id, runKey }, `${status}: ${note}`);
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
