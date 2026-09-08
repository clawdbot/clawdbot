// Resolves extension Vitest configs, costs, and batch shards for plugin test runs.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isAcpxExtensionRoot } from "../../test/vitest/vitest.extension-acpx-paths.mjs";
import { isActiveMemoryExtensionRoot } from "../../test/vitest/vitest.extension-active-memory-paths.mjs";
import { isBrowserExtensionRoot } from "../../test/vitest/vitest.extension-browser-paths.mjs";
import { resolveSplitChannelExtensionShard } from "../../test/vitest/vitest.extension-channel-split-paths.mjs";
import { isCodexExtensionRoot } from "../../test/vitest/vitest.extension-codex-paths.mjs";
import { isDiffsExtensionRoot } from "../../test/vitest/vitest.extension-diffs-paths.mjs";
import { isFeishuExtensionRoot } from "../../test/vitest/vitest.extension-feishu-paths.mjs";
import { isIrcExtensionRoot } from "../../test/vitest/vitest.extension-irc-paths.mjs";
import { isMatrixExtensionRoot } from "../../test/vitest/vitest.extension-matrix-paths.mjs";
import { isMattermostExtensionRoot } from "../../test/vitest/vitest.extension-mattermost-paths.mjs";
import { isMediaExtensionRoot } from "../../test/vitest/vitest.extension-media-paths.mjs";
import { isMemoryExtensionRoot } from "../../test/vitest/vitest.extension-memory-paths.mjs";
import { isMessagingExtensionRoot } from "../../test/vitest/vitest.extension-messaging-paths.mjs";
import { isMiscExtensionRoot } from "../../test/vitest/vitest.extension-misc-paths.mjs";
import { isMsTeamsExtensionRoot } from "../../test/vitest/vitest.extension-msteams-paths.mjs";
import {
  isProviderExtensionRoot,
  isProviderOpenAiExtensionRoot,
} from "../../test/vitest/vitest.extension-provider-paths.mjs";
import { isQaExtensionRoot } from "../../test/vitest/vitest.extension-qa-paths.mjs";
import { isTelegramExtensionRoot } from "../../test/vitest/vitest.extension-telegram-paths.mjs";
import { isVoiceCallExtensionRoot } from "../../test/vitest/vitest.extension-voice-call-paths.mjs";
import { isWhatsAppExtensionRoot } from "../../test/vitest/vitest.extension-whatsapp-paths.mjs";
import { isZaloExtensionRoot } from "../../test/vitest/vitest.extension-zalo-paths.mjs";
import { isPluginControlUiPath } from "../../test/vitest/vitest.ui-paths.mjs";
import { BUNDLED_PLUGIN_PATH_PREFIX, BUNDLED_PLUGIN_ROOT_DIR } from "./bundled-plugin-paths.mjs";
import { listAvailableExtensionIds } from "./changed-extensions.mts";
import { parsePositiveInt } from "./numeric-options.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const TRACKED_EXTENSION_TEST_PATHSPECS = [
  `:(glob)${BUNDLED_PLUGIN_ROOT_DIR}/**/*.test.ts`,
  `:(glob)${BUNDLED_PLUGIN_ROOT_DIR}/**/*.test.tsx`,
];
/** Default number of shards for broad bundled extension test batches. */
export const DEFAULT_EXTENSION_TEST_SHARD_COUNT = 8;
export type ExtensionTestPlanGroup = {
  config: string;
  estimatedCost: number;
  extensionIds: string[];
  roots: string[];
  testFileCount: number;
};

export type ExtensionBatchPlan = {
  extensionCount: number;
  extensionIds: string[];
  estimatedCost: number;
  hasTests: boolean;
  noTestExtensionIds?: string[];
  planGroups: ExtensionTestPlanGroup[];
  testFileCount: number;
};

type ExtensionTestShard = ExtensionBatchPlan & { checkName: string };

