/**
 * 配对统计检验：与 ablation_paired_test.py 的口径一致。
 * Wilcoxon 符号秩在 n<=16 时用精确枚举，更大样本用正态近似；
 * 配对 t 检验经不完全贝塔函数计算双侧 p 值。
 */

export interface PairedTestResult {
  n: number;
  /** 配对差均值 */
  meanDiff: number;
  /** 胜平负计数（正差为胜） */
  win: number;
  tie: number;
  loss: number;
  wilcoxon: { statistic: number; p: number; exact: boolean };
  pairedT: { t: number; df: number; p: number };
}

export function pairedTest(pairs: number[]): PairedTestResult {
  const diffs = pairs.filter((d) => Number.isFinite(d));
  const n = diffs.length;
  if (n === 0) throw new Error("配对样本为空");
  const meanDiff = diffs.reduce((a, b) => a + b, 0) / n;
  const win = diffs.filter((d) => d > 0).length;
  const tie = diffs.filter((d) => d === 0).length;
  const loss = diffs.filter((d) => d < 0).length;
  return {
    n,
    meanDiff,
    win,
    tie,
    loss,
    wilcoxon: wilcoxonSignedRank(diffs),
    pairedT: pairedTTest(diffs),
  };
}

/** Wilcoxon 符号秩检验（双侧 p 值） */
export function wilcoxonSignedRank(diffs: number[]): { statistic: number; p: number; exact: boolean } {
  const nonzero = diffs.filter((d) => d !== 0).map((d) => Math.abs(d));
  const n = nonzero.length;
  if (n === 0) return { statistic: 0, p: 1, exact: true };
  const signs = diffs.filter((d) => d !== 0).map((d) => (d > 0 ? 1 : -1));

  // 平均秩
  const sortedIdx = nonzero.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && sortedIdx[j + 1].v === sortedIdx[i].v) j++;
    const avgRank = (i + j + 2) / 2;
    for (let k = i; k <= j; k++) ranks[sortedIdx[k].i] = avgRank;
    i = j + 1;
  }
  const wPlus = signs.reduce((acc, s, idx) => acc + (s > 0 ? ranks[idx] : 0), 0);

  if (n <= 16) {
    // 精确枚举 2^n 种符号组合
    const total = 2 ** n;
    let ge = 0;
    let le = 0;
    for (let mask = 0; mask < total; mask++) {
      let w = 0;
      for (let b = 0; b < n; b++) {
        if (mask & (1 << b)) w += ranks[b];
      }
      if (w >= wPlus) ge++;
      if (w <= wPlus) le++;
    }
    const p = Math.min(1, (2 * Math.min(ge, le)) / total);
    return { statistic: wPlus, p, exact: true };
  }

  const mu = (n * (n + 1)) / 4;
  const sigma = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24);
  const z = (wPlus - mu) / sigma;
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return { statistic: wPlus, p, exact: false };
}

/** 配对 t 检验（双侧 p 值） */
export function pairedTTest(diffs: number[]): { t: number; df: number; p: number } {
  const n = diffs.length;
  if (n < 2) return { t: Number.NaN, df: n - 1, p: Number.NaN };
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const variance = diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  if (sd === 0) return { t: mean > 0 ? Number.POSITIVE_INFINITY : mean < 0 ? Number.NEGATIVE_INFINITY : 0, df: n - 1, p: mean === 0 ? 1 : 0 };
  const t = mean / (sd / Math.sqrt(n));
  const df = n - 1;
  // 双侧 p = I_{df/(df+t^2)}(df/2, 1/2)
  const x = df / (df + t * t);
  const p = incompleteBeta(x, df / 2, 0.5);
  return { t, df, p };
}

function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function erf(x: number): number {
  // Abramowitz-Stegun 7.1.26
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

function logGamma(z: number): number {
  // Lanczos 近似
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < g.length; i++) x += g[i] / (z + i + 1);
  const t = z + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function betacf(a: number, b: number, x: number): number {
  // Numerical Recipes 的连分式
  const MAXIT = 200;
  const EPS = 3e-12;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** 正则化不完全贝塔函数 I_x(a, b) */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}
