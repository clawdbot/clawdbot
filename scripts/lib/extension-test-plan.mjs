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
import { BUNDLED_PLUGIN_PATH_PREFIX, BUNDLED_PLUGIN_ROOT_DIR } from "./bundled-plugin-paths.mjs";
import { listAvailableExtensionIds } from "./changed-extensions.mjs";
import { parsePositiveInt } from "./numeric-options.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const TRACKED_EXTENSION_TEST_PATHSPECS = [
  `:(glob)${BUNDLED_PLUGIN_ROOT_DIR}/**/*.test.ts`,
  `:(glob)${BUNDLED_PLUGIN_ROOT_DIR}/**/*.test.tsx`,
];
/** Default number of shards for broad bundled extension test batches. */
export const DEFAULT_EXTENSION_TEST_SHARD_COUNT = 8;
const EXTENSION_TEST_COST_MULTIPLIERS = {
  // CI shard planning uses measured wall time rather than raw file count.
  // These ratios come from Blacksmith extension batch timings; import-heavy
  // suites vary widely, and file count alone leaves long tail shards.
  "test/vitest/vitest.extension-acpx.config.ts": 0.75,
  "test/vitest/vitest.extension-browser.config.ts": 0.5,
  "test/vitest/vitest.extension-codex.config.ts": 1.3,
  "test/vitest/vitest.extension-diffs.config.ts": 0.6,
  "test/vitest/vitest.extension-discord.config.ts": 0.62,
  "test/vitest/vitest.extension-feishu.config.ts": 0.18,
  "test/vitest/vitest.extension-imessage.config.ts": 1.7,
  "test/vitest/vitest.extension-irc.config.ts": 1,
  "test/vitest/vitest.extension-line.config.ts": 1.1,
  "test/vitest/vitest.extension-matrix.config.ts": 0.28,
  "test/vitest/vitest.extension-mattermost.config.ts": 0.75,
  "test/vitest/vitest.extension-media.config.ts": 0.7,
  "test/vitest/vitest.extension-memory.config.ts": 1,
  "test/vitest/vitest.extension-messaging.config.ts": 0.4,
  "test/vitest/vitest.extension-misc.config.ts": 0.7,
  "test/vitest/vitest.extension-msteams.config.ts": 0.5,
  "test/vitest/vitest.extension-provider-openai.config.ts": 1.35,
  "test/vitest/vitest.extension-providers.config.ts": 0.5,
  "test/vitest/vitest.extension-qa.config.ts": 0.65,
  "test/vitest/vitest.extension-slack.config.ts": 0.45,
  "test/vitest/vitest.extension-telegram.config.ts": 0.72,
  "test/vitest/vitest.extension-voice-call.config.ts": 0.27,
  "test/vitest/vitest.extension-whatsapp.config.ts": 0.8,
  "test/vitest/vitest.extension-zalo.config.ts": 0.7,
  // This shared config is comparatively cheap per file, so raw file count
  // overstates its real wall-clock cost during CI shard planning.
  "test/vitest/vitest.extensions.config.ts": 1.1,
};
const EXTENSION_TEST_PROCESS_FILE_LIMITS = new Map([
  // The non-isolated Matrix suite intentionally shares module state within a process.
  // Bound its lifetime so Vite's transformed module graph cannot grow across the whole suite.
  ["test/vitest/vitest.extension-matrix.config.ts", 40],
]);
const EXTENSION_TEST_CONFIG_ROUTES = [
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

function normalizeRelative(inputPath) {
  return inputPath.split(path.sep).join("/");
}

function isPathInsideRepo(relativePath) {
  return relativePath !== ".." && !relativePath.startsWith("../") && !path.isAbsolute(relativePath);
}

function isSkippedTrackedTestFile(relativePath) {
  return relativePath
    .split("/")
    .some((segment) => segment === "dist" || segment === "node_modules");
}

let trackedRepoTestFiles;
// Large checkouts exceed Node's 1 MiB spawnSync default. Preserve the Git inventory path;
// ENOBUFS would otherwise trigger expensive extension-directory walks.
const GIT_LS_FILES_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

function loadTrackedRepoTestFiles() {
  if (trackedRepoTestFiles !== undefined) {
    return trackedRepoTestFiles;
  }

  // Query only the planner-owned tree: a full-repo inventory can overflow
  // spawnSync's buffer and either truncate the plan or force directory walks.
  const result = spawnSync("git", ["ls-files", "--", ...TRACKED_EXTENSION_TEST_PATHSPECS], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: GIT_LS_FILES_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || result.error) {
    trackedRepoTestFiles = null;
    return trackedRepoTestFiles;
  }

  // Tracked repository metadata is immutable during one planner invocation.
  // Reuse one inventory so broad extension plans do not fork Git per plugin.
  trackedRepoTestFiles = result.stdout
    .split("\n")
    .map((line) => line.trim().replaceAll("\\", "/"))
    .filter(
      (line) =>
        line.length > 0 &&
        !isSkippedTrackedTestFile(line) &&
        (line.endsWith(".test.ts") || line.endsWith(".test.tsx")),
    );
  return trackedRepoTestFiles;
}

function listTrackedTestFiles(rootPath) {
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

function listFilesystemTestFiles(rootPath) {
  const files = [];
  const stack = [rootPath];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !fs.existsSync(current)) {
      continue;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
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

/** List tracked or filesystem-discovered test files for extension roots. */
export function listTrackedTestFilesForRoots(roots) {
  const files = [];
  for (const root of roots) {
    const rootPath = path.join(repoRoot, root);
    const trackedFiles = listTrackedTestFiles(rootPath) ?? listFilesystemTestFiles(rootPath);
    files.push(...trackedFiles);
  }
  return [...new Set(files)].toSorted((left, right) => left.localeCompare(right));
}

/** List working-tree test files for extension roots, including new untracked tests. */
export function listExtensionTestFilesForRoots(roots) {
  const files = roots.flatMap((root) => listFilesystemTestFiles(path.join(repoRoot, root)));
  return [...new Set(files)].toSorted((left, right) => left.localeCompare(right));
}

/** Split an extension config's test files across bounded process lifetimes when required. */
export function splitExtensionTestProcessTargets(config, targets) {
  const maxFilesPerProcess = EXTENSION_TEST_PROCESS_FILE_LIMITS.get(config);
  const orderedTargets = [...new Set(targets)].toSorted((left, right) => left.localeCompare(right));
  if (!maxFilesPerProcess || orderedTargets.length <= maxFilesPerProcess) {
    return [orderedTargets];
  }

  const chunkCount = Math.ceil(orderedTargets.length / maxFilesPerProcess);
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

/** Whether a Vitest invocation can safely be split into independent one-shot processes. */
export function shouldSplitExtensionTestProcesses(config, vitestArgs = []) {
  // Passthrough options can carry suite-wide semantics such as bail thresholds,
  // filtering, watch state, or shared artifacts. Only plain one-shot runs are splittable.
  return EXTENSION_TEST_PROCESS_FILE_LIMITS.has(config) && vitestArgs.length === 0;
}

/** Resolve process targets for an extension config, expanding roots only when it is bounded. */
export function createExtensionTestProcessTargetChunks(config, roots, vitestArgs = []) {
  if (!shouldSplitExtensionTestProcesses(config, vitestArgs)) {
    return [roots];
  }
  // Explicit file targets replace Vitest's root discovery, so inventory the working tree.
  // Otherwise a newly authored untracked test would silently disappear from a broad run.
  const testFiles = listExtensionTestFilesForRoots(roots);
  return testFiles.length > 0 ? splitExtensionTestProcessTargets(config, testFiles) : [roots];
}

function countTestFiles(rootPath) {
  const trackedFiles = listTrackedTestFiles(rootPath);
  if (trackedFiles) {
    return trackedFiles.length;
  }

  return listFilesystemTestFiles(rootPath).length;
}

function estimatePlanCost(config, testFileCount) {
  const multiplier = EXTENSION_TEST_COST_MULTIPLIERS[config] ?? 1;
  return Math.max(1, Math.ceil(testFileCount * multiplier));
}

/** Resolve the dedicated Vitest config for an extension root. */
export function resolveExtensionTestConfig(root) {
  const splitChannelShard = resolveSplitChannelExtensionShard(root);
  if (splitChannelShard) {
    return splitChannelShard.config;
  }
  return (
    EXTENSION_TEST_CONFIG_ROUTES.find(([matches]) => matches(root))?.[1] ??
    "test/vitest/vitest.extensions.config.ts"
  );
}

function resolveExtensionDirectory(targetArg, cwd = process.cwd()) {
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
export function resolveExtensionTestPlan(params = {}) {
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
  const estimatedCost = estimatePlanCost(config, testFileCount);

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

function mergeTestPlans(plans) {
  const groupsByConfig = new Map();

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
export function resolveExtensionBatchPlan(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const hasExplicitExtensionIds = params.extensionIds !== undefined;
  const extensionIds = params.extensionIds ?? listAvailableExtensionIds();
  const plans = extensionIds.map((extensionId) =>
    resolveExtensionTestPlan({ cwd, targetArg: extensionId }),
  );

  return mergeTestPlans(hasExplicitExtensionIds ? plans : plans.filter((plan) => plan.hasTests));
}

function pickLeastLoadedShard(shards) {
  return shards.reduce((bestIndex, shard, index) => {
    if (bestIndex === -1) {
      return index;
    }
    const best = shards[bestIndex];
    if (shard.estimatedCost !== best.estimatedCost) {
      return shard.estimatedCost < best.estimatedCost ? index : bestIndex;
    }
    if (shard.testFileCount !== best.testFileCount) {
      return shard.testFileCount < best.testFileCount ? index : bestIndex;
    }
    if (shard.plans.length !== best.plans.length) {
      return shard.plans.length < best.plans.length ? index : bestIndex;
    }
    return index < bestIndex ? index : bestIndex;
  }, -1);
}

/** Create balanced extension test shards from per-extension plans. */
export function createExtensionTestShards(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const extensionIds = params.extensionIds ?? listAvailableExtensionIds();
  const shardCount =
    params.shardCount === undefined ? 1 : parsePositiveInt(params.shardCount, "shardCount");
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
  const shards = Array.from({ length: effectiveShardCount }, () => ({
    estimatedCost: 0,
    plans: [],
    testFileCount: 0,
  }));

  for (const plan of plans) {
    const targetIndex = pickLeastLoadedShard(shards);
    shards[targetIndex].plans.push(plan);
    shards[targetIndex].estimatedCost += plan.estimatedCost;
    shards[targetIndex].testFileCount += plan.testFileCount;
  }

  return shards
    .map((shard, index) =>
      Object.assign(
        {},
        { index, checkName: `checks-node-extensions-shard-${index + 1}` },
        mergeTestPlans(shard.plans),
      ),
    )
    .filter((shard) => shard.hasTests);
}