const EXTENSION_TEST_COST_MULTIPLIERS: Record<string, number> = {
  // Use the larger complete-family seconds/file from runs 33676780376/33747183683.
  // Round up to 0.01s and retain prior floors; both used two CPUs and two workers.
  // Runner setup and runtime preparation are charged separately.
  "test/vitest/vitest.extension-acpx.config.ts": 2.3,
  "test/vitest/vitest.extension-browser.config.ts": 0.71,
  "test/vitest/vitest.extension-codex.config.ts": 5.28,
  "test/vitest/vitest.extension-diffs.config.ts": 1.97,
  "test/vitest/vitest.extension-discord.config.ts": 0.76,
  "test/vitest/vitest.extension-feishu.config.ts": 0.72,
  "test/vitest/vitest.extension-imessage.config.ts": 1.7,
  "test/vitest/vitest.extension-irc.config.ts": 2.06,
  "test/vitest/vitest.extension-line.config.ts": 1.1,
  "test/vitest/vitest.extension-matrix.config.ts": 1.37,
  "test/vitest/vitest.extension-mattermost.config.ts": 1.48,
  "test/vitest/vitest.extension-media.config.ts": 1.38,
  "test/vitest/vitest.extension-memory.config.ts": 1.57,
  "test/vitest/vitest.extension-messaging.config.ts": 0.72,
  "test/vitest/vitest.extension-misc.config.ts": 1.16,
  "test/vitest/vitest.extension-msteams.config.ts": 0.62,
  "test/vitest/vitest.extension-provider-openai.config.ts": 1.48,
  "test/vitest/vitest.extension-providers.config.ts": 1.92,
  "test/vitest/vitest.extension-qa.config.ts": 1.3,
  "test/vitest/vitest.extension-signal.config.ts": 1.1,
  "test/vitest/vitest.extension-slack.config.ts": 0.96,
  "test/vitest/vitest.extension-telegram.config.ts": 8.98,
  "test/vitest/vitest.extension-voice-call.config.ts": 1.38,
  "test/vitest/vitest.extension-whatsapp.config.ts": 0.8,
  "test/vitest/vitest.extension-zalo.config.ts": 0.94,
  // This shared config is comparatively cheap per file, so raw file count
  // overstates its real wall-clock cost during CI shard planning.
  "test/vitest/vitest.extensions.config.ts": 1.1,
};
// A 34-file changed shard starved real-time watches and the no-output watchdog.
// Keep serial, non-isolated Codex processes small enough for prompt output (#125768, #125839).
const CODEX_EXTENSION_TEST_PROCESS_FILE_LIMIT = 12;
const MATRIX_EXTENSION_TEST_PROCESS_FILE_LIMIT = 40;
const TELEGRAM_EXTENSION_TEST_PROCESS_FILE_LIMIT = 1;
const TELEGRAM_EXTENSION_TEST_JOB_FILE_LIMIT = 10;
const EXTENSION_TEST_PROCESS_FILE_LIMITS = new Map<string, number>([
  [
    "test/vitest/vitest.extension-codex.config.ts",
    // This non-isolated fileParallelism:false lane accumulates every mocked module graph.
    // At ~166 files, one worker exhausted its heap during teardown (#124413).
    CODEX_EXTENSION_TEST_PROCESS_FILE_LIMIT,
  ],
  // The non-isolated Matrix suite intentionally shares module state within a process.
  // Bound its lifetime so Vite's transformed module graph cannot grow across the whole suite.
  ["test/vitest/vitest.extension-matrix.config.ts", MATRIX_EXTENSION_TEST_PROCESS_FILE_LIMIT],
  [
    "test/vitest/vitest.extension-telegram.config.ts",
    // isolate:true re-evaluates the Telegram graph per file. A second file in
    // the same process stayed silent past the 300s CI watchdog (observed 2026-08,
    // changed-extensions-config-14/15 on #123528).
    TELEGRAM_EXTENSION_TEST_PROCESS_FILE_LIMIT,
  ],
]);
const EXTENSION_TEST_JOB_FILE_LIMITS = new Map<string, number>([
  // The 468-file catch-all took 528–829s on two detected CPUs. Six jobs leave
  // room for checkout/setup without changing its non-isolated worker lifecycle.
  ["test/vitest/vitest.extensions.config.ts", 90],
  // Run 33449014227: QA took 203s and isolated providers 271s on two detected
  // CPUs. Reuse the job-only bound; Vitest keeps each config's file lifecycle.
  ["test/vitest/vitest.extension-qa.config.ts", 90],
  ["test/vitest/vitest.extension-providers.config.ts", 90],
  // Bound Telegram CI jobs so isolate recycling stays inside one job instead
  // of minting one runner per test file. Ten files keeps the worst job near
  // 3 minutes (observed 2026-08: ~45s runner setup + ~7-24s per file) while
  // halving the ~42-job fanout a Telegram-touching diff produced at five.
  ["test/vitest/vitest.extension-telegram.config.ts", TELEGRAM_EXTENSION_TEST_JOB_FILE_LIMIT],
]);
const EXTENSION_TEST_CONFIG_ROUTES: Array<[(root: string) => boolean, string]> = [
  [isActiveMemoryExtensionRoot, "test/vitest/vitest.extension-active-memory.config.ts"],
  [isAcpxExtensionRoot, "test/vitest/vitest.extension-acpx.config.ts"],
  [isBrowserExtensionRoot, "test/vitest/vitest.extension-browser.config.ts"],
  [isCodexExtensionRoot, "test/vitest/vitest.extension-codex.config.ts"],
  [isDiffsExtensionRoot, "test/vitest/vitest.extension-diffs.config.ts"],
  [isFeishuExtensionRoot, "test/vitest/vitest.extension-feishu.config.ts"],
  [isIrcExtensionRoot, "test/vitest/vitest.extension-irc.config.ts"],
  [isMattermostExtensionRoot, "test/vitest/vitest.extension-mattermost.config.ts"],
  [isMatrixExtensionRoot, "test/vitest/vitest.extension-matrix.config.ts"],
  [isMediaExtensionRoot, "test/vitest/vitest.extension-media.config.ts"],
  [isMemoryExtensionRoot, "test/vitest/vitest.extension-memory.config.ts"],
  [isMessagingExtensionRoot, "test/vitest/vitest.extension-messaging.config.ts"],
  [isMiscExtensionRoot, "test/vitest/vitest.extension-misc.config.ts"],
  [isMsTeamsExtensionRoot, "test/vitest/vitest.extension-msteams.config.ts"],
  [isQaExtensionRoot, "test/vitest/vitest.extension-qa.config.ts"],
  [isTelegramExtensionRoot, "test/vitest/vitest.extension-telegram.config.ts"],
  [isVoiceCallExtensionRoot, "test/vitest/vitest.extension-voice-call.config.ts"],
  [isWhatsAppExtensionRoot, "test/vitest/vitest.extension-whatsapp.config.ts"],
  [isZaloExtensionRoot, "test/vitest/vitest.extension-zalo.config.ts"],
  [isProviderOpenAiExtensionRoot, "test/vitest/vitest.extension-provider-openai.config.ts"],
  [isProviderExtensionRoot, "test/vitest/vitest.extension-providers.config.ts"],
];

