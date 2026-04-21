import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { acquireLocalHeavyCheckLockSync } from "./lib/local-heavy-check-runtime.mjs";
import { isCiLikeEnv, resolveLocalFullSuiteProfile } from "./lib/vitest-local-scheduling.mjs";
import {
  resolveVitestCliEntry,
  resolveVitestNodeArgs,
  resolveVitestSpawnParams,
  spawnWatchedVitestProcess,
} from "./run-vitest.mjs";
import {
  applyParallelVitestCachePaths,
  buildFullSuiteVitestRunPlans,
  createVitestRunSpecs,
  listFullExtensionVitestProjectConfigs,
  parseTestProjectsArgs,
  resolveParallelFullSuiteConcurrency,
  resolveChangedTargetArgs,
  shouldAcquireLocalHeavyCheckLock,
  writeVitestIncludeFile,
} from "./test-projects.test-support.mjs";

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
  ["test/vitest/vitest.extension-provider-openai.config.ts", 167],
  ["test/vitest/vitest.runtime-config.config.ts", 166],
  ["test/vitest/vitest.contracts-channel-config.config.ts", 85],
  ["test/vitest/vitest.contracts-channel-surface.config.ts", 60],
  ["test/vitest/vitest.contracts-channel-session.config.ts", 50],
  ["test/vitest/vitest.contracts-channel-registry.config.ts", 35],
  ["test/vitest/vitest.contracts-plugin.config.ts", 20],
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
  ["test/vitest/vitest.extension-discord.config.ts", 98],
  ["test/vitest/vitest.extension-providers.config.ts", 96],
  ["test/vitest/vitest.extension-telegram.config.ts", 94],
  ["test/vitest/vitest.extension-whatsapp.config.ts", 92],
  ["test/vitest/vitest.auto-reply-core.config.ts", 90],
  ["test/vitest/vitest.cli.config.ts", 86],
  ["test/vitest/vitest.media.config.ts", 84],
  ["test/vitest/vitest.plugins.config.ts", 82],
  ["test/vitest/vitest.bundled.config.ts", 80],
  ["test/vitest/vitest.extension-slack.config.ts", 78],
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
  ["test/vitest/vitest.extension-imessage.config.ts", 13],
  ["test/vitest/vitest.extension-line.config.ts", 12],
  ["test/vitest/vitest.extension-signal.config.ts", 11],
  ["test/vitest/vitest.extension-acpx.config.ts", 10],
  ["test/vitest/vitest.extension-diffs.config.ts", 8],
  ["test/vitest/vitest.extension-memory.config.ts", 6],
  ["test/vitest/vitest.extension-msteams.config.ts", 4],
]);
const TIMINGS_FILE_ENV_KEY = "OPENCLAW_TEST_PROJECTS_TIMINGS_PATH";
const TIMINGS_DISABLE_ENV_KEY = "OPENCLAW_TEST_PROJECTS_TIMINGS";
const releaseLockOnce = () => {
  if (lockReleased) {
    return;
  }
  lockReleased = true;
  releaseLock();
};

function shouldUseShardTimings(env = process.env) {
  return env[TIMINGS_DISABLE_ENV_KEY] !== "0";
}

function resolveShardTimingsPath(cwd = process.cwd(), env = process.env) {
  return env[TIMINGS_FILE_ENV_KEY] || path.join(cwd, ".artifacts", "vitest-shard-timings.json");
}

function readShardTimings(cwd = process.cwd(), env = process.env) {
  if (!shouldUseShardTimings(env)) {
    return new Map();
  }
  try {
    const raw = fs.readFileSync(resolveShardTimingsPath(cwd, env), "utf8");
    const parsed = JSON.parse(raw);
    const configs = parsed && typeof parsed === "object" ? parsed.configs : null;
    if (!configs || typeof configs !== "object") {
      return new Map();
    }
    return new Map(
      Object.entries(configs)
        .map(([config, value]) => {
          const durationMs = Number(value?.averageMs ?? value?.durationMs);
          return Number.isFinite(durationMs) && durationMs > 0 ? [config, durationMs] : null;
        })
        .filter(Boolean),
    );
  } catch {
    return new Map();
  }
}

