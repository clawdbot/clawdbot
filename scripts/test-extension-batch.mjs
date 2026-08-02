#!/usr/bin/env node

// Runs grouped Vitest plans for one or more bundled plugins.
import path from "node:path";
import pMap from "p-map";
import {
  createExtensionTestProcessTargetChunks,
  listExtensionTestFilesForRoots,
  resolveExtensionBatchPlan,
  shouldSplitExtensionTestProcesses,
  splitExtensionTestProcessTargets,
} from "./lib/extension-test-plan.mjs";
import {
  normalizeRelativePath,
  relativizeExtensionVitestArgs,
  relativizeExtensionVitestPath,
} from "./lib/extension-vitest-paths.mjs";
import { parsePositiveInt } from "./lib/numeric-options.mjs";
import { isDirectScriptRun, runVitestBatch } from "./lib/vitest-batch-runner.mjs";

const FS_MODULE_CACHE_PATH_ENV_KEY = "OPENCLAW_VITEST_FS_MODULE_CACHE_PATH";
const PARALLEL_ENV_KEY = "OPENCLAW_EXTENSION_BATCH_PARALLEL";
const ALLOW_NO_TESTS_FLAG = "--allow-no-tests";
const ALLOW_EMPTY_AFTER_EXCLUDE_FLAG = "--allow-empty-after-exclude";

function printUsage() {
  console.error(
    `Usage: pnpm test:extensions:batch <extension[,extension...]> [${ALLOW_NO_TESTS_FLAG}] [${ALLOW_EMPTY_AFTER_EXCLUDE_FLAG}] [vitest args...]`,
  );
  console.error(
    `       node scripts/test-extension-batch.mjs <extension[,extension...]> [${ALLOW_NO_TESTS_FLAG}] [${ALLOW_EMPTY_AFTER_EXCLUDE_FLAG}] [vitest args...]`,
  );
}

/**
 * Parses comma-separated plugin ids and separates Vitest passthrough args.
 */
export function parseExtensionIds(rawArgs) {
  const normalizedArgs = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  const separatorIndex = normalizedArgs.indexOf("--");
  const args = separatorIndex >= 0 ? normalizedArgs.slice(0, separatorIndex) : [...normalizedArgs];
  const separatorPassthroughArgs =
    separatorIndex >= 0 ? normalizedArgs.slice(separatorIndex + 1) : [];
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

  return {
    extensionIds,
    passthroughArgs: separatorIndex >= 0 ? [...args, ...separatorPassthroughArgs] : args,
  };
}

/**
 * Resolves bounded parallelism for extension test config groups.
 */