function normalizeRelative(inputPath: string) {
  return inputPath.split(path.sep).join("/");
}

function isPathInsideRepo(relativePath: string) {
  return relativePath !== ".." && !relativePath.startsWith("../") && !path.isAbsolute(relativePath);
}

function isSkippedTrackedTestFile(relativePath: string) {
  return (
    isPluginControlUiPath(relativePath) ||
    relativePath.split("/").some((segment) => segment === "dist" || segment === "node_modules")
  );
}

let trackedRepoTestFiles: string[] | null | undefined;
// Large checkouts exceed Node's 1 MiB spawnSync default. Preserve the Git inventory path;
// ENOBUFS would otherwise trigger expensive extension-directory walks.
export const GIT_LS_FILES_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export function listTrackedTestPlanFiles(cwd: string, pathspecs: readonly string[]) {
  // Query only the planner-owned tree: a full-repo inventory can overflow
  // spawnSync's buffer and either truncate the plan or force directory walks.
  const result = spawnSync("git", ["ls-files", "-z", "--", ...pathspecs], {
    cwd,
    encoding: "utf8",
    maxBuffer: GIT_LS_FILES_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || result.error) {
    return null;
  }
  return result.stdout.split("\0").filter(Boolean);
}

function loadTrackedRepoTestFiles() {
  // Tracked repository metadata is immutable during one planner invocation.
  // Reuse one inventory so broad extension plans do not fork Git per plugin.
  if (trackedRepoTestFiles === undefined) {
    trackedRepoTestFiles =
      listTrackedTestPlanFiles(repoRoot, TRACKED_EXTENSION_TEST_PATHSPECS)?.filter(
        (line) =>
          !isSkippedTrackedTestFile(line) &&
          (line.endsWith(".test.ts") || line.endsWith(".test.tsx")),
      ) ?? null;
  }
  return trackedRepoTestFiles;
}

function listTrackedTestFiles(rootPath: string) {
  const relativeRoot = normalizeRelative(path.relative(repoRoot, rootPath));
  if (!isPathInsideRepo(relativeRoot)) {
    return null;
  }

  const trackedFiles = loadTrackedRepoTestFiles();
  if (trackedFiles === null) {
    return null;
  }

  if (!relativeRoot) {
    return trackedFiles;
  }
  const rootPrefix = `${relativeRoot}/`;
  return trackedFiles.filter((file) => file.startsWith(rootPrefix));
}

function listFilesystemTestFiles(rootPath: string) {
  const files = [];
  const stack = [rootPath];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !fs.existsSync(current)) {
      continue;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (isPluginControlUiPath(normalizeRelative(path.relative(repoRoot, fullPath)))) {
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && (fullPath.endsWith(".test.ts") || fullPath.endsWith(".test.tsx"))) {
        files.push(normalizeRelative(path.relative(repoRoot, fullPath)));
      }
    }
  }

  return files.toSorted((left, right) => left.localeCompare(right));
}

