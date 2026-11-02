import { createHash } from "node:crypto";

export function nowIso(): string {
  return new Date().toISOString();
}

/** 对象的稳定序列化（键排序），用于配置指纹 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortValue((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** 12 位短哈希，用于配置与端点指纹 */
export function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}
