import fs from "node:fs";
import { acquireLocalHeavyCheckLockSync } from "./lib/local-heavy-check-runtime.mjs";
import { isCiLikeEnv, resolveLocalFullSuiteProfile } from "./lib/vitest-local-scheduling.mjs";
import { spawnPnpmRunner } from "./pnpm-runner.mjs";
import {
  forwardVitestOutput,
  installVitestNoOutputWatchdog,
  resolveVitestCliEntry,
  resolveVitestNodeArgs,
  resolveVitestNoOutputTimeoutMs,
  shouldSuppressVitestStderrLine,
} from "./run-vitest.mjs";
import {
  applyParallelVitestCachePaths,
  buildFullSuiteVitestRunPlans,
  createVitestRunSpecs,
  parseTestProjectsArgs,
  resolveParallelFullSuiteConcurrency,
  resolveChangedTargetArgs,
  shouldAcquireLocalHeavyCheckLock,
  writeVitestIncludeFile,
} from "./test-projects.test-support.mjs";
import {
  forwardSignalToVitestProcessGroup,
  installVitestProcessGroupCleanup,
  shouldUseDetachedVitestProcessGroup,
} from "./vitest-process-group.mjs";

// Keep this shim so `pnpm test -- src/foo.test.ts` still forwards filters
// cleanly instead of leaking pnpm's passthrough sentinel to Vitest.
let releaseLock = () => {};
let lockReleased = false;

const FULL_SUITE_CONFIG_WEIGHT = new Map([
  ["test/vitest/vitest.gateway.config.ts", 180],
  ["test/vitest/vitest.gateway-server.config.ts", 180],
  ["test/vitest/vitest.gateway-core.config.ts", 179],
  ["test/vitest/vitest.gateway-client.config.ts", 178],
  ["test/vitest/vitest.gateway-methods.config.ts", 177],
  ["test/vitest/vitest.commands.config.ts", 175],
  ["test/vitest/vitest.agents.config.ts", 170],
  ["test/vitest/vitest.extension-voice-call.config.ts", 169],
  ["test/vitest/vitest.extensions.config.ts", 168],
  ["test/vitest/vitest.extension-channels.config.ts", 167],
  ["test/vitest/vitest.runtime-config.config.ts", 166],
  ["test/vitest/vitest.contracts.config.ts", 165],
  ["test/vitest/vitest.tasks.config.ts", 165],
  ["test/vitest/vitest.channels.config.ts", 164],
  ["test/vitest/vitest.unit-fast.config.ts", 160],
  ["test/vitest/vitest.auto-reply-reply.config.ts", 155],
  ["test/vitest/vitest.infra.config.ts", 145],
  ["test/vitest/vitest.secrets.config.ts", 140],
  ["test/vitest/vitest.cron.config.ts", 135],
  ["test/vitest/vitest.wizard.config.ts", 130],
  ["test/vitest/vitest.unit-src.config.ts", 125],
  ["test/vitest/vitest.extension-matrix.config.ts", 100],
  ["test/vitest/vitest.extension-providers.config.ts", 96],
  ["test/vitest/vitest.extension-telegram.config.ts", 94],
  ["test/vitest/vitest.extension-whatsapp.config.ts", 92],
  ["test/vitest/vitest.auto-reply-core.config.ts", 90],
  ["test/vitest/vitest.cli.config.ts", 86],
  ["test/vitest/vitest.media.config.ts", 84],
  ["test/vitest/vitest.plugins.config.ts", 82],
  ["test/vitest/vitest.bundled.config.ts", 80],
  ["test/vitest/vitest.commands-light.config.ts", 48],
  ["test/vitest/vitest.plugin-sdk.config.ts", 46],
  ["test/vitest/vitest.auto-reply-top-level.config.ts", 45],
  ["test/vitest/vitest.unit-ui.config.ts", 40],
  ["test/vitest/vitest.plugin-sdk-light.config.ts", 38],
  ["test/vitest/vitest.daemon.config.ts", 36],
  ["test/vitest/vitest.boundary.config.ts", 34],
  ["test/vitest/vitest.tooling.config.ts", 32],
  ["test/vitest/vitest.unit-security.config.ts", 30],
  ["test/vitest/vitest.unit-support.config.ts", 28],
  ["test/vitest/vitest.extension-zalo.config.ts", 24],
  ["test/vitest/vitest.extension-bluebubbles.config.ts", 22],
  ["test/vitest/vitest.extension-irc.config.ts", 20],
  ["test/vitest/vitest.extension-feishu.config.ts", 18],
  ["test/vitest/vitest.extension-mattermost.config.ts", 16],
  ["test/vitest/vitest.extension-messaging.config.ts", 14],
  ["test/vitest/vitest.extension-acpx.config.ts", 10],
  ["test/vitest/vitest.extension-diffs.config.ts", 8],
  ["test/vitest/vitest.extension-memory.config.ts", 6],
  ["test/vitest/vitest.extension-msteams.config.ts", 4],
]);
const releaseLockOnce = () => {
  if (lockReleased) {
    return;
  }
  lockReleased = true;
  releaseLock();
};

function cleanupVitestRunSpec(spec) {
  if (!spec.includeFilePath) {
    return;
  }
  try {
    fs.rmSync(spec.includeFilePath, { force: true });
  } catch {
    // Best-effort cleanup for temp include lists.
  }
}

