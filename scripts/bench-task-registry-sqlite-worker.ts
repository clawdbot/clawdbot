import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import type { DB as OpenClawStateKyselyDatabase } from "../src/state/openclaw-state-db.generated.js";
import {
  WORKER_RESULT_SENTINEL,
  type MemorySample,
  type RegistryLifecycleCounts,
  type RegistrySnapshot,
  type RetainedMemoryMetrics,
  type WorkerResult,
} from "./bench-task-registry-sqlite.js";
import { classifyBoundedUnsignedDecimal } from "./lib/arg-utils.mts";

type WorkerOptions = {
  size: number;
  cycles: number;
  warmup: number;
  stateDir: string;
};

type TimingSample = {
  registrationMs: number;
  terminalMs: number;
  teardownMs: number;
  registration: RegistrySnapshot;
  terminal: RegistrySnapshot;
  teardown: RegistrySnapshot;
};

type BenchmarkStateDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "task_delivery_state" | "task_runs"
>;

type TaskRecordApi = Pick<
  typeof import("../src/tasks/task-registry-record-api.js"),
  "createTaskRecord" | "markTaskTerminalById"
>;

type TaskRegistryQueryApi = Pick<
  typeof import("../src/tasks/task-registry-query.js"),
  "deleteTaskRecordById"
>;

function parseInteger(raw: string | undefined, flag: string, min: number, max: number): number {
  const result = classifyBoundedUnsignedDecimal(raw, min, max);
  if (result.kind === "syntax") {
    throw new Error(`${flag} must be an integer`);
  }
  if (result.kind !== "value") {
    throw new Error(`${flag} must be between ${min} and ${max}`);
  }
  return result.value;
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
  const stateDir = values.get("--state-dir");
  if (!stateDir || !path.isAbsolute(stateDir)) {
    throw new Error("--state-dir must be an absolute path");
  }
  return {
    size: parseInteger(values.get("--size"), "--size", 1, 4096),
    cycles: parseInteger(values.get("--cycles"), "--cycles", 1, 200),
    warmup: parseInteger(values.get("--warmup"), "--warmup", 0, 20),
    stateDir,
  };
}

function processPeakRssBytes(): number {
  return Math.max(0, Math.round(process.resourceUsage().maxRSS * 1024));
}

function forceGc(): void {
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  if (!gc) {
    throw new Error("benchmark worker requires --expose-gc");
  }
  gc();
  gc();
}

function readMemorySample(cycle: number): MemorySample {
  const memory = process.memoryUsage();
  return {
    cycle,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    rssBytes: memory.rss,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    processPeakRssBytes: processPeakRssBytes(),
  };
}

