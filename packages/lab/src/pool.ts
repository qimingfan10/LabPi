import { readFileSync } from "node:fs";

/**
 * 任务池 schema：SocialEvo 文档 7.8.2 的扩展版。
 * 实测难度元数据随任务落库，筛选与出题都以此为依据。
 */
export interface PoolRow {
  /** 场景标识（池内唯一） */
  scenario_id?: string;
  /** 场景描述，必填 */
  scenario: string;
  /** 人格；只注入模拟器与裁判侧，禁止进入被测模型上下文 */
  persona?: string;
  /** 多轮对话序列 */
  turns?: { role: string; content: string }[];
  /** 评价标准列表 */
  rubrics?: string[];
  /** 实测通过率（0 到 1），来自快筛 rollout */
  p_hat?: number;
  /** 难度测量时的模型标识 */
  measured_model?: string;
  /** 演化环境标记 */
  evolved?: boolean;
  [key: string]: unknown;
}

export interface PoolValidationReport {
  total: number;
  valid: number;
  problems: { line: number; problem: string }[];
}

export function validatePoolRows(path: string): PoolValidationReport {
  const lines = readFileSync(path, "utf-8").split("\n").filter((l) => l.trim());
  const problems: PoolValidationReport["problems"] = [];
  let valid = 0;
  const seen = new Set<string>();
  lines.forEach((line, idx) => {
    let row: PoolRow;
    try {
      row = JSON.parse(line) as PoolRow;
    } catch (e) {
      problems.push({ line: idx + 1, problem: `JSON 解析失败: ${(e as Error).message.slice(0, 80)}` });
      return;
    }
    if (!row.scenario || typeof row.scenario !== "string" || !row.scenario.trim()) {
      problems.push({ line: idx + 1, problem: "缺少 scenario 字段" });
      return;
    }
    if (row.turns !== undefined && !Array.isArray(row.turns)) {
      problems.push({ line: idx + 1, problem: "turns 应为数组" });
      return;
    }
    if (row.rubrics !== undefined && (!Array.isArray(row.rubrics) || row.rubrics.some((r) => typeof r !== "string"))) {
      problems.push({ line: idx + 1, problem: "rubrics 应为字符串数组" });
      return;
    }
    if (row.p_hat !== undefined && (typeof row.p_hat !== "number" || row.p_hat < 0 || row.p_hat > 1)) {
      problems.push({ line: idx + 1, problem: "p_hat 应为 0 到 1 之间的数值" });
      return;
    }
    const sid = row.scenario_id ?? row.scenario.slice(0, 32);
    if (seen.has(sid)) {
      problems.push({ line: idx + 1, problem: `scenario_id 重复: ${sid}` });
      return;
    }
    seen.add(sid);
    valid += 1;
  });
  return { total: lines.length, valid, problems };
}

/**
 * 难度带筛选：保留通过率在 [keepMin, keepMax] 的任务。
 * 全通过与全失败双向清理，缺实测通过率的任务默认保留。
 */
export function filterByDifficultyBand(rows: PoolRow[], keepMin: number, keepMax: number): PoolRow[] {
  return rows.filter((r) => {
    if (typeof r.p_hat !== "number") return true;
    return r.p_hat >= keepMin && r.p_hat <= keepMax;
  });
}

export interface PoolStats {
  total: number;
  withDifficulty: number;
  difficultyHistogram: Record<string, number>;
  evolvedCount: number;
  dimensionCoverage: Record<string, number>;
}

export function poolStats(path: string): PoolStats {
  const rows = readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as PoolRow);
  const histogram: Record<string, number> = {};
  let withDifficulty = 0;
  for (const r of rows) {
    if (typeof r.p_hat !== "number") continue;
    withDifficulty += 1;
    const bucket = r.p_hat === 0 ? "0" : r.p_hat === 1 ? "1" : `${Math.floor(r.p_hat * 10) / 10}-${Math.ceil(r.p_hat * 10) / 10}`;
    histogram[bucket] = (histogram[bucket] ?? 0) + 1;
  }
  const dimensions: Record<string, number> = {};
  for (const r of rows) {
    for (const rub of r.rubrics ?? []) {
      // 维度名从 rubric 文本首段提取（如 "Emotion Understanding: ..."）
      const dim = rub.split(/[:：]/)[0].trim().slice(0, 40);
      if (dim) dimensions[dim] = (dimensions[dim] ?? 0) + 1;
    }
  }
  return {
    total: rows.length,
    withDifficulty,
    difficultyHistogram: histogram,
    evolvedCount: rows.filter((r) => r.evolved).length,
    dimensionCoverage: dimensions,
  };
}
