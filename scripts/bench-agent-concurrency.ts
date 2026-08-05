import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import type { SubagentRunRecord } from "../src/agents/subagent-registry.types.js";

const DEFAULT_FANOUT = [1, 8, 32, 64],
  DEFAULT_SWEEP_ROWS = [32, 128, 512];

type Options = {
  runs: number;
  warmup: number;
  fanout: number[];
  sweepRows: number[];
  output?: string;
  json: boolean;
  help: boolean;
};

type TimingSummary = Record<"count" | "min" | "p50" | "p95" | "p99" | "max", number>;

type ScenarioResult = {
  size: number;
  timingsMs: TimingSummary;
  invariant: Record<string, number | boolean>;
};

function usage(): string {
  return `OpenClaw agent concurrency benchmark

Usage:
  node --import tsx scripts/bench-agent-concurrency.ts [options]

Options:
  --runs <n>          Measured samples per scenario (default: 5)
  --warmup <n>        Warmup samples per scenario (default: 1)
  --fanout <list>     Comma-separated spawn/admission sizes (default: 1,8,32,64)
  --sweep-rows <list> Comma-separated child counts, with 3 generations each (default: 32,128,512)
  --output <path>     Write the JSON report to a file
  --json              Print only the JSON report
  --help              Show this text
`;
}

function parseInteger(raw: string, flag: string, min: number, max: number): number {
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`${flag} must be an integer`);
  }
  const value = Number(raw);
  if (value < min) {
    throw new Error(`${flag} must be at least ${min}`);
  }
  if (value > max) {
    throw new Error(`${flag} must be at most ${max}`);
  }
  return value;
}

