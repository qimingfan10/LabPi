import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { auditEvaluator, computeNoiseFloor } from "../src/audit.ts";
import { detectPython } from "../src/eval.ts";
import { LabRegistry } from "../src/store.ts";

function makeRegistry() {
	const dir = mkdtempSync(join(tmpdir(), "pi-lab-audit-"));
	const reg = new LabRegistry({ dbPath: join(dir, "lab.db"), runsRoot: join(dir, "runs") });
	return { reg, dir };
}

function pythonAvailable(): boolean {
	try {
		detectPython();
		return true;
	} catch {
		return false;
	}
}

describe("noise floor", () => {
	test("measures sd across same-config verified runs and persists it", () => {
		const { reg, dir } = makeRegistry();
		reg.createLine("line-a");
		for (const value of [0.5, 0.52, 0.48]) {
			const run = reg.registerRun({ lineId: "line-a", config: { fixed: 1 } });
			reg.recordMetric(run.run_key, "score", value);
			reg.setVerification(run.run_key, "verified", "ok");
		}
		// 不同配置的 run 不进入同一组
		const other = reg.registerRun({ lineId: "line-a", config: { fixed: 2 } });
		reg.recordMetric(other.run_key, "score", 0.9);
		reg.setVerification(other.run_key, "verified", "ok");

		const result = computeNoiseFloor(reg, { lineId: "line-a", metric: "score" });
		expect(result.status).toBe("ok");
		expect(result.n).toBe(3);
		expect(result.sd).toBeCloseTo(0.02, 10);
		expect(result.mean).toBeCloseTo(0.5, 10);
		const ev = reg.getEvaluator(result.evaluatorId!);
		expect(ev?.noise_floor).toContain("score");
		reg.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("reports insufficient below minRuns", () => {
		const { reg, dir } = makeRegistry();
		reg.createLine("line-a");
		for (const value of [0.5, 0.6]) {
			const run = reg.registerRun({ lineId: "line-a", config: { fixed: 1 } });
			reg.recordMetric(run.run_key, "score", value);
			reg.setVerification(run.run_key, "verified", "ok");
		}
		const result = computeNoiseFloor(reg, { lineId: "line-a", metric: "score" });
		expect(result.status).toBe("insufficient");
		expect(result.note).toContain("不足");
		reg.close();
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("evaluator audit", () => {
	test("requires a verified run with eval spec", async () => {
		const { reg, dir } = makeRegistry();
		reg.createLine("line-a");
		const ev = reg.addEvaluator({ lineId: "line-a" });
		await expect(auditEvaluator(reg, dir, ev.id)).rejects.toThrow(/没有带 eval_spec/);
		reg.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("determinism probe and fault probes", async () => {
		if (!pythonAvailable()) {
			// 无 Python 环境时跳过：审计本身依赖真实评测脚本
			return;
		}
		const { reg, dir } = makeRegistry();
		reg.createLine("line-a");
		const script = join(dir, "eval_ok.py");
		const probe = join(dir, "eval_bad.py");
		writeFileSync(script, 'print(\'RESULT_JSON: {"score": 1.0}\')\n', "utf-8");
		// 探针与参考值一致：评测器分辨不出坏实现 → 记一次漏检
		writeFileSync(probe, 'print(\'RESULT_JSON: {"score": 1.0}\')\n', "utf-8");
		const run = reg.registerRun({ lineId: "line-a" });
		reg.recordMetric(run.run_key, "score", 1.0);
		reg.setRunEvalSpec(run.run_key, { script, probes: [{ script: probe }] });
		reg.setVerification(run.run_key, "verified", "ok");
		const ev = reg.addEvaluator({ lineId: "line-a", scriptPath: script });
		const result = await auditEvaluator(reg, dir, ev.id);
		expect(result.deterministic).toBe("pass");
		expect(result.probeCount).toBe(1);
		expect(result.missCount).toBe(1);
		expect(result.missRate).toBe(1);
		expect(reg.getEvaluator(ev.id)?.audit_miss_rate).toBe(1);
		reg.close();
		rmSync(dir, { recursive: true, force: true });
	}, 60_000);
});
