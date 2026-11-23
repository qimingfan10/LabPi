import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { collectSignals, rankHypotheses, rankHypothesis } from "../src/hypothesis.ts";
import { LabRegistry } from "../src/store.ts";

function freshRegistry(): { reg: LabRegistry; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "pi-lab-hyp-"));
	const reg = new LabRegistry({ dbPath: join(dir, "lab.db"), runsRoot: join(dir, "runs") });
	return { reg, dir };
}

describe("hypothesis ledger", () => {
	test("tables exist and runs gain hypothesis binding", () => {
		const { reg, dir } = freshRegistry();
		const tables = reg.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
		const names = tables.map((t) => t.name);
		for (const expected of ["hypotheses", "novelty_checks", "questions", "evaluators", "anchors"]) {
			expect(names).toContain(expected);
		}
		const cols = reg.db.prepare("PRAGMA table_info(runs)").all() as { name: string }[];
		expect(cols.some((c) => c.name === "hypothesis_id")).toBe(true);

		reg.createLine("line-a");
		const h = reg.addHypothesis({
			statement: "加长反思链会提升通过率",
			prediction: "pass_rate 至少 +0.05",
			discriminator: "若 pass_rate 提升但 held-out 不变，则属于评测集过拟合",
			provenance: "human",
			lineId: "line-a",
		});
		reg.updateHypothesis(h.id, { status: "queued" });
		const run = reg.registerRun({ lineId: "line-a", hypothesisId: h.id });
		expect(run.hypothesis_id).toBe(h.id);
		reg.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("requires prediction and discriminator; enforces transitions", () => {
		const { reg, dir } = freshRegistry();
		expect(() =>
			reg.addHypothesis({ statement: "x", prediction: "", discriminator: "y", provenance: "human" }),
		).toThrow(/预测/);
		expect(() =>
			reg.addHypothesis({ statement: "x", prediction: "y", discriminator: " ", provenance: "human" }),
		).toThrow(/判别/);
		const h = reg.addHypothesis({
			statement: "x",
			prediction: "y",
			discriminator: "z",
			provenance: "human",
		});
		expect(() => reg.updateHypothesis(h.id, { status: "supported" })).toThrow(/非法/);
		reg.updateHypothesis(h.id, { status: "queued" });
		reg.updateHypothesis(h.id, { status: "running" });
		expect(() => reg.decideHypothesis(h.id, "supported")).toThrow(/run_key/);
		reg.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("supported decision requires a verified run and records the link", () => {
		const { reg, dir } = freshRegistry();
		reg.createLine("line-a");
		const h = reg.addHypothesis({
			statement: "s",
			prediction: "p",
			discriminator: "d",
			provenance: "human",
			lineId: "line-a",
		});
		reg.updateHypothesis(h.id, { status: "queued" });
		reg.updateHypothesis(h.id, { status: "running" });
		const run = reg.registerRun({ lineId: "line-a", hypothesisId: h.id });
		reg.recordMetric(run.run_key, "score", 1);
		reg.setVerification(run.run_key, "unverified", "no script");
		expect(() => reg.decideHypothesis(h.id, "supported", { runKey: run.run_key })).toThrow(/verified/);
		reg.setVerification(run.run_key, "verified", "rerun matched");
		const decided = reg.decideHypothesis(h.id, "supported", { runKey: run.run_key });
		expect(decided.status).toBe("supported");
		expect(decided.decided_run).toBe(run.run_key);
		reg.close();
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("direction signals", () => {
	test("conflicting claim direction produces a claim_conflict signal", () => {
		const { reg, dir } = freshRegistry();
		reg.createLine("a");
		reg.createLine("b");
		const ra1 = reg.registerRun({ lineId: "a" });
		reg.recordMetric(ra1.run_key, "score", 0.4);
		const ra2 = reg.registerRun({ lineId: "a" });
		reg.recordMetric(ra2.run_key, "score", 0.45);
		const rb1 = reg.registerRun({ lineId: "b" });
		reg.recordMetric(rb1.run_key, "score", 0.7);
		const rb2 = reg.registerRun({ lineId: "b" });
		reg.recordMetric(rb2.run_key, "score", 0.72);
		reg.addClaim({
			statement: "a 高于 b",
			check: { metric: "score", lineA: "a", lineB: "b", direction: "A>B" },
		});
		const signals = collectSignals(reg);
		expect(signals.some((s) => s.kind === "claim_conflict")).toBe(true);
		reg.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("unexplained variance produces a residual signal", () => {
		const { reg, dir } = freshRegistry();
		reg.createLine("noisy");
		for (const value of [0.2, 1.0, 0.3]) {
			const run = reg.registerRun({ lineId: "noisy", config: { fixed: true } });
			reg.recordMetric(run.run_key, "score", value);
			reg.updateRun(run.run_key, { status: "completed" });
		}
		const signals = collectSignals(reg);
		expect(signals.some((s) => s.kind === "residual")).toBe(true);
		reg.close();
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("dispatch progress", () => {
	test("addDispatch / updateDispatch / listDispatches track a dispatch lifecycle", () => {
		const { reg, dir } = freshRegistry();
		reg.createLine("rag");
		const h = reg.addHypothesis({
			statement: "s",
			prediction: "p",
			discriminator: "d",
			provenance: "human",
			lineId: "rag",
		});
		const id = reg.addDispatch({
			lineId: "rag",
			hypothesisId: h.id,
			session: "rag-main",
			stage: "rag",
			goal: h.statement,
			logPath: "runs/logs/rag-x.log",
		});
		expect(id).toBeGreaterThan(0);
		let rows = reg.listDispatches({ status: "running" });
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe("running");

		reg.updateDispatch(id, { pid: 4242 });
		reg.updateDispatch(id, { status: "completed", exitCode: 0, summary: "RUN_KEY=rag-001 STATUS=completed" });
		rows = reg.listDispatches({ status: "running" });
		expect(rows).toHaveLength(0);
		const done = reg.listDispatches({ status: "completed" });
		expect(done[0].pid).toBe(4242);
		expect(done[0].summary).toContain("RUN_KEY=rag-001");
		expect(done[0].finished_at).toBeTruthy();

		// gate_blocked 行也入表
		const blocked = reg.addDispatch({ lineId: "rag", stage: "rag", goal: "缺判据的方向" });
		reg.updateDispatch(blocked, { status: "gate_blocked", summary: "missing eval_ref" });
		expect(reg.listDispatches({ status: "gate_blocked" })).toHaveLength(1);
		expect(reg.listDispatches({})).toHaveLength(2);
		reg.close();
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("hypothesis ranking", () => {
	test("writes rank components and orders by score", () => {
		const { reg, dir } = freshRegistry();
		reg.createLine("a");
		reg.createLine("b");
		for (const lineId of ["a", "b"]) {
			const run = reg.registerRun({ lineId, config: { x: 1 } });
			reg.recordMetric(run.run_key, "score", lineId === "a" ? 0.5 : 0.9);
			reg.setVerification(run.run_key, "verified", "ok");
		}
		const weak = reg.addHypothesis({
			statement: "弱线改进",
			prediction: "score +0.01",
			discriminator: "held-out 同向",
			provenance: "human",
			lineId: "a",
			expectedGain: 0.01,
		});
		const strong = reg.addHypothesis({
			statement: "强线改进",
			prediction: "score +0.1",
			discriminator: "held-out 同向",
			provenance: "human",
			lineId: "b",
			expectedGain: 0.1,
		});
		const anchor = reg.addAnchor({ kind: "held_out_split", strength: "strong" });
		reg.updateHypothesis(strong.id, { anchorRef: anchor.id });
		for (const id of [weak.id, strong.id]) {
			reg.addNoveltyCheck({ hypothesisId: id, query: "q", verdict: "adjacent" });
		}
		// 噪声底：同配置三次重复 run
		for (const value of [0.89, 0.9, 0.91]) {
			const run = reg.registerRun({ lineId: "b", config: { x: 1 } });
			reg.recordMetric(run.run_key, "score", value);
			reg.setVerification(run.run_key, "verified", "ok");
		}
		const ev = reg.addEvaluator({ lineId: "b", metricNames: ["score"] });
		reg.updateEvaluatorAudit(ev.id, { noiseFloor: { score: { n: 3, mean: 0.9, sd: 0.01 } } });

		const ranked = rankHypotheses(reg);
		expect(ranked.length).toBe(2);
		const strongRank = ranked.find((r) => r.hypothesis.id === strong.id)!;
		const weakRank = ranked.find((r) => r.hypothesis.id === weak.id)!;
		// 强线分位更高、锚更强、可学性更高 → 分数更高
		expect(strongRank.components.score).toBeGreaterThan(weakRank.components.score);
		expect(strongRank.components.anchorStrength).toBe(1);
		expect(strongRank.components.learnability).toBe(1);
		expect(reg.getHypothesis(strong.id)?.rank_score).toBeCloseTo(strongRank.components.score, 6);
		expect(reg.getHypothesis(strong.id)?.rank_components).toContain("learnability");
		const single = rankHypothesis(reg, reg.getHypothesis(weak.id)!);
		expect(single.noiseDefaulted).toBe(true); // a 线无噪声底
		reg.close();
		rmSync(dir, { recursive: true, force: true });
	});
});
