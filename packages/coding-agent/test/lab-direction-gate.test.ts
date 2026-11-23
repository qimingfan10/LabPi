import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { getLabRegistry, labBeforeToolCheck } from "../src/core/tools/lab.ts";

/**
 * 方向层闸门：worker 进程被禁止做方向操作；dispatch --hypothesis 派发的
 * 进程必须把 run 挂在被派发的假设上。此前该闸门零测试覆盖。
 *
 * getLabRegistry 是模块级单例（按首次 cwd 绑定），本文件共用一个临时目录，
 * 每个用例自行清理 env。
 */
const dir = mkdtempSync(join(tmpdir(), "pi-lab-gate-"));

afterEach(() => {
	delete process.env.LAB_LINE_ID;
	delete process.env.LAB_HYPOTHESIS_ID;
});

afterAll(() => {
	// 单例 registry 仍持有 sqlite 句柄，Windows 下先关闭再删目录
	try {
		getLabRegistry(dir).close();
	} catch {
		// registry 未创建或已关闭
	}
	rmSync(dir, { recursive: true, force: true });
});

describe("lab direction gate", () => {
	test("worker cannot perform router-only direction operations", () => {
		process.env.LAB_LINE_ID = "line-a";
		for (const tool of [
			"lab_propose_hypothesis",
			"lab_rank_hypotheses",
			"lab_novelty_check",
			"lab_record_novelty",
			"lab_write_brief",
			"lab_decide_hypothesis",
			"lab_noise_floor",
			"lab_audit_evaluator",
			"lab_fork_line",
		]) {
			const verdict = labBeforeToolCheck(dir, tool, {});
			expect(verdict?.block, `${tool} should be blocked for workers`).toBe(true);
		}
		// 只读视图放行
		expect(labBeforeToolCheck(dir, "lab_list_hypotheses", {})).toBeUndefined();
	});

	test("dispatch-bound run must carry the bound hypothesis id", () => {
		const reg = getLabRegistry(dir);
		if (!reg.getLine("line-a")) reg.createLine("line-a");
		const h = reg.addHypothesis({
			statement: "s",
			prediction: "p",
			discriminator: "d",
			provenance: "human",
			lineId: "line-a",
		});
		reg.updateHypothesis(h.id, { status: "queued" });
		process.env.LAB_HYPOTHESIS_ID = h.id;

		// 缺 hypothesis_id → 拒
		const missing = labBeforeToolCheck(dir, "lab_register_run", { line_id: "line-a" });
		expect(missing?.block).toBe(true);
		// 假设 id 不一致 → 拒
		const mismatch = labBeforeToolCheck(dir, "lab_register_run", { line_id: "line-a", hypothesis_id: "H-9999" });
		expect(mismatch?.block).toBe(true);
		// 一致且假设 queued → 放行
		const ok = labBeforeToolCheck(dir, "lab_register_run", { line_id: "line-a", hypothesis_id: h.id });
		expect(ok).toBeUndefined();
		// 终态假设 → 拒
		reg.updateHypothesis(h.id, { status: "running" });
		reg.decideHypothesis(h.id, "killed", { note: "test" });
		const terminal = labBeforeToolCheck(dir, "lab_register_run", { line_id: "line-a", hypothesis_id: h.id });
		expect(terminal?.block).toBe(true);
	});

	test("router sessions (no LAB_LINE_ID) may use direction tools", () => {
		delete process.env.LAB_LINE_ID;
		delete process.env.LAB_HYPOTHESIS_ID;
		expect(labBeforeToolCheck(dir, "lab_propose_hypothesis", {})).toBeUndefined();
		expect(labBeforeToolCheck(dir, "lab_rank_hypotheses", {})).toBeUndefined();
	});
});
