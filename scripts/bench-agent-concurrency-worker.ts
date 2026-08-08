import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import type { SubagentRunRecord } from "../src/agents/subagent-registry.types.js";
import type { DB as OpenClawStateKyselyDatabase } from "../src/state/openclaw-state-db.generated.js";
import {
  WORKER_RESULT_SENTINEL,
  type WorkerResult,
  type WorkerScenario,
} from "./bench-agent-concurrency.js";

type WorkerOptions = {
  scenario: WorkerScenario;
  size: number;
  runs: number;
  warmup: number;
};

type Sample = {
  durationMs: number;
  invariant: Record<string, number | boolean>;
};

const SCENARIOS = new Set<WorkerScenario>([
  "spawnPipelineInMemory",
  "spawnPipelineDurable",
  "admission",
  "recoverySweep",
  "duplicateSuppression",
]);

function parseInteger(raw: string | undefined, flag: string, min: number, max: number): number {
  if (!raw || !/^\d+$/u.test(raw)) {
    throw new Error(`${flag} must be an integer`);
  }
  const value = Number(raw);
  if (value < min || value > max) {
    throw new Error(`${flag} must be between ${min} and ${max}`);
  }
  return value;
}

function parseOptions(argv: string[]): WorkerOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`invalid worker argument near ${flag ?? "end"}`);
    }
    if (values.has(flag)) {
      throw new Error(`${flag} was provided more than once`);
    }
    values.set(flag, value);
  }
  const scenario = values.get("--scenario") as WorkerScenario | undefined;
  if (!scenario || !SCENARIOS.has(scenario)) {
    throw new Error(`unknown worker scenario: ${scenario ?? "missing"}`);
  }
  return {
    scenario,
    size: parseInteger(values.get("--size"), "--size", 1, 4096),
    runs: parseInteger(values.get("--runs"), "--runs", 1, 100),
    warmup: parseInteger(values.get("--warmup"), "--warmup", 0, 20),
  };
}

