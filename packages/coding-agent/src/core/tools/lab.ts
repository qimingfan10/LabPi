import { Type, type Static, type TSchema } from "typebox";
import { join } from "node:path";
import {
	LabRegistry,
	compareLines,
	compareScenarios,
	experimentBrief,
	filterByDifficultyBand,
	poolStats,
	recallMetrics,
	runPythonScript,
	spawnLabWorker,
	validatePoolRows,
	workerStatusView,
	collectLabWorker,
} from "@earendil-works/pi-lab";
import type { ToolDefinition } from "../extensions/types.ts";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

/**
 * Built-in research-experiment tools: the lab ledger (experiment lines, runs, metrics,
 * artifacts, evidence-linked claims). The completion gate is enforced in
 * agent-session's beforeToolCall. Ledger lives under <cwd>/runs/.
 */

export const LAB_TOOL_NAMES = [
	"lab_create_line",
	"lab_fork_line",
	"lab_register_run",
	"lab_update_run",
	"lab_record_metric",
	"lab_query_runs",
	"lab_query_metrics",
	"lab_experiment_brief",
	"lab_record_scenario_scores",
	"lab_compare_lines",
	"lab_compare_runs",
	"lab_record_claim",
	"lab_list_claims",
	"lab_resolve_claim",
	"lab_pool_validate",
	"lab_pool_filter",
	"lab_pool_stats",
	"lab_eval_run_python",
	"lab_worker_spawn",
	"lab_worker_status",
	"lab_worker_collect",
] as const;

let registry: LabRegistry | undefined;

export function getLabRegistry(cwd: string): LabRegistry {
	if (!registry) {
		const runsRoot = join(cwd, "runs");
		registry = new LabRegistry({ dbPath: join(runsRoot, "lab.db"), runsRoot });
	}
	return registry;
}

function text(result: string): AgentToolResult<undefined> {
	return { content: [{ type: "text", text: result }], details: undefined };
}

function json(result: unknown): AgentToolResult<undefined> {
	return text(JSON.stringify(result, null, 2));
}

type LabToolDef<T extends TSchema = TSchema> = ToolDefinition<T, undefined>;

function defineTool<T extends TSchema>(def: LabToolDef<T>): LabToolDef<T> {
	return def;
}

function claimConflicts(
	reg: LabRegistry,
	metric: string,
	lineA: string,
	lineB: string,
	meanDiff: number,
): string[] {
	const out: string[] = [];
	for (const claim of reg.listClaims({ status: "open" })) {
		if (!claim.check_json) continue;
		let check: { metric: string; lineA: string; lineB: string; direction: string };
		try {
			check = JSON.parse(claim.check_json) as typeof check;
		} catch {
			continue;
		}
		if (check.metric !== metric) continue;
		const samePair =
			(check.lineA === lineA && check.lineB === lineB) ||
			(check.lineA === lineB && check.lineB === lineA);
		if (!samePair || meanDiff === 0) continue;
		const claimSaysABigger =
			check.direction === "A>B" ? check.lineA === lineA : check.lineA === lineB;
		const diffSaysABigger = meanDiff > 0;
		if (claimSaysABigger !== diffSaysABigger) {
			out.push(
				`This result conflicts with open claim C${claim.id} "${claim.statement}" (it asserts the opposite direction). If this data is trustworthy, resolve_claim C${claim.id} as refuted with evidence; if measurement conditions differ, say so.`,
			);
		}
	}
	return out;
}

/** Slash-command formatters (read-only ledger views). */
export function labCommandLines(reg: LabRegistry): string {
	const lines = reg.listLines();
	if (lines.length === 0) return "(ledger empty: no experiment lines yet)";
	return lines
		.map((l) => {
			const runs = reg.listRuns(l.id);
			const done = runs.filter((r) => r.status === "completed").length;
			const running = runs.filter((r) => r.status === "running").length;
			const stat = `${runs.length} run(s)${running ? `, ${running} running` : ""}${done ? `, ${done} completed` : ""}`;
			return `${l.id.padEnd(16)} ${l.status.padEnd(8)} ${stat}${l.parent_line ? `  fork<-${l.parent_line}` : ""}${l.title ? `  ${l.title}` : ""}`;
		})
		.join("\n");
}

