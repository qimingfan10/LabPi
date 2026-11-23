import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { HypothesisRow, LabRegistry } from "./store.ts";
import { shortHash } from "./fingerprint.ts";

/**
 * 新颖性检索：papers.cool 提供 arXiv 的大召回池（单次最多 1000 条，
 * 服务端忽略 max_results/sortBy/start，排序由本地术语打分完成），
 * OpenAlex 补引用数与期刊覆盖。模块只产出候选，verdict 由会话内模型判定。
 */

export interface NoveltyCandidate {
	source: "papers_cool" | "openalex" | "arxiv";
	id: string;
	title: string;
	year?: number;
	citations?: number;
	url?: string;
	abstract?: string;
	/** 与查询词的本地重合度，仅用于排序 */
	score: number;
}

export interface NoveltySearchResult {
	query: string;
	candidates: NoveltyCandidate[];
	sources: string[];
	errors: string[];
	cached: boolean;
}

export interface NoveltyOptions {
	/** 单源超时，默认 20 秒 */
	timeoutMs?: number;
	/** 合并后保留的候选数，默认 10 */
	limit?: number;
	/** 缓存目录（默认 <runsRoot>/cache/novelty） */
	cacheDir?: string;
	/** 缓存有效期，默认 30 天 */
	cacheTtlMs?: number;
	/** 关闭网络，仅用于测试解析与缓存 */
	offline?: boolean;
}

const STOPWORDS = new Set([
	"the",
	"a",
	"an",
	"of",
	"and",
	"or",
	"for",
	"to",
	"in",
	"on",
	"with",
	"by",
	"is",
	"are",
	"was",
	"be",
	"as",
	"that",
	"this",
	"these",
	"from",
	"into",
	"than",
	"then",
	"when",
	"which",
	"while",
	"more",
	"less",
	"can",
	"may",
	"will",
	"not",
	"its",
	"it",
	"we",
	"our",
	"using",
	"use",
	"via",
	"under",
	"over",
	"after",
	"before",
	"between",
	"within",
	"across",
	"against",
	"about",
	"such",
	"each",
	"both",
	"same",
	"other",
	"only",
	"also",
	"there",
	"their",
]);

function tokens(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, " ")
		.split(/\s+/)
		.map((t) => t.replace(/^-+|-+$/g, ""))
		.filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** 从假设的陈述与预测中抽取 2–4 个英文检索词：服务端按字面关键词弱匹配，长句只会引入噪声 */
export function buildQuery(h: Pick<HypothesisRow, "statement" | "prediction">): string {
	const stmt = tokens(h.statement);
	const pred = tokens(h.prediction);
	const seen = new Set<string>();
	const picked: string[] = [];
	// 陈述优先；预测里的术语补充区分度
	for (const t of [...stmt, ...pred]) {
		if (seen.has(t)) continue;
		seen.add(t);
		picked.push(t);
		if (picked.length >= 4) break;
	}
	return picked.join(" ");
}

interface AtomEntry {
	id: string;
	title: string;
	summary: string;
	updated?: string;
}

function decodeXml(s: string): string {
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

/** 解析 Atom feed（papers.cool 与 export.arxiv.org 同格式），纯函数 */
export function parseAtomFeed(xml: string): AtomEntry[] {
	const entries: AtomEntry[] = [];
	const blocks = xml.split("<entry>").slice(1);
	for (const block of blocks) {
		const body = block.split("</entry>")[0];
		const pick = (tag: string): string => {
			const m = body.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
			return m ? decodeXml(m[1].trim()) : "";
		};
		const idRaw = pick("id");
		const arxivId = idRaw.match(/arxiv\.org\/abs\/([^<\s]+)/)?.[1] ?? idRaw.match(/papers\.cool\/arxiv\/([^<\s]+)/)?.[1] ?? idRaw;
		entries.push({
			id: arxivId,
			title: pick("title").replace(/\s+/g, " "),
			summary: pick("summary").replace(/\s+/g, " "),
			updated: pick("updated") || pick("published") || undefined,
		});
	}
	return entries;
}

function scoreAgainst(queryTokens: Set<string>, text: string, title: string): number {
	const titleTokens = new Set(tokens(title));
	const bodyTokens = new Set(tokens(text));
	let hit = 0;
	let titleHit = 0;
	for (const t of queryTokens) {
		if (titleTokens.has(t)) titleHit++;
		else if (bodyTokens.has(t)) hit++;
	}
	const q = queryTokens.size || 1;
	return (titleHit * 1.5 + hit) / q;
}

// ---------- 礼貌请求：全局串行、最小间隔、指数退避 ----------

let queue: Promise<unknown> = Promise.resolve();
let lastAt = 0;

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function politeFetch(url: string, timeoutMs: number, minIntervalMs = 2000): Promise<Response> {
	const task = queue.then(async () => {
		const wait = lastAt + minIntervalMs - Date.now();
		if (wait > 0) await sleep(wait);
		lastAt = Date.now();
		let lastErr: unknown;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const res = await fetch(url, {
					headers: { "User-Agent": "LabPi/1.0 novelty-check" },
					signal: AbortSignal.timeout(timeoutMs),
				});
				if (res.ok) return res;
				if (res.status === 429 || res.status >= 500) {
					lastErr = new Error(`HTTP ${res.status}`);
					await sleep(1000 * 2 ** attempt);
					continue;
				}
				throw new Error(`HTTP ${res.status}`);
			} catch (err) {
				lastErr = err;
				if (String(err).includes("429")) await sleep(1000 * 2 ** attempt);
			}
		}
		throw lastErr;
	});
	queue = task.catch(() => undefined);
	return task;
}