function runVitestSpec(spec) {
  if (spec.includeFilePath && spec.includePatterns) {
    writeVitestIncludeFile(spec.includeFilePath, spec.includePatterns);
  }
  return new Promise((resolve, reject) => {
    const child = spawnPnpmRunner({
      cwd: process.cwd(),
      detached: shouldUseDetachedVitestProcessGroup(),
      pnpmArgs: spec.pnpmArgs,
      env: spec.env,
      stdio: ["inherit", "pipe", "pipe"],
    });
    const teardownChildCleanup = installVitestProcessGroupCleanup({ child });
    const teardownNoOutputWatchdog = installVitestNoOutputWatchdog({
      streams: [child.stdout, child.stderr],
      timeoutMs: resolveVitestNoOutputTimeoutMs(spec.env),
      label: spec.config,
      log: (message) => {
        console.error(message);
      },
      onTimeout: () => {
        forwardSignalToVitestProcessGroup({
          child,
          signal: "SIGTERM",
          kill: process.kill.bind(process),
        });
      },
      onForceKill: () => {
        forwardSignalToVitestProcessGroup({
          child,
          signal: "SIGKILL",
          kill: process.kill.bind(process),
        });
      },
    });

    forwardVitestOutput(child.stdout, process.stdout);
    forwardVitestOutput(child.stderr, process.stderr, shouldSuppressVitestStderrLine);

    child.on("exit", (code, signal) => {
      teardownChildCleanup();
      teardownNoOutputWatchdog();
      cleanupVitestRunSpec(spec);
      resolve({ code: code ?? 1, signal });
    });

    child.on("error", (error) => {
      teardownChildCleanup();
      teardownNoOutputWatchdog();
      cleanupVitestRunSpec(spec);
      reject(error);
    });
  });
}

function applyDefaultParallelVitestWorkerBudget(specs, env) {
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

function orderFullSuiteSpecsForParallelRun(specs) {
  return specs.toSorted((a, b) => {
    const weightDelta =
      (FULL_SUITE_CONFIG_WEIGHT.get(b.config) ?? 0) - (FULL_SUITE_CONFIG_WEIGHT.get(a.config) ?? 0);
    if (weightDelta !== 0) {
      return weightDelta;
    }
    return a.config.localeCompare(b.config);
  });
}

async function runVitestSpecsParallel(specs, concurrency) {
  let nextIndex = 0;
  let exitCode = 0;

  const runWorker = async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      const spec = specs[index];
      if (!spec) {
        return;
      }
      console.error(`[test] starting ${spec.config}`);
      const result = await runVitestSpec(spec);
      if (result.signal) {
        console.error(`[test] ${spec.config} exited by signal ${result.signal}`);
        releaseLockOnce();
        process.kill(process.pid, result.signal);
        return;
      }
      if (result.code !== 0) {
        exitCode = exitCode || result.code;
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
  return exitCode;
}

async function main() {
  const args = process.argv.slice(2);
  const { targetArgs } = parseTestProjectsArgs(args, process.cwd());
  const changedTargetArgs =
    targetArgs.length === 0 ? resolveChangedTargetArgs(args, process.cwd()) : null;
  const runSpecs =
    targetArgs.length === 0 && changedTargetArgs === null
      ? buildFullSuiteVitestRunPlans(args, process.cwd()).map((plan) => ({
          config: plan.config,
          continueOnFailure: true,
          env: process.env,
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
          watchMode: plan.watchMode,
        }))
      : createVitestRunSpecs(args, {
          baseEnv: process.env,
          cwd: process.cwd(),
        });

  releaseLock = shouldAcquireLocalHeavyCheckLock(runSpecs, process.env)
    ? acquireLocalHeavyCheckLockSync({
        cwd: process.cwd(),
        env: process.env,
        toolName: "test",
      })
    : () => {};

  const isFullSuiteRun =
    targetArgs.length === 0 &&
    changedTargetArgs === null &&
    !runSpecs.some((spec) => spec.watchMode);
  if (isFullSuiteRun) {
    const concurrency = resolveParallelFullSuiteConcurrency(runSpecs.length, process.env);
    if (concurrency > 1) {
      const localFullSuiteProfile = resolveLocalFullSuiteProfile(process.env);
      const parallelSpecs = applyDefaultParallelVitestWorkerBudget(
        applyParallelVitestCachePaths(orderFullSuiteSpecsForParallelRun(runSpecs), {
          cwd: process.cwd(),
          env: process.env,
        }),
        process.env,
      );
      if (
        !isCiLikeEnv(process.env) &&
        !process.env.OPENCLAW_TEST_PROJECTS_PARALLEL &&
        !process.env.OPENCLAW_VITEST_MAX_WORKERS &&
        !process.env.OPENCLAW_TEST_WORKERS &&
        localFullSuiteProfile.shardParallelism === 10 &&
        localFullSuiteProfile.vitestMaxWorkers === 2
      ) {
        console.error("[test] using host-aware local full-suite profile: shards=10 workers=2");
      }
      console.error(
        `[test] running ${parallelSpecs.length} Vitest shards with parallelism ${concurrency}`,
      );
      const parallelExitCode = await runVitestSpecsParallel(parallelSpecs, concurrency);
      console.error(
        `[test] completed ${parallelSpecs.length} Vitest shards; Vitest summaries above are per-shard, not aggregate totals.`,
      );
      releaseLockOnce();
      if (parallelExitCode !== 0) {
        process.exit(parallelExitCode);
      }
      return;
    }
  }

  let exitCode = 0;
  for (const spec of runSpecs) {
    console.error(`[test] starting ${spec.config}`);
    const result = await runVitestSpec(spec);
    if (result.signal) {
      console.error(`[test] ${spec.config} exited by signal ${result.signal}`);
      releaseLockOnce();
      process.kill(process.pid, result.signal);
      return;
    }
    if (result.code !== 0) {
      exitCode = exitCode || result.code;
      if (spec.continueOnFailure !== true) {
        releaseLockOnce();
        process.exit(result.code);
      }
    }
  }

  releaseLockOnce();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

main().catch((error) => {
  releaseLockOnce();
  console.error(error);
  process.exit(1);
});