function slope(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const xMean = (values.length - 1) / 2;
  const yMean = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index += 1) {
    const xDelta = index - xMean;
    numerator += xDelta * ((values[index] ?? 0) - yMean);
    denominator += xDelta * xDelta;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

function retainedMemorySlopes(samples: MemorySample[]): RetainedMemoryMetrics {
  return {
    heapUsedBytes: slope(samples.map((sample) => sample.heapUsedBytes)),
    heapTotalBytes: slope(samples.map((sample) => sample.heapTotalBytes)),
    rssBytes: slope(samples.map((sample) => sample.rssBytes)),
    externalBytes: slope(samples.map((sample) => sample.externalBytes)),
    arrayBuffersBytes: slope(samples.map((sample) => sample.arrayBuffersBytes)),
  };
}

function retainedMemoryDelta(
  baseline: MemorySample,
  finalSample: MemorySample,
): RetainedMemoryMetrics {
  return {
    heapUsedBytes: finalSample.heapUsedBytes - baseline.heapUsedBytes,
    heapTotalBytes: finalSample.heapTotalBytes - baseline.heapTotalBytes,
    rssBytes: finalSample.rssBytes - baseline.rssBytes,
    externalBytes: finalSample.externalBytes - baseline.externalBytes,
    arrayBuffersBytes: finalSample.arrayBuffersBytes - baseline.arrayBuffersBytes,
  };
}

function assertLifecycleCounts(
  actual: RegistryLifecycleCounts,
  expected: RegistryLifecycleCounts,
  phase: string,
  surface: string,
): void {
  for (const field of Object.keys(expected) as Array<keyof RegistryLifecycleCounts>) {
    if (actual[field] !== expected[field]) {
      throw new Error(
        `${phase} ${surface} invariant failed: ${JSON.stringify({ expected, actual })}`,
      );
    }
  }
}

function assertSnapshot(
  actual: RegistrySnapshot,
  expected: RegistryLifecycleCounts,
  phase: string,
): void {
  for (const surface of ["memory", "sqlite"] as const) {
    assertLifecycleCounts(actual[surface], expected, phase, surface);
  }
}

async function createCountReader() {
  const [{ executeSqliteQuerySync, getNodeSqliteKysely }, stateDb, state] = await Promise.all([
    import("../src/infra/kysely-sync.js"),
    import("../src/state/openclaw-state-db.js"),
    import("../src/tasks/task-registry-state.js"),
  ]);
  return (): RegistrySnapshot => {
    const database = stateDb.openOpenClawStateDatabase();
    const db = getNodeSqliteKysely<BenchmarkStateDatabase>(database.db);
    const taskRows = executeSqliteQuerySync(
      database.db,
      db.selectFrom("task_runs").select(["status", "delivery_status", "terminal_outcome"]),
    ).rows;
    const deliveryRows = executeSqliteQuerySync(
      database.db,
      db.selectFrom("task_delivery_state").select(({ fn }) => fn.countAll<number>().as("count")),
    ).rows[0]?.count;
    const summarize = (
      taskRecords: Iterable<{
        status: string;
        deliveryStatus: string;
        terminalOutcome?: string | null;
      }>,
      deliveryStateCount: number,
    ): RegistryLifecycleCounts => {
      let taskCount = 0;
      let runningTasks = 0;
      let succeededTasks = 0;
      let pendingDeliveryTasks = 0;
      let succeededTerminalOutcomes = 0;
      for (const task of taskRecords) {
        taskCount += 1;
        runningTasks += task.status === "running" ? 1 : 0;
        succeededTasks += task.status === "succeeded" ? 1 : 0;
        pendingDeliveryTasks += task.deliveryStatus === "pending" ? 1 : 0;
        succeededTerminalOutcomes += task.terminalOutcome === "succeeded" ? 1 : 0;
      }
      return {
        taskCount,
        deliveryStateCount,
        runningTasks,
        succeededTasks,
        pendingDeliveryTasks,
        succeededTerminalOutcomes,
      };
    };
    return {
      memory: summarize(
        [...state.tasks.values()].map((task) => ({
          status: task.status,
          deliveryStatus: task.deliveryStatus,
          terminalOutcome: task.terminalOutcome,
        })),
        state.taskDeliveryStates.size,
      ),
      sqlite: summarize(
        taskRows.map((task) => ({
          status: task.status,
          deliveryStatus: task.delivery_status,
          terminalOutcome: task.terminal_outcome,
        })),
        deliveryRows ?? 0,
      ),
    };
  };
}

async function runCycle(
  size: number,
  serial: number,
  readSnapshot: () => RegistrySnapshot,
  taskRecordApi: TaskRecordApi,
  taskRegistryQuery: TaskRegistryQueryApi,
): Promise<TimingSample> {
  const taskIds: string[] = [];
  const startedAt = Date.now();
  const registrationStartedAt = performance.now();
  for (let index = 0; index < size; index += 1) {
    const task = taskRecordApi.createTaskRecord({
      runtime: "subagent",
      requesterSessionKey: "agent:benchmark:main",
      ownerKey: "agent:benchmark:main",
      scopeKind: "session",
      requesterOrigin: { channel: "benchmark", to: "task-registry" },
      childSessionKey: `agent:benchmark:subagent:${serial}:${index}`,
      runId: `benchmark-task-${serial}-${index}`,
      task: `durable registration benchmark ${index}`,
      status: "running",
      deliveryStatus: "pending",
      notifyPolicy: "silent",
      startedAt,
      lastEventAt: startedAt,
    });
    if (!task) {
      throw new Error(`task registration failed at ${index + 1}/${size}`);
    }
    taskIds.push(task.taskId);
  }
  const registrationMs = performance.now() - registrationStartedAt;
  const emptyCounts: RegistryLifecycleCounts = {
    taskCount: 0,
    deliveryStateCount: 0,
    runningTasks: 0,
    succeededTasks: 0,
    pendingDeliveryTasks: 0,
    succeededTerminalOutcomes: 0,
  };
  const registration = readSnapshot();
  assertSnapshot(
    registration,
    {
      ...emptyCounts,
      taskCount: size,
      deliveryStateCount: size,
      runningTasks: size,
      pendingDeliveryTasks: size,
    },
    "registration",
  );

  const terminalStartedAt = performance.now();
  for (const taskId of taskIds) {
    const endedAt = Date.now();
    const task = taskRecordApi.markTaskTerminalById({
      taskId,
      status: "succeeded",
      endedAt,
      lastEventAt: endedAt,
      terminalOutcome: "succeeded",
    });
    if (!task) {
      throw new Error(`terminal transition failed for task ${taskId}`);
    }
  }
  const terminalMs = performance.now() - terminalStartedAt;
  const terminal = readSnapshot();
  assertSnapshot(
    terminal,
    {
      ...emptyCounts,
      taskCount: size,
      deliveryStateCount: size,
      succeededTasks: size,
      pendingDeliveryTasks: size,
      succeededTerminalOutcomes: size,
    },
    "terminal",
  );

  const teardownStartedAt = performance.now();
  for (const taskId of taskIds) {
    if (!taskRegistryQuery.deleteTaskRecordById(taskId)) {
      throw new Error(`teardown failed for task ${taskId}`);
    }
  }
  const teardownMs = performance.now() - teardownStartedAt;
  const teardown = readSnapshot();
  assertSnapshot(teardown, emptyCounts, "teardown");
  return { registrationMs, terminalMs, teardownMs, registration, terminal, teardown };
}

async function resetRuntime(persist: boolean): Promise<void> {
  const [tasks, stateDb] = await Promise.all([
    import("../src/tasks/task-runtime.test-helpers.js"),
    import("../src/state/openclaw-state-db.js"),
  ]);
  tasks.resetTaskRegistryForTests({ persist });
  stateDb.closeOpenClawStateDatabaseForTest();
}

async function runBenchmark(options: WorkerOptions): Promise<WorkerResult> {
  await resetRuntime(true);
  // Load lifecycle owners before the baseline so warmup=0 still measures task churn,
  // not one-time module initialization retained by the worker.
  const [readSnapshot, taskRecordApi, taskRegistryQuery] = await Promise.all([
    createCountReader(),
    import("../src/tasks/task-registry-record-api.js"),
    import("../src/tasks/task-registry-query.js"),
  ]);
  const emptyCounts: RegistryLifecycleCounts = {
    taskCount: 0,
    deliveryStateCount: 0,
    runningTasks: 0,
    succeededTasks: 0,
    pendingDeliveryTasks: 0,
    succeededTerminalOutcomes: 0,
  };
  assertSnapshot(readSnapshot(), emptyCounts, "initial");
  const timingsMs = {
    registration: [] as number[],
    terminal: [] as number[],
    teardown: [] as number[],
  };
  const postGcSamples: MemorySample[] = [];
  let lastSample: TimingSample | undefined;
  for (let index = 0; index < options.warmup; index += 1) {
    await runCycle(options.size, index, readSnapshot, taskRecordApi, taskRegistryQuery);
    forceGc();
  }
  forceGc();
  const postGcBaseline = readMemorySample(-1);
  for (let index = 0; index < options.cycles; index += 1) {
    lastSample = await runCycle(
      options.size,
      options.warmup + index,
      readSnapshot,
      taskRecordApi,
      taskRegistryQuery,
    );
    forceGc();
    timingsMs.registration.push(lastSample.registrationMs);
    timingsMs.terminal.push(lastSample.terminalMs);
    timingsMs.teardown.push(lastSample.teardownMs);
    postGcSamples.push(readMemorySample(index));
  }
  if (!lastSample) {
    throw new Error("benchmark completed without a cycle");
  }
  const finalPostGcSample = postGcSamples.at(-1);
  if (!finalPostGcSample) {
    throw new Error("benchmark completed without a post-GC sample");
  }
  return {
    size: options.size,
    timingsMs,
    memory: {
      postGcBaseline,
      postGcSamples,
      retainedSlopesBytesPerCycle: retainedMemorySlopes(postGcSamples),
      retainedDeltasBytes: retainedMemoryDelta(postGcBaseline, finalPostGcSample),
      processPeakRssBytes: processPeakRssBytes(),
    },
    invariant: {
      ok: true,
      cyclesValidated: options.warmup + options.cycles,
      registration: lastSample.registration,
      terminal: lastSample.terminal,
      teardown: lastSample.teardown,
      serializedSharedConnection: true,
    },
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousNodeEnv = process.env.NODE_ENV;
  let result: WorkerResult | undefined;
  let failure: unknown;
  process.env.OPENCLAW_STATE_DIR = options.stateDir;
  process.env.NODE_ENV = "test";
  try {
    const { pinRuntimePaths } = await import("../src/config/paths.js");
    pinRuntimePaths();
    result = await runBenchmark(options);
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
    }
  }
  if (failure) {
    throw toErrorObject(failure, "Task registry SQLite benchmark failed");
  }
  if (!result) {
    throw new Error("benchmark worker completed without a result");
  }
  process.stdout.write(`${WORKER_RESULT_SENTINEL}${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  } finally {
    if (process.exitCode && process.exitCode !== 0) {
      console.error(`[bench-task-registry-sqlite-worker] FAILED (exit ${process.exitCode})`);
    }
  }
}
