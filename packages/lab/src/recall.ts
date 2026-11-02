import { LabRegistry } from "./store.ts";

/** 实验记忆查询条件 */
export interface RecallFilter {
  lineId?: string;
  name?: string;
  stage?: string;
  runKey?: string;
}

/**
 * 按条件检索指标轨迹，输出结构化文本供注入 agent 上下文。
 * 每次 record 附带 run 的模型与端点，防止不同裁判端点的指标被混读。
 */
export function recallMetrics(reg: LabRegistry, filter: RecallFilter): string {
  const rows = reg.listMetrics(filter);
  if (rows.length === 0) return "无匹配指标记录";
  const lines = rows.map(
    (m) =>
      `${m.run_key}\t${(m as { line_id?: string }).line_id ?? ""}\t${m.name}=${m.value}` +
      `\t阶段=${m.stage ?? "-"}\t模型=${(m as { model?: string }).model ?? "-"}\t端点=${(m as { endpoint?: string }).endpoint ?? "-"}` +
      (m.context ? `\t备注=${m.context}` : ""),
  );
  return ["run_key\t线\t指标\t阶段\t模型\t端点\t备注", ...lines].join("\n");
}

/**
 * 实验上下文重建：汇总一条实验线的全部认知，
 * 供新会话恢复实验状态，替代重读历史文件。
 */
export function experimentBrief(reg: LabRegistry, lineId: string): string {
  const line = reg.getLine(lineId);
  if (!line) return `实验线不存在: ${lineId}`;
  const runs = reg.listRuns(lineId);
  const parts: string[] = [];
  parts.push(`# 实验线 ${line.id}`);
  if (line.title) parts.push(`标题: ${line.title}`);
  if (line.parent_line) {
    parts.push(`fork 自: 线 ${line.parent_line}${line.forked_from_run ? `（run ${line.forked_from_run}）` : ""}`);
    if (line.note) parts.push(`fork 说明: ${line.note}`);
  }
  parts.push(`状态: ${line.status}，共 ${runs.length} 次 run`);
  if (runs.length === 0) return parts.join("\n");
  parts.push("");
  parts.push("| run | 阶段 | 模型 | 端点 | 状态 | 失败类别 | 指标 |");
  parts.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const r of runs) {
    const metrics = reg
      .listMetrics({ runKey: r.run_key })
      .map((m) => `${m.name}=${m.value}`)
      .join("，");
    parts.push(
      `| ${r.run_key} | ${r.stage ?? "-"} | ${r.model ?? "-"} | ${r.endpoint ?? "-"} | ${r.status} | ${r.fail_class ?? "-"} | ${metrics || "-"} |`,
    );
  }
  const running = runs.filter((r) => r.status === "running");
  if (running.length > 0) {
    parts.push("");
    parts.push(`未完成 run: ${running.map((r) => r.run_key).join("、")}`);
  }
  return parts.join("\n");
}
