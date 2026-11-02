import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LabRegistry } from "../src/store.ts";
import { pairedTest, wilcoxonSignedRank, pairedTTest } from "../src/stats.ts";
import { validatePoolRows, filterByDifficultyBand } from "../src/pool.ts";

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
