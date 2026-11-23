import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AnchorRow, EvaluatorRow, HypothesisRow, LabRegistry } from "./store.ts";
import { HYPOTHESIS_TRANSITIONS } from "./store.ts";
import { compareLines } from "./compare.ts";

/** 假设状态机（与账本保持单一来源，这里再导出供工具层引用） */
export const HYPOTHESIS_STATUSES = Object.keys(HYPOTHESIS_TRANSITIONS);

export function assertTransition(from: string, to: string): void {
	if (from === to) return;
	const allowed = HYPOTHESIS_TRANSITIONS[from] ?? [];
	if (!allowed.includes(to)) {
		throw new Error(`假设状态迁移非法: ${from}→${to}（允许: ${allowed.join(", ") || "无"}）`);
	}
}

// ---------- 可计算信号：方向提议的原料，全部取自账本既有事实 ----------

export type SignalKind = "claim_conflict" | "residual" | "cross_line" | "saturation";

export interface Signal {
	kind: SignalKind;
	line_id?: string;
	/** 证据引用：run_key、claim 编号（C3 形式）或指标名 */
	evidence_refs: string[];
	summary: string;
}

export interface SignalOptions {
	/** 残差信号的变异系数阈值，默认 0.15 */
	cvThreshold?: number;
	/** 饱和信号考察的最近 run 数，默认 4 */
	saturationWindow?: number;
	/** 每类信号最多产出条数，默认 5 */
	maxPerKind?: number;
}

