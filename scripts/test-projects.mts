// Dispatches Vitest project shards for explicit targets, changed files, or the
// full local suite.
import type { SpawnOptions } from "node:child_process";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import pMap from "p-map";
import { waitForever } from "../src/cli/wait.ts";
import { formatMs } from "./lib/check-timing-summary.mts";
import {
  prepareE2eVitestRuntime,
  prepareVitestRuntime,
} from "./lib/vitest-build-prerequisites.mts";
import {
  isCiLikeEnv,
  resolveLocalFullSuiteProfile,
  resolveLocalVitestEnv,
} from "./lib/vitest-local-scheduling.mts";
import { createVitestReportOwner, type VitestReportOwner } from "./lib/vitest-report-owner.mts";
import {
  createShardTimingSample,
  readShardTimings,
  writeShardTimings,
} from "./lib/vitest-shard-timings.mts";
import {
  resolveVitestCliEntry,
  resolveVitestNodeArgs,
  resolveVitestSpawnParams,
  spawnWatchedVitestProcess,
} from "./run-vitest.mts";
import {
  applyDefaultMultiSpecVitestCachePaths,
  applyDefaultVitestNoOutputTimeout,
  applyFullExtensionsHeapBudget,
  applyParallelVitestCachePaths,
  buildFullSuiteVitestRunPlans,
  createVitestPreflightPnpmArgs,
  createVitestRunSpecs,
  findUnmatchedExplicitTestTargets,
  formatFailedShardDigest,
  formatNoChangedTestTargetLines,
  listFullExtensionVitestProjectConfigs,
  orderFullSuiteSpecsForParallelRun,
  parseTestProjectsArgs,
  resolveParallelFullSuiteConcurrency,
  resolveChangedTestTargetPlanForArgs,
  resolveChangedTargetArgs,
  shouldRetryVitestNoOutputTimeout,
  type FailedVitestShard,
  type VitestRunSpec as BaseVitestRunSpec,
  withRetryNoOutputTimeout,
  writeVitestIncludeFile,
} from "./test-projects.test-support.mts";

type VitestRunSpec = BaseVitestRunSpec & { continueOnFailure?: boolean; reportIndex?: number };
type VitestCommandOutcome = {
  code: number;
  noOutputTimedOut: boolean;
  signal: NodeJS.Signals | null;
};

type ShardTiming = NonNullable<ReturnType<typeof createShardTimingSample>>;

function isWrapperMetadataRequest(args: string[]) {
  for (const arg of args) {
    if (arg === "--") {
      return false;
    }
    if (arg === "--help" || arg === "-h") {
      return true;
    }
  }
  return false;
}

function printHelp() {
  console.log(`Usage: node --import tsx scripts/test-projects.mts [--changed <base>] [--watch] [targets...] [-- vitest-args...]

Runs the Vitest project shards that own the requested targets. With no targets,
this runs the full local suite. Use explicit targets for local edit loops.`);
}

function cleanupVitestRunSpec(spec: VitestRunSpec) {
  if (!spec.includeFilePath) {
    return;
  }
  try {
    fs.rmSync(spec.includeFilePath, { force: true });
  } catch {
    // Best-effort cleanup for temp include lists.
  }
}

