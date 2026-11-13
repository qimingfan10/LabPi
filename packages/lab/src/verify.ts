import { join } from "node:path";
import { runPythonScript } from "./eval.ts";
import type { LabRegistry } from "./store.ts";

/**
 * 独立复核（选手不当裁判）：重跑 run 登记的评测命令，用脚本自己输出的结构化
 * 结果（RESULT_JSON）与账本指标比对。执行者上报的分数由评测脚本独立复算，
 * 对不上就落 mismatch——「看起来对」不等于「真的对」。
 */

export interface VerifyComparison {
	metric: string;
	ledger: number;
	rerun: number;
	diff: number;
	ok: boolean;
}

export interface VerifyResult {
	status: "verified" | "mismatch";
	comparisons: VerifyComparison[];
	/** 重跑输出里有、但账本没登记的指标（提醒，不算失败） */
	unrecorded: string[];
	rerunLog: string;
	note: string;
}

/** 从评测脚本 stdout 提取最后一行 RESULT_JSON */
export function parseResultJson(stdout: string): Record<string, unknown> {
	const lines = stdout.split("\n").reverse();
	for (const line of lines) {
		const idx = line.indexOf("RESULT_JSON:");
		if (idx >= 0) {
			return JSON.parse(line.slice(idx + "RESULT_JSON:".length).trim()) as Record<string, unknown>;
		}
	}
	throw new Error("重跑输出中没有 RESULT_JSON 行：评测脚本必须以「RESULT_JSON: {...}」输出结构化结果");
}

export async function verifyRun(
	registry: LabRegistry,
	cwd: string,
	runKey: string,
	opts: { tolerance?: number } = {},
): Promise<VerifyResult> {
	const run = registry.getRun(runKey);
	if (!run) throw new Error(`run 不存在: ${runKey}`);
	if (!run.eval_spec) {
		throw new Error(
			`run ${runKey} 没有登记评测复现命令：先用 lab_eval_run_python 执行评测（自动登记），独立复核才有可重跑的依据。`,
		);
	}
	const spec = JSON.parse(run.eval_spec) as {
		script: string;
		args?: string[];
		tolerance?: number;
		timeoutSec?: number;
	};
	const tolerance = opts.tolerance ?? spec.tolerance ?? 1e-6;

	const rerun = await runPythonScript(spec.script, spec.args ?? [], {
		timeoutMs: (spec.timeoutSec ?? 1800) * 1000,
		logDir: join(registry.runsRoot, runKey, "verify"),
		cwd,
	});
	if (!rerun.ok) {
		const note = `复核重跑失败（${rerun.reason}，exit=${rerun.exitCode}）：指标可信度存疑，需排查后重新验证。日志 ${rerun.logRelPath}`;
		registry.setVerification(runKey, "mismatch", note);
		return { status: "mismatch", comparisons: [], unrecorded: [], rerunLog: rerun.logRelPath, note };
	}

	let rerunMetrics: Record<string, unknown>;
	try {
		rerunMetrics = parseResultJson(rerun.stdout);
	} catch (err) {
		const note = `复核失败：${(err as Error).message}`;
		registry.setVerification(runKey, "mismatch", note);
		return { status: "mismatch", comparisons: [], unrecorded: [], rerunLog: rerun.logRelPath, note };
	}

	const ledgerMetrics = registry.listMetrics({ runKey });
	const comparisons: VerifyComparison[] = [];
	const notes: string[] = [];
	for (const m of ledgerMetrics) {
		const key = rerunMetrics[m.name] !== undefined ? m.name : m.name.split("@")[0];
		const value = rerunMetrics[key];
		if (value === undefined || typeof value !== "number") {
			comparisons.push({ metric: m.name, ledger: m.value, rerun: Number.NaN, diff: Number.NaN, ok: false });
			notes.push(`账本指标 ${m.name}=${m.value} 在重跑结果里找不到对应数值（执行者可能登记了脚本没产出的数）`);
			continue;
		}
		const diff = value - m.value;
		const ok = Math.abs(diff) <= tolerance;
		comparisons.push({ metric: m.name, ledger: m.value, rerun: value, diff, ok });
		if (!ok)
			notes.push(`${m.name}: 账本 ${m.value} vs 重跑 ${value}（差 ${diff.toFixed(6)}，超出容差 ${tolerance}）`);
	}
	const unrecorded = Object.keys(rerunMetrics).filter(
		(k) =>
			typeof rerunMetrics[k] === "number" && !ledgerMetrics.some((m) => m.name === k || m.name.split("@")[0] === k),
	);

	const ok = comparisons.length > 0 && comparisons.every((c) => c.ok);
	const status: "verified" | "mismatch" = ok ? "verified" : "mismatch";
	const note = ok
		? `独立复核通过：重跑 ${comparisons.length} 项指标全部一致（容差 ${tolerance}）${unrecorded.length ? `；未入账 ${unrecorded.join(", ")}` : ""}`
		: notes.join("；");
	registry.setVerification(runKey, status, note);
	return { status, comparisons, unrecorded, rerunLog: rerun.logRelPath, note };
}
