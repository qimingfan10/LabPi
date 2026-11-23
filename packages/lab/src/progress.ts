import type { DispatchRow, HypothesisRow, LineRow, RunRow } from "./store.ts";

/**
 * 进度图：阶段是节点，边来自上下文分叉关系——
 * 显式声明的父阶段、实验线 fork 谱系、假设派生谱系。
 * 图构建是纯函数，CLI 只负责渲染；ZCode 侧也可直接消费 nodes/edges。
 */

export type ProgressEdgeKind = "explicit" | "line_fork" | "hypothesis_parent";

export interface ProgressEdge {
	from: string;
	to: string;
	kind: ProgressEdgeKind;
	/** 分叉依据：父假设 id、父 run、父线 id */
	evidence?: string;
}

export interface ProgressNode {
	stage: string;
	total: number;
	running: number;
	stale: number;
	completed: number;
	failed: number;
	blocked: number;
	/** 该阶段第一次与最后一次派发的时间 */
	first_started_at?: string;
	last_started_at?: string;
	items: {
		id: number;
		line?: string;
		hypothesis?: string;
		session?: string;
		goal?: string;
		status: string;
		pid?: number;
		started_at: string;
		finished_at?: string;
		summary?: string;
	}[];
}

export interface ProgressGraph {
	nodes: ProgressNode[];
	edges: ProgressEdge[];
	roots: string[];
	/** 存在环时列出节点，正常为空 */
	cycles: string[][];
}

export interface ProgressInput {
	dispatches: DispatchRow[];
	lines: LineRow[];
	hypotheses: HypothesisRow[];
	runs: RunRow[];
}

const TERMINAL = new Set(["completed", "failed", "gate_blocked", "gateway_unreachable", "stale"]);

function byStarted(a: DispatchRow, b: DispatchRow): number {
	return a.started_at.localeCompare(b.started_at) || a.id - b.id;
}

/**
 * 构建阶段图。边的优先级：显式 parent_stage > 假设的父假设 > 假设的父 run > 线的父线。
 * 推断边只连向"在本次派发开始前最近一次发生在祖先对象上的派发"，
 * 避免把同一阶段的无关派发连成一团。
 */
