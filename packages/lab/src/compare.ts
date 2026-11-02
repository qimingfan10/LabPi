import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LabRegistry, type MetricRow, type RunRow } from "./store.ts";
import { pairedTest, type PairedTestResult } from "./stats.ts";

export interface LineComparison {
  lineA: string;
  lineB: string;
  runsA: RunRow[];
  runsB: RunRow[];
  /** 两线同名指标的配对检验（按记录时间顺序对齐） */
  metricComparisons: {
    metric: string;
    valuesA: number[];
    valuesB: number[];
    test: PairedTestResult;
  }[];
  warnings: string[];
}

function metricKey(m: MetricRow & { model?: string; endpoint?: string }): string {
  // 配对单位是同名指标；端点（裁判测量条件）必须一致，模型是被比较对象
  return `${m.name}@${(m as { endpoint?: string }).endpoint ?? "-"}`;
}

/**
 * 两条实验线的对比：run 与指标轨迹对照 + 同名指标配对检验。
 * 可比性检查：任一指标的模型或端点指纹不一致时产出警告，
 * 拒绝把不同测量条件的数值混入同一配对。
 */
export function compareLines(reg: LabRegistry, lineA: string, lineB: string): LineComparison {
  const a = reg.getLine(lineA);
  const b = reg.getLine(lineB);
  if (!a) throw new Error(`实验线不存在: ${lineA}`);
  if (!b) throw new Error(`实验线不存在: ${lineB}`);

  const runsA = reg.listRuns(lineA);
  const runsB = reg.listRuns(lineB);
  const metricsA = reg.listMetrics({ lineId: lineA });
  const metricsB = reg.listMetrics({ lineId: lineB });

  const warnings: string[] = [];
  const namesA = new Map<string, number[]>();
  const namesB = new Map<string, number[]>();
  for (const m of metricsA) {
    const k = metricKey(m as MetricRow & { model?: string; endpoint?: string });
    namesA.set(k, [...(namesA.get(k) ?? []), m.value]);
  }
  for (const m of metricsB) {
    const k = metricKey(m as MetricRow & { model?: string; endpoint?: string });
    namesB.set(k, [...(namesB.get(k) ?? []), m.value]);
  }

  const metricComparisons: LineComparison["metricComparisons"] = [];
  for (const [k, valuesA] of namesA) {
    const valuesB = namesB.get(k);
    if (!valuesB) continue;
    const n = Math.min(valuesA.length, valuesB.length);
    if (n === 0) continue;
    if (valuesA.length !== valuesB.length) {
      warnings.push(`指标 ${k} 两线记录数不同（${valuesA.length} 对 ${valuesB.length}），按时间序对齐前 ${n} 条`);
    }
    metricComparisons.push({
      metric: k,
      valuesA: valuesA.slice(0, n),
      valuesB: valuesB.slice(0, n),
      test: pairedTest(valuesA.slice(0, n).map((v, i) => v - valuesB[i])),
    });
  }
  for (const k of namesB.keys()) {
    if (!namesA.has(k)) {
      warnings.push(`指标 ${k} 仅存在于其中一条线，未纳入配对检验`);
    }
  }

  return { lineA, lineB, runsA, runsB, metricComparisons, warnings };
}

export interface ScenarioComparison {
  runA: string;
  runB: string;
  n: number;
  test: PairedTestResult;
  perScenario: { scenarioId: string; scoreA: number; scoreB: number; diff: number }[];
}

interface ScenarioScore {
  scenario_id: string;
  score: number;
}

/**
 * 逐场景配对检验：读取两 run 的 results/per_scenario.json 工件，
 * 按 scenario_id 配对后检验。历史消融的可信度正依赖逐任务配对。
 */
export function compareScenarios(reg: LabRegistry, runA: string, runB: string): ScenarioComparison {
  const read = (runKey: string): Map<string, number> => {
    const run = reg.getRun(runKey);
    if (!run) throw new Error(`run 不存在: ${runKey}`);
    const artifact = reg
      .listArtifacts(runKey)
      .filter((a) => a.rel_path === "results/per_scenario.json")
      .at(-1);
    if (!artifact) throw new Error(`run ${runKey} 缺少 results/per_scenario.json 工件`);
    const rows = JSON.parse(readFileSync(join(reg.runDir(runKey), "results/per_scenario.json"), "utf-8")) as ScenarioScore[];
    return new Map(rows.map((r) => [r.scenario_id, r.score]));
  };
  const mapA = read(runA);
  const mapB = read(runB);
  const shared = [...mapA.keys()].filter((k) => mapB.has(k)).sort((x, y) => Number(x) - Number(y));
  if (shared.length === 0) throw new Error("两 run 无共同场景，无法配对");
  const perScenario = shared.map((id) => ({
    scenarioId: id,
    scoreA: mapA.get(id)!,
    scoreB: mapB.get(id)!,
    diff: mapA.get(id)! - mapB.get(id)!,
  }));
  return {
    runA,
    runB,
    n: perScenario.length,
    test: pairedTest(perScenario.map((p) => p.diff)),
    perScenario,
  };
}