function processMaxRssBytes(): number {
  return Math.max(0, Math.round(process.resourceUsage().maxRSS * 1024));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function waitForCondition(check: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (check()) {
      return true;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  return check();
}

async function drainSpawnSampleRootWork(
  waitForRootWork?: (timeoutMs: number) => Promise<{ drained: boolean; active: number }>,
): Promise<void> {
  const wait =
    waitForRootWork ??
    (await import("../src/process/gateway-work-admission.js")).waitForActiveGatewayRootWork;
  const result = await wait(30_000);
  if (!result.drained || result.active !== 0) {
    throw new Error(`spawn sample left ${result.active} active gateway root work items`);
  }
}

async function resetRuntime(persist: boolean): Promise<void> {
  const [subagents, tasks, stateDb, agentDb] = await Promise.all([
    import("../src/agents/subagent-registry.test-helpers.js"),
    import("../src/tasks/task-runtime.test-helpers.js"),
    import("../src/state/openclaw-state-db.js"),
    import("../src/state/openclaw-agent-db.js"),
  ]);
  subagents.resetSubagentRegistryForTests({ persist });
  subagents.testing.setDepsForTest();
  tasks.resetTaskRegistryControlRuntimeForTests();
  tasks.resetTaskRegistryDeliveryRuntimeForTests();
  tasks.resetDetachedTaskLifecycleRuntimeForTests();
  tasks.resetTaskRegistryForTests({ persist });
  tasks.resetTaskFlowRegistryForTests({ persist });
  stateDb.closeOpenClawStateDatabaseForTest();
  agentDb.closeOpenClawAgentDatabasesForTest();
}

function createTerminalWaitBarrier() {
  const waiters = new Map<string, (value: unknown) => void>();
  let outstanding = 0;
  let releasesStarted = false;
  const callGateway = (async <T>(request: { method?: string; params?: unknown }) => {
    if (request.method !== "agent.wait") {
      return {} as T;
    }
    if (releasesStarted) {
      throw new Error("agent.wait registered after the benchmark barrier released");
    }
    const runId =
      request.params &&
      typeof request.params === "object" &&
      !Array.isArray(request.params) &&
      typeof (request.params as { runId?: unknown }).runId === "string"
        ? (request.params as { runId: string }).runId
        : undefined;
    if (!runId || waiters.has(runId)) {
      throw new Error(`invalid or duplicate benchmark agent.wait run id: ${runId ?? "missing"}`);
    }
    outstanding += 1;
    return await new Promise<T>((resolve) => {
      waiters.set(runId, (value) => {
        outstanding -= 1;
        resolve(value as T);
      });
    });
  }) as typeof import("../src/gateway/call.js").callGateway;
  return {
    callGateway,
    get outstanding() {
      return outstanding;
    },
    async waitUntilBlocked(expected: number) {
      return await waitForCondition(() => outstanding === expected);
    },
    release(runId: string) {
      releasesStarted = true;
      const resolve = waiters.get(runId);
      if (!resolve) {
        throw new Error(`missing blocked benchmark agent.wait for ${runId}`);
      }
      waiters.delete(runId);
      const endedAt = Date.now();
      resolve({
        status: "ok",
        startedAt: endedAt - 1,
        endedAt,
        stopReason: "stop",
      });
    },
    releaseAll() {
      releasesStarted = true;
      for (const runId of waiters.keys()) {
        this.release(runId);
      }
    },
  };
}

async function configureSpawnRuntime(
  mode: "memory" | "durable",
  callGateway: typeof import("../src/gateway/call.js").callGateway,
): Promise<void> {
  const [subagents, registry, taskStore, flowStore] = await Promise.all([
    import("../src/agents/subagent-registry.test-helpers.js"),
    import("../src/agents/subagent-registry-memory.js"),
    import("../src/tasks/task-registry.store.js"),
    import("../src/tasks/task-flow-registry.store.test-support.js"),
  ]);
  const sharedDeps = {
    callGateway,
    getRuntimeConfig: () => ({}),
    onAgentEvent: () => () => {},
    resolveAgentTimeoutMs: () => 1_000,
    captureSubagentCompletionReply: async (childSessionKey: string) => {
      const entry = [...registry.subagentRuns.values()].find(
        (candidate) => candidate.childSessionKey === childSessionKey,
      );
      if (entry) {
        // Completion already owns the row at this awaited seam. Suppress only
        // its unrelated session projection, not the terminal registry/task transition.
        entry.execution.suppressSessionEffects = true;
      }
      return undefined;
    },
    cleanupBrowserSessionsForLifecycleEnd: async () => {},
    runSubagentAnnounceFlow: async () => false,
    maybeWakeRequesterAfterAllChildrenSettled: async () => false,
    ensureContextEnginesInitialized: () => {},
    loadAgentRuntimePluginRegistryHandle: () => undefined,
    resolveContextEngine: async () =>
      ({
        info: { id: "bench", name: "bench", version: "1" },
        ingest: async () => ({ ok: true }),
        assemble: async () => ({ messages: [] }),
        onSubagentEnded: async () => {},
      }) as unknown as import("../src/context-engine/types.js").ContextEngine,
  };
  if (mode === "memory") {
    subagents.testing.setDepsForTest({
      ...sharedDeps,
      persistSubagentRunsToDisk: () => {},
      persistSubagentRunsToDiskOrThrow: () => {},
    });
    taskStore.configureTaskRegistryRuntime({
      store: {
        loadSnapshot: () => ({ tasks: new Map(), deliveryStates: new Map() }),
        saveSnapshot: () => {},
        upsertTaskWithDeliveryState: () => {},
        upsertTask: () => {},
        deleteTaskWithDeliveryState: () => {},
        deleteTask: () => {},
        upsertDeliveryState: () => {},
        deleteDeliveryState: () => {},
        close: () => {},
      },
    });
    flowStore.configureTaskFlowRegistryRuntime({
      store: {
        loadSnapshot: () => ({ flows: new Map() }),
        saveSnapshot: () => {},
        upsertFlow: () => {},
        deleteFlow: () => {},
        close: () => {},
      },
    });
    return;
  }
  subagents.testing.setDepsForTest(sharedDeps);
}

type BenchmarkStateDatabase = Pick<OpenClawStateKyselyDatabase, "subagent_runs" | "task_runs">;

async function readDurableRows() {
  const [{ executeSqliteQuerySync, getNodeSqliteKysely }, stateDb] = await Promise.all([
    import("../src/infra/kysely-sync.js"),
    import("../src/state/openclaw-state-db.js"),
  ]);
  const database = stateDb.openOpenClawStateDatabase();
  const db = getNodeSqliteKysely<BenchmarkStateDatabase>(database.db);
  return {
    path: database.path,
    subagentRows: executeSqliteQuerySync(
      database.db,
      db.selectFrom("subagent_runs").select(["run_id", "ended_at"]).orderBy("run_id"),
    ).rows,
    taskRows: executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("task_runs")
        .select(["run_id", "status", "ended_at"])
        .where("runtime", "=", "subagent")
        .orderBy("run_id"),
    ).rows,
  };
}

function listSqliteFiles(root: string): string[] {
  return fs
    .readdirSync(root, { recursive: true })
    .map(String)
    .filter((entry) => entry.includes(".sqlite"))
    .toSorted();
}

async function listBenchmarkTasks() {
  const tasks = await import("../src/tasks/task-registry.js");
  return tasks.listTaskRecords().filter((task) => task.runtime === "subagent");
}

async function listBenchmarkTaskMemory() {
  const state = await import("../src/tasks/task-registry-state.js");
  return [...state.tasks.values()].filter((task) => task.runtime === "subagent");
}

function assertExactRunIds(actual: Array<string | null>, expected: string[], label: string): void {
  const normalized = actual
    .filter((value): value is string => typeof value === "string")
    .toSorted();
  const wanted = expected.toSorted();
  if (JSON.stringify(normalized) !== JSON.stringify(wanted)) {
    throw new Error(
      `${label} mismatch: ${JSON.stringify({ actual: normalized, expected: wanted })}`,
    );
  }
}

async function runSpawnSample(
  fanout: number,
  serial: number,
  mode: "memory" | "durable",
  stateDir: string,
): Promise<Sample> {
  const [pipeline, registry] = await Promise.all([
    import("../src/agents/spawn-pipeline.js"),
    import("../src/agents/subagent-registry-memory.js"),
  ]);
  await resetRuntime(mode === "durable");
  const barrier = createTerminalWaitBarrier();
  await configureSpawnRuntime(mode, barrier.callGateway);
  const taskRegistry = await import("../src/tasks/task-registry.js");
  let releases = 0;
  const runIds: string[] = [];
  const params = Array.from({ length: fanout }, (_, index) => {
    const runId = `bench-${mode}-${serial}-${index}`;
    runIds.push(runId);
    let released = false;
    return {
      adapter: {
        initialize: async () => ({ index }),
        dispatchTurn: async () => ({ runId }),
        cleanupOnFailure: async () => {},
      },
      admissionReservation: {
        release: () => {
          if (!released) {
            released = true;
            releases += 1;
          }
        },
      },
      buildRegistration: () => ({
        runId,
        childSessionKey: `agent:bench:subagent:${mode}:${serial}:${index}`,
        requesterSessionKey: "agent:bench:main",
        requesterDisplayKey: "bench",
        task: `benchmark child ${index}`,
        cleanup: "keep" as const,
        expectsCompletionMessage: false,
      }),
      progressSessionKey: "agent:bench:main",
    };
  });
  let result: Sample | undefined;
  let failure: unknown;
  try {
    const startedAt = performance.now();
    const pipelineResults = await Promise.all(
      params.map((entry) => pipeline.runSpawnPipeline(entry)),
    );
    const durationMs = performance.now() - startedAt;
    const blocked = await barrier.waitUntilBlocked(fanout);
    const successful = pipelineResults.filter((pipelineResult) => pipelineResult.ok);
    const uniqueRuns = new Set(successful.map((pipelineResult) => pipelineResult.runId)).size;
    const registeredRuns = registry.subagentRuns.size;
    const tasksWhileBlocked = await listBenchmarkTasks();
    assertExactRunIds(
      tasksWhileBlocked.map((task) => task.runId ?? null),
      runIds,
      `${mode} in-memory task rows`,
    );
    if (!blocked || barrier.outstanding !== fanout) {
      throw new Error(`spawn ${mode} did not block ${fanout} agent.wait calls`);
    }
    if (
      successful.length !== fanout ||
      uniqueRuns !== fanout ||
      registeredRuns !== fanout ||
      releases !== fanout
    ) {
      throw new Error(
        `spawn ${mode} registration invariant failed: ${JSON.stringify({ fanout, uniqueRuns, registeredRuns, releases })}`,
      );
    }
    let durableSubagentRows = 0;
    let durableTaskRows = 0;
    let durableStateFile = listSqliteFiles(stateDir).length > 0;
    if (mode === "durable") {
      const durable = await readDurableRows();
      assertExactRunIds(
        durable.subagentRows.map((row) => row.run_id),
        runIds,
        "durable subagent rows",
      );
      assertExactRunIds(
        durable.taskRows.map((row) => row.run_id),
        runIds,
        "durable task rows",
      );
      if (
        durable.subagentRows.some((row) => row.ended_at !== null) ||
        durable.taskRows.some((row) => row.status !== "running" || row.ended_at !== null)
      ) {
        throw new Error("durable rows settled before the benchmark barrier released");
      }
      durableSubagentRows = durable.subagentRows.length;
      durableTaskRows = durable.taskRows.length;
      durableStateFile = fs.existsSync(durable.path);
      if (!durableStateFile) {
        throw new Error(`durable spawn pipeline database is missing at ${durable.path}`);
      }
    } else if (durableStateFile) {
      throw new Error("in-memory spawn pipeline created durable SQLite state");
    }
    for (const runId of runIds) {
      barrier.release(runId);
      const runSettled = await waitForCondition(() => {
        const run = registry.subagentRuns.get(runId);
        const task = taskRegistry.findTaskByRunId(runId);
        return (
          run?.execution.status === "terminal" &&
          typeof run.execution.endedAt === "number" &&
          typeof run.cleanupCompletedAt === "number" &&
          task?.status === "succeeded"
        );
      });
      if (!runSettled) {
        throw new Error(`spawn ${mode} did not settle released run ${runId}`);
      }
    }
    const settledTasks = await listBenchmarkTasks();
    const settledRuns = [...registry.subagentRuns.values()].filter(
      (entry) =>
        entry.execution.status === "terminal" &&
        typeof entry.execution.endedAt === "number" &&
        typeof entry.cleanupCompletedAt === "number",
    ).length;
    const succeededTasks = settledTasks.filter((task) => task.status === "succeeded").length;
    if (settledRuns !== fanout || succeededTasks !== fanout || barrier.outstanding !== 0) {
      throw new Error(
        `spawn ${mode} settlement invariant failed: ${JSON.stringify({ fanout, settledRuns, succeededTasks, outstandingWaits: barrier.outstanding })}`,
      );
    }
    // Terminal rows can settle before detached cleanup and requester-wake roots.
    // Drain before reset so leaked work stays visible and cannot reach the next sample.
    await drainSpawnSampleRootWork();
    result = {
      durationMs,
      invariant: {
        ok: true,
        registeredRuns,
        reservationsReleased: releases,
        blockedWaits: fanout,
        settledRuns,
        settledTasks: succeededTasks,
        outstandingWaits: barrier.outstanding,
        durableSubagentRows,
        durableTaskRows,
        durableStateFile,
        postTeardownRegistryRows: -1,
        postTeardownTaskRows: -1,
        postTeardownDurableSubagentRows: -1,
        postTeardownDurableTaskRows: -1,
        postTeardownActiveRootWork: 0,
      },
    };
  } catch (error) {
    failure = error;
  } finally {
    try {
      barrier.releaseAll();
    } catch (error) {
      failure ??= error;
    }
    try {
      await resetRuntime(mode === "durable");
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) {
    throw toError(failure);
  }
  const postTeardownTasks = await listBenchmarkTaskMemory();
  const postTeardownRegistryRows = registry.subagentRuns.size;
  const postTeardownTaskRows = postTeardownTasks.length;
  let postTeardownDurableSubagentRows = 0;
  let postTeardownDurableTaskRows = 0;
  if (mode === "durable") {
    const durable = await readDurableRows();
    postTeardownDurableSubagentRows = durable.subagentRows.length;
    postTeardownDurableTaskRows = durable.taskRows.length;
    await resetRuntime(false);
  }
  if (
    postTeardownRegistryRows !== 0 ||
    postTeardownTaskRows !== 0 ||
    postTeardownDurableSubagentRows !== 0 ||
    postTeardownDurableTaskRows !== 0 ||
    barrier.outstanding !== 0
  ) {
    throw new Error(
      `spawn ${mode} teardown invariant failed: ${JSON.stringify({ postTeardownRegistryRows, postTeardownTaskRows, postTeardownDurableSubagentRows, postTeardownDurableTaskRows, outstandingWaits: barrier.outstanding })}`,
    );
  }
  if (mode === "memory" && listSqliteFiles(stateDir).length > 0) {
    throw new Error("in-memory spawn pipeline created SQLite state during teardown");
  }
  if (!result) {
    throw new Error(`spawn ${mode} did not produce a benchmark result`);
  }
  result.invariant.postTeardownRegistryRows = postTeardownRegistryRows;
  result.invariant.postTeardownTaskRows = postTeardownTaskRows;
  result.invariant.postTeardownDurableSubagentRows = postTeardownDurableSubagentRows;
  result.invariant.postTeardownDurableTaskRows = postTeardownDurableTaskRows;
  return result;
}

async function runAdmissionSample(fanout: number, serial: number): Promise<Sample> {
  const { reserveChildAdmissionSlot } = await import("../src/agents/child-admission.js");
  const controllerSessionKey = `agent:bench:admission:${serial}`;
  const reservations: Array<{ release: () => void }> = [];
  const reserve = () =>
    reserveChildAdmissionSlot({
      controllerSessionKey,
      resolveAdmission: (pendingChildren) =>
        pendingChildren < fanout
          ? { ok: true as const }
          : { ok: false as const, governingCap: "benchmark" },
    });
  const startedAt = performance.now();
  for (let index = 0; index < fanout; index += 1) {
    const reservation = reserve();
    if (!reservation.ok) {
      throw new Error(`admission rejected slot ${index + 1}/${fanout}`);
    }
    reservations.push(reservation);
  }
  const overflow = reserve();
  for (const reservation of reservations) {
    reservation.release();
    reservation.release();
  }
  const replacement = reserve();
  if (replacement.ok) {
    replacement.release();
  }
  const durationMs = performance.now() - startedAt;
  const ok = !overflow.ok && replacement.ok;
  if (!ok) {
    throw new Error(`admission invariant failed at fanout ${fanout}`);
  }
  return {
    durationMs,
    invariant: { ok, admissionCap: reservations.length, overflowRejected: true, released: true },
  };
}

function sweepRow(child: number, generation: number, now: number): SubagentRunRecord {
  const current = generation === 3;
  return {
    runId: `bench-sweep-${child}-${generation}`,
    childSessionKey: `agent:bench:subagent:sweep-${child}`,
    requesterSessionKey: "agent:bench:main",
    requesterDisplayKey: "bench",
    task: `sweep child ${child}`,
    cleanup: current ? "keep" : "delete",
    generation,
    createdAt: now - generation,
    archiveAtMs: current ? undefined : now - 1,
    terminalOwner: current ? "interrupted-recovery" : undefined,
    endedReason: current ? "subagent-error" : undefined,
    execution: current
      ? {
          status: "terminal",
          startedAt: now - 2_000,
          endedAt: now - 1_000,
          outcome: { status: "error", error: "interrupted recovery replay" },
          suppressSessionEffects: true,
        }
      : {
          status: "terminal",
          startedAt: now - 2_000,
          endedAt: now - 1_000,
          outcome: { status: "error", error: "retired recovery generation" },
          suppressSessionEffects: true,
        },
  };
}

async function runSweepSample(childCount: number): Promise<Sample> {
  const [
    { getSubagentRunsForChildSession, subagentRuns: runs },
    { createSubagentRegistrySweeper },
  ] = await Promise.all([
    import("../src/agents/subagent-registry-memory.js"),
    import("../src/agents/subagent-registry-sweeper.js"),
  ]);
  const now = Date.now();
  runs.clear();
  for (let child = 0; child < childCount; child += 1) {
    for (const generation of [3, 2, 1]) {
      const entry = sweepRow(child, generation, now);
      runs.set(entry.runId, entry);
    }
  }
  let sessionEffects = 0;
  let recoveryProjections = 0;
  let lostContextCompletions = 0;
  const sweeper = createSubagentRegistrySweeper({
    runs,
    resumedRuns: new Set(),
    persist: () => {},
    clearPendingLifecycleError: () => {},
    clearPendingLifecycleTimeout: () => {},
    sweepPendingLifecycle: () => {},
    completeSubagentRunWithRecovery: async () => {
      lostContextCompletions += 1;
    },
    getGatewayRecoveryRuntime: () => undefined,
    abandonSubagentRestartRecoveryLaunch: () => true,
    clearAcceptedSubagentRestartRecovery: () => true,
    resumeSettledSubagentRestartRecovery: () => true,
    replaceSubagentRunAfterSteer: () => true,
    markSubagentRestartRecoveryLaunchAttempted: () => undefined,
    markSubagentRestartRecoveryLaunchAccepted: () => undefined,
    markSubagentRestartRecoveryLaunchConsumed: () => undefined,
    reserveSubagentRestartRecoveryLaunch: () => undefined,
    resetSubagentRestartRecoveryLaunchAttempt: () => true,
    finalizeInterruptedSubagentRun: async ({ runId, expectedEntry }) => {
      if (runs.get(runId) !== expectedEntry || expectedEntry?.generation !== 3) {
        throw new Error(`unexpected recovery projection owner: ${runId}`);
      }
      recoveryProjections += 1;
      return 1;
    },
    resumeRequesterSettleWake: () => {},
    startSubagentAnnounceCleanupFlow: () => true,
    completeCleanupBookkeeping: () => {},
    shouldEmitEndedHookForRun: () => false,
    emitSubagentEndedHookForRun: async () => {},
    callGateway: (async <T>() => {
      sessionEffects += 1;
      return {} as T;
    }) as typeof import("../src/gateway/call.js").callGateway,
    cleanupCollectorLaunchResources: async () => true,
    runContextEngineSubagentEnded: async () => {
      sessionEffects += 1;
    },
    notifyContextEngineSubagentEnded: async () => {
      sessionEffects += 1;
    },
    retireSupersededRun: async () => {},
    getRunsForChildSession: getSubagentRunsForChildSession,
    getRunsForCollectorGroup: () => [],
    warn: () => {},
  });
  try {
    const startedAt = performance.now();
    await sweeper.sweepOnce();
    const durationMs = performance.now() - startedAt;
    const retainedCurrent = [...runs.values()].filter((entry) => entry.generation === 3).length;
    const removedRows = childCount * 3 - runs.size;
    const ok =
      removedRows === childCount * 2 &&
      retainedCurrent === childCount &&
      sessionEffects === 0 &&
      recoveryProjections === childCount &&
      lostContextCompletions === 0;
    if (!ok) {
      throw new Error(
        `registry sweep invariant failed: ${JSON.stringify({ childCount, removedRows, retainedCurrent, sessionEffects, recoveryProjections, lostContextCompletions })}`,
      );
    }
    return {
      durationMs,
      invariant: {
        ok,
        seededRows: childCount * 3,
        removedRows,
        retainedCurrent,
        sessionEffects,
        recoveryProjections,
        lostContextCompletions,
      },
    };
  } finally {
    sweeper.reset();
    runs.clear();
  }
}

async function runDedupeSample(childCount: number): Promise<Sample> {
  const { dedupeLatestChildCompletionRows } =
    await import("../src/agents/subagent-announce-output.js");
  const rowsForOrder = (generations: number[]) =>
    Array.from({ length: childCount }, (_, child) =>
      generations.map((generation) => ({
        runId: `bench-dedupe-${child}-${generation}`,
        childSessionKey: `agent:bench:subagent:dedupe-${child}`,
        task: `dedupe child ${child}`,
        generation,
        createdAt: generation,
        execution: { status: "terminal" as const, endedAt: generation },
      })),
    ).flat();
  const newestFirstRows = rowsForOrder([3, 2, 1]);
  const oldestFirstRows = rowsForOrder([1, 2, 3]);
  const startedAt = performance.now();
  const newestFirst = dedupeLatestChildCompletionRows(newestFirstRows);
  const oldestFirst = dedupeLatestChildCompletionRows(oldestFirstRows);
  const durationMs = performance.now() - startedAt;
  const newestFirstSelectedNewest = newestFirst.every((row) => row.generation === 3);
  const oldestFirstSelectedNewest = oldestFirst.every((row) => row.generation === 3);
  const ok =
    newestFirst.length === childCount &&
    oldestFirst.length === childCount &&
    newestFirstSelectedNewest &&
    oldestFirstSelectedNewest;
  if (!ok) {
    throw new Error(`completion dedupe invariant failed for ${childCount} children`);
  }
  return {
    durationMs,
    invariant: {
      ok,
      inputRowsPerOrdering: newestFirstRows.length,
      newestFirstSelectedRows: newestFirst.length,
      oldestFirstSelectedRows: oldestFirst.length,
      newestFirstSelectedNewest,
      oldestFirstSelectedNewest,
    },
  };
}

async function runScenario(options: WorkerOptions, stateDir: string): Promise<WorkerResult> {
  const timingsMs: number[] = [];
  let invariant: Record<string, number | boolean> = {};
  const rssStartBytes = process.memoryUsage().rss;
  for (let index = 0; index < options.warmup + options.runs; index += 1) {
    let sample: Sample;
    if (options.scenario === "spawnPipelineInMemory") {
      sample = await runSpawnSample(options.size, index, "memory", stateDir);
    } else if (options.scenario === "spawnPipelineDurable") {
      sample = await runSpawnSample(options.size, index, "durable", stateDir);
    } else if (options.scenario === "admission") {
      sample = await runAdmissionSample(options.size, index);
    } else if (options.scenario === "recoverySweep") {
      sample = await runSweepSample(options.size);
    } else {
      sample = await runDedupeSample(options.size);
    }
    invariant = sample.invariant;
    if (index >= options.warmup) {
      timingsMs.push(sample.durationMs);
    }
  }
  return {
    scenario: options.scenario,
    size: options.size,
    timingsMs,
    memory: {
      rssStartBytes,
      rssEndBytes: process.memoryUsage().rss,
      processMaxRssBytes: processMaxRssBytes(),
    },
    invariant,
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-concurrency-worker-"));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousNodeEnv = process.env.NODE_ENV;
  let result: WorkerResult | undefined;
  let failure: unknown;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.NODE_ENV = "test";
  try {
    const { pinRuntimePaths } = await import("../src/config/paths.js");
    pinRuntimePaths();
    result = await runScenario(options, stateDir);
  } catch (error) {
    failure = error;
  } finally {
    try {
      await resetRuntime(false);
    } catch (error) {
      failure ??= error;
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
      try {
        fs.rmSync(stateDir, { recursive: true, force: true });
      } catch (error) {
        failure ??= error;
      }
    }
  }
  if (failure) {
    throw toError(failure);
  }
  if (!result) {
    throw new Error("benchmark worker completed without a result");
  }
  process.stdout.write(`${WORKER_RESULT_SENTINEL}${JSON.stringify(result)}\n`);
}

export const testing = { drainSpawnSampleRootWork };

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  } finally {
    if (process.exitCode && process.exitCode !== 0) {
      console.error(`[bench-agent-concurrency-worker] FAILED (exit ${process.exitCode})`);
    }
  }
}