/** List working-tree test files for extension roots, including new untracked tests. */
export function listExtensionTestFilesForRoots(roots: string[]) {
  const files = roots.flatMap((root) => listFilesystemTestFiles(path.join(repoRoot, root)));
  return [...new Set(files)].toSorted((left, right) => left.localeCompare(right));
}

function uniqueSortedTargets(targets: string[]) {
  return [...new Set(targets)].toSorted((left, right) => left.localeCompare(right));
}

function splitTargetsByFileLimit(targets: string[], maxFilesPerChunk: number) {
  const orderedTargets = uniqueSortedTargets(targets);
  if (orderedTargets.length <= maxFilesPerChunk) {
    return [orderedTargets];
  }

  const chunkCount = Math.ceil(orderedTargets.length / maxFilesPerChunk);
  const baseSize = Math.floor(orderedTargets.length / chunkCount);
  const remainder = orderedTargets.length % chunkCount;
  const chunks = [];
  let offset = 0;
  for (let index = 0; index < chunkCount; index += 1) {
    const chunkSize = baseSize + (index < remainder ? 1 : 0);
    chunks.push(orderedTargets.slice(offset, offset + chunkSize));
    offset += chunkSize;
  }
  return chunks;
}

function resolveExtensionTestJobFileLimit(config: string) {
  return (
    EXTENSION_TEST_JOB_FILE_LIMITS.get(config) ?? EXTENSION_TEST_PROCESS_FILE_LIMITS.get(config)
  );
}

/** Split an extension config's test files across bounded process lifetimes when required. */
export function splitExtensionTestProcessTargets(config: string, targets: string[]) {
  const maxFilesPerProcess = EXTENSION_TEST_PROCESS_FILE_LIMITS.get(config);
  return maxFilesPerProcess
    ? splitTargetsByFileLimit(targets, maxFilesPerProcess)
    : [uniqueSortedTargets(targets)];
}

/** Split an extension config's test files into CI envelopes without changing process lifetime. */
export function splitExtensionTestJobTargets(config: string, targets: string[]) {
  const maxFilesPerJob = resolveExtensionTestJobFileLimit(config);
  return maxFilesPerJob
    ? splitTargetsByFileLimit(targets, maxFilesPerJob)
    : [uniqueSortedTargets(targets)];
}

/** Whether a Vitest invocation can safely be split into independent one-shot processes. */
export function shouldSplitExtensionTestProcesses(config: string, vitestArgs: string[] = []) {
  if (!EXTENSION_TEST_PROCESS_FILE_LIMITS.has(config)) {
    return false;
  }
  // Per-test retries and exact file exclusions preserve independent process scopes.
  // Other options may own suite-wide bail, watch, sharding, or report state.
  for (let index = 0; index < vitestArgs.length; index++) {
    const option = /^(--retry|--exclude)(?:=(.+))?$/u.exec(vitestArgs[index]!);
    if (!option) {
      return false;
    }
    const value = option[2] ?? vitestArgs[++index];
    if (!value || value.startsWith("-")) {
      return false;
    }
    if (option[1] === "--retry" ? !/^\d+$/u.test(value) : /[*!?[\]{}()]/u.test(value)) {
      return false;
    }
  }
  return true;
}

