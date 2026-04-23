#!/usr/bin/env node

import path from "node:path";
import { resolveExtensionBatchPlan } from "./lib/extension-test-plan.mjs";
import { isDirectScriptRun, runVitestBatch } from "./lib/vitest-batch-runner.mjs";

const FS_MODULE_CACHE_PATH_ENV_KEY = "OPENCLAW_VITEST_FS_MODULE_CACHE_PATH";
const PARALLEL_ENV_KEY = "OPENCLAW_EXTENSION_BATCH_PARALLEL";

function printUsage() {
  console.error("Usage: pnpm test:extensions:batch <extension[,extension...]> [vitest args...]");
  console.error(
    "       node scripts/test-extension-batch.mjs <extension[,extension...]> [vitest args...]",
  );
}

function parseExtensionIds(rawArgs) {
  const args = [...rawArgs];
  const extensionIds = [];

  while (args[0] && !args[0].startsWith("-")) {
    extensionIds.push(
      ...args
        .shift()
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    );
  }

  return { extensionIds, passthroughArgs: args };
}

function parsePositiveInt(value) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function resolveExtensionBatchParallelism(groupCount, env = process.env) {
  const override = parsePositiveInt(env[PARALLEL_ENV_KEY]);
  return Math.min(Math.max(1, override ?? 1), Math.max(1, groupCount));
}

function sanitizeCacheSegment(value) {
  return (
    value
      .replace(/[^a-zA-Z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 180) || "default"
  );
}

function createGroupEnv({ baseEnv, group, groupIndex, useDedicatedCache }) {
  if (!useDedicatedCache || baseEnv[FS_MODULE_CACHE_PATH_ENV_KEY]?.trim()) {
    return baseEnv;
  }

  return {
    ...baseEnv,
    [FS_MODULE_CACHE_PATH_ENV_KEY]: path.join(
      process.cwd(),
      "node_modules",
      ".experimental-vitest-cache",
      "extension-batch",
      sanitizeCacheSegment(`${groupIndex}-${group.config}`),
    ),
  };
}

function orderPlanGroups(planGroups, parallelism) {
  if (parallelism <= 1) {
    return planGroups;
  }
  return [...planGroups].toSorted((left, right) => {
    if (left.estimatedCost !== right.estimatedCost) {
      return right.estimatedCost - left.estimatedCost;
    }
    if (left.testFileCount !== right.testFileCount) {
      return right.testFileCount - left.testFileCount;
    }
    return left.config.localeCompare(right.config);
  });
}

async function runPlanGroup(group, params) {
  console.log(
    `[test-extension-batch] ${group.config}: ${group.extensionIds.join(", ")} (${group.testFileCount} files)`,
  );
  return await params.runGroup({
    args: params.vitestArgs,
    config: group.config,
    env: createGroupEnv({
      baseEnv: params.env,
      group,
      groupIndex: params.groupIndex,
      useDedicatedCache: params.useDedicatedCache,
    }),
    targets: group.roots,
  });
}

export async function runExtensionBatchPlan(batchPlan, params = {}) {
  const env = params.env ?? process.env;
  const vitestArgs = params.vitestArgs ?? [];
  const runGroup = params.runGroup ?? runVitestBatch;
  const parallelism = resolveExtensionBatchParallelism(batchPlan.planGroups.length, env);
  const orderedGroups = orderPlanGroups(batchPlan.planGroups, parallelism);
  const useDedicatedCache = parallelism > 1;

  if (parallelism > 1) {
    console.log(`[test-extension-batch] Running up to ${parallelism} config groups in parallel`);
  }

  let nextGroupIndex = 0;
  let exitCode = 0;
  async function worker() {
    while (exitCode === 0) {
      const groupIndex = nextGroupIndex;
      nextGroupIndex += 1;
      const group = orderedGroups[groupIndex];
      if (!group) {
        return;
      }
      const groupExitCode = await runPlanGroup(group, {
        env,
        groupIndex,
        runGroup,
        useDedicatedCache,
        vitestArgs,
      });
      if (groupExitCode !== 0) {
        exitCode = groupExitCode;
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: parallelism }, () => worker()));
  return exitCode;
}

async function run() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    printUsage();
    return;
  }

  const passthroughArgs = rawArgs.filter((arg) => arg !== "--");
  const { extensionIds, passthroughArgs: vitestArgs } = parseExtensionIds(passthroughArgs);
  if (extensionIds.length === 0) {
    printUsage();
    process.exit(1);
  }

  const batchPlan = resolveExtensionBatchPlan({ cwd: process.cwd(), extensionIds });
  if (!batchPlan.hasTests) {
    console.log("[test-extension-batch] No tests found for the requested extensions. Skipping.");
    return;
  }

  console.log(
    `[test-extension-batch] Running ${batchPlan.testFileCount} test files across ${batchPlan.extensionCount} extensions`,
  );

  const exitCode = await runExtensionBatchPlan(batchPlan, {
    env: process.env,
    vitestArgs,
  });
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

if (isDirectScriptRun(import.meta.url)) {
  await run();
}