function parseList(raw: string, flag: string, max: number): number[] {
  if (!raw || raw.split(",").some((value) => value.length === 0)) {
    throw new Error(`${flag} requires a comma-separated integer list`);
  }
  const values = raw.split(",").map((value) => parseInteger(value, flag, 1, max));
  if (new Set(values).size !== values.length) {
    throw new Error(`${flag} contains duplicate values`);
  }
  return values;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    runs: 5,
    warmup: 1,
    fanout: DEFAULT_FANOUT,
    sweepRows: DEFAULT_SWEEP_ROWS,
    json: false,
    help: false,
  };
  const seen = new Set<string>();
  const valueFlags = new Set(["--runs", "--warmup", "--fanout", "--sweep-rows", "--output"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag?.startsWith("--")) {
      throw new Error(`Unknown argument: ${flag}`);
    }
    if (seen.has(flag)) {
      throw new Error(`${flag} was provided more than once`);
    }
    seen.add(flag);
    if (flag === "--json" || flag === "--help") {
      options[flag === "--json" ? "json" : "help"] = true;
      continue;
    }
    if (!valueFlags.has(flag)) {
      throw new Error(`Unknown argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    index += 1;
    if (flag === "--runs") {
      options.runs = parseInteger(value, flag, 1, 100);
    } else if (flag === "--warmup") {
      options.warmup = parseInteger(value, flag, 0, 20);
    } else if (flag === "--fanout") {
      options.fanout = parseList(value, flag, 256);
    } else if (flag === "--sweep-rows") {
      options.sweepRows = parseList(value, flag, 4096);
    } else {
      options.output = value;
    }
  }
  return options;
}

function percentile(sorted: number[], ratio: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

function summarizeTimings(values: number[]): TimingSummary {
  if (values.length === 0) {
    throw new Error("cannot summarize an empty timing set");
  }
  const sorted = values.toSorted((left, right) => left - right);
  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1) ?? 0,
  };
}

async function sampleScenario<T extends { durationMs: number }>(
  options: Options,
  sample: () => Promise<T>,
  validate: (result: T) => Record<string, number | boolean>,
): Promise<{ timingsMs: TimingSummary; invariant: Record<string, number | boolean> }> {
  const timings: number[] = [];
  let invariant: Record<string, number | boolean> = {};
  for (let index = 0; index < options.warmup + options.runs; index += 1) {
    const result = await sample();
    invariant = validate(result);
    if (index >= options.warmup) {
      timings.push(result.durationMs);
    }
  }
  return { timingsMs: summarizeTimings(timings), invariant };
}

async function runSpawnPipelineSample(fanout: number, serial: number) {
  const [{ runSpawnPipeline }, registry, helpers] = await Promise.all([
    import("../src/agents/spawn-pipeline.js"),
    import("../src/agents/subagent-registry-memory.js"),
    import("../src/agents/subagent-registry.test-helpers.js"),
  ]);
  helpers.resetSubagentRegistryForTests({ persist: false });
  helpers.testing.setDepsForTest({
    getRuntimeConfig: () => ({}),
    onAgentEvent: () => () => {},
    persistSubagentRunsToDisk: () => {},
    persistSubagentRunsToDiskOrThrow: () => {},
  });
  let releases = 0;
  const pipelineParams = Array.from({ length: fanout }, (_, index) => {
    const runId = `bench-pipeline-${serial}-${index}`;
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
        childSessionKey: `agent:bench:subagent:${serial}:${index}`,
        requesterSessionKey: "agent:bench:main",
        requesterDisplayKey: "bench",
        task: `benchmark child ${index}`,
        cleanup: "keep" as const,
        expectsCompletionMessage: false,
      }),
      progressSessionKey: "agent:bench:main",
    };
  });
  const startedAt = performance.now();
  const results = await Promise.all(pipelineParams.map((params) => runSpawnPipeline(params)));
  const durationMs = performance.now() - startedAt;
  const registered = results.filter((result) => result.ok).map((result) => result.runId);
  const uniqueRegistered = new Set(registered).size;
  const registrySize = registry.subagentRuns.size;
  helpers.resetSubagentRegistryForTests({ persist: false });
  helpers.testing.setDepsForTest();
  return { durationMs, expected: fanout, uniqueRegistered, registrySize, releases };
}

function validateSpawnPipeline(result: Awaited<ReturnType<typeof runSpawnPipelineSample>>) {
  const ok =
    result.uniqueRegistered === result.expected &&
    result.registrySize === result.expected &&
    result.releases === result.expected;
  if (!ok) {
    throw new Error(`spawn pipeline invariant failed: ${JSON.stringify(result)}`);
  }
  return { ok, registeredRuns: result.registrySize, reservationsReleased: result.releases };
}

async function runAdmissionSample(fanout: number, serial: number) {
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
  return {
    durationMs: performance.now() - startedAt,
    admitted: reservations.length,
    overflowRejected: !overflow.ok,
    replacement: replacement.ok,
  };
}

function validateAdmission(result: Awaited<ReturnType<typeof runAdmissionSample>>) {
  const ok = result.overflowRejected && result.replacement;
  if (!ok) {
    throw new Error(`admission invariant failed: ${JSON.stringify(result)}`);
  }
  return { ok, admissionCap: result.admitted, overflowRejected: true, released: true };
}

function recoveryRow(child: number, generation: number, now: number): SubagentRunRecord {
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

async function runSweepSample(childCount: number) {
  const { createSubagentRegistrySweeper } =
    await import("../src/agents/subagent-registry-sweeper.js");
  const now = Date.now();
  const runs = new Map<string, SubagentRunRecord>();
  for (let child = 0; child < childCount; child += 1) {
    for (const generation of [3, 2, 1]) {
      const entry = recoveryRow(child, generation, now);
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
    getRunsForChildSession: (childSessionKey) =>
      [...runs.values()].filter((entry) => entry.childSessionKey === childSessionKey),
    getRunsForCollectorGroup: () => [],
    warn: () => {},
  });
  const startedAt = performance.now();
  let durationMs: number;
  try {
    await sweeper.sweepOnce();
    durationMs = performance.now() - startedAt;
  } finally {
    sweeper.reset();
  }
  const retainedCurrent = [...runs.values()].filter((entry) => entry.generation === 3).length;
  return {
    durationMs,
    seededRows: childCount * 3,
    removedRows: childCount * 3 - runs.size,
    retainedCurrent,
    sessionEffects,
    recoveryProjections,
    lostContextCompletions,
  };
}

function validateSweep(result: Awaited<ReturnType<typeof runSweepSample>>) {
  const expectedChildren = result.seededRows / 3;
  const ok =
    result.removedRows === expectedChildren * 2 &&
    result.retainedCurrent === expectedChildren &&
    result.sessionEffects === 0 &&
    result.recoveryProjections === expectedChildren &&
    result.lostContextCompletions === 0;
  if (!ok) {
    throw new Error(`registry sweep invariant failed: ${JSON.stringify(result)}`);
  }
  return { ok, ...result };
}

async function runDedupeSample(childCount: number) {
  const { dedupeLatestChildCompletionRows } =
    await import("../src/agents/subagent-announce-output.js");
  const rows = Array.from({ length: childCount }, (_, child) =>
    [3, 2, 1].map((generation) => ({
      runId: `bench-dedupe-${child}-${generation}`,
      childSessionKey: `agent:bench:subagent:dedupe-${child}`,
      task: `dedupe child ${child}`,
      generation,
      createdAt: generation,
      execution: { status: "terminal" as const, endedAt: generation },
    })),
  ).flat();
  const startedAt = performance.now();
  const deduped = dedupeLatestChildCompletionRows(rows);
  return {
    durationMs: performance.now() - startedAt,
    inputRows: rows.length,
    selectedRows: deduped.length,
    newestSelected: deduped.every((row) => row.generation === 3),
  };
}

function validateDedupe(result: Awaited<ReturnType<typeof runDedupeSample>>) {
  const ok = result.selectedRows === result.inputRows / 3 && result.newestSelected;
  if (!ok) {
    throw new Error(`completion dedupe invariant failed: ${JSON.stringify(result)}`);
  }
  return { ok, ...result };
}

async function benchmark(options: Options) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-concurrency-"));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.NODE_ENV = "test";
  let serial = 0;
  let peakRss = process.memoryUsage().rss;
  const beforeRss = peakRss;
  const runSized = async <T extends { durationMs: number }>(
    sizes: number[],
    sample: (size: number, serial: number) => Promise<T>,
    validate: (result: T) => Record<string, number | boolean>,
  ): Promise<ScenarioResult[]> => {
    const results: ScenarioResult[] = [];
    for (const size of sizes) {
      const measured = await sampleScenario(options, () => sample(size, serial++), validate);
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      results.push({ size, ...measured });
    }
    return results;
  };
  try {
    const scenarios = {
      spawnPipeline: await runSized(options.fanout, runSpawnPipelineSample, validateSpawnPipeline),
      admission: await runSized(options.fanout, runAdmissionSample, validateAdmission),
      recoverySweep: await runSized(
        options.sweepRows,
        (size) => runSweepSample(size),
        validateSweep,
      ),
      duplicateSuppression: await runSized(
        options.sweepRows,
        (size) => runDedupeSample(size),
        validateDedupe,
      ),
    };
    const afterRss = process.memoryUsage().rss;
    const checks = {
      admissionCapOverflowRelease: scenarios.admission.every((entry) => entry.invariant.ok),
      uniqueRegisteredRunsAndReleasedReservations: scenarios.spawnPipeline.every(
        (entry) => entry.invariant.ok,
      ),
      sweepRecoveryRowsWithoutSessionEffects: scenarios.recoverySweep.every(
        (entry) => entry.invariant.ok,
      ),
      dedupeNewestPerChild: scenarios.duplicateSuppression.every((entry) => entry.invariant.ok),
    };
    const failures = Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([name]) => name);
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      options: {
        runs: options.runs,
        warmup: options.warmup,
        fanout: options.fanout,
        sweepRows: options.sweepRows,
      },
      memory: {
        rssStartBytes: beforeRss,
        rssPeakBytes: Math.max(peakRss, afterRss),
        rssEndBytes: afterRss,
        rssDeltaBytes: afterRss - beforeRss,
      },
      scenarios,
      invariants: {
        ok: failures.length === 0,
        failures,
        ...checks,
      },
    };
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
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseOptions(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const report = await benchmark(options);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
    fs.writeFileSync(options.output, json);
  }
  if (options.json) {
    process.stdout.write(json);
    return;
  }
  for (const [name, scenarios] of Object.entries(report.scenarios)) {
    for (const scenario of scenarios) {
      console.log(
        `${name} size=${scenario.size} p50=${scenario.timingsMs.p50.toFixed(3)}ms p95=${scenario.timingsMs.p95.toFixed(3)}ms`,
      );
    }
  }
  console.log(`peak RSS ${(report.memory.rssPeakBytes / 1024 / 1024).toFixed(1)} MiB`);
}

export const testing = {
  benchmark,
  parseOptions,
  summarizeTimings,
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    if (process.exitCode && process.exitCode !== 0) {
      console.error(`[bench-agent-concurrency] FAILED (exit ${process.exitCode})`);
    }
  }
}