/** Resolve process targets for an extension config, expanding roots only when it is bounded. */
export function createExtensionTestProcessTargetChunks(
  config: string,
  roots: string[],
  vitestArgs: string[] = [],
) {
  if (!shouldSplitExtensionTestProcesses(config, vitestArgs)) {
    return [roots];
  }
  // Explicit file targets replace Vitest's root discovery, so inventory the working tree.
  // Otherwise a newly authored untracked test would silently disappear from a broad run.
  const testFiles = listExtensionTestFilesForRoots(roots);
  return testFiles.length > 0 ? splitExtensionTestProcessTargets(config, testFiles) : [roots];
}

function countTestFiles(rootPath: string) {
  const trackedFiles = listTrackedTestFiles(rootPath);
  if (trackedFiles) {
    return trackedFiles.length;
  }

  return listFilesystemTestFiles(rootPath).length;
}

export function estimateExtensionTestCost(config: string, testFileCount: number) {
  const multiplier = EXTENSION_TEST_COST_MULTIPLIERS[config] ?? 1;
  return Math.max(1, Math.ceil(testFileCount * multiplier));
}

/** Resolve the dedicated Vitest config for an extension root. */
export function resolveExtensionTestConfig(root: string) {
  const splitChannelShard = resolveSplitChannelExtensionShard(root);
  if (splitChannelShard) {
    return splitChannelShard.config;
  }
  return (
    EXTENSION_TEST_CONFIG_ROUTES.find(([matches]) => matches(root))?.[1] ??
    "test/vitest/vitest.extensions.config.ts"
  );
}

