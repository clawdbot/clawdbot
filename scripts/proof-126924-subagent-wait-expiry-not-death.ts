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
 * - `subagentRegistryDeps.captureSubagentCompletionReply` — the child's own
 *   transcript. It answers from a scripted per-session map so the proof can tell
 *   pre-expiry partial output apart from the child's real final output. The seam
 *   under test (`freezeRunResultAtCompletion`'s first-write-wins capture and the
 *   promotion that must clear it) is entirely real; only the transcript text is
 *   scripted, exactly as a real child would have changed it between the two
 *   reads.
 * - `subagentRegistryDeps.loadAgentRuntimePluginRegistryHandle` — resolves "no
 *   plugin registry" rather than loading the plugin host. The terminal-hook code
 *   path still executes for real against an empty registry, which is what a real
 *   load would return for this config's zero configured plugins. The reason is
 *   measured, not aesthetic: the real loader compiles the plugin host through
 *   jiti synchronously and blocked the event loop for ~160s on a cold cache.
 *   Plugin-hook deferral itself is covered by unit tests, not by this script.
 *
 * WHAT IS ADVANCED RATHER THAN WAITED OUT
 * - `delivery.suspendedAt` is rewound past its hard-coded seven-day expiry.
 *   Sleeping that out is impossible. The sweeper still reads `Date.now()`
 *   itself and compares it against the real row, so the expiry branch is
 *   genuinely eligible.
 *
 * OUTPUT CADENCE AND RUNTIME
 * - Measured here: ~2 minutes end to end, of which ~95s is one cold synchronous jiti
 *   compile of a large production module graph reached by the real promotion
 *   path. That block cannot be split or yielded, so a heartbeat worker prints an
 *   `[alive]` line every 5s straight to fd 1 (see below) — no gap in this
 *   script's output exceeds ~5s, in any environment.
 * - The script exits on its own verdict rather than waiting for the registry's
 *   live timers and open session store to drain, which added ~3 minutes.
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
 *  6. Suspended-delivery expiry — a still-unconfirmed run whose final delivery
 *                                 has been suspended past its seven-day
 *                                 retention: the expiry fires and abandons the
 *                                 stale delivery, but the child's real
 *                                 attachments directory survives and the row is
 *                                 not retired. The assertion that the discard
 *                                 actually ran is what keeps this non-vacuous.
 *  7. Swarm slot retention      — a real collector in a real `maxConcurrent: 1`
 *                                 scheduler lane with a real queued sibling: the
 *                                 deadline-only expiry must NOT release the lane
 *                                 slot, so the sibling does not start beside a
 *                                 possibly-live child. The observed stop later
 *                                 releases it and the sibling runs.
 *  8. Result recapture          — the promoted run must publish the child's
 *                                 FINAL output, not the partial text frozen when
 *                                 the wait expired.
 *  9. List liveness             — the production `buildSubagentList` must show an
 *                                 unconfirmed run as live rather than filing it
 *                                 under recent timeouts while its task is still
 *                                 running.
 * 10. Cancellation at the deadline — a real `lifecycle` abort event whose
 *                                 authoritative `endedAt` equals the deadline is
 *                                 stop evidence: it must promote a row whose
 *                                 child session record is genuinely absent,
 *                                 rather than deferring cleanup forever.
 * 11. Restart reconciliation   — the rows are reloaded from the real registry
 *                                 store into a fresh map, exactly as a gateway
 *                                 restart does, and handed to the production
 *                                 `reconcileOrphanedRestoredRuns`. An
 *                                 unconfirmed row with a genuinely absent child
 *                                 session snapshot must survive; the same
 *                                 reloaded row with an observed stop must still
 *                                 be pruned.
 * 12. Resume, then promotion   — the real exported `resumeSubagentRun` must not
 *                                 delete that row either, and the child's own
 *                                 terminal session record must then promote it
 *                                 out of the provisional state. This is the
 *                                 half that shows the retention was load-
 *                                 bearing: a deleted row can never be promoted.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