// ---------- 两个来源 ----------

export async function searchPapersCool(
	query: string,
	opts: { timeoutMs?: number; limit?: number } = {},
): Promise<NoveltyCandidate[]> {
	const url = `https://papers.cool/arxiv/search/feed?query=${encodeURIComponent(query)}`;
	const res = await politeFetch(url, opts.timeoutMs ?? 20_000);
	const xml = await res.text();
	const queryTokens = new Set(tokens(query));
	const scored = parseAtomFeed(xml)
		.map((e) => ({
			source: "papers_cool" as const,
			id: e.id,
			title: e.title,
			year: e.updated ? Number(e.updated.slice(0, 4)) : undefined,
			url: `https://arxiv.org/abs/${e.id}`,
			abstract: e.summary,
			score: scoreAgainst(queryTokens, `${e.title} ${e.summary}`, e.title),
		}))
		.filter((c) => c.score > 0)
		.sort((a, b) => b.score - a.score);
	return scored.slice(0, opts.limit ?? 10);
}

interface OpenAlexWork {
	id: string;
	title?: string;
	display_name?: string;
	publication_year?: number;
	cited_by_count?: number;
	doi?: string;
	abstract_inverted_index?: Record<string, number[]>;
}

function openAlexAbstract(work: OpenAlexWork): string | undefined {
	const idx = work.abstract_inverted_index;
	if (!idx) return undefined;
	const slots: string[] = [];
	for (const [word, positions] of Object.entries(idx)) {
		for (const p of positions) slots[p] = word;
	}
	const text = slots.filter(Boolean).join(" ").trim();
	return text || undefined;
}

export async function searchOpenAlex(
	query: string,
	opts: { timeoutMs?: number; limit?: number; mailto?: string } = {},
): Promise<NoveltyCandidate[]> {
	const mailto = opts.mailto ?? process.env.LABPI_CONTACT_MAILTO ?? "";
	const params = new URLSearchParams({ search: query, "per-page": String(opts.limit ?? 10) });
	if (mailto) params.set("mailto", mailto);
	const url = `https://api.openalex.org/works?${params.toString()}`;
	const res = await politeFetch(url, opts.timeoutMs ?? 20_000, 1000);
	const body = (await res.json()) as { results?: OpenAlexWork[] };
	const queryTokens = new Set(tokens(query));
	return (body.results ?? [])
		.map((w) => {
			const title = w.title ?? w.display_name ?? "";
			const abstract = openAlexAbstract(w);
			return {
				source: "openalex" as const,
				id: w.id.replace("https://openalex.org/", ""),
				title,
				year: w.publication_year,
				citations: w.cited_by_count,
				url: w.doi ?? w.id,
				abstract,
				score: scoreAgainst(queryTokens, `${title} ${abstract ?? ""}`, title),
			};
		})
		.sort((a, b) => b.score - a.score);
}

/** 官方 arXiv API：papers.cool 不可用或需要字段语法时的后备 */
export async function searchArxiv(
	query: string,
	opts: { timeoutMs?: number; limit?: number } = {},
): Promise<NoveltyCandidate[]> {
	const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${opts.limit ?? 10}&sortBy=relevance`;
	const res = await politeFetch(url, opts.timeoutMs ?? 20_000);
	const xml = await res.text();
	const queryTokens = new Set(tokens(query));
	return parseAtomFeed(xml)
		.map((e) => ({
			source: "arxiv" as const,
			id: e.id,
			title: e.title,
			year: e.updated ? Number(e.updated.slice(0, 4)) : undefined,
			url: `https://arxiv.org/abs/${e.id}`,
			abstract: e.summary,
			score: scoreAgainst(queryTokens, `${e.title} ${e.summary}`, e.title),
		}))
		.sort((a, b) => b.score - a.score);
}

