import { join } from "node:path";
import { runPythonScript } from "./eval.ts";
import { parseResultJson } from "./verify.ts";
import type { EvaluatorRow, LabRegistry } from "./store.ts";

/**
 * 裁判审计：改进信号的上限由裁判质量决定，这里做两件可量化的事——
 * 噪声底实测（同配置重复 run 的标准差）与评测器分辨力审计
 * （确定性复跑 + 故障脚本探针：坏了却测不出，就是漏检）。
 */

export interface NoiseFloorResult {
	evaluatorId?: string;
	metric: string;
	status: "ok" | "insufficient";
	n: number;
	mean: number;
	sd: number;
	runKeys: string[];
	note: string;
}

function mean(xs: number[]): number {
	return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function sd(xs: number[]): number {
	if (xs.length < 2) return 0;
	const m = mean(xs);
	return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/**
 * 噪声底：取同一 config_fingerprint 下已验证 run 的指标值，
 * 用最大同配置组的样本标准差作为"增益必须超过"的基线。
 */
export function computeNoiseFloor(
	reg: LabRegistry,
	opts: { lineId: string; metric: string; minRuns?: number; evaluatorId?: string },
): NoiseFloorResult {
	const minRuns = opts.minRuns ?? 3;
	const groups = new Map<string, { value: number; runKey: string }[]>();
	for (const run of reg.listRuns(opts.lineId)) {
		if (run.verification !== "verified") continue;
		const metric = reg.listMetrics({ runKey: run.run_key }).find((m) => m.name === opts.metric);
		if (!metric) continue;
		const key = run.config_fingerprint ?? "-";
		groups.set(key, [...(groups.get(key) ?? []), { value: metric.value, runKey: run.run_key }]);
	}
	const largest = [...groups.values()].sort((a, b) => b.length - a.length)[0] ?? [];
	const values = largest.map((x) => x.value);
	const runKeys = largest.map((x) => x.runKey);
	if (values.length < minRuns) {
		return {
			evaluatorId: opts.evaluatorId,
			metric: opts.metric,
			status: "insufficient",
			n: values.length,
			mean: mean(values),
			sd: sd(values),
			runKeys,
			note: `同配置已验证 run 仅 ${values.length} 次，不足 ${minRuns} 次，噪声底无法实测；先重复跑同配置基线`,
		};
	}
	const m = mean(values);
	const s = sd(values);
	let evaluator = opts.evaluatorId ? reg.getEvaluator(opts.evaluatorId) : reg.listEvaluators({ lineId: opts.lineId })[0];
	if (!evaluator) {
		evaluator = reg.addEvaluator({ lineId: opts.lineId, metricNames: [opts.metric] });
	}
	let floors: Record<string, { n: number; mean: number; sd: number }> = {};
	try {
		floors = evaluator.noise_floor ? (JSON.parse(evaluator.noise_floor) as typeof floors) : {};
	} catch {
		floors = {};
	}
	floors[opts.metric] = { n: values.length, mean: m, sd: s };
	reg.updateEvaluatorAudit(evaluator.id, { noiseFloor: floors });
	return {
		evaluatorId: evaluator.id,
		metric: opts.metric,
		status: "ok",
		n: values.length,
		mean: m,
		sd: s,
		runKeys,
		note: `噪声底 sd=${s.toFixed(6)}（${values.length} 次同配置 run），最小效应建议不低于 ${(2 * s).toFixed(6)}`,
	};
}

export interface EvaluatorAuditResult {
	evaluatorId: string;
	runKey: string;
	deterministic: "pass" | "fail" | "skipped";
	probeCount: number;
	missCount: number;
	missRate?: number;
	note: string;
}

interface EvalSpecWithProbes {
	script: string;
	args?: string[];
	tolerance?: number;
	timeoutSec?: number;
	/** 故障探针：故意写坏的评测脚本变体，应当产出与参考值不同的结果 */
	probes?: { script: string; args?: string[] }[];
}

function numericMetrics(result: Record<string, unknown>): Map<string, number> {
	const out = new Map<string, number>();
	for (const [k, v] of Object.entries(result)) {
		if (typeof v === "number" && Number.isFinite(v)) out.set(k, v);
	}
	return out;
}

function sameMetrics(
	a: Map<string, number>,
	b: Map<string, number>,
	tolerance: number,
): boolean {
	if (a.size !== b.size) return false;
	for (const [k, va] of a) {
		const vb = b.get(k);
		if (vb === undefined || Math.abs(va - vb) > tolerance) return false;
	}
	return true;
}

/**
 * 评测器审计：以该线最近一次已验证 run 的 eval_spec 为准，
 * 1) 连跑两次比较 RESULT_JSON，检验确定性；
 * 2) 依次运行故障探针，探针若与参考值在容差内一致，说明评测器分辨不出坏实现，计一次漏检。
 */
export async function auditEvaluator(
	reg: LabRegistry,
	cwd: string,
	evaluatorId: string,
): Promise<EvaluatorAuditResult> {
	const ev: EvaluatorRow | undefined = reg.getEvaluator(evaluatorId);
	if (!ev) throw new Error(`评测器不存在: ${evaluatorId}`);
	if (!ev.line_id) throw new Error(`评测器 ${evaluatorId} 未绑定实验线`);
	const run = reg
		.listRuns(ev.line_id)
		.filter((r) => r.verification === "verified" && r.eval_spec)
		.at(-1);
	if (!run) throw new Error(`线 ${ev.line_id} 没有带 eval_spec 的已验证 run，无可审计的评测命令`);
	const spec = JSON.parse(run.eval_spec!) as EvalSpecWithProbes;
	const tolerance = spec.tolerance ?? 1e-6;
	const logDir = join(reg.runDir(run.run_key), "logs");
	const runOnce = async (script: string, args: string[] = []) =>
		runPythonScript(script, args, {
			timeoutMs: (spec.timeoutSec ?? 1800) * 1000,
			logDir,
			cwd,
		});

	const first = await runOnce(spec.script, spec.args);
	const second = await runOnce(spec.script, spec.args);
	let deterministic: EvaluatorAuditResult["deterministic"] = "skipped";
	if (first.ok && second.ok) {
		try {
			deterministic = sameMetrics(
				numericMetrics(parseResultJson(first.stdout)),
				numericMetrics(parseResultJson(second.stdout)),
				tolerance,
			)
				? "pass"
				: "fail";
		} catch {
			deterministic = "fail";
		}
	}

	const referenceMetrics = new Map(
		reg.listMetrics({ runKey: run.run_key }).map((m) => [m.name, m.value]),
	);
	let missCount = 0;
	const probes = spec.probes ?? [];
	for (const probe of probes) {
		const res = await runOnce(probe.script, probe.args ?? []);
		if (!res.ok) continue; // 探针本身崩溃算"被抓住"，不计漏检
		try {
			const probeMetrics = numericMetrics(parseResultJson(res.stdout));
			// 探针与参考值一致 → 评测器无法区分好坏，计漏检
			if (sameMetrics(probeMetrics, referenceMetrics, tolerance)) missCount++;
		} catch {
			// 无 RESULT_JSON 视为被抓住
		}
	}
	const missRate = probes.length > 0 ? missCount / probes.length : undefined;
	reg.updateEvaluatorAudit(evaluatorId, missRate === undefined ? {} : { missRate });

	const parts: string[] = [];
	parts.push(`确定性: ${deterministic}`);
	if (probes.length === 0) {
		parts.push("覆盖不足：未声明故障探针，本次只测了确定性，未评估分辨力");
	} else {
		parts.push(`故障探针 ${probes.length} 个，漏检 ${missCount} 个（漏检率 ${(missRate! * 100).toFixed(1)}%）`);
	}
	if (deterministic === "fail") parts.push("评测输出不确定：同脚本两次结果不一致，指标不可复现");
	return {
		evaluatorId,
		runKey: run.run_key,
		deterministic,
		probeCount: probes.length,
		missCount,
		missRate,
		note: parts.join("；"),
	};
}