function writeShardTimings(samples, cwd = process.cwd(), env = process.env) {
  if (!shouldUseShardTimings(env) || samples.length === 0) {
    return;
  }

  const outputPath = resolveShardTimingsPath(cwd, env);
  let current = { version: 1, configs: {} };
  try {
    current = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  } catch {
    // First run, or a corrupt local artifact. Rewrite below.
  }

  const configs =
    current && typeof current === "object" && current.configs && typeof current.configs === "object"
      ? { ...current.configs }
      : {};
  const updatedAt = new Date().toISOString();
  for (const sample of samples) {
    if (!sample.config || !Number.isFinite(sample.durationMs) || sample.durationMs <= 0) {
      continue;
    }
    const previous = configs[sample.config];
    const previousAverage = Number(previous?.averageMs ?? previous?.durationMs);
    const sampleCount = Math.max(0, Number(previous?.sampleCount) || 0) + 1;
    const averageMs =
      Number.isFinite(previousAverage) && previousAverage > 0
        ? Math.round(previousAverage * 0.7 + sample.durationMs * 0.3)
        : Math.round(sample.durationMs);
    configs[sample.config] = {
      averageMs,
      lastMs: Math.round(sample.durationMs),
      sampleCount,
      updatedAt,
    };
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify({ version: 1, configs }, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, outputPath);
}

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
    const { child, teardown } = spawnWatchedVitestProcess({
      pnpmArgs: spec.pnpmArgs,
      env: spec.env,
      label: spec.config,
      spawnParams: {
        cwd: process.cwd(),
        ...resolveVitestSpawnParams(spec.env),
      },
    });

    child.on("exit", (code, signal) => {
      teardown();
      cleanupVitestRunSpec(spec);
      resolve({ code: code ?? 1, signal });
    });

    child.on("error", (error) => {
      teardown();
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

async function runLoggedVitestSpec(spec) {
  console.error(`[test] starting ${spec.config}`);
  const startedAt = performance.now();
  const result = await runVitestSpec(spec);
  const durationMs = performance.now() - startedAt;
  if (result.signal) {
    console.error(`[test] ${spec.config} exited by signal ${result.signal}`);
    releaseLockOnce();
    process.kill(process.pid, result.signal);
    return null;
  }
  return {
    ...result,
    timing:
      !spec.watchMode && spec.includePatterns === null ? { config: spec.config, durationMs } : null,
  };
}

function resolveConfigSortWeight(config, shardTimings) {
  return shardTimings.get(config) ?? (FULL_SUITE_CONFIG_WEIGHT.get(config) ?? 0) * 1000;
}

function interleaveSlowAndFastSpecs(sortedSpecs) {
  const ordered = [];
  let slowIndex = 0;
  let fastIndex = sortedSpecs.length - 1;
  while (slowIndex <= fastIndex) {
    ordered.push(sortedSpecs[slowIndex]);
    slowIndex += 1;
    if (slowIndex <= fastIndex) {
      ordered.push(sortedSpecs[fastIndex]);
      fastIndex -= 1;
    }
  }
  return ordered;
}

function orderFullSuiteSpecsForParallelRun(specs, shardTimings = new Map()) {
  const sortedSpecs = specs.toSorted((a, b) => {
    const weightDelta =
      resolveConfigSortWeight(b.config, shardTimings) -
      resolveConfigSortWeight(a.config, shardTimings);
    if (weightDelta !== 0) {
      return weightDelta;
    }
    return a.config.localeCompare(b.config);
  });
  return shardTimings.size > 0 ? interleaveSlowAndFastSpecs(sortedSpecs) : sortedSpecs;
}

function isFullExtensionsProjectRun(specs) {
  const fullExtensionProjectConfigs = new Set(listFullExtensionVitestProjectConfigs());
  return (
    specs.length > 1 &&
    specs.every(
      (spec) =>
        spec.watchMode === false &&
        spec.includePatterns === null &&
        fullExtensionProjectConfigs.has(spec.config),
    )
  );
}

async function runVitestSpecsParallel(specs, concurrency) {
  let nextIndex = 0;
  let exitCode = 0;
  const timings = [];

  const runWorker = async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      const spec = specs[index];
      if (!spec) {
        return;
      }
      const result = await runLoggedVitestSpec(spec);
      if (!result) {
        return;
      }
      if (result.code !== 0) {
        exitCode = exitCode || result.code;
      }
      if (result.timing) {
        timings.push(result.timing);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
  return { exitCode, timings };
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

  if (runSpecs.length === 0) {
    console.error("[test] no changed test targets; skipping Vitest.");
    return;
  }

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
  const isParallelShardRun = isFullSuiteRun || isFullExtensionsProjectRun(runSpecs);
  if (isParallelShardRun) {
    const concurrency = resolveParallelFullSuiteConcurrency(runSpecs.length, process.env);
    if (concurrency > 1) {
      const localFullSuiteProfile = resolveLocalFullSuiteProfile(process.env);
      const shardTimings = readShardTimings(process.cwd(), process.env);
      const parallelSpecs = applyDefaultParallelVitestWorkerBudget(
        applyParallelVitestCachePaths(orderFullSuiteSpecsForParallelRun(runSpecs, shardTimings), {
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
      const { exitCode: parallelExitCode, timings } = await runVitestSpecsParallel(
        parallelSpecs,
        concurrency,
      );
      writeShardTimings(timings, process.cwd(), process.env);
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
  const timings = [];
  for (const spec of runSpecs) {
    const result = await runLoggedVitestSpec(spec);
    if (!result) {
      return;
    }
    if (result.code !== 0) {
      exitCode = exitCode || result.code;
      if (spec.continueOnFailure !== true) {
        releaseLockOnce();
        process.exit(result.code);
      }
    }
    if (result.timing) {
      timings.push(result.timing);
    }
  }
  writeShardTimings(timings, process.cwd(), process.env);

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
