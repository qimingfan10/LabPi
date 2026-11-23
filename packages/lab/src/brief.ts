import type { HypothesisRow, LabRegistry } from "./store.ts";
import { readNoiseFloor } from "./hypothesis.ts";

/**
 * 提问闸门与任务书渲染。只问会改变下一步动作的问题：
 * 判据（eval_ref）、锚（anchor_ref）、留出方案（held_out_spec）缺失 → 拒绝出任务书；
 * 最小效应与预算缺失 → 附默认答案的问题（默认来自噪声底与线历史），放行但留痕。
 */

export interface ProposedQuestion {
	field: string;
	question: string;
	defaultAnswer?: string;
}

export interface BriefCheckResult {
	pass: boolean;
	/** 缺失即拒绝出任务书的字段 */
	missing: string[];
	/** 可带默认答案放行的问题 */
	questions: ProposedQuestion[];
	notes: string[];
}

export interface BriefContext {
	/** 该线噪声底（指标标准差）；无实测时最小效应无法给默认值 */
	noiseFloorSd?: number;
	/** 该线历史单 run 预算中位数 */
	lineMedianBudget?: number;
}

export function gatherBriefContext(reg: LabRegistry, h: HypothesisRow): BriefContext {
	const ctx: BriefContext = {};
	if (h.line_id) {
		const evs = reg.listEvaluators({ lineId: h.line_id });
		const sds: number[] = [];
		for (const ev of evs) {
			for (const floor of Object.values(readNoiseFloor(ev))) {
				if (Number.isFinite(floor.sd) && floor.sd > 0) sds.push(floor.sd);
			}
		}
		if (sds.length > 0) {
			sds.sort((a, b) => a - b);
			const mid = Math.floor(sds.length / 2);
			ctx.noiseFloorSd = sds.length % 2 ? sds[mid] : (sds[mid - 1] + sds[mid]) / 2;
		}
	}
	return ctx;
}

/** 闸门：校验假设能否出任务书。必答缺失 → missing；可默认缺失 → questions */
export function checkBrief(h: HypothesisRow, ctx: BriefContext = {}): BriefCheckResult {
	const missing: string[] = [];
	const questions: ProposedQuestion[] = [];
	const notes: string[] = [];

	if (!h.eval_ref) missing.push("eval_ref（评测脚本与参数，引用前先 lab_eval_run_python 登记）");
	if (!h.anchor_ref) missing.push("anchor_ref（锚：held-out 划分、隐藏场景、固定预算或外部验证器）");
	if (!h.held_out_spec) missing.push("held_out_spec（留出验证方案：哪部分场景不参与选择、如何判定同向）");
	if (!h.line_id) missing.push("line_id（目标实验线）");

	if (h.expected_gain === undefined || h.expected_gain === null) {
		if (ctx.noiseFloorSd !== undefined && ctx.noiseFloorSd > 0) {
			questions.push({
				field: "expected_gain",
				question: "该假设的最小效应是多少（低于此增益视为无改进）？",
				defaultAnswer: String(2 * ctx.noiseFloorSd),
			});
		} else {
			missing.push("expected_gain（最小效应；该线无实测噪声底，无法给默认值，先跑 lab_noise_floor 或手工给出）");
		}
	}
	if (h.budget_cap === undefined || h.budget_cap === null) {
		if (ctx.lineMedianBudget !== undefined) {
			questions.push({
				field: "budget_cap",
				question: "该假设的单线预算上限是多少？",
				defaultAnswer: String(ctx.lineMedianBudget),
			});
		} else {
			questions.push({
				field: "budget_cap",
				question: "该假设的单线预算上限是多少？该线无历史预算记录，请显式给出。",
			});
		}
	}
	if (h.discriminator.trim().length < 8) {
		notes.push("discriminator 过短：备择解释的区分条件应具体到可观测结果，建议补充");
	}
	if (h.status === "proposed") {
		notes.push("假设尚未通过新颖性检查：出任务书前先 lab_novelty_check 并 lab_record_novelty");
	}
	return { pass: missing.length === 0, missing, questions, notes };
}

const EXECUTOR_RULES = `账本只允许通过 lab_* 工具读写：禁止用 sqlite3、node:sqlite 或直接编辑 runs/lab.db 等价替代。
所有实验先 lab_register_run 登记到该线；结果必须用 lab_record_metric 或 lab_record_scenario_scores 登记。
脚本类实验：lab_eval_run_python 执行后必须 lab_verify_run 复核，通过后才能标 completed。
失败必须落 failed 并给 fail_class，禁止编造数据；需要人决策时如实说明。
不要 fork 实验线、不要派生 worker（编排由上层负责）。
大文件用脚本程序化写出或分批追加（每批不超过 300 行），禁止一次性生成。`;

/** 六段式任务书渲染：首段固定 Hypothesis 行，供 dispatch --hypothesis 与闸门双向核对 */
export function renderBrief(h: HypothesisRow, ctx: BriefContext = {}): string {
	if (!h.line_id) throw new Error("假设未绑定实验线，无法渲染任务书");
	const anchor = h.anchor_ref ? h.anchor_ref : "（未登记）";
	const minEffect =
		h.expected_gain !== undefined && h.expected_gain !== null
			? String(h.expected_gain)
			: ctx.noiseFloorSd !== undefined
				? String(2 * ctx.noiseFloorSd)
				: "（闸门未通过，缺最小效应）";
	return `# 任务书：实验线 ${h.line_id} / 假设 ${h.id}

Hypothesis: ${h.id} [${h.status}]
Statement: ${h.statement}
Prediction: ${h.prediction}
Discriminator: ${h.discriminator}
Provenance: ${h.provenance}${h.provenance_ref ? ` (${h.provenance_ref})` : ""}

## 1. Line

目标实验线 \`${h.line_id}\`。只允许写这条线，禁止写入其他线。

## 2. Goal

验证假设 ${h.id}：${h.statement}

预测：${h.prediction}

判别条件：${h.discriminator}

${h.parent_run ? `从 run ${h.parent_run} 派生。` : ""}

## 3. Eval

评测脚本与参数：${h.eval_ref ?? "（缺失，闸门未通过）"}

锚：${anchor}

留出验证方案：${h.held_out_spec ?? "（缺失，闸门未通过）"}

评测输出必须含 \`RESULT_JSON\` 行；登记 run 前先 lab_eval_run_python。

## 4. Record

登记指标名与统计定义（禁止手工估算）；评测读取的数据文件列入 data_paths，快照会记录哈希。

最小效应：${minEffect}（低于此增益视为无改进，不作为支持证据）

停止条件：连续 ${h.kill_after ?? 3} 次 run 无增益即终止并如实标注。

${h.budget_cap !== undefined && h.budget_cap !== null ? `预算上限：${h.budget_cap}。` : "预算上限：未设（闸门未通过）。"}

## 5. Rules

${EXECUTOR_RULES}

## 6. Output

最后一行输出：\`RUN_KEY=<run_key> STATUS=<completed|failed>\`
`;
}