export function labCommandRuns(reg: LabRegistry, lineId?: string): string {
	const runs = reg.listRuns(lineId);
	if (runs.length === 0) return "(no runs)";
	return runs
		.map(
			(r) =>
				`${r.run_key.padEnd(20)} ${r.status.padEnd(10)} ${(r.stage ?? "-").padEnd(6)} model=${r.model ?? "-"} endpoint=${r.endpoint ?? "-"}${r.fail_class ? ` fail=${r.fail_class}` : ""}`,
		)
		.join("\n");
}

export function labCommandClaims(reg: LabRegistry, status?: string): string {
	const claims = reg.listClaims({ status });
	if (claims.length === 0) return "(no matching claims)";
	return claims
		.map((cl) => {
			const ev = cl.evidence ? `  evidence: ${cl.evidence}` : "";
			const note = cl.verdict_note ? `  note: ${cl.verdict_note}` : "";
			return `C${cl.id} [${cl.status}] ${cl.statement}${ev}${note}`;
		})
		.join("\n");
}

/**
 * Completion gate, enforced in agent-session's beforeToolCall ahead of the extension runner:
 * a run cannot be marked completed without any recorded metric — conclusions must carry
 * evidence, and results can only be recorded onto existing runs.
 */
export function labBeforeToolCheck(
	cwd: string,
	toolName: string,
	args: unknown,
): { block: true; reason: string } | undefined {
	const a = (args ?? {}) as { run_key?: string; status?: string; line_id?: string };
	// 线绑定：worker 进程只能写自己绑定的实验线（单一写入者）
	const boundLine = process.env.LAB_LINE_ID;
	if (boundLine) {
		if (toolName === "lab_register_run" && a.line_id !== undefined && a.line_id !== boundLine) {
			return {
				block: true,
				reason: `本进程是绑定实验线「${boundLine}」的 worker：禁止把 run 登记到其他线（${a.line_id}）。这是单一写入者约束，保证各方向数据不混杂。`,
			};
		}
		if (toolName === "lab_fork_line" || toolName === "lab_worker_spawn") {
			return {
				block: true,
				reason: "worker 进程不做路由操作（分叉实验线或派生 worker 由 router 会话执行）。",
			};
		}
	}
	if (toolName === "lab_update_run" && a.status === "completed" && a.run_key) {
		const run = getLabRegistry(cwd).getRun(a.run_key);
		if (!run) {
			return { block: true, reason: `Run ${a.run_key} does not exist; cannot mark completed.` };
		}
		const metrics = getLabRegistry(cwd).listMetrics({ runKey: a.run_key });
		if (metrics.length === 0) {
			return {
				block: true,
				reason:
					"Completion gate: this run has no recorded metrics, so it cannot be marked completed — conclusions must carry evidence. Record results first with lab_record_metric or lab_record_scenario_scores; if the experiment truly produced nothing, use status=failed with a fail_class and an explanation instead.",
			};
		}
	}
	if (
		(toolName === "lab_record_metric" || toolName === "lab_record_scenario_scores") &&
		a.run_key &&
		!getLabRegistry(cwd).getRun(a.run_key)
	) {
		return {
			block: true,
			reason: `Run ${a.run_key} does not exist. Register the experiment with lab_register_run first; results can only be recorded onto existing runs.`,
		};
	}
	return undefined;
}

/**
 * State card, injected before every LLM call via the transformContext chain:
 * current line, running runs, open claims. Regenerated each turn, so it survives
 * context compaction by construction. Returns undefined when the ledger is empty.
 */
export function buildLabStateCard(cwd: string): string | undefined {
	const reg = getLabRegistry(cwd);
	const lines = reg.listLines();
	if (lines.length === 0) return undefined;
	const running = reg.listRuns().filter((r) => r.status === "running");
	const open = reg.listClaims({ status: "open" });
	const parts = [
		"[Lab state card · injected by the harness every turn, no need to repeat it]",
	];
	const lastLine = lines.at(-1);
	if (lastLine) parts.push(`Current line: ${lastLine.id} (${lines.length} lines total)`);
	parts.push(
		`Running runs: ${running.length ? running.map((r) => r.run_key).join(", ") : "none"}`,
	);
	parts.push(
		open.length
			? `Open claims (verify before citing; refuted ones must not be cited as fact): ${open
					.map((cl) => `C${cl.id} ${cl.statement}`)
					.join("; ")}`
			: "Open claims: none",
	);
	const workers = reg.listWorkers();
	const runningW = workers.filter((w) => w.status === "running");
	const awaiting = workers.filter((w) => w.status !== "running");
	parts.push(
		workers.length === 0
			? "Workers: none"
			: `Workers: ${runningW.length} running${runningW.length ? ` (${runningW.map((w) => `W${w.id}@${w.line_id}`).join(", ")})` : ""}` +
				(awaiting.length ? `; ${awaiting.length} finished awaiting collect (${awaiting.map((w) => `W${w.id}`).join(", ")})` : ""),
	);
	return parts.join("\n");
}

