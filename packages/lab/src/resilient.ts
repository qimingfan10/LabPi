import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const nowIso = (): string => new Date().toISOString();

/** 单个 LLM 端点配置（裁判与评测调用使用；agent 自身调用由 pi 的 provider 层承担） */
export interface EndpointConfig {
	baseUrl: string;
	model: string;
	apiKey?: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
}

/** 端点清单：yaml/json 由调用方解析后传入 */
export interface EndpointsFile {
	default: string;
	endpoints: Record<string, EndpointConfig>;
}

export type LlmFailClass = "infra_error" | "format_violation";

export interface ResilientEndpoint {
  name: string;
  config: EndpointConfig;
  apiKey?: string;
}

export interface ResilientOptions {
  /** 按优先级排序的端点列表；首选故障时自动回退 */
  endpoints: ResilientEndpoint[];
  /** 审计日志 JSONL 路径；每次调用一行 */
  auditPath?: string;
  /** 单端点内最大尝试次数 */
  maxRetries?: number;
  /** 指数退避基数（毫秒），封顶 30 秒 */
  baseDelayMs?: number;
  /** 单请求超时（毫秒） */
  timeoutMs?: number;
}

export interface CallMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CallResult {
  ok: boolean;
  endpoint?: string;
  model?: string;
  content?: string;
  reasoning?: string;
  failClass?: LlmFailClass;
  error?: string;
  latencyMs: number;
  attempts: number;
}

export interface ProbeResult {
  endpoint: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

interface AuditLine {
  ts: string;
  endpoint: string;
  model: string;
  prompt_chars: number;
  response_chars: number;
  latency_ms: number;
  attempts: number;
  ok: boolean;
  fail_class?: string;
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 科研场景可靠 LLM 调用底座。
 *
 * 硬约束：任何失败都返回显式分类的 CallResult，禁止静默成功或静默空内容；
 * infra 层故障与格式违规分开计数；每次调用写审计日志。
 * 裁判类批处理调用与 agent 自身调用共用同一份端点配置。
 */
export class ResilientLLM {
  private readonly endpoints: ResilientEndpoint[];
  private readonly auditPath?: string;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly timeoutMs: number;
  private stats = new Map<string, { calls: number; infra: number; format: number; ok: number }>();

  constructor(opts: ResilientOptions) {
    if (opts.endpoints.length === 0) throw new Error("ResilientLLM 需要至少一个端点");
    this.endpoints = opts.endpoints;
    this.auditPath = opts.auditPath;
    this.maxRetries = opts.maxRetries ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 2000;
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    if (this.auditPath) {
      mkdirSync(dirname(this.auditPath), { recursive: true });
    }
  }

  static fromEndpointsFile(
    file: EndpointsFile,
    opts: { order?: string[]; auditPath?: string; maxRetries?: number; baseDelayMs?: number; timeoutMs?: number } = {},
  ): ResilientLLM {
    const names = opts.order ?? [file.default, ...Object.keys(file.endpoints).filter((k) => k !== file.default)];
    const endpoints = names
      .filter((n) => file.endpoints[n] !== undefined)
      .map((n) => ({ name: n, config: file.endpoints[n], apiKey: file.endpoints[n].apiKey }));
    return new ResilientLLM({ endpoints, ...opts });
  }

  private touch(endpoint: string, kind: "calls" | "infra" | "format" | "ok"): void {
    const s = this.stats.get(endpoint) ?? { calls: 0, infra: 0, format: 0, ok: 0 };
    s[kind] += 1;
    this.stats.set(endpoint, s);
  }

  private writeAudit(line: AuditLine): void {
    if (!this.auditPath) return;
    appendFileSync(this.auditPath, JSON.stringify(line) + "\n", "utf-8");
  }

  /** 探活：向端点发一条最小请求，返回延迟 */
  async probe(endpointName?: string): Promise<ProbeResult> {
    const target = endpointName
      ? this.endpoints.find((e) => e.name === endpointName)
      : this.endpoints[0];
    if (!target) return { endpoint: endpointName ?? "", ok: false, latencyMs: 0, error: "端点未定义" };
    const t0 = Date.now();
    const result = await this.requestOnce(target.config, target.apiKey, [
      { role: "user", content: "ping，只回复 pong" },
    ], 32);
    return {
      endpoint: target.name,
      ok: result.ok,
      latencyMs: Date.now() - t0,
      error: result.ok ? undefined : result.error,
    };
  }

  /** 探测全部端点，返回按延迟排序的可用性报告 */
  async probeAll(): Promise<ProbeResult[]> {
    const results = await Promise.all(this.endpoints.map((e) => this.probe(e.name)));
    return results.sort((a, b) => Number(a.ok === false) - Number(b.ok === false) || a.latencyMs - b.latencyMs);
  }

