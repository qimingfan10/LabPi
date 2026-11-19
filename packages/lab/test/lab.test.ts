import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { filterByDifficultyBand, validatePoolRows } from "../src/pool.ts";
import { pairedTest, pairedTTest, wilcoxonSignedRank } from "../src/stats.ts";
import { LabRegistry } from "../src/store.ts";

describe("lab registry", () => {
	test("line, run, metric, artifact, claim, fork", () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-lab-test-"));
		const reg = new LabRegistry({ dbPath: join(tmp, "lab.db"), runsRoot: join(tmp, "runs") });

		reg.createLine("baseline", { title: "基线" });
		const run = reg.registerRun({
			lineId: "baseline",
			stage: "eval",
			model: "m1",
			endpoint: "e1",
			config: { iterations: 2 },
		});
		expect(run.run_key).toBe("baseline-001");
		expect(run.config_fingerprint).toBeTruthy();

		reg.recordMetric(run.run_key, "weakness_total", 3.69, { stage: "eval", context: "32场景" });
		expect(reg.listMetrics({ lineId: "baseline" }).length).toBe(1);
		expect(reg.listArtifacts(run.run_key).length).toBe(1); // config.json
		reg.updateRun(run.run_key, { status: "completed" });
		expect(reg.getRun(run.run_key)?.status).toBe("completed");

		const { line } = reg.forkLine("variant", { runKey: run.run_key });
		expect(line.parent_line).toBe("baseline");

		const claim = reg.addClaim({
			statement: "variant 高于 baseline",
			evidence: [run.run_key],
			check: { metric: "weakness_total", lineA: "baseline", lineB: "variant", direction: "B>A" },
		});
		expect(claim.status).toBe("open");
		const resolved = reg.resolveClaim(claim.id, "refuted", "实测反向");
		expect(resolved.status).toBe("refuted");

		reg.close();
		rmSync(tmp, { recursive: true, force: true });
	});
});

describe("lab stats", () => {
	test("paired t matches known values", () => {
		const t = pairedTTest([1, 2, 3]);
		expect(Math.abs(t.t - 3.4641)).toBeLessThan(1e-3);
		expect(Math.abs(t.p - 0.0742)).toBeLessThan(2e-3);
	});
	test("wilcoxon exact matches known values", () => {
		const w = wilcoxonSignedRank([1, -2, 3, 4]);
		expect(w.statistic).toBe(8);
		expect(Math.abs(w.p - 0.375)).toBeLessThan(1e-9);
		expect(w.exact).toBe(true);
	});
	test("pairedTest win/tie/loss", () => {
		const r = pairedTest([0.5, -0.2, 0.8, 0.1, -0.3, 0.6, 0.2, 0.4, -0.1, 0.3]);
		expect(r.win).toBe(7);
		expect(r.loss).toBe(3);
		expect(r.n).toBe(10);
	});
});

describe("lab pool", () => {
	test("validate and difficulty band filter", () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-lab-pool-"));
		const path = join(tmp, "pool.jsonl");
		const { writeFileSync } = require("node:fs") as typeof import("node:fs");
		const rows = [
			{ scenario_id: "s1", scenario: "a", p_hat: 0.25 },
			{ scenario_id: "s2", scenario: "b", p_hat: 0.0 },
			{ scenario_id: "s3", scenario: "c", p_hat: 1.0 },
			{ scenario_id: "s4", scenario: "d", p_hat: 0.5 },
		];
		writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n"), "utf-8");
		const report = validatePoolRows(path);
		expect(report.valid).toBe(4);
		const kept = filterByDifficultyBand(rows, 0.25, 0.75);
		expect(kept.length).toBe(2);
		rmSync(tmp, { recursive: true, force: true });
	});
});