export function resolveExtensionBatchParallelism(groupCount, env = process.env) {
  const raw = env[PARALLEL_ENV_KEY]?.trim();
  const override = raw ? parsePositiveInt(raw, PARALLEL_ENV_KEY) : 1;
  return Math.min(Math.max(1, override), Math.max(1, groupCount));
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

function isExactExcludePath(inputPath) {
  return !/[*!?[\]{}]/u.test(inputPath);
}

function addExactExcludePath(excludePaths, value) {
  const normalized = normalizeRelativePath(value);
  excludePaths.add(normalized);
  if (!normalized.startsWith("extensions/")) {
    excludePaths.add(`extensions/${normalized}`);
  }
}

/**
 * Collects exact --exclude paths so empty groups can be reported accurately.
 */
export function parseExactVitestExcludePaths(vitestArgs) {
  const excludePaths = new Set();
  for (let index = 0; index < vitestArgs.length; index += 1) {
    const arg = vitestArgs[index];
    if (arg === "--exclude") {
      const value = vitestArgs[index + 1];
      if (value && isExactExcludePath(value)) {
        addExactExcludePath(excludePaths, value);
      }
      index += 1;
      continue;
    }
    const prefix = "--exclude=";
    if (arg.startsWith(prefix)) {
      const value = arg.slice(prefix.length);
      if (value && isExactExcludePath(value)) {
        addExactExcludePath(excludePaths, value);
      }
    }
  }
  return excludePaths;
}

function resolveGroupTargets(group, exactExcludePaths) {
  if (exactExcludePaths.size === 0) {
    return group.roots;
  }

  const testFiles = listExtensionTestFilesForRoots(group.roots);
  if (!testFiles) {
    return group.roots;
  }

  return testFiles.filter((file) => !exactExcludePaths.has(file));
}

async function runPlanGroup(group, params) {
  const targets = resolveGroupTargets(group, params.exactExcludePaths);
  if (targets.length === 0) {
    console.error(`[test-extension-batch] ${group.config}: no test files remain after excludes`);
    return params.allowEmptyAfterExclude ? 0 : 1;
  }

  const targetChunks =
    params.exactExcludePaths.size > 0
      ? shouldSplitExtensionTestProcesses(group.config, params.vitestArgs)
        ? splitExtensionTestProcessTargets(group.config, targets)
        : [targets]
      : createExtensionTestProcessTargetChunks(group.config, group.roots, params.vitestArgs);
  let finalExitCode = 0;
  for (const [index, chunk] of targetChunks.entries()) {
    console.log(
      `[test-extension-batch] ${group.config}: ${group.extensionIds.join(", ")} (${chunk.length} targets${targetChunks.length > 1 ? `, chunk ${index + 1}/${targetChunks.length}` : ""})`,
    );
    const exitCode = await params.runGroup({
      args: relativizeExtensionVitestArgs(params.vitestArgs),
      config: group.config,
      env: createGroupEnv({
        baseEnv: params.env,
        group,
        groupIndex: params.groupIndex,
        useDedicatedCache: params.useDedicatedCache,
      }),
      targets: chunk.map((target) => relativizeExtensionVitestPath(target)),
    });
    if (exitCode !== 0 && finalExitCode === 0) {
      finalExitCode = exitCode;
    }
  }
  return finalExitCode;
}

/**
 * Runs a resolved extension batch plan, optionally in parallel config groups.
 */
export async function runExtensionBatchPlan(batchPlan, params = {}) {
  const env = params.env ?? process.env;
  const vitestArgs = params.vitestArgs ?? [];
  const exactExcludePaths = parseExactVitestExcludePaths(vitestArgs);
  const runGroup = params.runGroup ?? runVitestBatch;
  const parallelism = resolveExtensionBatchParallelism(batchPlan.planGroups.length, env);
  const orderedGroups = orderPlanGroups(batchPlan.planGroups, parallelism);
  const useDedicatedCache = parallelism > 1;
  const allowEmptyAfterExclude = params.allowEmptyAfterExclude ?? false;

  if (parallelism > 1) {
    console.log(`[test-extension-batch] Running up to ${parallelism} config groups in parallel`);
  }

  let exitCode = 0;
  await pMap(
    orderedGroups,
    async (group, groupIndex) => {
      if (exitCode !== 0) {
        return;
      }
      const groupExitCode = await runPlanGroup(group, {
        env,
        groupIndex,
        runGroup,
        exactExcludePaths,
        allowEmptyAfterExclude,
        useDedicatedCache,
        vitestArgs,
      });
      if (groupExitCode !== 0 && exitCode === 0) {
        exitCode = groupExitCode;
      }
    },
    { concurrency: parallelism, stopOnError: true },
  );
  return exitCode;
}

async function run() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    printUsage();
    return;
  }

  const allowNoTests = rawArgs.includes(ALLOW_NO_TESTS_FLAG);
  const allowEmptyAfterExclude = rawArgs.includes(ALLOW_EMPTY_AFTER_EXCLUDE_FLAG);
  const controlArgs = new Set([ALLOW_NO_TESTS_FLAG, ALLOW_EMPTY_AFTER_EXCLUDE_FLAG]);
  const args = rawArgs.filter((arg) => !controlArgs.has(arg));
  const { extensionIds, passthroughArgs: vitestArgs } = parseExtensionIds(args);
  if (extensionIds.length === 0) {
    printUsage();
    process.exit(1);
  }

  const batchPlan = resolveExtensionBatchPlan({ cwd: process.cwd(), extensionIds });
  if (batchPlan.noTestExtensionIds.length > 0 && !allowNoTests) {
    console.error(
      `[test-extension-batch] No tests found for requested extension(s): ${batchPlan.noTestExtensionIds.join(", ")}`,
    );
    process.exit(1);
  }
  if (!batchPlan.hasTests) {
    console.error("[test-extension-batch] No tests found for the requested extensions.");
    if (!allowNoTests) {
      process.exit(1);
    }
    return;
  }

  console.log(
    `[test-extension-batch] Running ${batchPlan.testFileCount} test files across ${batchPlan.extensionCount} extensions`,
  );

  const exitCode = await runExtensionBatchPlan(batchPlan, {
    allowEmptyAfterExclude,
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