export function buildProgressGraph(input: ProgressInput): ProgressGraph {
	const dispatches = [...input.dispatches].sort(byStarted);
	const lineById = new Map(input.lines.map((l) => [l.id, l]));
	const hypById = new Map(input.hypotheses.map((h) => [h.id, h]));
	const runByKey = new Map(input.runs.map((r) => [r.run_key, r]));

	const latestOnLineBefore = (lineId: string, beforeIso: string): DispatchRow | undefined => {
		let found: DispatchRow | undefined;
		for (const d of dispatches) {
			if (d.line_id !== lineId) continue;
			if (d.started_at >= beforeIso) break;
			found = d;
		}
		return found;
	};
	const latestForHypothesisBefore = (hypId: string, beforeIso: string): DispatchRow | undefined => {
		let found: DispatchRow | undefined;
		for (const d of dispatches) {
			if (d.hypothesis_id !== hypId) continue;
			if (d.started_at >= beforeIso) break;
			found = d;
		}
		return found;
	};

	const edges: ProgressEdge[] = [];
	const seen = new Set<string>();
	const addEdge = (from: string | undefined, to: string, kind: ProgressEdgeKind, evidence?: string) => {
		if (!from || from === to) return;
		const key = `${from}>${to}>${kind}`;
		if (seen.has(key)) return;
		seen.add(key);
		edges.push({ from, to, kind, evidence });
	};

	for (const d of dispatches) {
		if (d.parent_stage) addEdge(d.parent_stage, d.stage, "explicit");
		const h = d.hypothesis_id ? hypById.get(d.hypothesis_id) : undefined;
		if (h?.parent_hypothesis) {
			const pd = latestForHypothesisBefore(h.parent_hypothesis, d.started_at);
			addEdge(pd?.stage, d.stage, "hypothesis_parent", h.parent_hypothesis);
		} else if (h?.parent_run) {
			const run = runByKey.get(h.parent_run);
			if (run) {
				const pd = latestOnLineBefore(run.line_id, d.started_at);
				addEdge(pd?.stage, d.stage, "hypothesis_parent", `run:${h.parent_run}`);
			}
		}
		const line = d.line_id ? lineById.get(d.line_id) : undefined;
		if (line?.parent_line) {
			const pd = latestOnLineBefore(line.parent_line, d.started_at);
			addEdge(pd?.stage, d.stage, "line_fork", `line:${line.parent_line}`);
		}
	}

	// 节点：以阶段聚合派发；被显式引用但没有派发的阶段也建空节点，避免边指向虚空
	const stageNames = new Set<string>(dispatches.map((d) => d.stage));
	for (const e of edges) {
		stageNames.add(e.from);
		stageNames.add(e.to);
	}
	const nodes: ProgressNode[] = [...stageNames].map((stage) => {
		const items = dispatches.filter((d) => d.stage === stage);
		return {
			stage,
			total: items.length,
			running: items.filter((d) => d.status === "running").length,
			stale: items.filter((d) => d.status === "stale").length,
			completed: items.filter((d) => d.status === "completed").length,
			failed: items.filter((d) => d.status === "failed").length,
			blocked: items.filter((d) => d.status === "gate_blocked" || d.status === "gateway_unreachable").length,
			first_started_at: items[0]?.started_at,
			last_started_at: items.at(-1)?.started_at,
			items: items.map((d) => ({
				id: d.id,
				line: d.line_id,
				hypothesis: d.hypothesis_id,
				session: d.session,
				goal: d.goal,
				status: d.status,
				pid: d.pid,
				started_at: d.started_at,
				finished_at: d.finished_at,
				summary: d.summary,
			})),
		};
	});
	nodes.sort((a, b) => (a.first_started_at ?? "").localeCompare(b.first_started_at ?? "") || a.stage.localeCompare(b.stage));

	const incoming = new Map<string, ProgressEdge[]>();
	const outgoing = new Map<string, ProgressEdge[]>();
	for (const e of edges) {
		incoming.set(e.to, [...(incoming.get(e.to) ?? []), e]);
		outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e]);
	}
	const roots = nodes.filter((n) => !(incoming.get(n.stage)?.length)).map((n) => n.stage);

	// 环检测：阶段图理论上应是 DAG，出现环说明 parent_stage 或谱系被错误地互指
	const cycles: string[][] = [];
	const state = new Map<string, 0 | 1 | 2>();
	const stack: string[] = [];
	const visit = (stage: string) => {
		state.set(stage, 1);
		stack.push(stage);
		for (const e of outgoing.get(stage) ?? []) {
			const next = e.to;
			if (state.get(next) === 1) {
				const idx = stack.indexOf(next);
				cycles.push(stack.slice(idx >= 0 ? idx : 0));
			} else if (!state.get(next)) {
				visit(next);
			}
		}
		stack.pop();
		state.set(stage, 2);
	};
	for (const n of nodes) if (!state.get(n.stage)) visit(n.stage);

	return { nodes, edges, roots, cycles };
}

/** 终端渲染：根在左，子阶段缩进；括号内为状态计数，第二行起列该阶段的派发 */
export function renderProgressTree(graph: ProgressGraph): string {
	const nodeByStage = new Map(graph.nodes.map((n) => [n.stage, n]));
	const children = new Map<string, string[]>();
	for (const e of graph.edges) children.set(e.from, [...(children.get(e.from) ?? []), e.to]);
	for (const [k, v] of children) children.set(k, [...new Set(v)]);
	const lines: string[] = [];
	const printed = new Set<string>();
	const printNode = (stage: string, depth: number, path: Set<string>) => {
		if (path.has(stage)) {
			lines.push(`${"  ".repeat(depth)}↺ ${stage} (cycle)`);
			return;
		}
		if (printed.has(stage)) return;
		printed.add(stage);
		const n = nodeByStage.get(stage);
		const counts = n
			? [
					n.running ? `${n.running} running` : "",
					n.completed ? `${n.completed} completed` : "",
					n.failed ? `${n.failed} failed` : "",
					n.blocked ? `${n.blocked} blocked` : "",
					n.stale ? `${n.stale} stale` : "",
				]
					.filter(Boolean)
					.join(", ") || "empty"
			: "no dispatches";
		lines.push(`${"  ".repeat(depth)}${depth === 0 ? "" : "└─ "}${stage} [${counts}]`);
		for (const it of n?.items ?? []) {
			lines.push(
				`${"  ".repeat(depth + 1)}· D${it.id} ${it.hypothesis ?? it.line ?? "-"} ${it.status} ${(it.goal ?? "").slice(0, 48)}`,
			);
		}
		for (const childStage of children.get(stage) ?? []) printNode(childStage, depth + 1, new Set([...path, stage]));
	};
	for (const root of graph.roots) printNode(root, 0, new Set());
	// 只出现在环里的阶段没有根可达，补印一次
	for (const n of graph.nodes) if (!printed.has(n.stage)) printNode(n.stage, 0, new Set());
	return lines.join("\n");
}