describe("lab governance", () => {
	test("metric overwrite needs revise_reason; old value kept as history", () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-lab-gov-"));
		const reg = new LabRegistry({ dbPath: join(tmp, "lab.db"), runsRoot: join(tmp, "runs") });
		reg.createLine("base");
		const run = reg.registerRun({ lineId: "base" });

		reg.recordMetric(run.run_key, "weakness_total", 3.69, { stage: "eval" });
		expect(() => reg.recordMetric(run.run_key, "weakness_total", 2.0)).toThrow(/不可覆盖/);

		const revised = reg.recordMetric(run.run_key, "weakness_total", 2.0, { reviseReason: "分母算错" });
		expect(revised.revision).toBe(2);
		// 默认视图只看当前生效版本
		const current = reg.listMetrics({ runKey: run.run_key });
		expect(current.length).toBe(1);
		expect(current[0].value).toBe(2.0);
		// 历史完整保留
		const history = reg.metricHistory(run.run_key, "weakness_total");
		expect(history.length).toBe(2);
		expect(history[0].value).toBe(3.69);
		expect(history[0].superseded_by).toBe(revised.id);
		reg.close();
		rmSync(tmp, { recursive: true, force: true });
	});

	test("circuit breaker: 3 consecutive failed runs pause the line", () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-lab-gov-"));
		const reg = new LabRegistry({ dbPath: join(tmp, "lab.db"), runsRoot: join(tmp, "runs") });
		reg.createLine("flaky");

		reg.registerRun({ lineId: "flaky" });
		reg.updateRun("flaky-001", { status: "failed", failClass: "infra_error" });
		reg.registerRun({ lineId: "flaky" });
		reg.updateRun("flaky-002", { status: "failed", failClass: "infra_error" });
		expect(reg.getLine("flaky")?.status).toBe("active");

		reg.registerRun({ lineId: "flaky" });
		reg.updateRun("flaky-003", { status: "failed", failClass: "infra_error" });
		expect(reg.getLine("flaky")?.status).toBe("paused");
		expect(() => reg.registerRun({ lineId: "flaky" })).toThrow(/熔断/);

		// 成功不计入失败：completed 重置计数
		reg.resumeLine("flaky", "换回备用端点");
		expect(reg.getLine("flaky")?.status).toBe("active");
		const run = reg.registerRun({ lineId: "flaky" });
		reg.recordMetric(run.run_key, "score", 1.0);
		reg.updateRun(run.run_key, { status: "completed" });
		expect(reg.getLine("flaky")?.consecutive_failures).toBe(0);
		reg.close();
		rmSync(tmp, { recursive: true, force: true });
	});

	test("independent verification: rerun must match ledger metrics", async () => {
		const { detectPython } = await import("../src/eval.ts");
		const { verifyRun } = await import("../src/verify.ts");
		try {
			detectPython();
		} catch {
			return; // 环境无 Python 时跳过
		}
		const tmp = mkdtempSync(join(tmpdir(), "pi-lab-gov-"));
		const reg = new LabRegistry({ dbPath: join(tmp, "lab.db"), runsRoot: join(tmp, "runs") });
		const { writeFileSync } = require("node:fs") as typeof import("node:fs");
		const script = join(tmp, "demo_eval.py");
		writeFileSync(script, 'import json\nprint("RESULT_JSON: " + json.dumps({"mean_energy": 1.25}))\n', "utf-8");

		// 一致：verified
		reg.createLine("verify-ok");
		const okRun = reg.registerRun({ lineId: "verify-ok" });
		reg.recordMetric(okRun.run_key, "mean_energy", 1.25);
		reg.setRunEvalSpec(okRun.run_key, { script, args: [], timeoutSec: 30 });
		const ok = await verifyRun(reg, tmp, okRun.run_key);
		expect(ok.status).toBe("verified");

		// 不一致：mismatch（账本里是执行者自己填的 9.99，重跑只有 1.25）
		reg.createLine("verify-bad");
		const badRun = reg.registerRun({ lineId: "verify-bad" });
		reg.recordMetric(badRun.run_key, "mean_energy", 9.99);
		reg.setRunEvalSpec(badRun.run_key, { script, args: [], timeoutSec: 30 });
		const bad = await verifyRun(reg, tmp, badRun.run_key);
		expect(bad.status).toBe("mismatch");
		expect(bad.comparisons[0].ok).toBe(false);
		expect(reg.getRun(badRun.run_key)?.verification).toBe("mismatch");
		reg.close();
		rmSync(tmp, { recursive: true, force: true });
	});
});

