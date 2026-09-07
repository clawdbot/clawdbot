// Dispatches Vitest project shards for explicit targets, changed files, or the
// full local suite.
import type { SpawnOptions } from "node:child_process";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import pMap from "p-map";
import { assertTestHomeSelection, combineTestHomeSelections } from "../test/test-home-policy.mts";
import { formatMs } from "./lib/check-timing-summary.mts";
import { signalExitCode } from "./lib/managed-child-process.mts";
import {
  prepareE2eVitestRuntime,
  prepareVitestRuntime,
  resolveVitestCliEntry,
} from "./lib/vitest-build-prerequisites.mts";
import { createVitestCacheSlots } from "./lib/vitest-cache-slots.mts";
import { hasNonRunVitestSubcommand } from "./lib/vitest-cli-mode.mts";
import { parseVitestExecutionArgs } from "./lib/vitest-cli.mts";
import { resolveVitestHomeSelection } from "./lib/vitest-home-selection.mts";
import { isCiLikeEnv, resolveLocalFullSuiteProfile } from "./lib/vitest-local-scheduling.mts";
import { resolveVitestNodeArgs, resolveVitestProcessEnv } from "./lib/vitest-process-env.mts";
import type { exitVitestBySignal } from "./lib/vitest-process.mts";
import { createVitestReportOwner, type VitestReportOwner } from "./lib/vitest-report-owner.mts";
import { resolveVitestRuntimeCliSelections } from "./lib/vitest-runtime-selection.mts";
import {
  createShardTimingSample,
  readShardTimings,
  writeShardTimings,
} from "./lib/vitest-shard-timings.mts";
import { createVitestWorkerRun, type VitestWorkerRun } from "./lib/vitest-worker-run.mts";
import { resolveVitestSpawnParams, spawnWatchedVitestProcess } from "./run-vitest.mts";
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
  isTestFileTarget,
  listFullExtensionVitestProjectConfigs,
  orderFullSuiteSpecsForParallelRun,
  parseTestProjectsArgs,
  resolveParallelFullSuiteConcurrency,
  resolveChangedTestTargetPlanForArgs,
  resolveChangedTargetArgs,
  shouldRetryVitestNoOutputTimeout,
  type FailedVitestShard,
  type VitestRunSpec as BaseVitestRunSpec,
  type VitestCacheAssignment,
  withRetryNoOutputTimeout,
  writeVitestIncludeFile,
} from "./test-projects.test-support.mts";

type VitestRunSpec = BaseVitestRunSpec & {
  continueOnFailure?: boolean;
  reportIndex?: number;
  workerRun?: VitestWorkerRun;
  cacheAssignment?: VitestCacheAssignment;
};
type VitestCommandOutcome = {
  code: number;
  noOutputTimedOut: boolean;
  signal: NodeJS.Signals | null;
  groupJoined: boolean;
};

type ShardTiming = NonNullable<ReturnType<typeof createShardTimingSample>>;

