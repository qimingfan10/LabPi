import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nowIso } from "./fingerprint.ts";

let cachedPython: string | undefined;

/** 探测可用的 Python 解释器：Windows 常只有 py，Linux/macOS 为 python3/python，结果缓存 */
export function detectPython(): string {
  if (cachedPython) return cachedPython;
  const candidates = process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"];
  for (const bin of candidates) {
    const r = spawnSync(bin, ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
    if (r.status === 0) {
      cachedPython = bin;
      return bin;
    }
  }
  throw new Error("未找到 Python 解释器（已尝试 python、py、python3）。请安装 Python 或在 eval_run_python 的环境里显式提供。");
}

export interface PythonRunResult {
  ok: boolean;
  /** infra_error 的具体原因：timeout 或 crash */
  reason?: "timeout" | "crash";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  logRelPath: string;
}

/**
 * 以独立子进程加硬超时运行 Python 脚本。
 * stdout/stderr 全量写入日志文件工件；超时与崩溃显式返回 reason，
 * 任何失败都不会被静默吞掉。
 */
export function runPythonScript(
  script: string,
  args: string[],
  opts: { timeoutMs?: number; logDir: string; pythonBin?: string; cwd?: string } = { logDir: "." },
): Promise<PythonRunResult> {
  const timeoutMs = opts.timeoutMs ?? 1_800_000;
  const pythonBin = opts.pythonBin ?? detectPython();
  const logRelPath = `logs/${script.split(/[\\/]/).pop() ?? "script"}-${Date.now()}.log`;
  return new Promise((resolve) => {
    mkdirSync(opts.logDir, { recursive: true });
    const t0 = Date.now();
    const child = spawn(pythonBin, [script, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: opts.cwd,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        if (process.platform === "win32") {
          // Windows 终止整棵进程树（py launcher 会再启动 python 子进程）
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        } else {
          child.kill("SIGKILL");
        }
      }
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      const logAbs = join(opts.logDir, logRelPath.split("/").pop()!);
      writeFileSync(
        logAbs,
        [
          `# ${nowIso()} script=${script} args=${JSON.stringify(args)}`,
          `# exit=${code} elapsed=${Date.now() - t0}ms timedOut=${timedOut}`,
          "## STDOUT",
          stdout,
          "## STDERR",
          stderr,
        ].join("\n"),
        "utf-8",
      );
      if (timedOut) {
        resolve({ ok: false, reason: "timeout", exitCode: code, stdout, stderr, logRelPath });
        return;
      }
      resolve({
        ok: code === 0,
        reason: code === 0 ? undefined : "crash",
        exitCode: code,
        stdout,
        stderr,
        logRelPath,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      stderr += `spawn error: ${err.message}`;
      resolve({ ok: false, reason: "crash", exitCode: null, stdout, stderr, logRelPath });
    });
  });
}