// ---------- 缓存与合并 ----------

function cachePath(cacheDir: string, query: string): string {
	return join(cacheDir, `${shortHash(query)}.json`);
}

function readCache(cacheDir: string, query: string, ttlMs: number): NoveltyCandidate[] | undefined {
	const p = cachePath(cacheDir, query);
	if (!existsSync(p)) return undefined;
	try {
		if (Date.now() - statSync(p).mtimeMs > ttlMs) return undefined;
		return JSON.parse(readFileSync(p, "utf-8")) as NoveltyCandidate[];
	} catch {
		return undefined;
	}
}

function writeCache(cacheDir: string, query: string, candidates: NoveltyCandidate[]): void {
	mkdirSync(cacheDir, { recursive: true });
	writeFileSync(cachePath(cacheDir, query), JSON.stringify(candidates), "utf-8");
}

function dedupe(candidates: NoveltyCandidate[]): NoveltyCandidate[] {
	const seen = new Map<string, NoveltyCandidate>();
	for (const c of candidates) {
		const key = c.title.toLowerCase().replace(/\s+/g, " ").trim();
		const prev = seen.get(key);
		// 同标题保留信息更全的一条：有引用数的优先，其次分数高的
		if (!prev || (c.citations ?? 0) > (prev.citations ?? 0) || (c.citations === prev.citations && c.score > prev.score)) {
			seen.set(key, c);
		}
	}
	return [...seen.values()];
}

/**
 * 检索一条假设的相关工作。只产出候选，不产出 verdict：
 * 判定（同一机制/同一场景/差异点）由会话内模型完成，随后用 recordVerdict 入账。
 */
export async function checkNovelty(
	reg: LabRegistry,
	hypothesisId: string,
	opts: NoveltyOptions = {},
): Promise<NoveltySearchResult> {
	const h = reg.getHypothesis(hypothesisId);
	if (!h) throw new Error(`假设不存在: ${hypothesisId}`);
	const query = buildQuery(h);
	const cacheDir = opts.cacheDir ?? join(reg.runsRoot, "cache", "novelty");
	const ttl = opts.cacheTtlMs ?? 30 * 24 * 3600_000;
	const errors: string[] = [];
	const sources: string[] = [];

	if (opts.offline) {
		const cached = readCache(cacheDir, query, ttl);
		return { query, candidates: cached ?? [], sources: cached ? ["cache"] : [], errors: ["offline"], cached: Boolean(cached) };
	}

	let all: NoveltyCandidate[] = [];
	const cached = readCache(cacheDir, query, ttl);
	if (cached) {
		all = cached;
		sources.push("cache");
	} else {
		const [papers, openalex] = await Promise.allSettled([
			searchPapersCool(query, opts),
			searchOpenAlex(query, opts),
		]);
		if (papers.status === "fulfilled") {
			all.push(...papers.value);
			sources.push("papers_cool");
		} else {
			errors.push(`papers_cool: ${String(papers.reason).slice(0, 200)}`);
		}
		if (openalex.status === "fulfilled") {
			all.push(...openalex.value);
			sources.push("openalex");
		} else {
			errors.push(`openalex: ${String(openalex.reason).slice(0, 200)}`);
		}
		// 两源都空时退回官方 arXiv API
		if (all.length === 0) {
			try {
				all = await searchArxiv(query, opts);
				sources.push("arxiv");
			} catch (err) {
				errors.push(`arxiv: ${String(err).slice(0, 200)}`);
			}
		}
		all = dedupe(all).sort((a, b) => b.score - a.score);
		if (all.length > 0) writeCache(cacheDir, query, all);
	}

	const limit = opts.limit ?? 10;
	return {
		query,
		candidates: all.slice(0, limit),
		sources,
		errors,
		cached: sources.includes("cache"),
	};
}

/** 证据清单的稳定指纹，用于去重同一批候选 */
export function evidenceDigest(candidates: NoveltyCandidate[]): string {
	return createHash("sha256")
		.update(JSON.stringify(candidates.map((c) => `${c.source}:${c.id}`)))
		.digest("hex")
		.slice(0, 12);
}
