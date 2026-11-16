import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { nowIso } from "./fingerprint.ts";

/**
 * 实验输入快照：把「当时跑的是什么」固定在 run 目录里。
 * 评测脚本复制一份、脚本/数据/环境/git 状态各自取哈希，
 * 供日后回溯与漂移检测——代码改得面目全非，也能回答当时那一版是什么样。
 */

export interface SnapshotFile {
	path: string;
	sha256: string;
	bytes: number;
	/** 文件在采集时不存在 */
	missing?: boolean;
}

export interface SnapshotManifest {
	captured_at: string;
	script: SnapshotFile & { copy: string };
	data: SnapshotFile[];
	runtime: { python?: string; env_hash?: string };
	git?: { commit?: string; dirty: boolean; dirty_files: string[]; available: boolean };
}

export interface CaptureOptions {
	/** 项目根目录 */
	project: string;
	/** 评测脚本路径（相对项目根或绝对路径） */
	script: string;
	/** run 的目录（runs/<run_key>） */
	runDir: string;
	/** 需要登记哈希的数据文件（相对项目根或绝对路径） */
	dataPaths?: string[];
}

export function sha256File(absPath: string): string {
	return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

function fileInfo(project: string, p: string): SnapshotFile {
	const abs = isAbsolute(p) ? p : resolve(project, p);
	if (!existsSync(abs)) return { path: p, sha256: "", bytes: 0, missing: true };
	const buf = readFileSync(abs);
	return { path: p, sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
}

let cachedEnv: { python?: string; env_hash?: string } | undefined;

/** 运行环境指纹：解释器版本 + 已安装包清单哈希（失败时只用解释器版本） */
function runtimeFingerprint(project: string): { python?: string; env_hash?: string } {
	if (cachedEnv) return cachedEnv;
	const env: { python?: string; env_hash?: string } = {};
	const bins = process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"];
	for (const bin of bins) {
		const v = spawnSync(bin, ["-V"], {
			cwd: project,
			stdio: "pipe",
			timeout: 10_000,
			shell: process.platform === "win32",
		});
		if (v.status === 0) {
			env.python = `${bin} ${v.stdout.toString().trim() || v.stderr.toString().trim()}`.trim();
			const freeze = spawnSync(bin, ["-m", "pip", "freeze"], {
				cwd: project,
				stdio: "pipe",
				timeout: 30_000,
				shell: process.platform === "win32",
			});
			if (freeze.status === 0) {
				const out = freeze.stdout.toString();
				if (out.trim()) env.env_hash = createHash("sha256").update(out).digest("hex").slice(0, 16);
			}
			break;
		}
	}
	cachedEnv = env;
	return env;
}

function gitFingerprint(project: string): SnapshotManifest["git"] {
	const run = (args: string[]) => spawnSync("git", args, { cwd: project, stdio: "pipe", timeout: 10_000 });
	const head = run(["rev-parse", "HEAD"]);
	if (head.status !== 0) return { dirty: false, dirty_files: [], available: false };
	const status = run(["status", "--porcelain"]);
	const lines = status.stdout
		.toString()
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	return {
		available: true,
		commit: head.stdout.toString().trim(),
		dirty: lines.length > 0,
		dirty_files: lines.slice(0, 50),
	};
}

/** 采集快照：脚本复制到 snapshot/src/，清单写到 snapshot/manifest.json */
export function captureSnapshot(opts: CaptureOptions): SnapshotManifest {
	const absScript = isAbsolute(opts.script) ? opts.script : resolve(opts.project, opts.script);
	if (!existsSync(absScript)) throw new Error(`评测脚本不存在，无法快照: ${absScript}`);

	const snapDir = join(opts.runDir, "snapshot");
	const srcDir = join(snapDir, "src");
	mkdirSync(srcDir, { recursive: true });

	const scriptName = basename(absScript);
	const copyRel = join("snapshot", "src", scriptName).replace(/\\/g, "/");
	copyFileSync(absScript, join(srcDir, scriptName));

	const snapshotScript = fileInfo(opts.project, join(opts.runDir, copyRel));
	const manifest: SnapshotManifest = {
		captured_at: nowIso(),
		script: {
			path: opts.script,
			sha256: snapshotScript.sha256,
			bytes: snapshotScript.bytes,
			copy: copyRel,
		},
		data: (opts.dataPaths ?? []).map((p) => fileInfo(opts.project, p)),
		runtime: runtimeFingerprint(opts.project),
		git: gitFingerprint(opts.project),
	};
	writeFileSync(join(snapDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
	return manifest;
}

export function loadSnapshot(runDir: string): SnapshotManifest | undefined {
	const p = join(runDir, "snapshot", "manifest.json");
	if (!existsSync(p)) return undefined;
	try {
		return JSON.parse(readFileSync(p, "utf-8")) as SnapshotManifest;
	} catch {
		return undefined;
	}
}

/** 当前工作区中该脚本的哈希（文件不存在返回 undefined） */
export function currentScriptHash(project: string, script: string): string | undefined {
	const abs = isAbsolute(script) ? script : resolve(project, script);
	if (!existsSync(abs)) return undefined;
	return sha256File(abs);
}

/** 快照副本的绝对路径（用于重跑当时的代码） */
export function snapshotScriptPath(runDir: string, manifest?: SnapshotManifest): string | undefined {
	const m = manifest ?? loadSnapshot(runDir);
	if (!m) return undefined;
	const abs = join(runDir, m.script.copy);
	return existsSync(abs) ? abs : undefined;
}
