import type { CouncilMessageRow, CouncilRow, LabRegistry } from "./store.ts";

/**
 * 群聊评审（council）纯函数层：executor（执行者）、auditor（审计员）、chair（裁决主持人）
 * 在共享会话记录中对抗质证，chair 的 approved/rejected 裁决是 run 完成门禁的依据。
 * 本模块只读账本渲染视图，副作用一律经 registry 方法留痕；轮次耗尽未决即 expired，
 * 门禁不得放行（fail-closed）。
 */

export interface CouncilIssue {
	msgId: number;
	round: number;
	text: string;
	refs?: string;
	/** 审计意见的严重级别：blocking | advisory | note，旧记录未分级时为空 */
	severity?: string;
}

function requireCouncil(reg: LabRegistry, councilId: string): CouncilRow {
	const council = reg.getCouncil(councilId);
	if (!council) throw new Error(`council 不存在: ${councilId}`);
	return council;
}

/** 渲染质证记录：chair 与各角色进程据此对同一份事实发言 */
export function renderTranscript(
	reg: LabRegistry,
	councilId: string,
	opts: { fromRound?: number } = {},
): string {
	const council = requireCouncil(reg, councilId);
	const messages: CouncilMessageRow[] = reg
		.councilTranscript(councilId)
		.filter((m) => (opts.fromRound === undefined ? true : m.round >= opts.fromRound));
	const lines = [`# council ${council.id} 轮次 ${council.round}/${council.max_rounds} 状态 ${council.status}`];
	for (const m of messages) {
		lines.push(
			`[R${m.round}][${m.role}]${m.severity ? `[${m.severity}]` : ""} ${m.content}${m.refs ? `（refs: ${m.refs}）` : ""}`,
		);
	}
	return lines.join("\n");
}

/** 未决质疑：auditor 的发言是质疑。advisory/note 级质疑在出现其后的 executor 发言
 *  （round >= 该发言轮次）后视为已回应；blocking 级质疑在本场 council 内终身未决——
 *  执行者回应、审计员显式解除等会话内动作一律不清零。理由：清零规则是内容盲的，
 *  可被程序性回应、无关发言或「解除登记 + 约束条件」规避开，实测两轮对抗均被绕过；
 *  唯一可靠的出路是 rejected 打回、修复后新开一场 council（旧场裁决不作为新场证据）。
 *  approved/expired 的 council 视为终态，返回空 */
export function outstandingIssues(reg: LabRegistry, councilId: string): CouncilIssue[] {
	const council = requireCouncil(reg, councilId);
	if (council.status === "approved" || council.status === "expired") return [];
	const messages = reg.councilTranscript(councilId);
	const issues: CouncilIssue[] = [];
	for (const m of messages) {
		if (m.role !== "auditor") continue;
		if (m.severity === "blocking") {
			// 闩锁：blocking 只随本场关闭而终结
			issues.push({ msgId: m.id, round: m.round, text: m.content, refs: m.refs, severity: m.severity });
			continue;
		}
		const answered = messages.some((r) => r.role === "executor" && r.id > m.id && r.round >= m.round);
		if (!answered) issues.push({ msgId: m.id, round: m.round, text: m.content, refs: m.refs, severity: m.severity });
	}
	return issues;
}

/** 阻塞级未决质疑：未决且 severity=blocking 的审计意见。只要存在一条，裁决在机制层
 *  一律不得 approved——无论主持人如何措辞，工具层都按失败关闭处理 */
export function blockingOutstanding(reg: LabRegistry, councilId: string): CouncilIssue[] {
	return outstandingIssues(reg, councilId).filter((i) => i.severity === "blocking");
}

/** 停滞检测：round >= 2 且最近一个 auditor 轮次未提出任何新的未决质疑（发言为空，
 *  或其质疑全部已被回应），继续空转只会烧轮次，驱动层据此转入裁决 */
export function isStalled(reg: LabRegistry, councilId: string): boolean {
	const council = requireCouncil(reg, councilId);
	if (council.status !== "open" || council.round < 2) return false;
	const auditorMsgs = reg.councilTranscript(councilId).filter((m) => m.role === "auditor");
	if (auditorMsgs.length === 0) return true;
	const lastRound = Math.max(...auditorMsgs.map((m) => m.round));
	const lastRoundMsgs = auditorMsgs.filter((m) => m.round === lastRound);
	const outstanding = outstandingIssues(reg, councilId);
	return lastRoundMsgs.every((m) => !outstanding.some((i) => i.msgId === m.id));
}

/** chair 裁决：只允许对 open 的 council 做出，理由为空即抛错（裁决必须给理由）。
 *  approved 前置条件：不存在未决的阻塞级质疑（severity=blocking）。该检查在账本层执行，
 *  与提示词无关——主持人即使想带过，机制层也拒绝落账 */
export function adjudicate(
	reg: LabRegistry,
	councilId: string,
	verdict: "approved" | "rejected",
	note: string,
	refs?: string,
): CouncilRow {
	const council = requireCouncil(reg, councilId);
	if (council.status !== "open") {
		throw new Error(`council ${councilId} 已关闭（${council.status}），裁决只能对 open 的 council 做出`);
	}
	if (!note?.trim()) throw new Error("裁决必须给出理由（note 不能为空）");
	if (verdict === "approved") {
		const blocking = blockingOutstanding(reg, councilId);
		if (blocking.length > 0) {
			throw new Error(
				`council ${councilId} 仍有 ${blocking.length} 条未决的阻塞级质疑（blocking），不能批准：` +
					blocking.map((i) => `[R${i.round} msg#${i.msgId}] ${i.text.slice(0, 160)}`).join("；"),
			);
		}
	}
	return reg.closeCouncil(councilId, verdict, note, refs);
}

/** 轮次耗尽仍未决：按 expired 关闭，run 完成门禁不得放行（fail-closed） */
export function expireCouncil(reg: LabRegistry, councilId: string, note: string): CouncilRow {
	return reg.closeCouncil(councilId, "expired", note);
}
