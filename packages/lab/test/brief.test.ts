import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { checkBrief, gatherBriefContext, renderBrief } from "../src/brief.ts";
import { LabRegistry } from "../src/store.ts";

function makeRegistry() {
	const dir = mkdtempSync(join(tmpdir(), "pi-lab-brief-"));
	const reg = new LabRegistry({ dbPath: join(dir, "lab.db"), runsRoot: join(dir, "runs") });
	return { reg, dir };
}

function fullHypothesis(reg: LabRegistry, overrides: Record<string, unknown> = {}) {
	reg.createLine("line-a");
	const anchor = reg.addAnchor({ kind: "held_out_split", strength: "strong" });
	const base = {
		statement: "加长反思链会提升通过率",
		prediction: "pass_rate 至少 +0.05",
		discriminator: "若 pass_rate 提升而 held-out 不变，则属评测集过拟合",
		provenance: "human" as const,
		lineId: "line-a",
		evalRef: "evals/pass_rate.py",
		anchorRef: anchor.id,
		heldOutSpec: "20% 场景留出，不参与任何选择",
		expectedGain: 0.05,
		budgetCap: 10,
	};
	return reg.addHypothesis({ ...base, ...overrides } as Parameters<typeof reg.addHypothesis>[0]);
}

describe("question gate", () => {
	test("complete hypothesis passes", () => {
		const { reg, dir } = makeRegistry();
		const h = fullHypothesis(reg);
		const check = checkBrief(h, gatherBriefContext(reg, h));
		expect(check.pass).toBe(true);
		expect(check.missing).toHaveLength(0);
		reg.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("missing eval/anchor/held-out blocks; min effect defaults to 2x noise", () => {
		const { reg, dir } = makeRegistry();
		const h = fullHypothesis(reg, { evalRef: undefined, anchorRef: undefined, heldOutSpec: undefined, expectedGain: undefined });
		const ctx = { noiseFloorSd: 0.02 };
		const check = checkBrief(h, ctx);
		expect(check.pass).toBe(false);
		expect(check.missing.length).toBe(3);
		expect(check.questions.find((q) => q.field === "expected_gain")?.defaultAnswer).toBe("0.04");
		reg.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("min effect without measured noise floor is a must-answer; budget gets a question", () => {
		const { reg, dir } = makeRegistry();
		const h = fullHypothesis(reg, { expectedGain: undefined, budgetCap: undefined });
		const check = checkBrief(h, gatherBriefContext(reg, h));
		expect(check.pass).toBe(false);
		expect(check.missing.some((m) => m.includes("expected_gain"))).toBe(true);
		expect(check.questions.find((q) => q.field === "budget_cap")).toBeDefined();
		reg.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("gatherBriefContext reads the evaluator noise floor", () => {
		const { reg, dir } = makeRegistry();
		const h = fullHypothesis(reg);
		const ev = reg.addEvaluator({ lineId: "line-a" });
		reg.updateEvaluatorAudit(ev.id, { noiseFloor: { score: { n: 3, mean: 1, sd: 0.03 } } });
		const ctx = gatherBriefContext(reg, h);
		expect(ctx.noiseFloorSd).toBeCloseTo(0.03, 10);
		reg.close();
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("brief rendering", () => {
	test("renders seven-labelled sections with hypothesis header", () => {
		const { reg, dir } = makeRegistry();
		const h = fullHypothesis(reg);
		const text = renderBrief(h, gatherBriefContext(reg, h));
		expect(text).toContain(`Hypothesis: ${h.id} [proposed]`);
		expect(text).toContain("## 1. Line");
		expect(text).toContain("## 2. Goal");
		expect(text).toContain("## 3. Eval");
		expect(text).toContain("## 4. Record");
		expect(text).toContain("## 5. Rules");
		expect(text).toContain("## 6. Output");
		expect(text).toContain("line-a");
		expect(text).toContain("lab_verify_run");
		expect(text).toContain("RESULT_JSON");
		reg.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("renders without line binding fails loudly", () => {
		const { reg, dir } = makeRegistry();
		const h = reg.addHypothesis({
			statement: "s",
			prediction: "p",
			discriminator: "d",
			provenance: "human",
		});
		expect(() => renderBrief(h, {})).toThrow(/未绑定/);
		reg.close();
		rmSync(dir, { recursive: true, force: true });
	});
});