type SubagentRegistryModule =
  typeof import("../src/agents/subagents/registry/subagent-registry.js");
type SubagentRegistryReadModule =
  typeof import("../src/agents/subagents/registry/subagent-registry-read.js");
type SubagentRegistryDepsModule =
  typeof import("../src/agents/subagents/registry/subagent-registry-deps.js");
type SessionReconciliationModule =
  typeof import("../src/agents/subagents/registry/subagent-session-reconciliation.js");
type SubagentRegistryMemoryModule =
  typeof import("../src/agents/subagents/registry/subagent-registry-memory.js");
type SubagentRegistryStateModule =
  typeof import("../src/agents/subagents/registry/subagent-registry-state.js");
type SubagentRegistryHelpersModule =
  typeof import("../src/agents/subagents/registry/subagent-registry-helpers.js");
type DetachedTaskRuntimeModule = typeof import("../src/tasks/detached-task-runtime.js");
type SessionAccessorModule = typeof import("../src/config/sessions/session-accessor.js");
type SwarmSchedulerModule = typeof import("../src/agents/subagents/swarm/swarm-scheduler.js");
type SubagentListModule = typeof import("../src/agents/subagents/registry/subagent-list.js");
type AgentEventsModule = typeof import("../src/infra/agent-events.js");

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
const COLLECT_RUN_ID = "run-proof-126924-collector";
const COLLECT_CHILD_SESSION_KEY = "agent:main:subagent:proof-126924-collector";
const COLLECT_SIBLING_RUN_ID = "run-proof-126924-collector-sibling";
const SWARM_GROUP_ID = "swarm-proof-126924";
const KILL_RUN_ID = "run-proof-126924-kill-at-deadline";
const KILL_CHILD_SESSION_KEY = "agent:main:subagent:proof-126924-kill-at-deadline";
const PARTIAL_OUTPUT = "PARTIAL: 40% done when the parent's wait expired";
const FINAL_OUTPUT = "FINAL: the child finished the whole task";
const RUN_TIMEOUT_SECONDS = 6;
const SUSPENDED_RETENTION_DAYS = 7;

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

// Liveness output that cannot be starved. The promotion path's real terminal-hook
// emit pulls the plugin-SDK module graph in through jiti, which compiles
// synchronously and blocked this thread's event loop for over a minute on a cold
// cache (profiled). A `setInterval` here could not fire during that window, so
// the heartbeat runs in a worker writing straight to fd 1, where it is never
// gated on this thread. Without it a reviewer's harness sees a long silence and
// concludes the script hung — which is exactly what happened in review round 6.
const heartbeat = new Worker(
  [
    'const fs = require("node:fs");',
    "const startedAt = Date.now();",
    "setInterval(() => {",
    "  const seconds = Math.round((Date.now() - startedAt) / 1000);",
    "  fs.writeSync(1, `[alive] ${seconds}s elapsed; loading production modules or sweeping\\n`);",
    "}, 5000);",
  ].join("\n"),
  { eval: true, execArgv: [] },
);
heartbeat.unref();