function resolveExtensionDirectory(targetArg: string | undefined, cwd = process.cwd()) {
  if (targetArg) {
    const asGiven = path.resolve(cwd, targetArg);
    if (fs.existsSync(path.join(asGiven, "package.json"))) {
      return asGiven;
    }

    const byName = path.join(repoRoot, BUNDLED_PLUGIN_ROOT_DIR, targetArg);
    if (fs.existsSync(path.join(byName, "package.json"))) {
      return byName;
    }

    throw new Error(
      `Unknown extension target "${targetArg}". Use a plugin name like "slack" or a path inside the bundled plugin workspace tree.`,
    );
  }

  let current = cwd;
  while (true) {
    if (
      normalizeRelative(path.relative(repoRoot, current)).startsWith(BUNDLED_PLUGIN_PATH_PREFIX) &&
      fs.existsSync(path.join(current, "package.json"))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  throw new Error(
    "No extension target provided, and current working directory is not inside the bundled plugin workspace tree.",
  );
}

/** Resolve the Vitest configs, files, and estimated cost for one extension target. */
export function resolveExtensionTestPlan(params: { cwd?: string; targetArg?: string } = {}) {
  const cwd = params.cwd ?? process.cwd();
  const targetArg = params.targetArg;
  const extensionDir = resolveExtensionDirectory(targetArg, cwd);
  const extensionId = path.basename(extensionDir);
  const relativeExtensionDir = normalizeRelative(path.relative(repoRoot, extensionDir));

  const roots = [relativeExtensionDir];

  const config = resolveExtensionTestConfig(relativeExtensionDir);
  const testFileCount = roots.reduce(
    (sum, root) => sum + countTestFiles(path.join(repoRoot, root)),
    0,
  );
  const estimatedCost = estimateExtensionTestCost(config, testFileCount);

  return {
    config,
    estimatedCost,
    extensionDir: relativeExtensionDir,
    extensionId,
    hasTests: testFileCount > 0,
    roots,
    testFileCount,
  };
}

type ResolvedExtensionTestPlan = ReturnType<typeof resolveExtensionTestPlan>;

export function mergeExtensionTestPlans(plans: ResolvedExtensionTestPlan[]): ExtensionBatchPlan {
  const groupsByConfig = new Map<string, ExtensionTestPlanGroup>();

  const testPlans = plans.filter((plan) => plan.hasTests);
  const noTestExtensionIds = plans
    .filter((plan) => !plan.hasTests)
    .map((plan) => plan.extensionId)
    .toSorted((left, right) => left.localeCompare(right));

  for (const plan of testPlans) {
    const current = groupsByConfig.get(plan.config) ?? {
      config: plan.config,
      extensionIds: [],
      roots: [],
      estimatedCost: 0,
      testFileCount: 0,
    };

    current.extensionIds.push(plan.extensionId);
    current.roots.push(...plan.roots);
    current.estimatedCost += plan.estimatedCost;
    current.testFileCount += plan.testFileCount;
    groupsByConfig.set(plan.config, current);
  }

  const planGroups = [...groupsByConfig.values()]
    .map((group) =>
      Object.assign({}, group, {
        extensionIds: group.extensionIds.toSorted((left, right) => left.localeCompare(right)),
        roots: [...new Set(group.roots)],
      }),
    )
    .toSorted((left, right) => left.config.localeCompare(right.config));

  return {
    extensionCount: plans.length,
    extensionIds: plans
      .map((plan) => plan.extensionId)
      .toSorted((left, right) => left.localeCompare(right)),
    estimatedCost: testPlans.reduce((sum, plan) => sum + plan.estimatedCost, 0),
    hasTests: testPlans.length > 0,
    noTestExtensionIds,
    planGroups,
    testFileCount: testPlans.reduce((sum, plan) => sum + plan.testFileCount, 0),
  };
}

/** Resolve a combined extension test plan for explicit or all available extension ids. */
export function resolveExtensionBatchPlan(params: { cwd?: string; extensionIds?: string[] } = {}) {
  const cwd = params.cwd ?? process.cwd();
  const hasExplicitExtensionIds = params.extensionIds !== undefined;
  const extensionIds = params.extensionIds ?? listAvailableExtensionIds();
  const plans = extensionIds.map((extensionId) =>
    resolveExtensionTestPlan({ cwd, targetArg: extensionId }),
  );

  return mergeExtensionTestPlans(
    hasExplicitExtensionIds ? plans : plans.filter((plan) => plan.hasTests),
  );
}

type PendingExtensionTestShard = {
  estimatedCost: number;
  plans: ResolvedExtensionTestPlan[];
  testFileCount: number;
};

function pickLeastLoadedShard(shards: PendingExtensionTestShard[]) {
  return shards.reduce((best, shard) => {
    if (shard.estimatedCost !== best.estimatedCost) {
      return shard.estimatedCost < best.estimatedCost ? shard : best;
    }
    if (shard.testFileCount !== best.testFileCount) {
      return shard.testFileCount < best.testFileCount ? shard : best;
    }
    return shard.plans.length < best.plans.length ? shard : best;
  });
}

/** Create balanced extension test shards from per-extension plans. */
export function createExtensionTestShards(
  params: { cwd?: string; extensionIds?: string[]; shardCount?: number | string } = {},
): ExtensionTestShard[] {
  const cwd = params.cwd ?? process.cwd();
  const extensionIds = params.extensionIds ?? listAvailableExtensionIds();
  const shardCount =
    params.shardCount === undefined ? 1 : parsePositiveInt(String(params.shardCount), "shardCount");
  const plans = extensionIds
    .map((extensionId) => resolveExtensionTestPlan({ cwd, targetArg: extensionId }))
    .filter((plan) => plan.hasTests)
    .toSorted((left, right) => {
      if (left.estimatedCost !== right.estimatedCost) {
        return right.estimatedCost - left.estimatedCost;
      }
      if (left.testFileCount !== right.testFileCount) {
        return right.testFileCount - left.testFileCount;
      }
      return left.extensionId.localeCompare(right.extensionId);
    });

  const effectiveShardCount = Math.min(shardCount, Math.max(1, plans.length));
  const shards: PendingExtensionTestShard[] = Array.from({ length: effectiveShardCount }, () => ({
    estimatedCost: 0,
    plans: [],
    testFileCount: 0,
  }));

  for (const plan of plans) {
    const target = pickLeastLoadedShard(shards);
    target.plans.push(plan);
    target.estimatedCost += plan.estimatedCost;
    target.testFileCount += plan.testFileCount;
  }

  return shards
    .map((shard, index) =>
      Object.assign(
        {},
        { index, checkName: `checks-node-extensions-shard-${index + 1}` },
        mergeExtensionTestPlans(shard.plans),
      ),
    )
    .filter((shard) => shard.hasTests);
}