function mean(xs: number[]): number {
	return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function sd(xs: number[]): number {
	if (xs.length < 2) return 0;
	const m = mean(xs);
	return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

function claimDirection(claimLineA: string, direction: string): "A>B" | "B>A" {
	return direction === "A>B" ? "A>B" : "B>A";
}

function conflictSignals(reg: LabRegistry, max: number): Signal[] {
	const out: Signal[] = [];
	for (const claim of reg.listClaims({ status: "open" })) {
		if (out.length >= max) break;
		if (!claim.check_json) continue;
		let check: { metric: string; lineA: string; lineB: string; direction: "A>B" | "B>A" };
		try {
			check = JSON.parse(claim.check_json) as typeof check;
		} catch {
			continue;
		}
		let cmp;
		try {
			cmp = compareLines(reg, check.lineA, check.lineB);
		} catch {
			continue;
		}
		const cmpMetric = cmp.metricComparisons.find((c) => c.metric === `${check.metric}@-`)?.metric.startsWith(check.metric)
			? cmp.metricComparisons.find((c) => c.metric === `${check.metric}@-`)
			: cmp.metricComparisons.find((c) => c.metric.startsWith(`${check.metric}@`));
		if (!cmpMetric || cmpMetric.valuesA.length < 2) continue;
		// compareLines 以 lineA−lineB 的差做检验；换算成"谁更大"
		const diffSaysABigger = cmpMetric.test.meanDiff > 0;
		const claimSaysABigger = check.direction === "A>B";
		if (diffSaysABigger !== claimSaysABigger) {
			out.push({
				kind: "claim_conflict",
				line_id: claim.line_id ?? undefined,
				evidence_refs: [`C${claim.id}`, check.lineA, check.lineB],
				summary: `未决判断 C${claim.id} 与指标 ${check.metric} 的实测方向相反（断言 ${check.direction}，实测均值差 ${cmpMetric.test.meanDiff.toFixed(4)}），值得追问哪个中间变量导致分歧`,
			});
		}
	}
	return out;
}

function residualSignals(reg: LabRegistry, opts: Required<Pick<SignalOptions, "cvThreshold">>, max: number): Signal[] {
	const out: Signal[] = [];
	for (const line of reg.listLines()) {
		if (out.length >= max) break;
		const runs = reg.listRuns(line.id).filter((r) => r.status !== "running");
		if (runs.length < 3) continue;
		const fingerprints = new Set(runs.map((r) => r.config_fingerprint ?? "-"));
		// 配置不同时方差有解释来源，不算残差
		if (fingerprints.size > 1) continue;
		const byName = new Map<string, number[]>();
		for (const m of reg.listMetrics({ lineId: line.id })) {
			byName.set(m.name, [...(byName.get(m.name) ?? []), m.value]);
		}
		for (const [name, values] of byName) {
			if (out.length >= max) break;
			if (values.length < 3) continue;
			const m = mean(values);
			if (m === 0) continue;
			const cv = sd(values) / Math.abs(m);
			if (cv > opts.cvThreshold) {
				out.push({
					kind: "residual",
					line_id: line.id,
					evidence_refs: values.slice(0, 3).map((_, i) => runs[i]?.run_key ?? "").filter(Boolean),
					summary: `线 ${line.id} 的指标 ${name} 在相同配置下变异系数 ${cv.toFixed(2)}，方差无配置解释，值得假设存在未记录的变量`,
				});
			}
		}
	}
	return out;
}

function crossLineSignals(reg: LabRegistry, max: number): Signal[] {
	const out: Signal[] = [];
	const lines = reg.listLines().filter((l) => l.status === "active");
	// 兄弟关系：共享 parent_line 或同属顶层；只对同一指标族的两两比较
	for (let i = 0; i < lines.length && out.length < max; i++) {
		for (let j = i + 1; j < lines.length && out.length < max; j++) {
			const related = lines[i].parent_line === lines[j].parent_line || lines[i].parent_line === lines[j].id || lines[j].parent_line === lines[i].id;
			if (!related) continue;
			let cmp;
			try {
				cmp = compareLines(reg, lines[i].id, lines[j].id);
			} catch {
				continue;
			}
			for (const mc of cmp.metricComparisons) {
				if (out.length >= max) break;
				if (mc.test.pairedT.p >= 0.05) continue;
				const better = mc.test.meanDiff > 0 ? lines[i] : lines[j];
				const worse = mc.test.meanDiff > 0 ? lines[j] : lines[i];
				const configOf = (runKey: string): Record<string, unknown> | undefined => {
					const artifact = reg.listArtifacts(runKey).find((a) => a.rel_path === "config.json");
					if (!artifact) return undefined;
					try {
						return JSON.parse(readFileSync(join(reg.runDir(runKey), "config.json"), "utf-8")) as Record<
							string,
							unknown
						>;
					} catch {
						return undefined;
					}
				};
				const betterRun = reg.listRuns(better.id).at(-1);
				const worseRun = reg.listRuns(worse.id).at(-1);
				if (!betterRun || !worseRun) continue;
				const bCfg = configOf(betterRun.run_key);
				const wCfg = configOf(worseRun.run_key);
				if (!bCfg || !wCfg) continue;
				const onlyInBetter = Object.keys(bCfg).filter((k) => !(k in wCfg));
				if (onlyInBetter.length === 0) continue;
				out.push({
					kind: "cross_line",
					line_id: worse.id,
					evidence_refs: [betterRun.run_key, worseRun.run_key, `${mc.test.pairedT.p.toFixed(3)}`],
					summary: `线 ${better.id} 在指标 ${mc.metric} 上显著优于 ${worse.id}（p=${mc.test.pairedT.p.toFixed(3)}），且配置独有键 ${onlyInBetter.join("、")} 尚未迁移，值得假设可迁移`,
				});
			}
		}
	}
	return out;
}

function saturationSignals(reg: LabRegistry, window: number, max: number): Signal[] {
	const out: Signal[] = [];
	for (const line of reg.listLines()) {
		if (out.length >= max) break;
		const verified = reg
			.listRuns(line.id)
			.filter((r) => r.verification === "verified")
			.slice(-window);
		if (verified.length < 3) continue;
		const byName = new Map<string, number[]>();
		for (const r of verified) {
			for (const m of reg.listMetrics({ runKey: r.run_key })) {
				byName.set(m.name, [...(byName.get(m.name) ?? []), m.value]);
			}
		}
		for (const ev of reg.listEvaluators({ lineId: line.id })) {
			if (out.length >= max) break;
			if (!ev.noise_floor) continue;
			let floors: Record<string, { n: number; mean: number; sd: number }>;
			try {
				floors = JSON.parse(ev.noise_floor) as typeof floors;
			} catch {
				continue;
			}
			for (const [metric, floor] of Object.entries(floors)) {
				if (out.length >= max) break;
				const values = byName.get(metric);
				if (!values || values.length < 3) continue;
				const deltas = values.slice(1).map((v, i) => Math.abs(v - values[i]));
				const quiet = deltas.every((d) => d < 2 * floor.sd);
				if (!quiet) continue;
				const openClaims = reg.listClaims({ status: "open", lineId: line.id }).length;
				if (openClaims === 0) continue;
				out.push({
					kind: "saturation",
					line_id: line.id,
					evidence_refs: [ev.id, `${floor.sd.toFixed(4)}`],
					summary: `线 ${line.id} 最近 ${values.length} 次已验证 run 的指标 ${metric} 波动均在噪声底内，同时仍有 ${openClaims} 条未决改进判断，值得先审计评测器是否饱和（元假设）`,
				});
			}
		}
	}
	return out;
}

/** 从账本既有事实抽取方向提议的原料：判断冲突、未解释残差、跨线配置差、评测器饱和 */
export function collectSignals(reg: LabRegistry, opts: SignalOptions = {}): Signal[] {
	const max = opts.maxPerKind ?? 5;
	const window = opts.saturationWindow ?? 4;
	const signals: Signal[] = [];
	signals.push(...conflictSignals(reg, max));
	signals.push(...residualSignals(reg, { cvThreshold: opts.cvThreshold ?? 0.15 }, max));
	signals.push(...crossLineSignals(reg, max));
	signals.push(...saturationSignals(reg, window, max));
	return signals;
}

// ---------- 排序：性能 × 未探索 × 锚强度 × 新颖性 × 可学性 ----------

export interface RankComponents {
	q: number;
	children: number;
	anchorStrength: number;
	anchorDefaulted: boolean;
	noveltyFactor: number;
	learnability: number;
	noiseDefaulted: boolean;
	score: number;
}

export interface Ranked {
	hypothesis: HypothesisRow;
	components: RankComponents;
}

const ANCHOR_STRENGTH: Record<string, number> = { strong: 1.0, medium: 0.6, weak: 0.3 };
const NOVELTY_FACTOR: Record<string, number> = { novel: 1.0, adjacent: 0.8, duplicate: 0, insufficient: 0 };

function sigmoid(x: number): number {
	return 1 / (1 + Math.exp(-x));
}

function percentileOf(value: number, all: number[]): number {
	if (all.length <= 1) return 0.5;
	const below = all.filter((v) => v < value).length;
	return below / (all.length - 1);
}

function lineNoiseSd(reg: LabRegistry, lineId?: string): { sd: number; defaulted: boolean } {
	if (!lineId) return { sd: 0, defaulted: true };
	const evs = reg.listEvaluators({ lineId });
	const floors = evs.map((e) => e.noise_floor).filter((f): f is string => Boolean(f));
	if (floors.length === 0) return { sd: 0, defaulted: true };
	let parsed: Record<string, { n: number; mean: number; sd: number }>;
	try {
		parsed = JSON.parse(floors[0]) as typeof parsed;
	} catch {
		return { sd: 0, defaulted: true };
	}
	const sds = Object.values(parsed)
		.map((f) => f.sd)
		.filter((v) => Number.isFinite(v) && v > 0)
		.sort((a, b) => a - b);
	if (sds.length === 0) return { sd: 0, defaulted: true };
	// 多指标取中位 sd，避免单一噪声极小的指标抬高全部假设
	const mid = Math.floor(sds.length / 2);
	const median = sds.length % 2 ? sds[mid] : (sds[mid - 1] + sds[mid]) / 2;
	return { sd: median, defaulted: false };
}

function lineQualityQuantile(reg: LabRegistry, lineId?: string): number {
	if (!lineId) return 0.5;
	const runs = reg.listRuns(lineId).filter((r) => r.verification === "verified");
	const latest = runs.at(-1);
	if (!latest) return 0.5;
	const metrics = reg.listMetrics({ runKey: latest.run_key });
	if (metrics.length === 0) return 0.5;
	// 取该 run 记录的第一条指标作为主指标
	const primary = metrics[0];
	const key = `${primary.name}@${(primary as unknown as { endpoint?: string }).endpoint ?? "-"}`;
	const latestPerLine = new Map<string, number>();
	for (const line of reg.listLines()) {
		const vr = reg.listRuns(line.id).filter((r) => r.verification === "verified").at(-1);
		if (!vr) continue;
		const ms = reg.listMetrics({ runKey: vr.run_key }).filter(
			(m) => `${m.name}@${(m as unknown as { endpoint?: string }).endpoint ?? "-"}` === key,
		);
		if (ms.length > 0) latestPerLine.set(line.id, ms[0].value);
	}
	if (latestPerLine.size <= 1) return 0.5;
	return percentileOf(latestPerLine.get(lineId)!, [...latestPerLine.values()]);
}

function anchorStrengthOf(reg: LabRegistry, anchorRef?: string): { strength: number; defaulted: boolean } {
	if (!anchorRef) return { strength: 0.5, defaulted: true };
	const anchor: AnchorRow | undefined = reg.getAnchor(anchorRef);
	if (!anchor) return { strength: 0.5, defaulted: true };
	return { strength: ANCHOR_STRENGTH[anchor.strength] ?? 0.5, defaulted: false };
}

function noveltyFactorOf(reg: LabRegistry, hypothesisId: string): number {
	const check = reg.latestNoveltyCheck(hypothesisId);
	if (!check) return 0.5;
	return NOVELTY_FACTOR[check.verdict] ?? 0.5;
}

function childrenOf(reg: LabRegistry, id: string): number {
	return reg.listHypotheses().filter((h) => h.parent_hypothesis === id).length;
}

/** 排序单条假设：分量全部显式产出，写入 rank_components 供事后核对 */
export function rankHypothesis(reg: LabRegistry, h: HypothesisRow): RankComponents {
	const q = lineQualityQuantile(reg, h.line_id);
	const children = childrenOf(reg, h.id);
	const anchor = anchorStrengthOf(reg, h.anchor_ref);
	const novelty = noveltyFactorOf(reg, h.id);
	const noise = lineNoiseSd(reg, h.line_id);
	let learnability = 0.5;
	if (!noise.defaulted && h.expected_gain !== undefined && h.expected_gain !== null) {
		learnability = Math.min(1, Math.max(0, h.expected_gain / (2 * noise.sd)));
	}
	const score =
		sigmoid(10 * (q - 0.5)) * (1 / (1 + children)) * anchor.strength * novelty * learnability;
	return {
		q,
		children,
		anchorStrength: anchor.strength,
		anchorDefaulted: anchor.defaulted,
		noveltyFactor: novelty,
		learnability,
		noiseDefaulted: noise.defaulted,
		score,
	};
}

/** 对全部非终态假设计算排序并写回账本，返回按分数降序的列表 */
export function rankHypotheses(reg: LabRegistry, filter: { lineId?: string } = {}): Ranked[] {
	const active = reg
		.listHypotheses({ lineId: filter.lineId })
		.filter((h) => h.status === "proposed" || h.status === "queued" || h.status === "running");
	const ranked = active.map((h) => {
		const components = rankHypothesis(reg, h);
		reg.setHypothesisRank(h.id, components.score, components);
		return { hypothesis: reg.getHypothesis(h.id)!, components };
	});
	return ranked.sort((a, b) => b.components.score - a.components.score);
}

/** 单条假设的上下文重建：供会话模型在不重读历史的情况下补充或判定假设 */
export function hypothesisContext(reg: LabRegistry, id: string): string {
	const h = reg.getHypothesis(id);
	if (!h) return `假设不存在: ${id}`;
	const parts: string[] = [];
	parts.push(`# 假设 ${h.id} [${h.status}]`);
	parts.push(`陈述: ${h.statement}`);
	parts.push(`预测: ${h.prediction}`);
	parts.push(`判别: ${h.discriminator}`);
	parts.push(`来源: ${h.provenance}${h.provenance_ref ? ` (${h.provenance_ref})` : ""}`);
	if (h.line_id) parts.push(`实验线: ${h.line_id}`);
	if (h.parent_run) parts.push(`父 run: ${h.parent_run}`);
	if (h.eval_ref) parts.push(`评测器: ${h.eval_ref}`);
	if (h.anchor_ref) {
		const a = reg.getAnchor(h.anchor_ref);
		parts.push(`锚: ${h.anchor_ref}${a ? `（${a.kind}/${a.strength}）` : "（未登记）"}`);
	}
	if (h.held_out_spec) parts.push(`留出方案: ${h.held_out_spec}`);
	parts.push(`预算上限: ${h.budget_cap ?? "未设"}，停止条件: ${h.kill_after ?? 3} 次无增益`);
	const novelty = reg.listNoveltyChecks(id);
	if (novelty.length > 0) {
		const latest = novelty[0];
		parts.push(`新颖性: ${latest.verdict}（${latest.checked_at}，检索词 ${latest.query}）`);
	} else {
		parts.push("新颖性: 尚未检查");
	}
	if (h.rank_components) {
		try {
			const c = JSON.parse(h.rank_components) as RankComponents;
			parts.push(
				`排序: ${c.score.toFixed(3)}（分位 ${c.q.toFixed(2)}、子代 ${c.children}、锚 ${c.anchorStrength.toFixed(2)}${c.anchorDefaulted ? " 默认" : ""}、新颖 ${c.noveltyFactor.toFixed(2)}、可学 ${c.learnability.toFixed(2)}${c.noiseDefaulted ? " 噪声底默认" : ""}）`,
			);
		} catch {
			// 排序分量损坏时跳过展示，不影响其余上下文
		}
	}
	const linked = reg.listRuns().filter((r) => r.hypothesis_id === id);
	if (linked.length > 0) {
		parts.push("");
		parts.push("| run | 状态 | 复核 | 指标 |");
		parts.push("| --- | --- | --- | --- |");
		for (const r of linked) {
			const metrics = reg
				.listMetrics({ runKey: r.run_key })
				.map((m) => `${m.name}=${m.value}`)
				.join("，");
			parts.push(`| ${r.run_key} | ${r.status} | ${r.verification ?? "-"} | ${metrics || "-"} |`);
		}
	}
	return parts.join("\n");
}

/** 评测器行内噪声底读取：audit.ts 与排序共用 */
export function readNoiseFloor(evaluator: EvaluatorRow): Record<string, { n: number; mean: number; sd: number }> {
	if (!evaluator.noise_floor) return {};
	try {
		return JSON.parse(evaluator.noise_floor) as Record<string, { n: number; mean: number; sd: number }>;
	} catch {
		return {};
	}
}
