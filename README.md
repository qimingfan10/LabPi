<p align="center">
  <a href="https://github.com/qimingfan10/LabPi">
    <img alt="LabPi" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://github.com/badlogic/pi-mono"><img alt="built on pi" src="https://img.shields.io/badge/built%20on-pi--mono-3b5bfd?style=flat-square" /></a>
  <a href="https://github.com/deepseek-ai/dsh-superagent-prototype"><img alt="dsh-superagent ideas" src="https://img.shields.io/badge/ideas%20from-DeepSeek%20dsh--superagent-4D6BFF?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square" /></a>
</p>

# LabPi — a research superagent, built on pi

**LabPi turns [pi](https://github.com/badlogic/pi-mono) — one of the most starred open-source coding agents — into a research-experiment superagent.** It follows the router/worker orchestration ideas DeepSeek open-sourced in [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype), but instead of managing code repositories, LabPi manages **experiments**: every run has a ledger entry, every conclusion carries evidence, parallel directions get their own isolated worker processes, and "it works" is something a statistical test has to sign off on.

> 科研版 superagent：在 pi 内核之上实现 DeepSeek dsh-superagent 原型的 router/worker 编排思想——多方向实验并行编排、结论必须携带证据、判断立字据可被推翻。

## The problem it solves

AI researchers don't lose experiments to weak models. They lose them to the chaos around the model: three experiment directions run in one context and pollute each other, results end up scattered across chat logs and temp folders, a judge silently scores failures as zeros and a wrong conclusion survives for weeks, endpoint flakiness invalidates an overnight run, and "v5 is better than v4" is never tied to a significance test.

These are not tooling gaps. They are **discipline gaps** — and discipline cannot be installed as a plugin. LabPi builds it into the agent loop itself.

## The four mechanisms

| Mechanism | Where it lives | What it enforces |
| --- | --- | --- |
| **Experiment ledger** | `packages/lab` (new package, node:sqlite) | Five ledgers — lines, runs, metrics, artifacts, claims. Every run gets a directory with config fingerprint, logs and per-scenario results; every metric carries model, endpoint and measurement conditions |
| **Completion gate** | `agent-session.ts` beforeToolCall, ahead of the extension runner | A run cannot be marked `completed` without recorded metrics. The model is blocked at the loop level and must either record evidence or honestly file a failure with a class |
| **Evidence-linked claims** | ledger + comparison tools | Conclusions are registered with evidence references and optional direction assertions; every comparison auto-verifies direction and reports conflicts; a refuted claim loses its license to be cited as fact |
| **Router/worker orchestration** | `lab_worker_spawn / status / collect` | One headless pi worker process per experiment direction, bound to one line, ledger writes locked to it (single-writer). The router spawns and collects, never executes; concurrency capped; blocked workers wait for the router |

On top of these: resilient LLM calls with endpoint failover and three-way failure classification (infra / format / semantic — silence is not an option), exact Wilcoxon and paired-t statistics validated against reference values, task pools with measured difficulty metadata and bidirectional band filtering, Python evaluation scripts as subprocesses with hard timeouts.

## What it looks like

```
you> Create experiment line baseline, register a run (stage=eval, model sevo_v4)
     ... run evaluation ...
you> Record total_score=3.69 with per-scenario scores, mark the run completed
you> Fork three direction lines from baseline and spawn a worker for each:
       recipe-a: pure empathy corpus    recipe-b: warmth-first corpus
       recipe-c: 6:4 mixed ratio
you> (keep working — workers run in their own processes and sessions)
you> /workers                          # router view
you> Collect all workers and compare the three lines with paired tests
    → conflicts with open claims are reported automatically
you> Register claim: recipe-c wins, evidence = W3 report + paired test
```

A worker that tried to write another line's ledger was **rejected at the loop level** — the single-writer guarantee is not a prompt, it is the tool interface. A model asked to mark an empty run `completed` was blocked and chose to file an honest `failed` instead.

## Quick start

Requires Node.js ≥ 22.19.

```bash
git clone https://github.com/qimingfan10/LabPi.git
cd LabPi
npm install --ignore-scripts
npm run build
./pi-test.bat --provider <your-provider> --model <your-model>
```

Model endpoints are configured in `~/.pi/agent/models.json` (any OpenAI-compatible endpoint works, including vLLM). Evaluation scripts run via `lab_eval_run_python` — Python is auto-detected (`python` / `py` / `python3`).

Everything pi can do, LabPi can do: file tools, session trees, compaction, forks, extensions, MCP — plus the four mechanisms above, which are part of the kernel, not plugins.

## Relationship to upstream

- **[pi](https://github.com/badlogic/pi-mono)** by Mario Zechner (earendil-works): the agent kernel — loop, tool execution, providers, TUI, session trees. LabPi is a distribution of it. `origin` points upstream; follow it with `git merge`.
- **[dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)** by DeepSeek: the source of the router/worker orchestration ideas (work-item isolation, single-writer state, worker slots, waits-for-person). LabPi applies them to research experiments with LLM-judged, statistics-verified outcomes. dsh is a research prototype marked "not an official DeepSeek product"; LabPi is likewise an independent implementation and is not affiliated with or endorsed by DeepSeek.

The lab changes live in the `lab/main` branch and touch one new package plus seven kernel files — the full diff is the answer to "what does a research harness actually add to an agent kernel".

## License

MIT, same as both parents of the ideas in this repository.
