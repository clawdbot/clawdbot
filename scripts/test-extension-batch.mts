#!/usr/bin/env node

// Runs grouped Vitest plans for one or more bundled plugins.
import path from "node:path";
import pMap from "p-map";
import { collectVitestExcludePatterns } from "../test/vitest/vitest.pattern-file.ts";
import {
  createExtensionTestProcessTargetChunks,
  listExtensionTestFilesForRoots,
  resolveExtensionBatchPlan,
  shouldSplitExtensionTestProcesses,
  splitExtensionTestProcessTargets,
} from "./lib/extension-test-plan.mts";
import type { ExtensionBatchPlan, ExtensionTestPlanGroup } from "./lib/extension-test-plan.mts";
import {
  normalizeRelativePath,
  relativizeExtensionVitestArgs,
  relativizeExtensionVitestPath,
} from "./lib/extension-vitest-paths.mts";
import { parsePositiveInt } from "./lib/numeric-options.mjs";
import { isDirectScriptRun, runVitestBatch } from "./lib/vitest-batch-runner.mts";
import type { VitestBatchRunParams } from "./lib/vitest-batch-runner.mts";
import { prepareVitestRuntime } from "./lib/vitest-build-prerequisites.mts";

const FS_MODULE_CACHE_PATH_ENV_KEY = "OPENCLAW_VITEST_FS_MODULE_CACHE_PATH";
const PARALLEL_ENV_KEY = "OPENCLAW_EXTENSION_BATCH_PARALLEL";
const ALLOW_NO_TESTS_FLAG = "--allow-no-tests";
const ALLOW_EMPTY_AFTER_EXCLUDE_FLAG = "--allow-empty-after-exclude";

function printUsage() {
  console.error(
    `Usage: pnpm test:extensions:batch <extension[,extension...]> [${ALLOW_NO_TESTS_FLAG}] [${ALLOW_EMPTY_AFTER_EXCLUDE_FLAG}] [vitest args...]`,
  );
  console.error(
    `       node --import tsx scripts/test-extension-batch.mts <extension[,extension...]> [${ALLOW_NO_TESTS_FLAG}] [${ALLOW_EMPTY_AFTER_EXCLUDE_FLAG}] [vitest args...]`,
  );
}

/**
 * Parses comma-separated plugin ids and separates Vitest passthrough args.
 */