export function createLabToolDefinitions(cwd: string): LabToolDef[] {
	const reg = () => getLabRegistry(cwd);
	const runsDir = () => join(cwd, "runs");

	return [
		defineTool({
			name: "lab_create_line",
			label: "Create experiment line",
			description:
				"Create an experiment line (top-level container for a research thread). Runs belong to lines.",
			parameters: Type.Object({
				id: Type.String({ description: "Line id, slug form, e.g. baseline" }),
				title: Type.Optional(Type.String()),
				note: Type.Optional(Type.String()),
			}),
			async execute(_id, params) {
				const line = reg().createLine(params.id, { title: params.title, note: params.note });
				return json(line);
			},
		}),
		defineTool({
			name: "lab_fork_line",
			label: "Fork experiment line",
			description:
				"Fork a new experiment line from an existing line or run, inheriting configuration and metric history. Use for parallel research threads.",
			parameters: Type.Object({
				new_id: Type.String({ description: "New line id" }),
				from_line: Type.Optional(Type.String()),
				from_run: Type.Optional(Type.String({ description: "run_key; either this or from_line" })),
				note: Type.Optional(Type.String({ description: "Why the fork exists and what differs" })),
			}),
			async execute(_id, params) {
				if (!params.from_line && !params.from_run) {
					return text("Error: provide from_line or from_run");
				}
				const { line, inheritedRuns } = reg().forkLine(
					params.new_id,
					{ lineId: params.from_line, runKey: params.from_run },
					params.note,
				);
				return json({ line, inheritedRuns });
			},
		}),
		defineTool({
			name: "lab_register_run",
			label: "Register experiment run",
			description:
				"Register an experiment run: creates the runs/<run_key>/ artifact directory (config.json, logs, results) and records a config fingerprint. Required before recording any results.",
			parameters: Type.Object({
				line_id: Type.String(),
				title: Type.Optional(Type.String()),
				stage: Type.Optional(Type.String({ description: "eval, train, screen, ..." })),
				model: Type.Optional(Type.String({ description: "Model under test" })),
				endpoint: Type.Optional(Type.String({ description: "Judge or serving endpoint name" })),
				config: Type.Optional(
					Type.Unknown({ description: "Experiment config object (hyperparams, judge settings, pool version)" }),
				),
				note: Type.Optional(Type.String()),
			}),
			promptSnippet:
				"lab_register_run: register an experiment run in the ledger (do this before running any evaluation)",
			promptGuidelines: [
				"Register every experiment with lab_register_run before running it; record results with lab_record_metric or lab_record_scenario_scores; never claim results without ledger evidence.",
			],
			async execute(_id, params) {
				const run = reg().registerRun({
					lineId: params.line_id,
					title: params.title,
					stage: params.stage,
					model: params.model,
					endpoint: params.endpoint,
					config: params.config,
					note: params.note,
				});
				return json(run);
			},
		}),
		defineTool({
			name: "lab_update_run",
			label: "Update run status",
			description:
				"Update run status. Failures must carry a fail_class: infra_error (endpoint/environment), format_violation (malformed output), semantic_fail (semantically wrong). Silent failures are forbidden.",
			parameters: Type.Object({
				run_key: Type.String(),
				status: Type.Optional(
					Type.Union([
						Type.Literal("running"),
						Type.Literal("completed"),
						Type.Literal("failed"),
						Type.Literal("cancelled"),
					]),
				),
				fail_class: Type.Optional(
					Type.Union([
						Type.Literal("infra_error"),
						Type.Literal("format_violation"),
						Type.Literal("semantic_fail"),
					]),
				),
				note: Type.Optional(Type.String()),
			}),
			async execute(_id, params) {
				const run = reg().updateRun(params.run_key, {
					status: params.status,
					failClass: params.fail_class,
					note: params.note,
				});
				return json(run);
			},
		}),
		defineTool({
			name: "lab_record_metric",
			label: "Record metric",
			description:
				"Record a metric value for a run with stage and measurement context. Metrics enter the experiment memory and carry endpoint/model conditions.",
			parameters: Type.Object({
				run_key: Type.String(),
				name: Type.String({ description: "Metric name, e.g. weakness_total" }),
				value: Type.Number(),
				stage: Type.Optional(Type.String()),
				context: Type.Optional(Type.String({ description: "Units and measurement conditions" })),
			}),
			promptSnippet: "lab_record_metric: record an experiment metric into the ledger",
			async execute(_id, params) {
				const metric = reg().recordMetric(params.run_key, params.name, params.value, {
					stage: params.stage,
					context: params.context,
				});
				return json(metric);
			},
		}),
		defineTool({
			name: "lab_query_runs",
			label: "Query runs",
			description: "List runs, optionally filtered by experiment line.",
			parameters: Type.Object({
				line_id: Type.Optional(Type.String()),
			}),
			async execute(_id, params) {
				return json(reg().listRuns(params.line_id));
			},
		}),
		defineTool({
			name: "lab_query_metrics",
			label: "Query metrics",
			description:
				"Search the experiment memory for metric trajectories filtered by line, metric name, stage, or run. Results carry model and endpoint conditions.",
			parameters: Type.Object({
				line_id: Type.Optional(Type.String()),
				name: Type.Optional(Type.String()),
				stage: Type.Optional(Type.String()),
				run_key: Type.Optional(Type.String()),
			}),
			async execute(_id, params) {
				return text(
					recallMetrics(reg(), {
						lineId: params.line_id,
						name: params.name,
						stage: params.stage,
						runKey: params.run_key,
					}),
				);
			},
		}),
		defineTool({
			name: "lab_experiment_brief",
			label: "Experiment brief",
			description:
				"Rebuild full awareness of an experiment line: runs, metric trajectories, fork relations, open items. Use when resuming work on a line.",
			parameters: Type.Object({
				line_id: Type.String(),
			}),
			promptSnippet: "lab_experiment_brief: rebuild awareness of an experiment line",
			async execute(_id, params) {
				return text(experimentBrief(reg(), params.line_id));
			},
		}),
		defineTool({
			name: "lab_record_scenario_scores",
			label: "Record scenario scores",
			description:
				"Write per-scenario scores to the run's results/per_scenario.json artifact and record the aggregate metric. Paired significance tests depend on this artifact.",
			parameters: Type.Object({
				run_key: Type.String(),
				metric_name: Type.String({ description: "Aggregate metric name, e.g. weakness_total" }),
				scores: Type.Array(Type.Object({ scenario_id: Type.String(), score: Type.Number() })),
				context: Type.Optional(Type.String()),
			}),
			async execute(_id, params) {
				reg().attachJsonArtifact(params.run_key, "results/per_scenario.json", params.scores);
				const values = params.scores.map((s) => s.score);
				const mean = values.reduce((a, b) => a + b, 0) / values.length;
				const metric = reg().recordMetric(params.run_key, params.metric_name, mean, {
					stage: "eval",
					context: params.context,
				});
				return json({ artifact: "results/per_scenario.json", n: values.length, metric });
			},
		}),
		defineTool({
			name: "lab_compare_lines",
			label: "Compare experiment lines",
			description:
				"Compare two experiment lines: run/metric trajectory side-by-side plus paired tests on shared metrics. Metrics measured under different endpoints are never mixed; results are automatically checked against open claims.",
			parameters: Type.Object({
				line_a: Type.String(),
				line_b: Type.String(),
			}),
			async execute(_id, params) {
				const cmp = compareLines(reg(), params.line_a, params.line_b);
				const conflicts = cmp.metricComparisons.flatMap((mc) =>
					claimConflicts(reg(), mc.metric.split("@")[0], params.line_a, params.line_b, mc.test.meanDiff),
				);
				return json({ ...cmp, claimConflicts: conflicts });
			},
		}),
		defineTool({
			name: "lab_compare_runs",
			label: "Paired scenario test",
			description:
				"Read the per-scenario score artifacts of two runs, pair by scenario_id, run Wilcoxon signed-rank and paired t tests. Automatically checked against open claims.",
			parameters: Type.Object({
				run_a: Type.String(),
				run_b: Type.String(),
			}),
			async execute(_id, params) {
				const cmp = compareScenarios(reg(), params.run_a, params.run_b);
				const runA = reg().getRun(params.run_a);
				const runB = reg().getRun(params.run_b);
				const conflicts =
					runA && runB
						? claimConflicts(reg(), "weakness_total", runA.line_id, runB.line_id, cmp.test.meanDiff)
						: [];
				return json({
					n: cmp.n,
					meanDiff: cmp.test.meanDiff,
					win: cmp.test.win,
					tie: cmp.test.tie,
					loss: cmp.test.loss,
					wilcoxon: cmp.test.wilcoxon,
					pairedT: cmp.test.pairedT,
					claimConflicts: conflicts,
				});
			},
		}),
		defineTool({
			name: "lab_record_claim",
			label: "Record research claim",
			description:
				"Register a research claim with evidence references (run keys, artifact paths, other claim ids). Claims enter the state card; optionally attach a structured direction check so comparisons auto-verify it. Refuted claims must no longer be cited as fact.",
			parameters: Type.Object({
				statement: Type.String({ description: "The claim in one sentence" }),
				line_id: Type.Optional(Type.String()),
				evidence: Type.Optional(Type.Array(Type.String())),
				check: Type.Optional(
					Type.Object({
						metric: Type.String(),
						line_a: Type.String(),
						line_b: Type.String(),
						direction: Type.Union([Type.Literal("A>B"), Type.Literal("B>A")]),
					}),
				),
			}),
			promptSnippet:
				"lab_record_claim: register a research claim with evidence (claims are auto-checked against future comparisons)",
			promptGuidelines: [
				"Research claims must be registered with lab_record_claim and carry evidence; a claim contradicted by later comparisons must be resolved (refuted) before it can be dropped, and refuted claims must not be cited as fact.",
			],
			async execute(_id, params) {
				const claim = reg().addClaim({
					statement: params.statement,
					lineId: params.line_id,
					evidence: params.evidence,
					check: params.check
						? {
								metric: params.check.metric,
								lineA: params.check.line_a,
								lineB: params.check.line_b,
								direction: params.check.direction,
							}
						: undefined,
				});
				return json({
					claim: `C${claim.id}`,
					status: claim.status,
					note: "Claim is on the state card from now on; comparisons auto-verify direction when check is set",
				});
			},
		}),
		defineTool({
			name: "lab_list_claims",
			label: "List claims",
			description: "List research claims and their status (open / supported / refuted).",
			parameters: Type.Object({
				status: Type.Optional(
					Type.Union([Type.Literal("open"), Type.Literal("supported"), Type.Literal("refuted")]),
				),
				line_id: Type.Optional(Type.String()),
			}),
			async execute(_id, params) {
				const claims = reg().listClaims({ status: params.status, lineId: params.line_id });
				if (claims.length === 0) return text("(no matching claims)");
				return text(
					claims
						.map((cl) => {
							const ev = cl.evidence ? `  evidence: ${cl.evidence}` : "";
							const note = cl.verdict_note ? `  note: ${cl.verdict_note}` : "";
							return `C${cl.id} [${cl.status}] ${cl.statement}${ev}${note}`;
						})
						.join("\n"),
				);
			},
		}),
		defineTool({
			name: "lab_resolve_claim",
			label: "Resolve claim",
			description:
				"Settle a claim against new evidence: supported or refuted. A refuted claim loses its license to be cited as fact.",
			parameters: Type.Object({
				id: Type.Number({ description: "Claim number without the C prefix" }),
				verdict: Type.Union([Type.Literal("supported"), Type.Literal("refuted")]),
				note: Type.Optional(Type.String({ description: "Basis for the verdict" })),
			}),
			async execute(_id, params) {
				return json(reg().resolveClaim(params.id, params.verdict, params.note));
			},
		}),
		defineTool({
			name: "lab_pool_validate",
			label: "Validate task pool",
			description:
				"Validate a task-pool jsonl against the schema (scenario required, rubrics and difficulty metadata shape).",
			parameters: Type.Object({
				path: Type.String({ description: "Task pool jsonl path" }),
			}),
			async execute(_id, params) {
				return json(validatePoolRows(join(cwd, params.path)));
			},
		}),
		defineTool({
			name: "lab_pool_filter",
			label: "Difficulty band filter",
			description:
				"Filter a task pool by measured pass rate: keep tasks within [keep_min, keep_max], dropping both all-pass and all-fail tasks.",
			parameters: Type.Object({
				path: Type.String(),
				out_path: Type.String({ description: "Output jsonl path" }),
				keep_min: Type.Number(),
				keep_max: Type.Number(),
			}),
			async execute(_id, params) {
				const { readFileSync, writeFileSync } = await import("node:fs");
				const rows = JSON.parse(readFileSync(join(cwd, params.path), "utf-8")) as import("@earendil-works/pi-lab").PoolRow[];
				const kept = filterByDifficultyBand(rows, params.keep_min, params.keep_max);
				writeFileSync(
					join(cwd, params.out_path),
					kept.map((r) => JSON.stringify(r)).join("\n") + "\n",
					"utf-8",
				);
				return json({ input: rows.length, kept: kept.length, out: params.out_path });
			},
		}),
		defineTool({
			name: "lab_pool_stats",
			label: "Task pool stats",
			description: "Difficulty distribution and dimension coverage of a task pool.",
			parameters: Type.Object({
				path: Type.String(),
			}),
			async execute(_id, params) {
				return json(poolStats(join(cwd, params.path)));
			},
		}),
		defineTool({
			name: "lab_eval_run_python",
			label: "Run evaluation script",
			description:
				"Run a Python evaluation script as a separate process with a hard timeout; stdout is archived under the run's logs/. Timeouts and crashes are classified infra_error.",
			parameters: Type.Object({
				run_key: Type.String(),
				script: Type.String({ description: "Python script path (relative to project root)" }),
				args: Type.Optional(Type.Array(Type.String())),
				timeout_sec: Type.Optional(Type.Number({ description: "Hard timeout seconds, default 1800" })),
			}),
			async execute(_id, params) {
				const result = await runPythonScript(params.script, params.args ?? [], {
					timeoutMs: (params.timeout_sec ?? 1800) * 1000,
					logDir: join(runsDir(), params.run_key, "logs"),
					cwd,
				});
				if (result.ok) {
					reg().attachArtifact(params.run_key, result.logRelPath, "log");
					return json({
						ok: true,
						exitCode: result.exitCode,
						log: result.logRelPath,
						stdoutTail: result.stdout.slice(-1500),
					});
				}
				return json({
					ok: false,
					failClass: "infra_error",
					reason: result.reason,
					exitCode: result.exitCode,
					log: result.logRelPath,
					stderrTail: result.stderr.slice(-500),
				});
			},
		}),
		defineTool({
			name: "lab_worker_spawn",
			label: "Spawn direction worker",
			description:
				"Spawn a headless pi worker process bound to one experiment line to execute one direction autonomously (own session, own directory, ledger writes locked to that line). The router spawns and collects; it does not execute. Concurrency is capped.",
			parameters: Type.Object({
				line_id: Type.String({ description: "Experiment line the worker is bound to" }),
				task: Type.String({ description: "Direction task: what the worker should try and record" }),
				max_workers: Type.Optional(Type.Number({ description: "Concurrency cap, default 3" })),
				timeout_min: Type.Optional(Type.Number({ description: "Hard timeout minutes, default 60" })),
			}),
			promptGuidelines: [
				"Multi-direction experiments: spawn one lab_worker_spawn per direction bound to its own forked line, keep working on router-side tasks, then lab_worker_collect each worker and compare directions with lab_compare_lines.",
			],
			async execute(_id, params) {
				const result = spawnLabWorker({
					registry: reg(),
					cwd,
					lineId: params.line_id,
					task: params.task,
					maxWorkers: params.max_workers,
					timeoutMs: (params.timeout_min ?? 60) * 60_000,
				});
				return json({
					worker: `W${result.workerId}`,
					pid: result.pid,
					note: "worker 已后台启动（独立会话与目录，账本写入锁定该线）。继续 router 侧工作，稍后用 lab_worker_status 查看、lab_worker_collect 收取报告与账本增量。",
				});
			},
		}),
		defineTool({
			name: "lab_worker_status",
			label: "Worker status view",
			description: "Router view of all worker processes: status, bound line, task, and latest report line.",
			parameters: Type.Object({}),
			async execute(_id) {
				return text(workerStatusView(reg()));
			},
		}),
		defineTool({
			name: "lab_worker_collect",
			label: "Collect worker report",
			description:
				"Collect a finished worker: its report plus the ledger delta of its bound line (new runs, metrics, claims created during its lifetime). Idempotent; use this to decide adopt / respawn / abandon.",
			parameters: Type.Object({
				worker_id: Type.Number({ description: "Worker number without the W prefix" }),
			}),
			async execute(_id, params) {
				return json(collectLabWorker(reg(), params.worker_id));
			},
		}),
	];
}