describe("lab lock & activity", () => {
	test("line lock: conflict, re-entrancy, expiry steal, release", async () => {
		const { sleep } = await import("../src/worker.ts");
		const tmp = mkdtempSync(join(tmpdir(), "pi-lab-lock-"));
		const reg = new LabRegistry({ dbPath: join(tmp, "lab.db"), runsRoot: join(tmp, "runs") });
		reg.createLine("lk");

		// 本进程占线（默认持有者 pid:<pid>）
		reg.acquireLineLock("lk");
		// 他人持锁被拒
		expect(() => reg.acquireLineLock("lk", { holder: "pid:999" })).toThrow(/占用/);
		// 同持有者重入即续期
		reg.acquireLineLock("lk");
		// 换持有者需先释放；短租期过期后可被接管
		reg.forceReleaseLineLock("lk", "测试切换持有者");
		reg.acquireLineLock("lk", { holder: "stale", ttlMs: 1 });
		await sleep(20);
		const stolen = reg.acquireLineLock("lk", { holder: "pid:999" });
		expect(stolen.holder).toBe("pid:999");
		const acts = reg.listActivity({ lineId: "lk" });
		expect(acts.some((a) => a.action === "lock.steal")).toBe(true);

		// 强制释放
		expect(reg.forceReleaseLineLock("lk", "确认 pid:999 已死")).toBe(true);
		expect(reg.getLineLock("lk")).toBeUndefined();

		// 有进行中的 run 时锁保持，run 终态后自动释放
		reg.acquireLineLock("lk");
		const run = reg.registerRun({ lineId: "lk" });
		expect(reg.getLineLock("lk")).toBeDefined();
		reg.updateRun(run.run_key, { status: "completed" });
		expect(reg.getLineLock("lk")).toBeUndefined();

		// 活动日志覆盖完整动作序列
		const seq = reg.listActivity({ lineId: "lk" }).map((a) => a.action);
		expect(seq).toContain("line.create");
		expect(seq).toContain("lock.acquire");
		expect(seq).toContain("run.register");
		expect(seq).toContain("run.status");
		expect(seq).toContain("lock.release");
		reg.close();
		rmSync(tmp, { recursive: true, force: true });
	});

	test("activity log: metric revise and claim resolve are recorded", () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-lab-act-"));
		const reg = new LabRegistry({ dbPath: join(tmp, "lab.db"), runsRoot: join(tmp, "runs") });
		reg.createLine("act");
		const run = reg.registerRun({ lineId: "act" });
		reg.recordMetric(run.run_key, "score", 1.0);
		reg.recordMetric(run.run_key, "score", 1.5, { reviseReason: "口径修正" });
		const claim = reg.addClaim({ statement: "act 高于基线", lineId: "act" });
		reg.resolveClaim(claim.id, "refuted", "实测反向");

		const actions = reg.listActivity({ runKey: run.run_key }).map((a) => a.action);
		expect(actions).toContain("metric.record");
		expect(actions).toContain("metric.revise");
		const revise = reg.listActivity({ action: "metric.revise" })[0];
		expect(revise.detail).toContain("1→1.5");
		const resolve = reg.listActivity({ action: "claim.resolve" })[0];
		expect(resolve.detail).toContain("refuted");
		// actor 区分角色
		expect(reg.listActivity({})[0].actor).toMatch(/^router:pid/);
		reg.close();
		rmSync(tmp, { recursive: true, force: true });
	});
});

