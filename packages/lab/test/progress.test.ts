import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildProgressGraph, renderProgressTree } from "../src/progress.ts";
import { LabRegistry } from "../src/store.ts";

describe("progress graph", () => {
	test("stages become a DAG from explicit parent, hypothesis lineage and line forks", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lab-progress-"));
		const reg = new LabRegistry({ dbPath: join(dir, "lab.db"), runsRoot: join(dir, "runs") });
		reg.createLine("rag");
		const h1 = reg.addHypothesis({ statement: "s1", prediction: "p1", discriminator: "d1", provenance: "human", lineId: "rag" });
		reg.updateHypothesis(h1.id, { status: "queued" });
		const run1 = reg.registerRun({ lineId: "rag", hypothesisId: h1.id });
		reg.updateRun(run1.run_key, { status: "completed" });
		reg.updateHypothesis(h1.id, { status: "running" });

		// 阶段一：基线派发
		reg.addDispatch({ lineId: "rag", hypothesisId: h1.id, session: "rag-main", stage: "baseline", goal: "基线" });

		// fork 出探索线，假设从 H-0001 派生
		reg.forkLine("rag-explore", { runKey: run1.run_key }, "探索分叉");
		const h2 = reg.addHypothesis({
			statement: "s2",
			prediction: "p2",
			discriminator: "d2",
			provenance: "human",
			lineId: "rag-explore",
			parentHypothesis: h1.id,
			parentRun: run1.run_key,
		});
		reg.addDispatch({
			lineId: "rag-explore",
			hypothesisId: h2.id,
			stage: "explore",
			parentStage: "baseline",
			goal: "探索",
		});

		// 再 fork 一层，假设链继续派生，无显式 parent_stage
		reg.forkLine("rag-deep", { lineId: "rag-explore" }, "深挖");
		const h3 = reg.addHypothesis({
			statement: "s3",
			prediction: "p3",
			discriminator: "d3",
			provenance: "human",
			lineId: "rag-deep",
			parentHypothesis: h2.id,
		});
		reg.addDispatch({ lineId: "rag-deep", hypothesisId: h3.id, stage: "deep", goal: "深挖" });

		const graph = buildProgressGraph({
			dispatches: reg.listDispatches(),
			lines: reg.listLines(),
			hypotheses: reg.listHypotheses(),
			runs: reg.listRuns(),
		});

		expect(graph.nodes.map((n) => n.stage).sort()).toEqual(["baseline", "deep", "explore"]);
		expect(graph.roots).toEqual(["baseline"]);
		expect(graph.cycles).toEqual([]);

		const edgeKeys = graph.edges.map((e) => `${e.from}>${e.to}:${e.kind}`);
		// 显式父阶段
		expect(edgeKeys).toContain("baseline>explore:explicit");
		// 假设派生：H-0002 的父假设在 baseline 阶段最近一次派发
		expect(edgeKeys).toContain("baseline>explore:hypothesis_parent");
		// 线 fork：rag-explore 的父线是 rag
		expect(edgeKeys).toContain("baseline>explore:line_fork");
		// 无显式父阶段时，从假设链（或父线）推断出 explore>deep
		expect(edgeKeys).toContain("explore>deep:hypothesis_parent");
		expect(edgeKeys).toContain("explore>deep:line_fork");

		const tree = renderProgressTree(graph);
		expect(tree.split("\n")[0]).toContain("baseline");
		expect(tree).toContain("└─ explore");
		expect(tree).toContain("└─ deep");
		expect(tree).toContain("H-0002");
		reg.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("cycles are detected instead of looping the renderer", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lab-progress-cyc-"));
		const reg = new LabRegistry({ dbPath: join(dir, "lab.db"), runsRoot: join(dir, "runs") });
		reg.createLine("a");
		reg.addDispatch({ lineId: "a", stage: "s1", parentStage: "s2", goal: "g" });
		reg.addDispatch({ lineId: "a", stage: "s2", parentStage: "s1", goal: "g" });
		const graph = buildProgressGraph({
			dispatches: reg.listDispatches(),
			lines: reg.listLines(),
			hypotheses: reg.listHypotheses(),
			runs: reg.listRuns(),
		});
		expect(graph.cycles.length).toBeGreaterThan(0);
		const tree = renderProgressTree(graph);
		expect(tree).toContain("cycle");
		reg.close();
		rmSync(dir, { recursive: true, force: true });
	});
});
