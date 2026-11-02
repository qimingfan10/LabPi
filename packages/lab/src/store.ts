import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nowIso, shortHash, stableStringify } from "./fingerprint.ts";

export interface LineRow {
  id: string;
  title?: string;
  parent_line?: string;
  forked_from_run?: string;
  status: string;
  note?: string;
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
}

export type FailClass = "infra_error" | "format_violation" | "semantic_fail";

type SqlRow = Record<string, unknown>;

function asRows<T>(rows: SqlRow[]): T[] {
  return rows as unknown as T[];
}

function asRow<T>(row: SqlRow | undefined): T | undefined {
  return row as unknown as T | undefined;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lines (
  id TEXT PRIMARY KEY,
  title TEXT,
  parent_line TEXT,
  forked_from_run TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT,
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
    if (!this.getLine(input.lineId)) throw new Error(`实验线不存在: ${input.lineId}`);
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

  updateRun(
    runKey: string,
    patch: { status?: string; failClass?: FailClass | null; note?: string },
  ): RunRow {
    const run = this.getRun(runKey);
    if (!run) throw new Error(`run 不存在: ${runKey}`);
    this.db
      .prepare(`UPDATE runs SET status = ?, fail_class = ?, note = ?, finished_at = ? WHERE run_key = ?`)
      .run(
        patch.status ?? run.status,
        patch.failClass === undefined ? (run.fail_class ?? null) : (patch.failClass ?? null),
        patch.note ?? (run.note ?? null),
        patch.status && patch.status !== "running" ? (nowIso() as string) : (run.finished_at ?? null),
        runKey,
      );
    return this.getRun(runKey) as RunRow;
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
    this.db
      .prepare(`INSERT INTO metrics (run_key, name, value, stage, context, recorded_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(runKey, name, value, opts.stage ?? null, opts.context ?? null, nowIso());
    const row = this.db
      .prepare(`SELECT * FROM metrics WHERE run_key = ? AND name = ? ORDER BY id DESC LIMIT 1`)
      .get(runKey, name) as unknown as MetricRow;
    return row;
  }

  listMetrics(filter: { lineId?: string; runKey?: string; name?: string; stage?: string } = {}): MetricRow[] {
    const conds: string[] = [];
    const params: string[] = [];
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
        input.evidence && input.evidence.length ? JSON.stringify(input.evidence) : null,
        input.check ? JSON.stringify(input.check) : null,
        nowIso(),
      );
    return this.db
      .prepare(`SELECT * FROM claims ORDER BY id DESC LIMIT 1`)
      .get() as unknown as ClaimRow;
  }

  getClaim(id: number): ClaimRow | undefined {
    return this.db.prepare(`SELECT * FROM claims WHERE id = ?`).get(id) as unknown as ClaimRow | undefined;
  }

  listClaims(filter: { status?: string; lineId?: string } = {}): ClaimRow[] {
    const conds: string[] = [];
    const params: string[] = [];
    if (filter.status) { conds.push("status = ?"); params.push(filter.status); }
    if (filter.lineId) { conds.push("line_id = ?"); params.push(filter.lineId); }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM claims ${where} ORDER BY id`)
      .all(...params) as unknown as ClaimRow[];
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
    if (filter.lineId) { conds.push("line_id = ?"); params.push(filter.lineId); }
    if (filter.status) { conds.push("status = ?"); params.push(filter.status); }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM workers ${where} ORDER BY id`)
      .all(...params) as unknown as WorkerRow[];
  }

  countRunningWorkers(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM workers WHERE status = 'running'`)
      .get() as unknown as { n: number };
    return Number(row.n);
  }

  finishWorker(id: number, status: "reported" | "failed", report: string, exitCode: number | null): WorkerRow {
    this.db
      .prepare(`UPDATE workers SET status = ?, report = ?, exit_code = ?, finished_at = ? WHERE id = ?`)
      .run(status, report, exitCode, nowIso(), id);
    return this.getWorker(id)!;
  }
}
