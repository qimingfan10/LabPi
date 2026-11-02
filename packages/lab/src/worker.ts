import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LabRegistry, WorkerRow } from "./store.ts";

/**
 * Router/worker process orchestration, adapted from the dsh-superagent ideas:
 * one worker process per direction, bound to one experiment line and one headless
 * pi session; the router only spawns and collects, never executes; concurrent
 * workers are capped (WorkerSlots); a worker that needs a human decision ends
 * blocked/failed and waits for the router.
 */

export interface SpawnWorkerOptions {
	registry: LabRegistry;
	/** Project root: worker's working directory and ledger location */
	cwd: string;
	lineId: string;
	/** Direction task for the worker to execute */
	task: string;
	maxWorkers?: number;
	/** Hard timeout for the worker process, default 60 minutes */
	timeoutMs?: number;
}

export interface SpawnWorkerResult {
	workerId: number;
	pid: number | undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Current pi invocation, replicated so both source-run and bundled forms spawn correctly. */
function currentPiInvocation(): { bin: string; args: string[] } {
	const argv1 = process.argv[1] ?? "";
	const execArgv = process.execArgv.filter((a) => !a.startsWith("--lab"));
	return { bin: process.execPath, args: [...execArgv, argv1] };
}

export function spawnLabWorker(opts: SpawnWorkerOptions): SpawnWorkerResult {
	if (process.env.LAB_NO_SPAWN === "1") {
		throw new Error("worker 进程内禁止再派生 worker（LAB_NO_SPAWN=1），避免进程树失控");
	}
	const max = opts.maxWorkers ?? 3;
	const running = opts.registry.countRunningWorkers();
	if (running >= max) {
		throw new Error(
			`活跃 worker 已达上限（${running}/${max}）。先 lab_worker_collect 收取已完成的 worker，或调高 maxWorkers。`,
		);
	}
	if (!opts.registry.getLine(opts.lineId)) {
		throw new Error(`实验线不存在: ${opts.lineId}`);
	}

	const { bin, args } = currentPiInvocation();
	const workerPrompt = [
		`你是绑定实验线「${opts.lineId}」的 worker，只执行该方向的任务。`,
		`纪律：所有实验操作先 lab_register_run 登记到线 ${opts.lineId}（line_id 必须用它，禁止写入其他线）；`,
		`结果必须用 lab_record_metric / lab_record_scenario_scores 登记；结束时把 run 收尾为 completed 或 failed（失败给 fail_class）。`,
		`需要人决策或环境不可用时，如实落 failed 并在 note 里说明，禁止编造数据。`,
		`最后输出一段简短总结（做了什么、指标是多少、结论）。`,
	].join("\n");

	const child: ChildProcess = spawn(
		bin,
		[...args, "--append-system-prompt", workerPrompt, "-p", opts.task],
		{
			cwd: opts.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, LAB_LINE_ID: opts.lineId, LAB_NO_SPAWN: "1" },
		},
	);

	const worker = opts.registry.addWorker(opts.lineId, opts.task, child.pid);
	const logPath = join(runsDir(opts.cwd, opts.lineId), `w${worker.id}.log`);
	mkdirSync(join(runsDir(opts.cwd, opts.lineId)), { recursive: true });

	let stdout = "";
	let stderr = "";
	let timedOut = false;
	child.stdout?.on("data", (d) => (stdout += d.toString()));
	child.stderr?.on("data", (d) => (stderr += d.toString()));

	const timeoutMs = opts.timeoutMs ?? 3_600_000;
	const timer = setTimeout(() => {
		timedOut = true;
		if (child.pid !== undefined) {
			if (process.platform === "win32") {
				spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
			} else {
				child.kill("SIGKILL");
			}
		}
	}, timeoutMs);

	child.on("error", (err) => {
		clearTimeout(timer);
		opts.registry.finishWorker(worker.id, "failed", `spawn error: ${err.message}`, null);
	});
	child.on("close", (code) => {
		clearTimeout(timer);
		writeFileSync(logPath, `# task: ${opts.task}\n${stdout}\n## STDERR\n${stderr}`, "utf-8");
		const tail = stdout.trim().split("\n").slice(-40).join("\n");
		const status = timedOut ? "failed" : code === 0 ? "reported" : "failed";
		const report = timedOut
			? `worker 超时被终止（${Math.round(timeoutMs / 60000)} 分钟）。部分输出：\n${tail}`
			: tail || stderr.trim().slice(-1000) || "(无输出)";
		opts.registry.finishWorker(worker.id, status, report, code);
	});

	return { workerId: worker.id, pid: child.pid };
}

function runsDir(cwd: string, lineId: string): string {
	return join(cwd, "runs", lineId, "workers");
}

export interface CollectedWorker {
	worker: WorkerRow;
	/** 该线在 worker 启动之后新登记的 run */
	newRuns: { run_key: string; status: string; model?: string }[];
	/** 新 run 上的指标 */
	newMetrics: { run_key: string; name: string; value: number; context?: string }[];
	/** 该线新增的判断 */
	newClaims: { id: number; statement: string; status: string }[];
}

/** 收取 worker：报告 + 该线在其生命周期内的账本增量（幂等，可重复收取） */
export function collectLabWorker(registry: LabRegistry, workerId: number): CollectedWorker {
	const worker = registry.getWorker(workerId);
	if (!worker) throw new Error(`worker 不存在: W${workerId}`);
	const runs = registry
		.listRuns(worker.line_id)
		.filter((r) => r.started_at >= worker.created_at);
	const metrics = runs.flatMap((r) =>
		registry.listMetrics({ runKey: r.run_key }).map((m) => ({
			run_key: r.run_key,
			name: m.name,
			value: m.value,
			context: m.context,
		})),
	);
	const claims = registry
		.listClaims({ lineId: worker.line_id })
		.filter((c) => c.created_at >= worker.created_at);
	return {
		worker,
		newRuns: runs.map((r) => ({ run_key: r.run_key, status: r.status, model: r.model })),
		newMetrics: metrics,
		newClaims: claims.map((c) => ({ id: c.id, statement: c.statement, status: c.status })),
	};
}

/** 路由视图：全部 worker 的状态一览 */
export function workerStatusView(registry: LabRegistry): string {
	const workers = registry.listWorkers();
	if (workers.length === 0) return "(no workers)";
	return workers
		.map((w) => {
			const report = w.report ? `  report: ${w.report.split("\n").at(-1)?.slice(0, 120)}` : "";
			return `W${w.id} [${w.status}] line=${w.line_id} task=${w.task.slice(0, 60)}${report}`;
		})
		.join("\n");
}

export { sleep };
