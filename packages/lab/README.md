# @earendil-works/pi-lab

Research experiment discipline for pi: experiment ledger, evidence-linked claims, completion gates, paired statistics, task pools, and router/worker orchestration.

## Router/worker orchestration (absorbed from dsh-superagent-prototype)

Two long-standing problems of multi-direction experiments — too many directions to manage, and data from different directions mixed together — are solved by four mechanisms:

1. **One worker process per direction**: `lab_worker_spawn` forks a headless pi process for an experiment line (independent session and directory), binds it to that line and locks ledger writes to it — cross-line writes are rejected at the interface layer, and the single writer keeps data from mixing.
2. **The router routes, it does not execute**: after spawning a worker the main session continues its own work; when the worker finishes it reports back into the ledger. `lab_worker_collect` collects the report together with the ledger delta across that line's lifetime, and the router decides on that basis whether to adopt, spawn again, or abandon.
3. **No built-in concurrency cap**: the number of simultaneously active workers is bounded by what the machine and the gateway can carry; when throttling is needed the caller passes maxWorkers explicitly.
4. **waitsForPerson**: a worker that needs a human decision or faces an unusable environment files an honest `failed` with the reason and waits for the router's ruling; fabricating data is forbidden.

The state card injects the active workers and the collection backlog every round; in interactive mode the `/workers` command shows the routing view. A worker may not spawn further workers (`LAB_NO_SPAWN`) — orchestration has exactly one layer.

## Governance: verification ladder, independent re-verification, irreversibility, and breaker

A research ledger fears two things most: the executor grading its own work, and failures being repeatedly retried until they are buried. Four mechanisms answer four lessons:

1. **Verification ladder, machines before models**: the evaluator script's own structured output (`RESULT_JSON`) → item-by-item comparison against the ledger (within tolerance) → paired significance testing → judgement. Whatever a machine can verify is never handed to an LLM to decide.
2. **Independent re-verification (the player does not referee)**: a successful `lab_eval_run_python` registers its reproduction command; `lab_verify_run` reruns the script and compares the rerun values against the ledger metrics. A discrepancy lands as `mismatch`, and that run cannot be marked complete before re-verification passes. A run with no reproduction command that wants to be marked complete must declare `evidence_class="manual"` and state the evidence source in the note; the ledger stamps it `unverified` permanently — a manual path is allowed to exist, but it is never allowed to masquerade as script evidence.
3. **The ledger cannot be overwritten**: writing a metric of the same name again requires a `revise_reason`, and the old value is kept as a historical version (`revision` + `superseded_by`); default queries see only the currently effective version.
4. **Breaker on consecutive failures**: three accumulated `failed` runs on one experiment line automatically set it to `paused`; registering new runs and spawning workers are both refused, and `lab_line_resume` must state what was investigated before the line resumes. The state card reports only items that need attention (paused lines, verification mismatches, workers awaiting collection, open claims); normal state is folded into one line.
5. **Execution lock**: only one process may write to an experiment line at a time. `registerRun` takes the line automatically (holder is the current process pid); re-entry from the same process renews the lease; another process is refused while an unexpired lock is held, and is told the holder and heartbeat time; after the process dies the lease (90 minutes by default) expires and the line can be taken over. The lock is released automatically when the run reaches a terminal state and no worker on the line is in progress; `forceReleaseLineLock` also allows manual cleanup. Cross-process parallelism therefore exists only across lines, never within one line.
6. **Activity log**: every ledger mutation writes an `activity` row: line creation/fork, run registration, status transitions, metric records and revisions, artifact mounts, claim insertion/deletion and adjudication, verification verdicts, worker birth/death, lock acquire/takeover/release, breaker trips. `lab_activity` queries by line, run or action type, for troubleshooting and for writing experiment records.
7. **Input snapshot and drift detection**: a successful `lab_eval_run_python` copies the evaluator script into `runs/<run_key>/snapshot/src/` and records the script sha256, data file hashes, Python environment fingerprint (interpreter + pip freeze hash) and git state (commit + uncommitted changes), with the manifest written to `snapshot/manifest.json`. Before re-verification the current script hash is compared against the registered value: a mismatch lands as `drift` (the code has moved on, reruns are not comparable) rather than being misjudged as fabricated data; when hashes match, the snapshot copy is preferred for the rerun. A drifted run cannot be marked complete, and both the state card and collect surface the condition.

## Core modules

| File | Responsibility |
| --- | --- |
| store.ts | Experiment ledger: lines, runs, metrics, artifacts, claims, workers, line_locks, councils, council_messages, activity (node:sqlite) |
| recall.ts | Metric trajectory retrieval and experiment-line cognitive summary |
| resilient.ts | Reliable LLM call foundation (liveness failover, three-way failure classification, audit) |
| stats.ts | Wilcoxon signed-rank (exact enumeration for n≤16), paired t, win/tie/loss |
| compare.ts | Experiment-line and per-scenario paired comparison, including direction checks against open claims |
| pool.ts | Task pool validation, bidirectional difficulty-band filtering, distribution statistics |
| eval.ts | Python evaluator script orchestration (isolated subprocess, hard timeout, interpreter probing) |
| verify.ts | Independent re-verification: rerun the evaluation command and compare the rerun results against the ledger metrics item by item; drift detection takes precedence over numeric comparison |
| snapshot.ts | Input snapshot: script copy, data/environment/git fingerprint manifest, for retrospection and drift determination |
| worker.ts | Router/worker process orchestration |
| council.ts | Group-chat review pure-function layer: open challenges, blocking latch, verdict gate (fail-closed) |

## Group-chat review (council)

The four tools `lab_council_open / post / read / verdict` support three roles — executor, auditor and chair — cross-examining each other around a single shared transcript: the executor truthfully reports on completion of the task brief, the auditor reads the ledger and artifacts read-only and challenges item by item (defects graded with `severity=blocking`), and the chair reads through the record and returns a verdict of approved or rejected. A blocking challenge is a lifetime latch within that council and must reach zero before `approved`; "constraint-qualified release" is refused at both the ledger layer and the tool layer. The run completion gate requires a council covering the run with status approved; rejected and expired are handled as fail-closed without exception.
