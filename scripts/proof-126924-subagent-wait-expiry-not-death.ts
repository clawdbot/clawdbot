/**
 * Real-runtime proof for PR #126924 — "distinguish a subagent wait expiring from
 * the child dying".
 *
 * Run:
 *   pnpm tsx scripts/proof-126924-subagent-wait-expiry-not-death.ts
 *
 * WHAT IS REAL HERE
 * - The production subagent registry singleton (`src/agents/subagents/registry/
 *   subagent-registry.ts`): the real `registerSubagentRun` launch path, the real
 *   run-wait loop on real wall-clock timers, the real completion pipeline, and
 *   the real sweeper driven through the exported
 *   `scheduleSubagentRegistrySweep`. No vitest, no fake timers.
 * - The real detached task registry. `registerSubagentRun` creates the task row
 *   itself, and every status write goes through the real
 *   `updateTaskStateByRunId` / `shouldApplyRunScopedStatusUpdate` transition
 *   rules. That matters: those rules are precisely why publishing `timed_out`
 *   is irreversible, so a mocked task runtime could not prove this fix.
 * - The real session store. Each child's own session row lives in a real SQLite
 *   store under a temp `OPENCLAW_STATE_DIR`, written through the real
 *   `replaceSessionEntry` and read back by the real
 *   `settleSubagentRunFromSessionStore`. The "absent snapshot" scenario uses a
 *   child that genuinely has no row on disk — not a stubbed return value.
 *
 * WHAT IS STUBBED, AND ONLY THIS
 * - `subagentRegistryDeps.callGateway` — the WebSocket edge that would reach the
 *   child agent's own run. `agent.wait` answers `{ status: "timeout" }` with no
 *   terminal snapshot, which is exactly the deadline-only expiry under test.
 *   Every request is recorded, so the proof asserts on what the production code
 *   actually submitted — notably whether any `sessions.delete` was sent for a
 *   child that may still be live.
 *
 * WHAT THIS PROOF DOES NOT COVER — stated plainly
 * - This is not a live isolated-Gateway run with a real child agent process. No
 *   model backend is invoked and no child agent is spawned, so "the child is
 *   still alive" is represented by its real persisted session row rather than by
 *   an OS process still doing work. The registry cannot tell the difference —
 *   that row is the only independent liveness evidence it ever consults — but
 *   the distinction is real and is not being papered over.
 * - Scenario 4 stages the child's successful stop by writing its real session
 *   row with an `endedAt` inside the deadline window after the wait already
 *   expired. That is the modelled race (the wait's snapshot missed a stop that
 *   had already happened), but the ordering is staged by this script rather than
 *   arising from a live child.
 *
 * SCENARIOS (each asserts; the script exits non-zero on any violation)
 *  1. Deadline-only expiry      — the run completes so the parent wakes, the
 *                                 outcome says `child-unconfirmed`, and the
 *                                 detached task stays NONTERMINAL.
 *  2. Continued liveness        — while the child's own row still says running,
 *                                 no `sessions.delete` is submitted, the row is
 *                                 not retired, and our guess is not stamped onto
 *                                 the child's record.
 *  3. Absent session snapshot   — a second run whose child has no session row at
 *                                 all is still not retired or deleted: absence
 *                                 of evidence is not evidence of a stop.
 *  4. Later observed completion — the child's own row reports a successful stop
 *                                 inside the deadline; the task is promoted to
 *                                 `succeeded` through the very transition a
 *                                 published `timed_out` would have blocked.
 *  5. Control (anti-vacuity)    — that same promotion attempted from a published
 *                                 `timed_out` is rejected, which is what makes
 *                                 scenario 1 load-bearing rather than cosmetic.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

type SubagentRegistryModule =
  typeof import("../src/agents/subagents/registry/subagent-registry.js");
type SubagentRegistryReadModule =
  typeof import("../src/agents/subagents/registry/subagent-registry-read.js");
type SubagentRegistryDepsModule =
  typeof import("../src/agents/subagents/registry/subagent-registry-deps.js");
type SessionReconciliationModule =
  typeof import("../src/agents/subagents/registry/subagent-session-reconciliation.js");
type DetachedTaskRuntimeModule = typeof import("../src/tasks/detached-task-runtime.js");
type SessionAccessorModule = typeof import("../src/config/sessions/session-accessor.js");

const repoRoot = process.env.PROOF_REPO_ROOT ?? process.cwd();
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-proof-126924-"));
const stateDir = path.join(stateRoot, "state");
fs.mkdirSync(stateDir, { recursive: true });
process.env.OPENCLAW_STATE_DIR = stateDir;
const configPath = path.join(stateRoot, "openclaw.json");
process.env.OPENCLAW_CONFIG_PATH = configPath;
// A real config file with the shortest archive window the schema allows (values
// below one minute are floored to one). Retention has to actually come due
// inside this script, or the fail-closed assertions would pass vacuously.
const ARCHIVE_AFTER_MINUTES = 1;
fs.writeFileSync(
  configPath,
  `${JSON.stringify(
    { agents: { defaults: { subagents: { archiveAfterMinutes: ARCHIVE_AFTER_MINUTES } } } },
    null,
    2,
  )}\n`,
);

const REQUESTER_SESSION_KEY = "agent:main:main";
const LIVE_RUN_ID = "run-proof-126924-live";
const LIVE_CHILD_SESSION_KEY = "agent:main:subagent:proof-126924-live";
const ABSENT_RUN_ID = "run-proof-126924-absent";
const ABSENT_CHILD_SESSION_KEY = "agent:main:subagent:proof-126924-absent";
const CONTROL_RUN_ID = "run-proof-126924-control";
const CONTROL_CHILD_SESSION_KEY = "agent:main:subagent:proof-126924-control";
const RUN_TIMEOUT_SECONDS = 6;

const importSource = async (relativePath: string) =>
  import(pathToFileURL(path.join(repoRoot, relativePath)).href);

const gatewayRequests: { method?: string }[] = [];
const sessionDeleteCount = () =>
  gatewayRequests.filter((request) => request.method === "sessions.delete").length;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

const log = (message: string) => {
  process.stdout.write(`${message}\n`);
};

try {
  const depsModule = (await importSource(
    "src/agents/subagents/registry/subagent-registry-deps.js",
  )) as SubagentRegistryDepsModule;
  const registry = (await importSource(
    "src/agents/subagents/registry/subagent-registry.js",
  )) as SubagentRegistryModule;
  const registryRead = (await importSource(
    "src/agents/subagents/registry/subagent-registry-read.js",
  )) as SubagentRegistryReadModule;
  const reconciliation = (await importSource(
    "src/agents/subagents/registry/subagent-session-reconciliation.js",
  )) as SessionReconciliationModule;
  const taskRuntime = (await importSource(
    "src/tasks/detached-task-runtime.js",
  )) as DetachedTaskRuntimeModule;
  const sessionAccessor = (await importSource(
    "src/config/sessions/session-accessor.js",
  )) as SessionAccessorModule;

  // The ONLY stub: the gateway edge that would reach the child agent's own run.
  // `agent.wait` returning a bare timeout with no terminal snapshot IS the
  // deadline-only expiry this PR is about.
  depsModule.setSubagentRegistryDepsForTest({
    callGateway: (async (request: { method?: string }) => {
      gatewayRequests.push(request);
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      return {};
    }) as SubagentRegistryDepsModule["subagentRegistryDeps"]["callGateway"],
  });

  const writeChildSessionRow = async (
    childSessionKey: string,
    entry: { status: "running" | "done"; updatedAt: number; startedAt: number; endedAt?: number },
  ) => {
    // The production writer for a whole entry: it creates the row when absent
    // and replaces it in place otherwise, through the real SQLite store.
    await sessionAccessor.replaceSessionEntry({ sessionKey: childSessionKey, agentId: "main" }, {
      sessionId: `sess-${childSessionKey}`,
      ...entry,
    } as Parameters<SessionAccessorModule["replaceSessionEntry"]>[1]);
  };
  const readChildSessionRow = (childSessionKey: string) =>
    reconciliation.loadSubagentSessionEntry({ childSessionKey });

  const readRun = (runId: string) =>
    registryRead
      .listSubagentRunsForRequester(REQUESTER_SESSION_KEY)
      .find((entry) => entry.runId === runId);
  const readTaskStatus = (runId: string, childSessionKey: string) => {
    const found = taskRuntime.findDetachedTaskRun({
      runId,
      runtime: "subagent",
      sessionKey: childSessionKey,
      createdAtOrAfter: startedAtMs,
    });
    return found.lookup === "available" ? found.task?.status : undefined;
  };
  const sweep = async () => {
    registry.scheduleSubagentRegistrySweep({ delayMs: 0 });
    await sleep(500);
  };

  const startedAtMs = Date.now();
  const deadlineMs = startedAtMs + RUN_TIMEOUT_SECONDS * 1_000;

  // The live child's own record: alive and running. This is a real row on disk
  // and the only independent liveness evidence the registry ever consults.
  await writeChildSessionRow(LIVE_CHILD_SESSION_KEY, {
    status: "running",
    updatedAt: startedAtMs,
    startedAt: startedAtMs,
  });
  assert.equal(
    readChildSessionRow(LIVE_CHILD_SESSION_KEY)?.status,
    "running",
    "the live child's session row must be readable through the production reader",
  );
  // The absent child deliberately gets NO row written, ever.
  assert.equal(
    readChildSessionRow(ABSENT_CHILD_SESSION_KEY),
    undefined,
    "the absent child must genuinely have no session row on disk",
  );

  for (const [runId, childSessionKey] of [
    [LIVE_RUN_ID, LIVE_CHILD_SESSION_KEY],
    [ABSENT_RUN_ID, ABSENT_CHILD_SESSION_KEY],
  ] as const) {
    registry.registerSubagentRun({
      runId,
      childSessionKey,
      requesterSessionKey: REQUESTER_SESSION_KEY,
      requesterDisplayKey: "main",
      task: "proof: a deadline-only wait expiry must not claim the child died",
      // delete-mode is what makes a row reach session/attachment teardown at
      // all; a keep-mode row would be retained for unrelated reasons.
      cleanup: "delete",
      runTimeoutSeconds: RUN_TIMEOUT_SECONDS,
      expectsCompletionMessage: false,
      taskRowOwnership: "required",
    });
    assert.equal(
      readTaskStatus(runId, childSessionKey),
      "running",
      `the launch must own a real running task row for ${runId}, or later assertions are vacuous`,
    );
  }
  log(
    `[setup] two runs registered with real running task rows (deadline in ${RUN_TIMEOUT_SECONDS}s)`,
  );

  // ---------------------------------------------------------------- scenario 1
  await waitFor(
    "the deadline-only wait expiry to complete both runs",
    () =>
      readRun(LIVE_RUN_ID)?.execution.outcome !== undefined &&
      readRun(ABSENT_RUN_ID)?.execution.outcome !== undefined,
  );
  for (const [runId, childSessionKey] of [
    [LIVE_RUN_ID, LIVE_CHILD_SESSION_KEY],
    [ABSENT_RUN_ID, ABSENT_CHILD_SESSION_KEY],
  ] as const) {
    const run = readRun(runId);
    assert.equal(run?.execution.status, "terminal", "the run must complete so the parent wakes");
    assert.equal(run?.execution.outcome?.status, "timeout");
    assert.equal(
      run?.execution.outcome?.timeoutDisposition,
      "child-unconfirmed",
      "a deadline is a clock comparison; nothing observed the child stop",
    );
    const taskStatus = readTaskStatus(runId, childSessionKey);
    assert.equal(
      taskStatus,
      "running",
      `the detached task must stay nonterminal on a deadline-only expiry (${runId} was ${String(taskStatus)})`,
    );
  }
  log("[1/5] deadline-only expiry: outcome=timeout disposition=child-unconfirmed for both runs");
  log(
    "[1/5] detached tasks read back through the real task registry: status=running (nonterminal)",
  );

  // Both rows are delete-mode, so retention is armed at `endedAt +
  // archiveAfterMinutes`. Wait until it has actually come due: without that the
  // fail-closed assertions below would pass simply because nothing was eligible
  // for teardown yet.
  const liveArchiveAtMs = readRun(LIVE_RUN_ID)?.archiveAtMs;
  const absentArchiveAtMs = readRun(ABSENT_RUN_ID)?.archiveAtMs;
  assert.equal(
    typeof liveArchiveAtMs,
    "number",
    "retention must be armed on the live run, or scenario 2 proves nothing",
  );
  assert.equal(
    typeof absentArchiveAtMs,
    "number",
    "retention must be armed on the absent run, or scenario 3 proves nothing",
  );
  const retentionDueAt = Math.max(liveArchiveAtMs ?? 0, absentArchiveAtMs ?? 0) + 2_000;
  log(
    `[wait] retention armed (archiveAfterMinutes=${ARCHIVE_AFTER_MINUTES}); waiting ${Math.max(0, Math.ceil((retentionDueAt - Date.now()) / 1_000))}s for it to come due`,
  );
  while (Date.now() < retentionDueAt) {
    await sleep(500);
  }

  // ---------------------------------------------------------------- scenario 2
  await sweep();
  await sweep();
  assert.ok(readRun(LIVE_RUN_ID), "a still-live child's run must not be retired by a clock");
  assert.equal(
    sessionDeleteCount(),
    0,
    "no sessions.delete may be submitted for a child that may still be running",
  );
  assert.equal(
    readChildSessionRow(LIVE_CHILD_SESSION_KEY)?.status,
    "running",
    "our own derived status must not be stamped onto the child's own record",
  );
  assert.equal(
    readTaskStatus(LIVE_RUN_ID, LIVE_CHILD_SESSION_KEY),
    "running",
    "the task must still be nonterminal after sweeps with a live child",
  );
  log(
    `[2/5] continued liveness: run retained, child row still "running", sessions.delete count=${sessionDeleteCount()}`,
  );

  // ---------------------------------------------------------------- scenario 3
  // The absent child: the production reader returns no entry, which is the
  // absence of evidence. The same read returns absent when the store is
  // unreadable or has not been written yet, so it can never mean "stopped".
  assert.equal(
    readChildSessionRow(ABSENT_CHILD_SESSION_KEY),
    undefined,
    "scenario 3 requires a genuinely absent session snapshot",
  );
  await sweep();
  await sweep();
  assert.ok(
    readRun(ABSENT_RUN_ID),
    "an absent session snapshot must not authorize retiring the run (fail closed)",
  );
  assert.equal(
    sessionDeleteCount(),
    0,
    "an absent session snapshot must not authorize deleting the child's session",
  );
  log(
    `[3/5] absent session snapshot: run retained across repeated sweeps, sessions.delete count=${sessionDeleteCount()}`,
  );

  // ---------------------------------------------------------------- scenario 4
  // The live child's own record now says it finished successfully, at a moment
  // inside the deadline window — exactly the race this PR exists to fix: the
  // wait expired on a clock while a successful stop had already happened.
  const observedEndedAt = deadlineMs - 2_000;
  await writeChildSessionRow(LIVE_CHILD_SESSION_KEY, {
    status: "done",
    updatedAt: observedEndedAt,
    startedAt: startedAtMs,
    endedAt: observedEndedAt,
  });
  assert.equal(readChildSessionRow(LIVE_CHILD_SESSION_KEY)?.status, "done");
  assert.equal(readChildSessionRow(LIVE_CHILD_SESSION_KEY)?.endedAt, observedEndedAt);
  await sweep();
  await waitFor(
    "the observed stop to promote the detached task",
    () => readTaskStatus(LIVE_RUN_ID, LIVE_CHILD_SESSION_KEY) === "succeeded",
  );
  assert.equal(
    readTaskStatus(LIVE_RUN_ID, LIVE_CHILD_SESSION_KEY),
    "succeeded",
    "the observed success must be publishable; a published timed_out would have blocked it",
  );
  log("[4/5] later observed completion: detached task promoted running -> succeeded");

  // ---------------------------------------------------------------- scenario 5
  // Control. The same promotion from a published `timed_out` is refused, which
  // is why scenario 1 has to withhold the terminal state rather than relabel it.
  const controlTask = taskRuntime.createRunningTaskRun({
    runtime: "subagent",
    ownerKey: REQUESTER_SESSION_KEY,
    scopeKind: "session",
    childSessionKey: CONTROL_CHILD_SESSION_KEY,
    runId: CONTROL_RUN_ID,
    task: "control: a published timed_out is unrepairable",
    startedAt: startedAtMs,
    lastEventAt: startedAtMs,
  });
  assert.ok(controlTask, "control task creation must succeed");
  taskRuntime.failTaskRunByRunId({
    runId: CONTROL_RUN_ID,
    runtime: "subagent",
    sessionKey: CONTROL_CHILD_SESSION_KEY,
    status: "timed_out",
    endedAt: observedEndedAt,
    lastEventAt: observedEndedAt,
  });
  assert.equal(readTaskStatus(CONTROL_RUN_ID, CONTROL_CHILD_SESSION_KEY), "timed_out");
  const rejected = taskRuntime.completeTaskRunByRunId({
    runId: CONTROL_RUN_ID,
    runtime: "subagent",
    sessionKey: CONTROL_CHILD_SESSION_KEY,
    endedAt: observedEndedAt + 1_000,
    lastEventAt: observedEndedAt + 1_000,
    progressSummary: "child finished after its deadline",
  });
  assert.equal(
    rejected.length,
    0,
    "timed_out -> succeeded must be rejected; if this ever passes, scenario 1 is unnecessary",
  );
  assert.equal(
    readTaskStatus(CONTROL_RUN_ID, CONTROL_CHILD_SESSION_KEY),
    "timed_out",
    "a published timeout stays published forever",
  );
  log("[5/5] control: timed_out -> succeeded rejected by the real task transition rules");

  log("");
  log("All runtime assertions passed.");
} finally {
  fs.rmSync(stateRoot, { recursive: true, force: true });
}