describe("lab snapshot & drift", () => {
	test("snapshot copies script and records data/env/git fingerprints", async () => {
		const { captureSnapshot, loadSnapshot, sha256File } = await import("../src/snapshot.ts");
		const tmp = mkdtempSync(join(tmpdir(), "pi-lab-snap-"));
		const { writeFileSync } = require("node:fs") as typeof import("node:fs");
		writeFileSync(join(tmp, "demo_eval.py"), 'print("RESULT_JSON: {\\"m\\": 1}")\n', "utf-8");
		writeFileSync(join(tmp, "data.csv"), "a,b\n1,2\n", "utf-8");
		const reg = new LabRegistry({ dbPath: join(tmp, "lab.db"), runsRoot: join(tmp, "runs") });
		reg.createLine("snap");
		const run = reg.registerRun({ lineId: "snap" });
		const runDir = join(tmp, "runs", run.run_key);

		const m = captureSnapshot({ project: tmp, script: "demo_eval.py", runDir, dataPaths: ["data.csv"] });
		expect(m.script.sha256).toBe(sha256File(join(tmp, "demo_eval.py")));
		expect(m.data[0].sha256).toBe(sha256File(join(tmp, "data.csv")));
		expect(require("node:fs").existsSync(join(runDir, m.script.copy))).toBe(true);
		const loaded = loadSnapshot(runDir);
		expect(loaded?.script.sha256).toBe(m.script.sha256);
		reg.close();
		rmSync(tmp, { recursive: true, force: true });
	});

	test("verify reports drift when the evaluation script changed", async () => {
		const { detectPython } = await import("../src/eval.ts");
		const { verifyRun } = await import("../src/verify.ts");
		const { captureSnapshot } = await import("../src/snapshot.ts");
		try {
			detectPython();
		} catch {
			return;
		}
		const tmp = mkdtempSync(join(tmpdir(), "pi-lab-drift-"));
		const { writeFileSync } = require("node:fs") as typeof import("node:fs");
		const script = join(tmp, "eval.py");
		writeFileSync(script, 'import json\nprint("RESULT_JSON: " + json.dumps({"mean_energy": 1.25}))\n', "utf-8");

		const reg = new LabRegistry({ dbPath: join(tmp, "lab.db"), runsRoot: join(tmp, "runs") });
		reg.createLine("drift");
		const run = reg.registerRun({ lineId: "drift" });
		const runDir = join(tmp, "runs", run.run_key);
		reg.recordMetric(run.run_key, "mean_energy", 1.25);
		reg.setRunEvalSpec(run.run_key, { script, args: [], timeoutSec: 30 });
		const m = captureSnapshot({ project: tmp, script, runDir });
		reg.setSnapshotMeta(run.run_key, m.script.sha256, m.captured_at);

		const ok = await verifyRun(reg, tmp, run.run_key);
		expect(ok.status).toBe("verified");

		// 改动评测脚本 → 复核必须报漂移，而不是把差异算成数据造假
		writeFileSync(script, 'import json\nprint("RESULT_JSON: " + json.dumps({"mean_energy": 2.5}))\n', "utf-8");
		const drifted = await verifyRun(reg, tmp, run.run_key);
		expect(drifted.status).toBe("drift");
		expect(reg.getRun(run.run_key)?.verification).toBe("drift");
		expect(reg.listActivity({ runKey: run.run_key }).some((a) => a.action === "run.drift")).toBe(true);

		// 恢复原脚本 → 重新复核通过
		writeFileSync(script, 'import json\nprint("RESULT_JSON: " + json.dumps({"mean_energy": 1.25}))\n', "utf-8");
		const again = await verifyRun(reg, tmp, run.run_key);
		expect(again.status).toBe("verified");
		reg.close();
		rmSync(tmp, { recursive: true, force: true });
	});
});

describe("stale lock takeover", () => {
	test("registerRun steals an expired lock without manual cleanup", () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-lab-stale-"));
		const reg = new LabRegistry({ dbPath: join(tmp, "lab.db"), runsRoot: join(tmp, "runs") });
		reg.createLine("stale");
		// 模拟一个死亡进程留下的过期锁
		reg.acquireLineLock("stale", { holder: "pid:99999", ttlMs: 60_000 });
		// 把心跳拨回两小时前，等价于持锁进程两天前死亡
		reg.db
			.prepare("UPDATE line_locks SET renewed_at = ? WHERE line_id = 'stale'")
			.run(new Date(Date.now() - 7_200_000).toISOString());
		// 新进程登记 run：应自动接管，而不是报占用
		const run = reg.registerRun({ lineId: "stale" });
		expect(run.run_key).toBe("stale-001");
		expect(reg.getLineLock("stale")?.holder).toBe(`pid:${process.pid}`);
		const acts = reg.listActivity({ lineId: "stale" }).map((a) => a.action);
		expect(acts).toContain("lock.steal");
		reg.close();
		rmSync(tmp, { recursive: true, force: true });
	});
});