export function parseExtensionIds(rawArgs: string[]) {
  const normalizedArgs = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  const separatorIndex = normalizedArgs.indexOf("--");
  const args = separatorIndex >= 0 ? normalizedArgs.slice(0, separatorIndex) : [...normalizedArgs];
  const separatorPassthroughArgs =
    separatorIndex >= 0 ? normalizedArgs.slice(separatorIndex + 1) : [];
  const extensionIds: string[] = [];

  while (args[0] && !args[0].startsWith("-")) {
    const extensionArg = args.shift();
    if (!extensionArg) {
      break;
    }
    extensionIds.push(
      ...extensionArg
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
export function resolveExtensionBatchParallelism(groupCount: number, env = process.env) {
  const raw = env[PARALLEL_ENV_KEY]?.trim();
  const override = raw ? parsePositiveInt(raw, PARALLEL_ENV_KEY) : 1;
  return Math.min(Math.max(1, override), Math.max(1, groupCount));
}

function sanitizeCacheSegment(value: string) {
  return (
    value
      .replace(/[^a-zA-Z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 180) || "default"
  );
}

function createGroupEnv({
  baseEnv,
  group,
  groupIndex,
  useDedicatedCache,
}: {
  baseEnv: NodeJS.ProcessEnv;
  group: ExtensionTestPlanGroup;
  groupIndex: number;
  useDedicatedCache: boolean;
}) {
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

function orderPlanGroups(planGroups: ExtensionTestPlanGroup[], parallelism: number) {
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

function isExactExcludePath(inputPath: string) {
  return !/[*!?[\]{}]/u.test(inputPath);
}

function addExactExcludePath(excludePaths: Set<string>, value: string) {
  const normalized = normalizeRelativePath(value);
  excludePaths.add(normalized);
  if (!normalized.startsWith("extensions/")) {
    excludePaths.add(`extensions/${normalized}`);
  }
}

/**
 * Collects exact --exclude paths so empty groups can be reported accurately.
 */
export function parseExactVitestExcludePaths(vitestArgs: string[]) {
  const excludePaths = new Set<string>();
  for (const value of collectVitestExcludePatterns(vitestArgs)) {
    if (isExactExcludePath(value)) {
      addExactExcludePath(excludePaths, value);
    }
  }
  return excludePaths;
}

function resolveGroupTargets(group: ExtensionTestPlanGroup, exactExcludePaths: Set<string>) {
  if (exactExcludePaths.size === 0) {
    return group.roots;
  }

  const testFiles = listExtensionTestFilesForRoots(group.roots);
  if (!testFiles) {
    return group.roots;
  }

  return testFiles.filter((file) => !exactExcludePaths.has(file));
}

function preparePlanGroup(
  group: ExtensionTestPlanGroup,
  groupIndex: number,
  env: NodeJS.ProcessEnv,
  vitestArgs: string[],
  exactExcludePaths: Set<string>,
  useDedicatedCache: boolean,
) {
  const targets = resolveGroupTargets(group, exactExcludePaths);
  const targetChunks =
    targets.length === 0
      ? []
      : exactExcludePaths.size > 0
        ? shouldSplitExtensionTestProcesses(group.config, vitestArgs)
          ? splitExtensionTestProcessTargets(group.config, targets)
          : [targets]
        : createExtensionTestProcessTargetChunks(group.config, group.roots, vitestArgs);
  return {
    group,
    invocations: targetChunks.map((chunk) => ({
      args: relativizeExtensionVitestArgs(vitestArgs),
      config: group.config,
      env: createGroupEnv({ baseEnv: env, group, groupIndex, useDedicatedCache }),
      targets: chunk.map((target) => relativizeExtensionVitestPath(target)),
    })),
  };
}

async function runPlanGroup(
  { group, invocations }: ReturnType<typeof preparePlanGroup>,
  runGroup: (params: VitestBatchRunParams) => Promise<number>,
  allowEmptyAfterExclude: boolean,
) {
  if (invocations.length === 0) {
    console.error(`[test-extension-batch] ${group.config}: no test files remain after excludes`);
    return allowEmptyAfterExclude ? 0 : 1;
  }
  let finalExitCode = 0;
  for (const [index, invocation] of invocations.entries()) {
    console.log(
      `[test-extension-batch] ${group.config}: ${group.extensionIds.join(", ")} (${invocation.targets.length} targets${invocations.length > 1 ? `, chunk ${index + 1}/${invocations.length}` : ""})`,
    );
    const exitCode = await runGroup(invocation);
    if (exitCode !== 0 && finalExitCode === 0) {
      finalExitCode = exitCode;
    }
  }
  return finalExitCode;
}

/**
 * Runs a resolved extension batch plan, optionally in parallel config groups.
 */
export async function runExtensionBatchPlan(
  batchPlan: ExtensionBatchPlan,
  params: {
    allowEmptyAfterExclude?: boolean;
    expandExactExcludes?: boolean;
    env?: NodeJS.ProcessEnv;
    runGroup?: (params: VitestBatchRunParams) => Promise<number>;
    vitestArgs?: string[];
  } = {},
) {
  const env = params.env ?? process.env;
  const vitestArgs = params.vitestArgs ?? [];
  // Single-plugin CLI historically leaves exact exclusions to Vitest.
  const exactExcludePaths =
    params.expandExactExcludes === false
      ? new Set<string>()
      : parseExactVitestExcludePaths(vitestArgs);
  const runGroup = params.runGroup ?? runVitestBatch;
  const parallelism = resolveExtensionBatchParallelism(batchPlan.planGroups.length, env);
  const orderedGroups = orderPlanGroups(batchPlan.planGroups, parallelism);
  const useDedicatedCache = parallelism > 1;
  const allowEmptyAfterExclude = params.allowEmptyAfterExclude ?? false;

  if (parallelism > 1) {
    console.log(`[test-extension-batch] Running up to ${parallelism} config groups in parallel`);
  }

  const preparedGroups = orderedGroups.map((group, index) =>
    preparePlanGroup(group, index, env, vitestArgs, exactExcludePaths, useDedicatedCache),
  );
  // No reader may start while a shared generation is being replaced. Select
  // from the exact emitted chunks, including existing exact-exclude expansion.
  const preparationCode = await prepareVitestRuntime(
    preparedGroups.flatMap(({ invocations }) =>
      invocations.map(({ config, args, targets }) => ({
        configs: [config],
        cli: { args: [...args, ...targets], dir: "extensions", env },
      })),
    ),
    env,
  );
  if (preparationCode !== 0) {
    return preparationCode;
  }
  let exitCode = 0;
  await pMap(
    preparedGroups,
    async (group) => {
      if (exitCode !== 0) {
        return;
      }
      const groupExitCode = await runPlanGroup(group, runGroup, allowEmptyAfterExclude);
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
  const noTestExtensionIds = batchPlan.noTestExtensionIds ?? [];
  if (noTestExtensionIds.length > 0 && !allowNoTests) {
    console.error(
      `[test-extension-batch] No tests found for requested extension(s): ${noTestExtensionIds.join(", ")}`,
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