  /**
   * 可靠调用：端点级回退 + 单端点内指数退避重试。
   * 返回 ok=false 时 failClass 必为 infra_error 或 format_violation。
   */
  async call(
    messages: CallMessage[],
    opts: { maxTokens?: number; temperature?: number; endpointOrder?: string[] } = {},
  ): Promise<CallResult> {
    const order = opts.endpointOrder ?? this.endpoints.map((e) => e.name);
    let totalAttempts = 0;
    const t0 = Date.now();
    let lastResult: CallResult = {
      ok: false,
      failClass: "infra_error",
      error: "无可用端点",
      latencyMs: 0,
      attempts: 0,
    };

    for (const name of order) {
      const target = this.endpoints.find((e) => e.name === name);
      if (!target) continue;
      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        totalAttempts += 1;
        this.touch(name, "calls");
        const r = await this.requestOnce(target.config, target.apiKey, messages, opts.maxTokens, opts.temperature);
        if (r.ok) {
          this.touch(name, "ok");
          const result: CallResult = {
            ok: true,
            endpoint: name,
            model: target.config.model,
            content: r.content,
            reasoning: r.reasoning,
            latencyMs: Date.now() - t0,
            attempts: totalAttempts,
          };
          this.writeAudit({
            ts: nowIso(),
            endpoint: name,
            model: target.config.model,
            prompt_chars: messages.reduce((n, m) => n + m.content.length, 0),
            response_chars: (r.content?.length ?? 0) + (r.reasoning?.length ?? 0),
            latency_ms: result.latencyMs,
            attempts: totalAttempts,
            ok: true,
          });
          return result;
        }
        lastResult = {
          ok: false,
          endpoint: name,
          model: target.config.model,
          failClass: r.failClass,
          error: r.error,
          latencyMs: Date.now() - t0,
          attempts: totalAttempts,
        };
        // 基础设施故障（连接、超时、5xx）：换端点前在本端点重试
        if (r.failClass === "infra_error") {
          this.touch(name, "infra");
          const delay = Math.min(this.baseDelayMs * 2 ** (attempt - 1), 30_000);
          if (attempt < this.maxRetries) await sleep(delay);
          continue;
        }
        // 格式违规（响应结构异常）：重试同端点一次意义有限，直接换端点
        this.touch(name, "format");
        break;
      }
    }
    this.writeAudit({
      ts: nowIso(),
      endpoint: lastResult.endpoint ?? "none",
      model: lastResult.model ?? "none",
      prompt_chars: messages.reduce((n, m) => n + m.content.length, 0),
      response_chars: 0,
      latency_ms: lastResult.latencyMs,
      attempts: totalAttempts,
      ok: false,
      fail_class: lastResult.failClass,
      error: lastResult.error,
    });
    return lastResult;
  }

  private async requestOnce(
    config: EndpointConfig,
    apiKey: string | undefined,
    messages: CallMessage[],
    maxTokens?: number,
    temperature?: number,
  ): Promise<{ ok: true; content: string; reasoning?: string } | { ok: false; failClass: LlmFailClass; error: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const body: Record<string, unknown> = {
        model: config.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        max_tokens: maxTokens ?? config.maxTokens ?? 4096,
      };
      if (temperature !== undefined) body.temperature = temperature;
      const resp = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        const retryable = resp.status === 429 || resp.status >= 500;
        return {
          ok: false,
          failClass: retryable ? "infra_error" : "infra_error",
          error: `HTTP ${resp.status}: ${text.slice(0, 200)}`,
        };
      }
      const data = (await resp.json()) as {
        choices?: { message?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null } }[];
      };
      const message = data.choices?.[0]?.message;
      const content = message?.content ?? "";
      const reasoning = message?.reasoning ?? message?.reasoning_content ?? undefined;
      // GLM 类推理模型在 max_tokens 不足时可能只返回 reasoning、content 为空：
      // 显式归为 format_violation，调用方据此决定重试或调整预算，绝不静默当成功
      if (!content || content.trim() === "") {
        return {
          ok: false,
          failClass: "format_violation",
          error: reasoning ? "content 为空，仅返回 reasoning（推理预算不足或服务端结构异常）" : "content 与 reasoning 均为空",
        };
      }
      return { ok: true, content, reasoning };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, failClass: "infra_error", error: msg };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 各端点调用统计：calls、ok、infra、format */
  getStats(): Record<string, { calls: number; ok: number; infraErrors: number; formatViolations: number }> {
    const out: Record<string, { calls: number; ok: number; infraErrors: number; formatViolations: number }> = {};
    for (const [name, s] of this.stats) {
      out[name] = { calls: s.calls, ok: s.ok, infraErrors: s.infra, formatViolations: s.format };
    }
    return out;
  }
}

export function defaultAuditPath(runsRoot: string): string {
  return join(runsRoot, "audit", "llm_calls.jsonl");
}
