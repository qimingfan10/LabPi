import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import {
	buildLabStateCard,
	createLabToolDefinitions,
	getLabRegistry,
	labBeforeToolCheck,
} from "../src/core/tools/lab.ts";

/**
 * 群聊评审（council）接入工具层的门禁：LAB_ROLE 角色分工（审计员只质证、
 * 主持人只裁决、执行者不自裁）与裁决硬门禁（run 标 completed 前必须有
 * approved council，fail-closed）。此前 council 账本层已由 lab 包测试覆盖，
 * 本文件只验证工具层接线与门禁行为。
 *
 * getLabRegistry 是模块级单例（按首次 cwd 绑定），本文件共用一个临时目录，
 * 每个用例自行清理 env（含 LAB_ROLE）。
 */
const dir = mkdtempSync(join(tmpdir(), "pi-lab-council-gate-"));

const tools = Object.fromEntries(createLabToolDefinitions(dir).map((t) => [t.name, t]));

function payload(result: AgentToolResult<undefined>): unknown {
	return JSON.parse((result.content[0] as { text: string }).text);
}

afterEach(() => {
	delete process.env.LAB_LINE_ID;
	delete process.env.LAB_HYPOTHESIS_ID;
	delete process.env.LAB_ROLE;
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

describe("lab council gate", () => {
	test("without LAB_ROLE the four council tools run the full open -> post -> verdict chain", async () => {
		const reg = getLabRegistry(dir);
		const opened = await tools.lab_council_open.execute(
			"t",
			{
				run_key: "council-run-1",
				topic: "评审 rag-001 的完成声明：目标逐项对照",
			},
			undefined,
			undefined,
			{} as ExtensionToolContext,
		);
		const council = payload(opened) as { id: string; status: string; round: number };
		expect(council.status).toBe("open");
		expect(council.id).toBe("council-council-run-1");

		const posted = await tools.lab_council_post.execute(
			"t",
			{
				council_id: council.id,
				content: "weakness_total 声称 -8%，基线配置一致吗？",
				refs: JSON.stringify({ run_key: "council-run-1", artifact: "results/per_scenario.json" }),
			},
			undefined,
			undefined,
			{} as ExtensionToolContext,
		);
		expect(payload(posted)).toMatchObject({ council: council.id, round: 1, role: "executor" });

		const read = await tools.lab_council_read.execute(
			"t",
			{ council_id: council.id },
			undefined,
			undefined,
			{} as ExtensionToolContext,
		);
		const text = (read.content[0] as { text: string }).text;
		expect(text).toContain(`council ${council.id}`);
		expect(text).toContain("[R1][executor]");

		const verdict = await tools.lab_council_verdict.execute(
			"t",
			{
				council_id: council.id,
				verdict: "approved",
				note: "已复核 runs/council-run-1 的 per_scenario.json，逐项目标同向",
				refs: "runs/council-run-1/results/per_scenario.json",
			},
			undefined,
			undefined,
			{} as ExtensionToolContext,
		);
		expect(payload(verdict)).toMatchObject({ status: "approved" });
		expect(reg.getCouncil(council.id)?.status).toBe("approved");
	});

	test("LAB_ROLE=auditor: ledger writes and verdict are denied, council_post is allowed", async () => {
		process.env.LAB_ROLE = "auditor";
		for (const [tool, args] of [
			["lab_record_metric", { run_key: "r", name: "m", value: 1 }],
			["lab_record_scenario_scores", { run_key: "r", metric_name: "m", scores: [] }],
			["lab_update_run", { run_key: "r", status: "completed" }],
			["lab_verify_run", { run_key: "r" }],
			["lab_council_verdict", { council_id: "c", verdict: "approved", note: "n" }],
			["lab_fork_line", { new_id: "x" }],
			["lab_worker_spawn", { line_id: "x", task: "t" }],
		] as const) {
			const verdict = labBeforeToolCheck(dir, tool, args);
			expect(verdict?.block, `${tool} should be denied for auditor`).toBe(true);
			expect(verdict?.reason).toContain("auditor");
		}
		// 质证是审计员的本职：放行
		expect(labBeforeToolCheck(dir, "lab_council_post", { council_id: "c", content: "s" })).toBeUndefined();
		expect(labBeforeToolCheck(dir, "lab_council_read", {})).toBeUndefined();
	});

	test("LAB_ROLE=chair: council_post is denied, council_verdict is allowed", () => {
		process.env.LAB_ROLE = "chair";
		const post = labBeforeToolCheck(dir, "lab_council_post", { council_id: "c", content: "s" });
		expect(post?.block).toBe(true);
		expect(post?.reason).toContain("chair");
		expect(
			labBeforeToolCheck(dir, "lab_council_verdict", { council_id: "c", verdict: "approved", note: "n" }),
		).toBeUndefined();
	});

	test("LAB_ROLE=executor: council_verdict is denied", () => {
		process.env.LAB_ROLE = "executor";
		const verdict = labBeforeToolCheck(dir, "lab_council_verdict", {
			council_id: "c",
			verdict: "approved",
			note: "n",
		});
		expect(verdict?.block).toBe(true);
		expect(verdict?.reason).toContain("executor");
		// 执行者照常登记证据与回应质证
		expect(labBeforeToolCheck(dir, "lab_council_post", { council_id: "c", content: "s" })).toBeUndefined();
		const reg = getLabRegistry(dir);
		if (!reg.getLine("exec-line")) reg.createLine("exec-line");
		const run = reg.registerRun({ lineId: "exec-line" });
		expect(
			labBeforeToolCheck(dir, "lab_record_metric", { run_key: run.run_key, name: "m", value: 1 }),
		).toBeUndefined();
	});

	test("completion gate: metrics + verified but no approved council blocks; approval releases it", async () => {
		const reg = getLabRegistry(dir);
		if (!reg.getLine("gate-line")) reg.createLine("gate-line");
		const run = reg.registerRun({ lineId: "gate-line", title: "council gate fixture" });
		reg.recordMetric(run.run_key, "weakness_total", 0.42, { stage: "eval" });
		reg.setVerification(run.run_key, "verified", "fixture 复核通过");
		const complete = {
			run_key: run.run_key,
			status: "completed",
			evidence_class: "manual",
			note: "人工核对 results/per_scenario.json",
		};

		// 证据齐备但没有 approved council → 拦
		const blocked = labBeforeToolCheck(dir, "lab_update_run", complete);
		expect(blocked?.block).toBe(true);
		expect(blocked?.reason).toContain("lab_council_open");

		// open 状态的 council 同样拦（fail-closed：只有 approved 放行）
		const opened = await tools.lab_council_open.execute(
			"t",
			{ run_key: run.run_key, topic: "评审完成声明" },
			undefined,
			undefined,
			{} as ExtensionToolContext,
		);
		const council = payload(opened) as { id: string };
		const stillBlocked = labBeforeToolCheck(dir, "lab_update_run", complete);
		expect(stillBlocked?.block).toBe(true);

		// 状态卡出现待质证块
		const card = buildLabStateCard(dir);
		expect(card).toContain(`council ${council.id} 待质证`);

		// chair 裁决 approved → 门禁放行
		await tools.lab_council_verdict.execute(
			"t",
			{
				council_id: council.id,
				verdict: "approved",
				note: "已复核证据，逐项目标同向",
				refs: run.run_key,
			},
			undefined,
			undefined,
			{} as ExtensionToolContext,
		);
		expect(labBeforeToolCheck(dir, "lab_update_run", complete)).toBeUndefined();
		expect(buildLabStateCard(dir)).not.toContain("待质证");
	});

	test("verdict gate: approved is refused while a blocking issue is outstanding; rejected goes through", async () => {
		const reg = getLabRegistry(dir);
		if (!reg.getLine("block-line")) reg.createLine("block-line");
		const run = reg.registerRun({ lineId: "block-line", title: "blocking verdict fixture" });

		const opened = await tools.lab_council_open.execute(
			"t",
			{ run_key: run.run_key, topic: "评审可疑的成功率" },
			undefined,
			undefined,
			{} as ExtensionToolContext,
		);
		const council = payload(opened) as { id: string };

		// auditor 以 blocking 登记缺陷
		await tools.lab_council_post.execute(
			"t",
			{
				council_id: council.id,
				role: "auditor",
				content: "评测脚本捕获异常样本后不计数，成功率虚高，目标不可判定",
				refs: "runs/" + run.run_key + "/results/eval.json",
				severity: "blocking",
			},
			undefined,
			undefined,
			{} as ExtensionToolContext,
		);

		// 工具层 read 显示 blocking 计数
		const read = await tools.lab_council_read.execute(
			"t",
			{ council_id: council.id },
			undefined,
			undefined,
			{} as ExtensionToolContext,
		);
		const readText = (read.content[0] as { text: string }).text;
		expect(readText).toContain("blocking 1 条");
		expect(readText).toContain("[blocking]");

		// chair 想批准 → 工具层直接拒绝并列出未决阻塞项，账本仍 open
		const refused = await tools.lab_council_verdict.execute(
			"t",
			{
				council_id: council.id,
				verdict: "approved",
				note: "旧场已 approved，本场按既有结论放行",
				refs: "council-prev",
			},
			undefined,
			undefined,
			{} as ExtensionToolContext,
		);
		const refusedText = (refused.content[0] as { text: string }).text;
		expect(refusedText).toContain("approved 被拒绝");
		expect(refusedText).toContain("成功率虚高");
		expect(reg.getCouncil(council.id)?.status).toBe("open");
		// 完成门禁同步保持拦截
		reg.recordMetric(run.run_key, "success_rate", 0.99, { stage: "eval" });
		reg.setVerification(run.run_key, "verified", "fixture");
		expect(
			labBeforeToolCheck(dir, "lab_update_run", {
				run_key: run.run_key,
				status: "completed",
				evidence_class: "manual",
				note: "n",
			})?.block,
		).toBe(true);

		// rejected 不被阻塞项拦截
		const rejected = await tools.lab_council_verdict.execute(
			"t",
			{ council_id: council.id, verdict: "rejected", note: "静默丢弃异常样本，成功率不可判定", refs: run.run_key },
			undefined,
			undefined,
			{} as ExtensionToolContext,
		);
		expect(payload(rejected)).toMatchObject({ status: "rejected" });
		expect(reg.getCouncil(council.id)?.status).toBe("rejected");
	});
});
