import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { adjudicate, blockingOutstanding, expireCouncil, isStalled, outstandingIssues, renderTranscript } from "../src/council.ts";
import { LabRegistry } from "../src/store.ts";

function freshRegistry(): { reg: LabRegistry; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "pi-lab-council-"));
	const reg = new LabRegistry({ dbPath: join(dir, "lab.db"), runsRoot: join(dir, "runs") });
	return { reg, dir };
}

// LAB_ROLE 是进程级环境变量，用例结束后必须清理，避免影响其它测试的 actor 记名
afterEach(() => {
	delete process.env.LAB_ROLE;
});

describe("council ledger", () => {
	test("lifecycle: open → messages → rounds → adjudicate approved", () => {
		const { reg, dir } = freshRegistry();
		reg.createLine("line-a");
		const c = reg.openCouncil({ lineId: "line-a", topic: "评审 rag-001 的结论" });
		expect(c.id).toBe("council-line-a-001");
		expect(c.status).toBe("open");
		expect(c.round).toBe(0);
		expect(c.max_rounds).toBe(3);

		reg.bumpCouncilRound(c.id);
		expect(reg.getCouncil(c.id)?.round).toBe(1);
		const msgId = reg.addCouncilMessage({
			councilId: c.id,
			round: 1,
			role: "executor",
			content: "pass_rate 从 0.42 升到 0.48",
		});
		expect(msgId).toBeGreaterThan(0);
		reg.addCouncilMessage({ councilId: c.id, round: 1, role: "auditor", content: "held-out 上呢？", refs: "runs/rag-001" });
		reg.bumpCouncilRound(c.id);
		reg.addCouncilMessage({ councilId: c.id, round: 2, role: "executor", content: "held-out 同向 +0.05" });

		const transcript = renderTranscript(reg, c.id);
		expect(transcript).toContain(`# council ${c.id} 轮次 2/3 状态 open`);
		expect(transcript).toContain("[R1][executor] pass_rate 从 0.42 升到 0.48");
		expect(transcript).toContain("[R1][auditor] held-out 上呢？（refs: runs/rag-001）");
		const tail = renderTranscript(reg, c.id, { fromRound: 2 });
		expect(tail).toContain("[R2][executor]");
		expect(tail).not.toContain("[R1]");

		const closed = adjudicate(reg, c.id, "approved", "质疑均已回应", "runs/rag-001");
		expect(closed.status).toBe("approved");
		expect(closed.verdict).toBe("approved");
		expect(closed.verdict_refs).toBe("runs/rag-001");
		expect(closed.closed_at).toBeTruthy();
		expect(reg.getCouncil(c.id)?.status).toBe("approved");

		const actions = reg.listActivity({}).map((a) => a.action);
		expect(actions).toContain("council.open");
		expect(actions).toContain("council.message");
		expect(actions).toContain("council.verdict");
		const open = reg.listActivity({ action: "council.open" })[0];
		expect(open.detail).toContain("评审 rag-001");
		reg.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("duplicate open for the same runKey or line throws; closed councils reject messages; round cap enforced", () => {
		const { reg, dir } = freshRegistry();
		reg.createLine("dup");
		const run = reg.registerRun({ lineId: "dup" });

		const c1 = reg.openCouncil({ runKey: run.run_key, topic: "第一次质证" });
		expect(c1.id).toBe(`council-${run.run_key}`);
		expect(() => reg.openCouncil({ runKey: run.run_key, topic: "重复开" })).toThrow(/进行中的 council/);

		const c2 = reg.openCouncil({ lineId: "dup", topic: "线级质证" });
		expect(() => reg.openCouncil({ lineId: "dup", topic: "再次开" })).toThrow(/进行中的 council/);

		// 关闭后的 council 不能再发言
		reg.closeCouncil(c1.id, "rejected", "证据不足");
		expect(() =>
			reg.addCouncilMessage({ councilId: c1.id, round: 1, role: "executor", content: "补充说明" }),
		).toThrow(/已关闭/);

		// round 超出 max_rounds 抛错
		expect(() =>
			reg.addCouncilMessage({ councilId: c2.id, round: 4, role: "executor", content: "越轮发言" }),
		).toThrow(/轮次上限/);
		reg.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("outstandingIssues: counted before executor response, cleared after, empty once approved", () => {
		const { reg, dir } = freshRegistry();
		reg.createLine("iss");
		const c = reg.openCouncil({ lineId: "iss", topic: "质疑清算" });
		reg.bumpCouncilRound(c.id);
		reg.addCouncilMessage({ councilId: c.id, round: 1, role: "executor", content: "结论陈述" });
		reg.addCouncilMessage({ councilId: c.id, round: 1, role: "auditor", content: "基线配置一致吗？" });
		let issues = outstandingIssues(reg, c.id);
		expect(issues).toHaveLength(1);
		expect(issues[0].round).toBe(1);
		expect(issues[0].text).toBe("基线配置一致吗？");

		// 同轮回应（发言在质疑之后）即清算
		reg.addCouncilMessage({ councilId: c.id, round: 1, role: "executor", content: "配置 fingerprint 一致" });
		expect(outstandingIssues(reg, c.id)).toHaveLength(0);

		// 高轮次回应也清算低轮次质疑
		reg.bumpCouncilRound(c.id);
		reg.addCouncilMessage({ councilId: c.id, round: 2, role: "auditor", content: "噪声底是多少？" });
		expect(outstandingIssues(reg, c.id)).toHaveLength(1);
		reg.addCouncilMessage({ councilId: c.id, round: 2, role: "executor", content: "sd=0.01，见 noise_floor" });
		expect(outstandingIssues(reg, c.id)).toHaveLength(0);

		// approved 后返回空
		adjudicate(reg, c.id, "approved", "无未决质疑");
		expect(outstandingIssues(reg, c.id)).toHaveLength(0);
		reg.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("isStalled: true when the last auditor round raises nothing new, false otherwise", () => {
		const { reg, dir } = freshRegistry();
		reg.createLine("stall");
		const c = reg.openCouncil({ lineId: "stall", topic: "空转检测" });

		// 轮次不足 2 时不算停滞
		reg.bumpCouncilRound(c.id);
		reg.addCouncilMessage({ councilId: c.id, round: 1, role: "auditor", content: "先看数据" });
		expect(isStalled(reg, c.id)).toBe(false);

		reg.bumpCouncilRound(c.id);
		reg.addCouncilMessage({ councilId: c.id, round: 2, role: "executor", content: "数据已贴" });
		// round=2 且此前质疑已获同轮回应（id 顺序在先），最后一轮 auditor 无新质疑 → 停滞
		expect(isStalled(reg, c.id)).toBe(true);

		// 最后一轮 auditor 提出新的未决质疑 → 不停滞
		reg.addCouncilMessage({ councilId: c.id, round: 2, role: "auditor", content: "复现命令呢？" });
		expect(isStalled(reg, c.id)).toBe(false);

		// auditor 从未发言且轮次已到 2 → 停滞（先关闭前一个，同线只允许一个 open）
		expireCouncil(reg, c.id, "用例结束");
		const c2 = reg.openCouncil({ lineId: "stall", topic: "无人质询" });
		reg.bumpCouncilRound(c2.id);
		reg.bumpCouncilRound(c2.id);
		expect(isStalled(reg, c2.id)).toBe(true);
		reg.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("adjudicate requires a note; expireCouncil closes fail-closed", () => {
		const { reg, dir } = freshRegistry();
		reg.createLine("exp");
		const c = reg.openCouncil({ lineId: "exp", topic: "耗尽裁决" });
		expect(() => adjudicate(reg, c.id, "approved", "  ")).toThrow(/理由/);

		const expired = expireCouncil(reg, c.id, "三轮已尽仍有未决质疑");
		expect(expired.status).toBe("expired");
		expect(expired.closed_at).toBeTruthy();
		expect(outstandingIssues(reg, c.id)).toHaveLength(0);

		const verdict = reg.listActivity({ action: "council.verdict" })[0];
		expect(verdict.detail).toContain("expired");
		// 已关闭的 council 不能再次裁决
		expect(() => adjudicate(reg, c.id, "approved", "改判")).toThrow(/open/);
		reg.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("blocking: approved is refused for the whole session; a fresh council after the fix can approve", () => {
		const { reg, dir } = freshRegistry();
		reg.createLine("block");
		const c = reg.openCouncil({ lineId: "block", topic: "阻塞级门禁" });
		reg.bumpCouncilRound(c.id);
		reg.addCouncilMessage({ councilId: c.id, round: 1, role: "auditor", content: "建议补充噪声报告", severity: "advisory" });
		reg.addCouncilMessage({ councilId: c.id, round: 1, role: "executor", content: "噪声 sd=0.01", severity: "note" });
		const blockingId = reg.addCouncilMessage({ councilId: c.id, round: 1, role: "auditor", content: "评测集混入了训练样本", severity: "blocking" });
		// advisory 已被回应，blocking 仍未决
		expect(outstandingIssues(reg, c.id)).toHaveLength(1);
		expect(blockingOutstanding(reg, c.id)).toHaveLength(1);
		// blocking 未决时 approved 在账本层被拒（与提示词无关，fail-closed）
		expect(() => adjudicate(reg, c.id, "approved", "总体达成，附带引用约束")).toThrow(/blocking/);
		expect(reg.getCouncil(c.id)?.status).toBe("open");

		// 闩锁：执行者回应、审计员「解除登记」都会话内动作均不清除 blocking
		reg.addCouncilMessage({ councilId: c.id, round: 1, role: "executor", content: "评测集与训练集 fingerprint 分离，见 snapshot", severity: "note" });
		expect(blockingOutstanding(reg, c.id)).toHaveLength(1);
		reg.addCouncilMessage({
			councilId: c.id,
			round: 1,
			role: "auditor",
			content: `质疑已获完整回应，解除 resolve:blocking#${blockingId}，剩余动作由 chair 落账`,
			severity: "note",
		});
		expect(blockingOutstanding(reg, c.id)).toHaveLength(1);
		expect(() => adjudicate(reg, c.id, "approved", "仍想批准")).toThrow(/blocking/);

		// 唯一出路：rejected 打回，修复后新开一场 council
		const closed = adjudicate(reg, c.id, "rejected", "证据有效性缺陷成立，打回修复");
		expect(closed.status).toBe("rejected");
		// rejected 场的记录保留原样，修复后的复审依赖新场而非旧场清单

		// 修复后的新场没有 blocking 质疑，approved 放行
		const c2 = reg.openCouncil({ lineId: "block", topic: "修复后复审" });
		reg.bumpCouncilRound(c2.id);
		reg.addCouncilMessage({ councilId: c2.id, round: 1, role: "auditor", content: "已核对修复证据，无缺陷", severity: "note" });
		reg.addCouncilMessage({ councilId: c2.id, round: 1, role: "executor", content: "修复说明已入账", severity: "note" });
		const approved = adjudicate(reg, c2.id, "approved", "新场质证通过，阻塞项不存在");
		expect(approved.status).toBe("approved");
		reg.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("severity: validated values, persisted rows, transcript and activity rendering", () => {
		const { reg, dir } = freshRegistry();
		reg.createLine("sev");
		const c = reg.openCouncil({ lineId: "sev", topic: "级别校验" });
		expect(() =>
			reg.addCouncilMessage({ councilId: c.id, round: 1, role: "auditor", content: "非法级别", severity: "critical" }),
		).toThrow(/severity/);
		reg.bumpCouncilRound(c.id);
		reg.addCouncilMessage({ councilId: c.id, round: 1, role: "auditor", content: "泄漏缺陷", severity: "blocking", refs: "runs/x" });
		reg.addCouncilMessage({ councilId: c.id, round: 1, role: "executor", content: "回应" });
		const msgs = reg.councilTranscript(c.id);
		expect(msgs[0].severity).toBe("blocking");
		expect(msgs[1].severity ?? null).toBeNull();
		// 渲染层带级别标注，chair 与角色进程看到同一份事实
		expect(renderTranscript(reg, c.id)).toContain("[R1][auditor][blocking] 泄漏缺陷");
		const act = reg
			.listActivity({ action: "council.message" })
			.find((a) => a.detail?.includes("泄漏缺陷"));
		expect(act?.detail).toContain("auditor[blocking]");
		// migrate 补列：旧账本（无 severity 列）打开后可写入
		reg.close();
		const reg2 = new LabRegistry({ dbPath: join(dir, "lab.db"), runsRoot: join(dir, "runs") });
		reg2.closeCouncil(c.id, "rejected", "用例收尾");
		const c2 = reg2.openCouncil({ lineId: "sev", topic: "补列后复用" });
		reg2.bumpCouncilRound(c2.id);
		const id = reg2.addCouncilMessage({ councilId: c2.id, round: 1, role: "auditor", content: "补列后写入", severity: "advisory" });
		expect(id).toBeGreaterThan(0);
		expect(reg2.councilTranscript(c2.id).find((m) => m.id === id)?.severity).toBe("advisory");
		reg2.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("LAB_ROLE names the activity actor; unset keeps the legacy behavior", () => {
		const { reg, dir } = freshRegistry();
		process.env.LAB_ROLE = "auditor";
		const c = reg.openCouncil({ lineId: "role", topic: "角色记名" });
		reg.closeCouncil(c.id, "approved", "通过");
		const verdict = reg.listActivity({ action: "council.verdict" })[0];
		expect(verdict.actor).toBe(`auditor:pid${process.pid}`);
		reg.close();
		rmSync(dir, { recursive: true, force: true });
	});
});
