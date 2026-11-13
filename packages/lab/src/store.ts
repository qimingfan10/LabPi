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
			if (patch.status === "failed") this.noteLineFailure(run.line_id, patch.failClass ?? null);
			if (patch.status === "completed") this.resetLineFailures(run.line_id);
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
		return this.getLine(lineId)!;
	}

	/** 记录评测复现命令：独立复核据此重跑，执行者不能自证 */
	setRunEvalSpec(
		runKey: string,
		spec: { script: string; args?: string[]; tolerance?: number; timeoutSec?: number },
	): RunRow {
		if (!this.getRun(runKey)) throw new Error(`run 不存在: ${runKey}`);
		this.db.prepare(`UPDATE runs SET eval_spec = ? WHERE run_key = ?`).run(JSON.stringify(spec), runKey);
		return this.getRun(runKey)!;
	}

	setVerification(
		runKey: string,
		status: "verified" | "mismatch" | "unverified",
		note: string,
	): RunRow {
		if (!this.getRun(runKey)) throw new Error(`run 不存在: ${runKey}`);
		this.db
			.prepare(`UPDATE runs SET verification = ?, verification_note = ?, verified_at = ? WHERE run_key = ?`)
			.run(status, note, nowIso(), runKey);
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
			return this.getMetric(newId);
		}
		this.db
			.prepare(`INSERT INTO metrics (run_key, name, value, stage, context, recorded_at) VALUES (?, ?, ?, ?, ?, ?)`)
			.run(runKey, name, value, opts.stage ?? null, opts.context ?? null, nowIso());
		const row = this.db
			.prepare(`SELECT * FROM metrics WHERE run_key = ? AND name = ? ORDER BY id DESC LIMIT 1`)
			.get(runKey, name) as unknown as MetricRow;
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
		if (!this.getRun(runKey)) throw new Error(`run 不存在: ${runKey}`);
		const abs = join(this.runDir(runKey), relPath);
		const checksum = shortHash(readFileSync(abs).toString("base64"));
		this.db
			.prepare(`INSERT INTO artifacts (run_key, rel_path, kind, checksum, recorded_at) VALUES (?, ?, ?, ?, ?)`)
			.run(runKey, relPath, kind, checksum, nowIso());
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
		return this.db.prepare(`SELECT * FROM claims ORDER BY id DESC LIMIT 1`).get() as unknown as ClaimRow;
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
		return this.getClaim(id)!;
	}

	// ---------- workers（router/worker 编排）----------

	addWorker(lineId: string, task: string, pid?: number): WorkerRow {
		if (!this.getLine(lineId)) throw new Error(`实验线不存在: ${lineId}`);
		this.db
			.prepare(`INSERT INTO workers (line_id, task, status, pid, created_at) VALUES (?, ?, 'running', ?, ?)`)
			.run(lineId, task, pid ?? null, nowIso());
		return this.db.prepare(`SELECT * FROM workers ORDER BY id DESC LIMIT 1`).get() as unknown as WorkerRow;
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
		this.db
			.prepare(`UPDATE workers SET status = ?, report = ?, exit_code = ?, finished_at = ? WHERE id = ?`)
			.run(status, report, exitCode, nowIso(), id);
		return this.getWorker(id)!;
	}
}
