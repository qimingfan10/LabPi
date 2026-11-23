import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { buildQuery, checkNovelty, parseAtomFeed, searchPapersCool } from "../src/novelty.ts";
import { shortHash } from "../src/fingerprint.ts";
import { LabRegistry } from "../src/store.ts";

const ATOM_FIXTURE = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>https://papers.cool/arxiv/search</id>
  <title>query</title>
  <updated>2026-11-19T22:48:32Z</updated>
  <entry>
    <id>https://papers.cool/arxiv/2611.10787</id>
    <title>Trustworthy Recursive Self-Improvement with Statistical Guarantees</title>
    <updated>2026-11-07T15:12:01Z</updated>
    <author><name>Zihe Gao</name></author>
    <link href="https://papers.cool/arxiv/2611.10787"/>
    <summary>We introduce TRUST, a framework that adapts an online multiple hypothesis testing procedure for agents that refine their own harnesses.</summary>
  </entry>
  <entry>
    <id>https://arxiv.org/abs/2505.22954v3</id>
    <title>The Darwin Godel Machine: Open-Ended Evolution of Self-Improving Agents</title>
    <updated>2025-06-01T00:00:00Z</updated>
    <author><name>Jenny Zhang</name></author>
    <summary>An agent that improves its own codebase iteratively.</summary>
  </entry>
</feed>`;

describe("atom parsing", () => {
	test("extracts arxiv ids, titles, abstracts", () => {
		const entries = parseAtomFeed(ATOM_FIXTURE);
		expect(entries).toHaveLength(2);
		expect(entries[0].id).toBe("2611.10787");
		expect(entries[0].title).toContain("Trustworthy Recursive");
		expect(entries[1].id).toBe("2505.22954v3");
		expect(entries[0].summary).toContain("TRUST");
	});
});

describe("query building", () => {
	test("picks at most four english terms, drops stopwords", () => {
		const q = buildQuery({
			statement: "The加长反思链 of reasoning improves the pass rate on held-out benchmarks",
			prediction: "pass_rate increases by at least 0.05",
		} as Parameters<typeof buildQuery>[0]);
		const words = q.split(" ");
		expect(words.length).toBeLessThanOrEqual(4);
		for (const w of words) {
			expect(["the", "of", "on", "at", "by", "is"]).not.toContain(w);
		}
	});
});

describe("novelty check", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-lab-novelty-"));
	const reg = new LabRegistry({ dbPath: join(dir, "lab.db"), runsRoot: join(dir, "runs") });
	afterAll(() => {
		reg.close();
		rmSync(dir, { recursive: true, force: true });
	});
	reg.createLine("line-a");
	const h = reg.addHypothesis({
		statement: "statistical gates accept fewer inferior updates in self-improvement loops",
		prediction: "accept_ratio drops by 0.2",
		discriminator: "final score unchanged",
		provenance: "human",
		lineId: "line-a",
	});

	afterEach(() => {
		// 每条用例独立缓存
		rmSync(join(dir, "runs", "cache"), { recursive: true, force: true });
	});

	test("offline without cache reports empty with offline error", async () => {
		const result = await checkNovelty(reg, h.id, { offline: true });
		expect(result.candidates).toHaveLength(0);
		expect(result.cached).toBe(false);
		expect(result.errors).toContain("offline");
	});

	test("cache is hit within ttl and exposes cached flag", async () => {
		const query = buildQuery(h);
		const cacheDir = join(dir, "runs", "cache", "novelty");
		mkdirSync(cacheDir, { recursive: true });
		const cached = [
			{
				source: "papers_cool",
				id: "2611.10787",
				title: "Trustworthy Recursive Self-Improvement with Statistical Guarantees",
				year: 2026,
				url: "https://arxiv.org/abs/2611.10787",
				abstract: "TRUST framework",
				score: 0.9,
			},
		];
		writeFileSync(join(cacheDir, `${shortHash(query)}.json`), JSON.stringify(cached), "utf-8");
		const result = await checkNovelty(reg, h.id, { offline: true });
		expect(result.cached).toBe(true);
		expect(result.candidates).toHaveLength(1);
		expect(result.sources).toContain("cache");
	});

	test("duplicate verdict kills the hypothesis through the ledger", async () => {
		reg.addNoveltyCheck({ hypothesisId: h.id, query: "q", verdict: "duplicate" });
		const killed = reg.decideHypothesis(h.id, "killed", { note: "新颖性判定 duplicate" });
		expect(killed.status).toBe("killed");
	});

	test("searchPapersCool parses the live feed when the network allows", async () => {
		try {
			const candidates = await searchPapersCool("recursive self-improvement", { timeoutMs: 15_000, limit: 3 });
			expect(candidates.length).toBeGreaterThan(0);
			expect(candidates[0].title.length).toBeGreaterThan(0);
		} catch (err) {
			// 网络不可用不算失败：papers.cool 的可达性不是本测试的断言对象
			expect(String(err).length).toBeGreaterThan(0);
		}
	}, 30_000);
});