function runPnpmSpecCommand(spec: VitestRunSpec, pnpmArgs: string[]) {
  let noOutputTimedOut = false;
  return new Promise<VitestCommandOutcome>((resolve, reject) => {
    const { completion, getForwardedSignal } = spawnWatchedVitestProcess({
      pnpmArgs,
      env: spec.env,
      onNoOutputTimeout: () => {
        noOutputTimedOut = true;
      },
      spawnParams: {
        cwd: process.cwd(),
        ...resolveVitestSpawnParams(spec.env),
        stdio: ["inherit", "pipe", "pipe"] satisfies SpawnOptions["stdio"],
      },
    });

    completion.then(
      ({ code, signal }) => {
        const forwardedSignal = getForwardedSignal();
        if (forwardedSignal) {
          resolve({ code: 143, noOutputTimedOut, signal: forwardedSignal });
          return;
        }
        resolve({ code: code ?? (signal ? 143 : 1), noOutputTimedOut, signal });
      },
      (error: unknown) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function runVitestSpec(spec: VitestRunSpec, reports: VitestReportOwner) {
  if (spec.includeFilePath && spec.includePatterns) {
    writeVitestIncludeFile(spec.includeFilePath, spec.includePatterns, {
      expandGlobs: !spec.watchMode,
    });
  }
  try {
    if (spec.preflightPnpmArgs) {
      console.error(`[test] preflight ${spec.config}`);
      const preflightResult = await runPnpmSpecCommand(spec, spec.preflightPnpmArgs);
      if (preflightResult.code !== 0 || preflightResult.signal) {
        return preflightResult;
      }
    }
    const attempt = reports?.attempt(spec.reportIndex!, spec.pnpmArgs);
    try {
      const result = await runPnpmSpecCommand(spec, attempt?.args ?? spec.pnpmArgs);
      attempt?.complete(result);
      return result;
    } catch (error) {
      attempt?.fail(error);
      throw error;
    }
  } finally {
    cleanupVitestRunSpec(spec);
  }
}

function applyDefaultParallelVitestWorkerBudget(specs: VitestRunSpec[], env: NodeJS.ProcessEnv) {
  if (env.OPENCLAW_VITEST_MAX_WORKERS || env.OPENCLAW_TEST_WORKERS || isCiLikeEnv(env)) {
    return specs;
  }
  const { vitestMaxWorkers } = resolveLocalFullSuiteProfile(env);
  return specs.map((spec) => ({
    ...spec,
    env: {
      ...spec.env,
      OPENCLAW_VITEST_MAX_WORKERS: String(vitestMaxWorkers),
    },
  }));
}

async function runLoggedVitestSpec(spec: VitestRunSpec, reports: VitestReportOwner) {
  console.error(`[test] starting ${spec.config}`);
  const startedAt = performance.now();
  let result = await runVitestSpec(spec, reports);
  if (result.noOutputTimedOut && !spec.watchMode && shouldRetryVitestNoOutputTimeout(spec.env)) {
    console.error(`[test] retrying ${spec.config} after no-output timeout`);
    result = await runVitestSpec(withRetryNoOutputTimeout(spec), reports);
  }
  const durationMs = performance.now() - startedAt;
  if (result.noOutputTimedOut && result.signal) {
    console.error(`[test] ${spec.config} exceeded no-output timeout`);
    return {
      ...result,
      code: result.code || 143,
      signal: null,
      timing: null,
    };
  }
  if (result.signal) {
    console.error(`[test] ${spec.config} exited by signal ${result.signal}`);
    if (reports) {
      return { ...result, timing: null };
    }
    process.kill(process.pid, result.signal);
    return null;
  }
  return {
    ...result,
    timing: createShardTimingSample(spec, durationMs),
  };
}

function isFullExtensionsProjectRun(specs: VitestRunSpec[]) {
  const fullExtensionProjectConfigs = new Set(listFullExtensionVitestProjectConfigs());
  return (
    specs.length > 1 &&
    specs.every(
      (spec) =>
        !spec.watchMode &&
        spec.includePatterns === null &&
        fullExtensionProjectConfigs.has(spec.config),
    )
  );
}

function printNoChangedTestTargets(args: string[], cwd: string, baseEnv: NodeJS.ProcessEnv) {
  const plan = resolveChangedTestTargetPlanForArgs(args, cwd, undefined, { env: baseEnv });
  const skippedBroadFallbackPaths = plan?.skippedBroadFallbackPaths ?? [];
  for (const line of formatNoChangedTestTargetLines(skippedBroadFallbackPaths)) {
    console.error(line);
  }
}

async function runVitestSpecs(
  specs: VitestRunSpec[],
  concurrency: number,
  reports: VitestReportOwner,
  termination: { signal: NodeJS.Signals | null },
) {
  let exitCode = 0;
  let stopScheduling = false;
  const failures: FailedVitestShard[] = [];
  const timings: ShardTiming[] = [];
  const started: Promise<unknown>[] = [];
  let interrupted = false;

  try {
    await pMap(
      specs,
      (spec, index) => {
        const running = (async () => {
          if (stopScheduling || termination.signal) {
            return;
          }
          const result = await runLoggedVitestSpec(spec, reports);
          if (!result) {
            // A forwarded termination signal must not admit replacement shards during shutdown.
            stopScheduling = true;
            interrupted = true;
            return;
          }
          if (result.signal) {
            termination.signal ??= result.signal;
            stopScheduling = true;
          }
          if (result.code !== 0) {
            exitCode = exitCode || result.code;
            if (concurrency === 1 && spec.continueOnFailure !== true) {
              stopScheduling = true;
            }
            failures.push({
              code: result.code,
              config: spec.config,
              includePatterns: spec.includePatterns,
              noOutputTimedOut: result.noOutputTimedOut,
              order: index,
              signal: result.signal,
            });
          }
          if (result.timing) {
            timings.push(result.timing);
          }
        })();
        started.push(running);
        return running;
      },
      { concurrency, stopOnError: true },
    );
  } finally {
    await Promise.allSettled(started);
  }
  return { exitCode, failures, timings, stopScheduling, interrupted };
}

async function main() {
  const suiteStartedAt = performance.now();
  const args = process.argv.slice(2);
  if (isWrapperMetadataRequest(args)) {
    printHelp();
    return;
  }
  const baseEnv = resolveLocalVitestEnv(process.env);
  const { targetArgs } = parseTestProjectsArgs(args, process.cwd());
  const unmatchedExplicitTargets = findUnmatchedExplicitTestTargets(args, process.cwd());
  if (unmatchedExplicitTargets.length > 0) {
    for (const unmatched of unmatchedExplicitTargets) {
      const suffix = unmatched.includePattern ? ` (tried: ${unmatched.includePattern})` : "";
      console.error(
        `[test] explicit test target matched no test files: ${unmatched.target}${suffix}`,
      );
    }
    printTestSummary("failed", 1, performance.now() - suiteStartedAt);
    process.exitCode = 1;
    return;
  }
  const changedTargetArgs =
    targetArgs.length === 0
      ? resolveChangedTargetArgs(args, process.cwd(), undefined, { env: baseEnv })
      : null;
  const rawRunSpecs: VitestRunSpec[] =
    targetArgs.length === 0 && changedTargetArgs === null
      ? buildFullSuiteVitestRunPlans(args, process.cwd()).map((plan) => ({
          config: plan.config,
          continueOnFailure: true,
          env: baseEnv,
          includeFilePath: null,
          includePatterns: null,
          pnpmArgs: [
            "exec",
            "node",
            ...resolveVitestNodeArgs(process.env),
            resolveVitestCliEntry(),
            ...(plan.watchMode ? [] : ["run"]),
            "--config",
            plan.config,
            ...plan.forwardedArgs,
          ],
          preflightPnpmArgs: createVitestPreflightPnpmArgs(plan.config),
          watchMode: plan.watchMode,
        }))
      : createVitestRunSpecs(args, {
          baseEnv,
          cwd: process.cwd(),
        });
  const runSpecs: VitestRunSpec[] = applyDefaultMultiSpecVitestCachePaths(
    applyDefaultVitestNoOutputTimeout(
      applyFullExtensionsHeapBudget(rawRunSpecs, { env: baseEnv }),
      {
        env: baseEnv,
      },
    ),
    { cwd: process.cwd(), env: baseEnv },
  );

  if (runSpecs.length === 0) {
    printNoChangedTestTargets(args, process.cwd(), baseEnv);
    printTestSummary("skipped", 0, performance.now() - suiteStartedAt);
    return;
  }

  runSpecs.forEach((spec, index) => {
    spec.reportIndex = index;
  });
  const reports = await createVitestReportOwner(
    runSpecs.map((spec) => ({
      config: spec.config,
      includePatterns: spec.includePatterns,
      args: spec.pnpmArgs.slice(spec.pnpmArgs.indexOf(resolveVitestCliEntry()) + 1),
    })),
    process.cwd(),
  );
  const termination: { signal: NodeJS.Signals | null } = { signal: null };
  const onSignal = (signal: NodeJS.Signals) => {
    termination.signal ??= signal;
  };
  if (reports) {
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  }
  let reportFailure: string | undefined;
  try {
    const e2eSpecs = runSpecs.filter((spec) => spec.config === "test/vitest/vitest.e2e.config.ts");
    if (e2eSpecs.length > 0) {
      const preparedEnv = await prepareE2eVitestRuntime(baseEnv);
      for (const spec of e2eSpecs) {
        spec.env = { ...spec.env, ...preparedEnv };
      }
    } else {
      const code = await prepareVitestRuntime(
        runSpecs.map((spec) => ({ configs: [spec.config], includePatterns: spec.includePatterns })),
        baseEnv,
      );
      if (code !== 0) {
        printTestSummary("failed", 0, performance.now() - suiteStartedAt);
        process.exitCode = code;
        return;
      }
    }

    const isFullSuiteRun =
      targetArgs.length === 0 &&
      changedTargetArgs === null &&
      !runSpecs.some((spec) => spec.watchMode);
    const isExplicitParallelMultiConfigRun =
      Boolean(baseEnv.OPENCLAW_TEST_PROJECTS_PARALLEL) &&
      runSpecs.length > 1 &&
      !runSpecs.some((spec) => spec.watchMode);
    const isParallelShardRun =
      isFullSuiteRun || isFullExtensionsProjectRun(runSpecs) || isExplicitParallelMultiConfigRun;
    let scheduledSpecs = runSpecs;
    const concurrency = isParallelShardRun
      ? resolveParallelFullSuiteConcurrency(runSpecs.length, baseEnv)
      : 1;
    if (isParallelShardRun) {
      if (!isCiLikeEnv(baseEnv) && runSpecs.length > 1) {
        console.warn(
          `[test] warning: broad local run will start ${runSpecs.length} Vitest shards; use \`pnpm test:changed\` for routine checks.`,
        );
      }
      if (concurrency > 1) {
        const shardTimings = readShardTimings(process.cwd(), baseEnv);
        const orderedSpecs = orderFullSuiteSpecsForParallelRun(runSpecs, shardTimings).filter(
          (spec): spec is VitestRunSpec => spec !== undefined,
        );
        scheduledSpecs = applyDefaultParallelVitestWorkerBudget(
          applyParallelVitestCachePaths(orderedSpecs, {
            cwd: process.cwd(),
            env: baseEnv,
          }),
          baseEnv,
        );
        console.error(
          `[test] running ${scheduledSpecs.length} Vitest shards with parallelism ${concurrency}`,
        );
      }
    }

    const result = await runVitestSpecs(scheduledSpecs, concurrency, reports, termination);
    if (result.interrupted || (concurrency === 1 && termination.signal)) {
      return;
    }
    if (concurrency > 1 || !result.stopScheduling) {
      writeShardTimings(result.timings, process.cwd(), baseEnv);
    }
    printTestSummary(
      result.exitCode === 0 ? "passed" : "failed",
      concurrency > 1 ? scheduledSpecs.length : result.timings.length,
      performance.now() - suiteStartedAt,
      concurrency > 1 ? "Vitest summaries above are per-shard, not aggregate totals." : undefined,
    );
    if (concurrency > 1) {
      for (const line of formatFailedShardDigest(result.failures)) {
        console.error(line);
      }
    }
    if (result.exitCode !== 0) {
      process.exitCode = result.exitCode;
    }
  } catch (error) {
    reportFailure = String(error);
    throw error;
  } finally {
    if (reports) {
      try {
        const reportCode = await reports.finish(
          async (mergeArgs) => {
            // Per-spec include files have been cleaned up. Replay loads the selected
            // configs with the caller environment; blobs own the exact executed selection.
            const outcome = await runPnpmSpecCommand({ ...runSpecs[0]!, env: baseEnv }, [
              "exec",
              "node",
              ...resolveVitestNodeArgs(baseEnv),
              resolveVitestCliEntry(),
              ...mergeArgs,
            ]);
            termination.signal ??= outcome.signal;
            return outcome;
          },
          termination.signal ? `Cancelled by ${termination.signal}` : reportFailure,
        );
        if (reportCode) {
          process.exitCode ||= reportCode;
        }
      } finally {
        process.off("SIGTERM", onSignal);
        process.off("SIGINT", onSignal);
        if (termination.signal) {
          process.kill(process.pid, termination.signal);
          // Keep the loop alive for dependency signal handlers to finish cleanup
          // and re-raise; a numeric return can win the race with signal delivery.
          await waitForever();
        }
      }
    }
  }
}

function printTestSummary(
  status: "failed" | "passed" | "skipped",
  shardCount: number,
  durationMs: number,
  detail?: string,
) {
  const suffix = detail ? `; ${detail}` : "";
  console.error(
    `[test] ${status} ${shardCount} Vitest shard${shardCount === 1 ? "" : "s"} in ${formatMs(durationMs)}${suffix}`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