let exitCode = 0;
try {
  const bootStartedAt = Date.now();
  log("[boot] importing the production registry, task runtime and session store...");
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
  // The live registry row map the sweeper itself reads. Used only to rewind the
  // two retention clocks described in the header; every decision under test is
  // still made by production code against `Date.now()`.
  const registryState = (await importSource(
    "src/agents/subagents/registry/subagent-registry-state.js",
  )) as SubagentRegistryStateModule;
  const registryHelpers = (await importSource(
    "src/agents/subagents/registry/subagent-registry-helpers.js",
  )) as SubagentRegistryHelpersModule;
  const memory = (await importSource(
    "src/agents/subagents/registry/subagent-registry-memory.js",
  )) as SubagentRegistryMemoryModule;
  const taskRuntime = (await importSource(
    "src/tasks/detached-task-runtime.js",
  )) as DetachedTaskRuntimeModule;
  const sessionAccessor = (await importSource(
    "src/config/sessions/session-accessor.js",
  )) as SessionAccessorModule;
  const swarmScheduler = (await importSource(
    "src/agents/subagents/swarm/swarm-scheduler.js",
  )) as SwarmSchedulerModule;
  const subagentList = (await importSource(
    "src/agents/subagents/registry/subagent-list.js",
  )) as SubagentListModule;
  const agentEvents = (await importSource("src/infra/agent-events.js")) as AgentEventsModule;
  log(`[boot] production modules imported in ${Math.round((Date.now() - bootStartedAt) / 1_000)}s`);

  // The ONLY stub: the gateway edge that would reach the child agent's own run.
  // `agent.wait` returning a bare timeout with no terminal snapshot IS the
  // deadline-only expiry this PR is about.
  // The child's transcript, scripted. Flipped from partial to final exactly when
  // the child's own session row is flipped to `done` in scenario 4 — i.e. the
  // transcript changes when the child finishes, as it would in production.
  const childTranscript = new Map<string, string>();
  depsModule.setSubagentRegistryDepsForTest({
    captureSubagentCompletionReply: (async (sessionKey: string) =>
      childTranscript.get(
        sessionKey,
      )) as SubagentRegistryDepsModule["subagentRegistryDeps"]["captureSubagentCompletionReply"],
    callGateway: (async (request: { method?: string }) => {
      gatewayRequests.push(request);
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      return {};
    }) as SubagentRegistryDepsModule["subagentRegistryDeps"]["callGateway"],
    // Second declared stub, at the plugin-host edge: resolve "no plugin registry"
    // instead of loading the plugin runtime. The terminal-hook path still runs
    // for real (`emitSubagentEndedHookOnce`, its exactly-once marker, and the
    // provisional gate above it) — it just runs against an empty registry, which
    // is what a real load would return anyway for this config's zero configured
    // plugins. This is here for a measured reason: the real loader compiles the
    // plugin host through jiti synchronously, which blocked the event loop for
    // ~160s on a cold cache (profiled: 181s sampled, 12s idle, the rest in
    // jiti frames) and made this script unrunnable inside a reviewer's harness.
    loadAgentRuntimePluginRegistryHandle: () => undefined,
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

  const attachmentsRootDir = path.join(stateRoot, "attachments");
  const attachmentsDirFor = (runId: string) => path.join(attachmentsRootDir, runId);
  const artifactFor = (runId: string) => path.join(attachmentsDirFor(runId), "child-output.txt");
  for (const runId of [LIVE_RUN_ID, ABSENT_RUN_ID]) {
    fs.mkdirSync(attachmentsDirFor(runId), { recursive: true });
    fs.writeFileSync(artifactFor(runId), "written by a child that may still be running\n");
  }

  const liveRow = (runId: string) => {
    const row = memory.subagentRuns.get(runId);
    assert.ok(row, `the live registry row for ${runId} must be readable`);
    return row;
  };
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
      // Real directories with real content, handed to the production launch
      // path. Attachment removal is the one terminal effect a later promotion
      // can never undo, so it is asserted on the filesystem, not on a spy.
      attachmentsRootDir,
      attachmentsDir: attachmentsDirFor(runId),
    });
    assert.equal(
      readTaskStatus(runId, childSessionKey),
      "running",
      `the launch must own a real running task row for ${runId}, or later assertions are vacuous`,
    );
  }

  // The live child's transcript as it stands while it is still working. Nothing
  // has observed it stop, so this is the only text any capture can return yet.
  childTranscript.set(LIVE_CHILD_SESSION_KEY, PARTIAL_OUTPUT);

  // A third run for scenario 10: its child session record is deliberately never
  // written, which is the exact condition in which a rejected cancellation
  // callback leaves the row deferred forever.
  registry.registerSubagentRun({
    runId: KILL_RUN_ID,
    childSessionKey: KILL_CHILD_SESSION_KEY,
    requesterSessionKey: REQUESTER_SESSION_KEY,
    requesterDisplayKey: "main",
    task: "proof: a cancellation recorded at the deadline is stop evidence",
    cleanup: "keep",
    runTimeoutSeconds: RUN_TIMEOUT_SECONDS,
    expectsCompletionMessage: false,
    taskRowOwnership: "required",
  });

  // A real swarm lane with room for exactly one collector, driven through the
  // production scheduler the spawn path uses. The sibling is a genuine queued
  // launch: nothing but a released slot can start it.
  const collectorSiblingStarts: string[] = [];
  const swarmActiveRunIds: string[] = [];
  await writeChildSessionRow(COLLECT_CHILD_SESSION_KEY, {
    status: "running",
    updatedAt: startedAtMs,
    startedAt: startedAtMs,
  });
  swarmScheduler.enqueueSwarmRun({
    groupId: SWARM_GROUP_ID,
    runId: COLLECT_RUN_ID,
    maxConcurrent: 1,
    activeRunIds: swarmActiveRunIds,
    start: async () => {
      swarmActiveRunIds.push(COLLECT_RUN_ID);
      registry.registerSubagentRun({
        runId: COLLECT_RUN_ID,
        childSessionKey: COLLECT_CHILD_SESSION_KEY,
        requesterSessionKey: REQUESTER_SESSION_KEY,
        requesterDisplayKey: "main",
        task: "proof: a collector must keep its swarm slot until it is seen to stop",
        cleanup: "keep",
        collect: true,
        groupId: SWARM_GROUP_ID,
        runTimeoutSeconds: RUN_TIMEOUT_SECONDS,
        expectsCompletionMessage: false,
        taskRowOwnership: "required",
      });
    },
    onStartFailure: () => true,
  });
  swarmScheduler.enqueueSwarmRun({
    groupId: SWARM_GROUP_ID,
    runId: COLLECT_SIBLING_RUN_ID,
    maxConcurrent: 1,
    activeRunIds: swarmActiveRunIds,
    start: async () => {
      collectorSiblingStarts.push(COLLECT_SIBLING_RUN_ID);
    },
    onStartFailure: () => true,
  });
  await waitFor(
    "the collector to occupy the only slot in its lane",
    () => swarmScheduler.isSwarmRunActive(COLLECT_RUN_ID) && readRun(COLLECT_RUN_ID) !== undefined,
  );
  assert.deepEqual(
    collectorSiblingStarts,
    [],
    "the queued sibling must be genuinely blocked by maxConcurrent, or scenario 7 is vacuous",
  );
  log(
    `[setup] four runs registered with real running task rows (deadline in ${RUN_TIMEOUT_SECONDS}s); collector holds the only slot in a maxConcurrent=1 lane`,
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
  log("[1/12] deadline-only expiry: outcome=timeout disposition=child-unconfirmed for both runs");
  log(
    "[1/12] detached tasks read back through the real task registry: status=running (nonterminal)",
  );

  for (const runId of [LIVE_RUN_ID, ABSENT_RUN_ID]) {
    assert.equal(
      liveRow(runId).archiveAtMs,
      undefined,
      `an unconfirmed child must not arm retention (${runId})`,
    );
  }
  log("[clock] unconfirmed rows armed no destructive retention deadline");

  // ---------------------------------------------------------------- scenario 7
  // The collector's wait expired on the same clock. `releaseSwarmRun` deletes the
  // lane's active reservation and pumps the queue, so releasing it here would
  // start the sibling beside a child nothing has observed stopping.
  await waitFor(
    "the collector's deadline-only expiry",
    () => readRun(COLLECT_RUN_ID)?.execution.outcome !== undefined,
  );
  assert.equal(
    readRun(COLLECT_RUN_ID)?.execution.outcome?.timeoutDisposition,
    "child-unconfirmed",
    "the collector must reach the same deadline-only disposition",
  );
  await sleep(200);
  assert.equal(
    swarmScheduler.isSwarmRunActive(COLLECT_RUN_ID),
    true,
    "the swarm slot belongs to the child, not the row: a bare deadline must not release it",
  );
  assert.deepEqual(
    collectorSiblingStarts,
    [],
    "no queued sibling may start beside a collector whose stop was never observed",
  );
  log(
    "[7/12] swarm slot retention: collector expired child-unconfirmed, slot still held, queued sibling not started",
  );

  // Now the collector's own record reports a stop. The promotion must release
  // the slot exactly once and let the queued sibling run — without this half the
  // assertion above could be satisfied by never releasing the slot at all.
  const collectorEndedAt = deadlineMs - 1_000;
  await writeChildSessionRow(COLLECT_CHILD_SESSION_KEY, {
    status: "done",
    updatedAt: collectorEndedAt,
    startedAt: startedAtMs,
    endedAt: collectorEndedAt,
  });
  await sweep();
  await waitFor(
    "the observed collector stop to release the swarm slot",
    () => collectorSiblingStarts.length > 0,
  );
  assert.deepEqual(
    collectorSiblingStarts,
    [COLLECT_SIBLING_RUN_ID],
    "the observed stop must release the slot exactly once",
  );
  assert.equal(swarmScheduler.isSwarmRunActive(COLLECT_RUN_ID), false);
  log("[7/12] observed collector stop released the slot; the queued sibling started");

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
  assert.ok(
    fs.existsSync(artifactFor(LIVE_RUN_ID)),
    "the child's attachments must survive: a live child may still be writing there",
  );
  log(
    `[2/12] continued liveness: run retained, child row still "running", attachments intact, sessions.delete count=${sessionDeleteCount()}`,
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
  assert.ok(
    fs.existsSync(artifactFor(ABSENT_RUN_ID)),
    "an absent session snapshot must not authorize removing the child's attachments",
  );
  log(
    `[3/12] absent session snapshot: run retained across repeated sweeps, attachments intact, sessions.delete count=${sessionDeleteCount()}`,
  );

  // ---------------------------------------------------------------- scenario 9
  // The model-visible listing, built by the production `buildSubagentList` from
  // the real registry rows while the live run is still unconfirmed. Filing it
  // under recent timeouts here would contradict, in the same turn, both the
  // completion warning and the still-`running` detached task — and a parent that
  // believes the listing is the one that spawns the destructive replacement.
  const unconfirmedList = subagentList.buildSubagentList({
    cfg: depsModule.subagentRegistryDeps.getRuntimeConfig(),
    runs: registryRead.listSubagentRunsForRequester(REQUESTER_SESSION_KEY),
    recentMinutes: 30,
  });
  const listedLiveRun = unconfirmedList.active.find((item) => item.runId === LIVE_RUN_ID);
  assert.ok(
    listedLiveRun,
    "an unconfirmed run must be listed as live work, not filed under recent timeouts",
  );
  assert.equal(
    unconfirmedList.recent.some((item) => item.runId === LIVE_RUN_ID),
    false,
    "an unconfirmed run must not appear under recent",
  );
  assert.notEqual(
    listedLiveRun.status,
    "timeout",
    "the listing must never report a possibly-live child as a finished timeout",
  );
  assert.match(listedLiveRun.status, /unconfirmed/);
  assert.equal(
    readTaskStatus(LIVE_RUN_ID, LIVE_CHILD_SESSION_KEY),
    "running",
    "the contradiction under test requires the detached task to still be running here",
  );
  log(`[9/12] subagents list: active row status="${listedLiveRun.status}", task still running`);

  // ---------------------------------------------------------------- scenario 4
  // The live child's own record now says it finished successfully, at a moment
  // inside the deadline window — exactly the race this PR exists to fix: the
  // wait expired on a clock while a successful stop had already happened.
  const observedEndedAt = deadlineMs - 2_000;
  // The child's transcript changed when it finished, exactly as it would in
  // production. The registry froze `PARTIAL_OUTPUT` at wait expiry, and
  // `freezeRunResultAtCompletion` is first-write-wins on `resultText`.
  assert.equal(
    readRun(LIVE_RUN_ID)?.completion?.resultText,
    PARTIAL_OUTPUT,
    "scenario 8 requires the provisional capture to have really frozen the partial text",
  );
  childTranscript.set(LIVE_CHILD_SESSION_KEY, FINAL_OUTPUT);
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
  log("[4/12] later observed completion: detached task promoted running -> succeeded");

  // ---------------------------------------------------------------- scenario 8
  // The durable projection is the one that matters: this is the task a parent
  // or operator reads after the promotion, and it is what would have exposed
  // pre-expiry output as a finished run's result.
  const promotedTask = taskRuntime.findDetachedTaskRun({
    runId: LIVE_RUN_ID,
    runtime: "subagent",
    sessionKey: LIVE_CHILD_SESSION_KEY,
    createdAtOrAfter: startedAtMs,
  });
  const promotedSummary =
    promotedTask.lookup === "available" ? promotedTask.task?.progressSummary : undefined;
  assert.notEqual(
    promotedSummary,
    PARTIAL_OUTPUT,
    "the succeeded task must not expose the text frozen when the wait expired",
  );
  assert.equal(
    promotedSummary,
    FINAL_OUTPUT,
    "the succeeded task must expose the child's final result",
  );
  assert.notEqual(
    readRun(LIVE_RUN_ID)?.completion?.resultText,
    PARTIAL_OUTPUT,
    "the registry row must not retain the pre-expiry capture after promotion",
  );
  log("[8/12] result recapture: the succeeded task exposes the child's FINAL output");

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
  log("[5/12] control: timed_out -> succeeded rejected by the real task transition rules");

  // --------------------------------------------------------------- scenario 10
  // The kill run is still `child-unconfirmed` and its child session record was
  // never written, so the sweeper's pull path can never promote it: absence is
  // not stop evidence. The only owner left is a lifecycle callback. A real
  // `lifecycle` abort event is published through the production emitter and
  // consumed by the registry's own listener; its authoritative `endedAt` is the
  // deadline itself, which is where a hard run-timeout kill lands.
  assert.equal(
    readRun(KILL_RUN_ID)?.execution.outcome?.timeoutDisposition,
    "child-unconfirmed",
    "scenario 10 requires the kill run to be deferred first",
  );
  assert.equal(
    readChildSessionRow(KILL_CHILD_SESSION_KEY),
    undefined,
    "scenario 10 requires a genuinely absent session record, so only the callback can promote",
  );
  const killEndedAt = readRun(KILL_RUN_ID)?.execution.endedAt;
  assert.equal(typeof killEndedAt, "number");
  agentEvents.emitAgentEvent({
    runId: KILL_RUN_ID,
    stream: "lifecycle",
    sessionKey: KILL_CHILD_SESSION_KEY,
    data: {
      // No `startedAt`: the callback carries only the authoritative end. Sending
      // an earlier observed start would move the effective deadline back and let
      // the ordinary post-deadline clamp promote the row for a different reason,
      // which is not the case under test.
      phase: "end",
      aborted: true,
      stopReason: "aborted",
      endedAt: killEndedAt,
    },
  });
  await waitFor(
    "the delayed cancellation to promote the unconfirmed row",
    () => readRun(KILL_RUN_ID)?.execution.outcome?.timeoutDisposition !== "child-unconfirmed",
  );
  const promotedKillRun = readRun(KILL_RUN_ID);
  assert.notEqual(
    promotedKillRun?.execution.outcome?.timeoutDisposition,
    "child-unconfirmed",
    "a killed lifecycle end is stop evidence regardless of its recorded timestamp",
  );
  assert.ok(promotedKillRun, "the promoted row must still exist to be inspected");
  assert.equal(
    promotedKillRun.endedReason,
    "subagent-killed",
    "the cancellation itself must own the promoted terminal state",
  );
  await waitFor(
    "the promoted cancellation to reach a terminal detached-task state",
    () => readTaskStatus(KILL_RUN_ID, KILL_CHILD_SESSION_KEY) === "cancelled",
    15_000,
  );
  log(
    `[10/12] cancellation recorded at the deadline (endedAt=${String(killEndedAt)} == deadline) promoted the row: endedReason=${String(promotedKillRun.endedReason)}, task=cancelled`,
  );

  // ---------------------------------------------------------------- scenario 6
  // The absent run is still `child-unconfirmed`. Suspend its final delivery and
  // rewind the suspension past the hard-coded seven-day retention. The sweeper
  // handles suspended delivery at phase 1, ahead of the unconfirmed-child
  // reconciliation branch, so this row reaches expiry without passing through
  // it — which is exactly how the expiry path escaped the provisional guard.
  const suspendedRow = liveRow(ABSENT_RUN_ID);
  suspendedRow.expectsCompletionMessage = true;
  suspendedRow.delivery = {
    status: "suspended",
    suspendedAt: Date.now() - (SUSPENDED_RETENTION_DAYS + 1) * 24 * 60 * 60_000,
    suspendedReason: "expiry",
    payload: {
      requesterSessionKey: REQUESTER_SESSION_KEY,
      requesterDisplayKey: "main",
      childSessionKey: ABSENT_CHILD_SESSION_KEY,
      childRunId: ABSENT_RUN_ID,
      task: suspendedRow.task,
    },
  } as (typeof suspendedRow)["delivery"];
  await sweep();
  assert.ok(
    memory.subagentRuns.get(ABSENT_RUN_ID),
    "suspended-delivery expiry must not retire an unconfirmed row: promotion resolves the run by id, so a retired row can never be promoted at all",
  );
  // Non-vacuity: the expiry must actually have fired. Without this the survival
  // assertions could pass simply because the branch never ran.
  assert.notEqual(
    liveRow(ABSENT_RUN_ID).delivery?.status,
    "suspended",
    "the seven-day suspended-delivery expiry must actually have fired for this scenario to mean anything",
  );
  assert.ok(
    fs.existsSync(artifactFor(ABSENT_RUN_ID)),
    "suspended-delivery expiry must not remove attachments while the child stop is unconfirmed",
  );
  assert.equal(
    sessionDeleteCount(),
    0,
    "suspended-delivery expiry must not delete the child's session either",
  );
  log(
    `[6/12] suspended-delivery expiry (${SUSPENDED_RETENTION_DAYS + 1}d old): delivery discarded, row retained, attachments intact, sessions.delete count=${sessionDeleteCount()}`,
  );

  // --------------------------------------------------------------- scenario 11
  // Restart reconciliation. A gateway restart reloads the registry from its own
  // store into a fresh map and then hands that map to
  // `reconcileOrphanedRestoredRuns`. Both halves here are the production
  // functions, and the rows come off the real SQLite registry store this proof
  // has been writing all along — nothing about the map is synthesized.
  const restoredRuns = new Map<string, ReturnType<typeof liveRow>>();
  const restoredCount = registryState.restoreSubagentRunsFromDisk({ runs: restoredRuns });
  assert.ok(
    restoredCount > 0 && restoredRuns.has(ABSENT_RUN_ID),
    "scenario 11 requires the unconfirmed row to have really been persisted and reloaded",
  );
  assert.equal(
    restoredRuns.get(ABSENT_RUN_ID)?.execution.outcome?.timeoutDisposition,
    "child-unconfirmed",
    "scenario 11 requires the reloaded row to still be child-unconfirmed",
  );
  assert.equal(
    readChildSessionRow(ABSENT_CHILD_SESSION_KEY),
    undefined,
    "scenario 11 requires the child session snapshot to still be genuinely absent",
  );
  registryHelpers.reconcileOrphanedRestoredRuns({
    runs: restoredRuns,
    resumedRuns: new Set<string>(),
  });
  assert.ok(
    restoredRuns.has(ABSENT_RUN_ID),
    "restart reconciliation must not delete an unconfirmed row on an absent session snapshot: the row is the only thing a later authoritative stop can promote",
  );
  assert.ok(
    fs.existsSync(artifactFor(ABSENT_RUN_ID)),
    "restart reconciliation must not remove a possibly-live child's attachments",
  );
  // Non-vacuity: the same absent snapshot still prunes a row whose child WAS
  // observed to stop. Only the disposition differs, so the assertion above pins
  // the provisional state rather than a blanket refusal to reconcile.
  const observedStopControl = new Map<string, ReturnType<typeof liveRow>>();
  registryState.restoreSubagentRunsFromDisk({ runs: observedStopControl });
  const controlRow = observedStopControl.get(ABSENT_RUN_ID);
  assert.ok(controlRow, "scenario 11's control needs the same reloaded row");
  controlRow.execution.outcome = { status: "timeout", timeoutDisposition: "child-stopped" };
  delete controlRow.delivery;
  registryHelpers.reconcileOrphanedRestoredRuns({
    runs: observedStopControl,
    resumedRuns: new Set<string>(),
  });
  assert.equal(
    observedStopControl.has(ABSENT_RUN_ID),
    false,
    "restart reconciliation must still prune an orphaned run whose child stop was observed, or scenario 11 proves nothing",
  );
  log(
    `[11/12] restart reconciliation: ${restoredCount} row(s) reloaded from the real store, unconfirmed row retained, observed-stop control pruned`,
  );

  // --------------------------------------------------------------- scenario 12
  // Resume takes the same shared owner through a different door, and this is the
  // half that has to end in a real promotion: the row survives resume, then the
  // child's own terminal session record lands and the production sweeper
  // promotes the run out of the provisional state. A deleted row could not have
  // received it.
  registry.resumeSubagentRun(ABSENT_RUN_ID);
  await sleep(250);
  assert.ok(
    memory.subagentRuns.get(ABSENT_RUN_ID),
    "resume must not delete an unconfirmed row on an absent session snapshot",
  );
  assert.equal(
    sessionDeleteCount(),
    0,
    "resume must not delete the child's session while its stop is unconfirmed",
  );
  const lateStopEndedAt = Date.now();
  childTranscript.set(ABSENT_CHILD_SESSION_KEY, FINAL_OUTPUT);
  await writeChildSessionRow(ABSENT_CHILD_SESSION_KEY, {
    status: "done",
    updatedAt: lateStopEndedAt,
    startedAt: startedAtMs,
    endedAt: lateStopEndedAt,
  });
  await sweep();
  await waitFor(
    "the late authoritative stop to promote the retained row",
    () =>
      memory.subagentRuns.get(ABSENT_RUN_ID)?.execution.outcome?.timeoutDisposition !==
      "child-unconfirmed",
    15_000,
  );
  const promotedAbsentRow = memory.subagentRuns.get(ABSENT_RUN_ID);
  assert.ok(promotedAbsentRow, "the retained row must still exist to be promoted");
  assert.notEqual(
    promotedAbsentRow.execution.outcome?.timeoutDisposition,
    "child-unconfirmed",
    "the child's own terminal record must promote the retained row out of the provisional state",
  );
  log(
    `[12/12] resume + later promotion: row retained through resume, then promoted by the child's own terminal record (outcome=${JSON.stringify(promotedAbsentRow.execution.outcome)})`,
  );

  log("");
  log("All runtime assertions passed.");
} catch (error) {
  exitCode = 1;
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
} finally {
  fs.rmSync(stateRoot, { recursive: true, force: true });
}
// The registry legitimately holds live sweeper timers, run-wait loops and an
// open session store, so the event loop stays busy for minutes after the last
// assertion. Exit on the verdict instead of leaving the process — and any CI
// harness watching its output — waiting for those handles to drain.
process.exit(exitCode);