function assertCacheLeaseJoined(spec: VitestRunSpec, result: VitestCommandOutcome) {
  if (
    spec.cacheAssignment?.kind === "scheduler" &&
    spec.cacheAssignment.leased &&
    !result.groupJoined
  ) {
    throw new Error("Cannot continue a Vitest cache lease without verified group completion");
  }
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

function runPnpmSpecCommand(
  spec: VitestRunSpec,
  pnpmArgs: string[],
  workerRun?: VitestWorkerRun,
  homeMode?: Parameters<typeof spawnWatchedVitestProcess>[0]["homeMode"],
) {
  let noOutputTimedOut = false;
  return new Promise<VitestCommandOutcome>((resolve, reject) => {
    const { completion, getForwardedSignal } = spawnWatchedVitestProcess({
      workerRun,
      homeMode,
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
      ({ code, signal, groupJoined }) => {
        const exitSignal = getForwardedSignal() ?? signal;
        resolve({
          code: exitSignal ? signalExitCode(exitSignal) : (code ?? 1),
          noOutputTimedOut,
          signal: exitSignal,
          groupJoined,
        });
      },
      (error: unknown) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function runVitestSpec(spec: VitestRunSpec, reports: VitestReportOwner) {
  let preflightJoined = true;
  if (spec.includeFilePath && spec.includePatterns) {
    writeVitestIncludeFile(spec.includeFilePath, spec.includePatterns, {
      expandGlobs: !spec.watchMode,
    });
  }
  try {
    if (spec.preflightPnpmArgs) {
      console.error(`[test] preflight ${spec.config}`);
      const preflightResult = await runPnpmSpecCommand(
        spec,
        spec.preflightPnpmArgs,
        undefined,
        "tooling",
      );
      preflightJoined = preflightResult.groupJoined;
      if (preflightResult.code !== 0 || preflightResult.signal) {
        return preflightResult;
      }
      assertCacheLeaseJoined(spec, preflightResult);
    }
    const attempt = reports?.attempt(spec.reportIndex!, spec.pnpmArgs);
    try {
      const result = await runPnpmSpecCommand(spec, attempt?.args ?? spec.pnpmArgs, spec.workerRun);
      attempt?.complete(result);
      return { ...result, groupJoined: preflightJoined && result.groupJoined };
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
    assertCacheLeaseJoined(spec, result);
    console.error(`[test] retrying ${spec.config} after no-output timeout`);
    const firstJoined = result.groupJoined;
    result = await runVitestSpec(withRetryNoOutputTimeout(spec), reports);
    result = { ...result, groupJoined: firstJoined && result.groupJoined };
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
    return { ...result, timing: null };
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
  const withCacheSlot = createVitestCacheSlots(concurrency);
  await pMap(
    specs,
    async (spec, index) => {
      if (stopScheduling || termination.signal) {
        return;
      }
      let result: Awaited<ReturnType<typeof runLoggedVitestSpec>>;
      try {
        result = await withCacheSlot(spec, (assigned) => runLoggedVitestSpec(assigned, reports));
      } catch (error) {
        stopScheduling = true;
        throw error;
      }
      if (result.signal) {
        // A forwarded termination signal must not admit replacement shards during shutdown.
        termination.signal ??= result.signal;
        stopScheduling = true;
      }
      if (result.code !== 0) {
        exitCode ||= result.code;
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
    },
    // Join already-admitted shards even when another shard's group join fails.
    { concurrency, stopOnError: false },
  );
  return { exitCode, failures, timings, stopScheduling };
}

export async function runTestProjects(
  exitBySignal: typeof exitVitestBySignal,
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
) {
  const suiteStartedAt = performance.now();
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    printHelp();
    return;
  }
  const baseEnv = resolveVitestProcessEnv(env);
  const { targetArgs, forwardedArgs } = parseTestProjectsArgs(args, process.cwd());
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
            ...resolveVitestNodeArgs(baseEnv),
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

  const { parseCLI } = await import("vitest/node");
  if (
    targetArgs.length &&
    !runSpecs.some((spec) => spec.watchMode) &&
    !hasNonRunVitestSubcommand(forwardedArgs)
  ) {
    // Native parsing stays in the execution owner. Original filters distinguish
    // explicit files from broad selections that also lower to literal include files.
    const execution = parseVitestExecutionArgs(["run", ...forwardedArgs], parseCLI);
    if (
      execution &&
      !execution.options.watch &&
      execution.options.run !== false &&
      execution.filter.length > 0 &&
      execution.filter.every(
        (file) => isTestFileTarget(file) && /[/\\]/u.test(file) && !/[*?[\]{}]|[@+!]\(/u.test(file),
      ) &&
      !Object.hasOwn(execution.options, "passWithNoTests")
    ) {
      for (const spec of runSpecs) {
        const separator = spec.pnpmArgs.indexOf("--");
        spec.pnpmArgs.splice(
          separator < 0 ? spec.pnpmArgs.length : separator,
          0,
          "--passWithNoTests=false",
        );
      }
    }
  }

  runSpecs.forEach((spec, index) => {
    spec.reportIndex = index;
  });
  const homeMode = combineTestHomeSelections(
    runSpecs.map((spec) => resolveVitestHomeSelection(spec.pnpmArgs, { env: spec.env })),
  );
  // Refuse a mixed real-home run before report setup or runtime preparation imports code.
  assertTestHomeSelection(baseEnv, homeMode);
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
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  let workers: VitestWorkerRun | undefined;
  let reportFailure: string | undefined;
  let printCompletedSummary: (() => void) | undefined;
  try {
    const admitted = runSpecs.map((spec) => {
      const cliArgs = spec.pnpmArgs.slice(spec.pnpmArgs.indexOf(resolveVitestCliEntry()) + 1);
      const execution = parseVitestExecutionArgs(cliArgs, parseCLI);
      // Metadata and invalid input must not install browser prerequisites either.
      if (!execution) {
        spec.preflightPnpmArgs = null;
      }
      return { spec, cliArgs, execution };
    });
    const runnable = admitted.filter(({ execution }) => execution !== null);
    const e2eSpecs = runnable
      .map(({ spec }) => spec)
      .filter((spec) => spec.config === "test/vitest/vitest.e2e.config.ts");
    if (e2eSpecs.length > 0) {
      const preparedEnv = await prepareE2eVitestRuntime(baseEnv);
      for (const spec of e2eSpecs) {
        spec.env = { ...spec.env, ...preparedEnv };
      }
    } else {
      const code = await prepareVitestRuntime(
        runnable.flatMap(({ spec, cliArgs }) => {
          const selections = resolveVitestRuntimeCliSelections(spec.config, cliArgs, spec.env);
          // These selections are invocation-owned; their include files are not written yet.
          for (const selection of selections) {
            selection.includePatterns = spec.includePatterns;
          }
          return selections;
        }),
        baseEnv,
      );
      if (code !== 0) {
        printTestSummary("failed", 0, performance.now() - suiteStartedAt);
        process.exitCode = code;
        return;
      }
    }

    const compiled = runnable.filter(
      ({ spec, execution }) => !spec.watchMode && !execution?.options.watch,
    );
    if (compiled.length) {
      workers = createVitestWorkerRun(baseEnv);
      for (const { spec } of compiled) {
        spec.workerRun = workers;
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
    if (concurrency === 1 && termination.signal) {
      return;
    }
    if (concurrency > 1 || !result.stopScheduling) {
      writeShardTimings(result.timings, process.cwd(), baseEnv);
    }
    printCompletedSummary = () =>
      printTestSummary(
        process.exitCode ? "failed" : "passed",
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
    try {
      await workers?.dispose().catch((error: unknown) => {
        reportFailure ??= String(error);
        process.exitCode ||= 1;
        console.error(error);
      });
      if (reports) {
        const reportCode = await reports.finish(
          async (mergeArgs) => {
            // Replay is source-only: selected configs load after all compiled
            // borrowers close; report blobs own the exact executed selection.
            const outcome = await runPnpmSpecCommand(
              { ...runSpecs[0]!, env: baseEnv },
              [
                "exec",
                "node",
                ...resolveVitestNodeArgs(baseEnv),
                resolveVitestCliEntry(),
                ...mergeArgs,
              ],
              undefined,
              homeMode,
            );
            termination.signal ??= outcome.signal;
            return outcome;
          },
          termination.signal ? `Cancelled by ${termination.signal}` : reportFailure,
        );
        if (reportCode) {
          process.exitCode ||= reportCode;
        }
      }
      printCompletedSummary?.();
    } finally {
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
      if (termination.signal) {
        await exitBySignal(termination.signal);
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
