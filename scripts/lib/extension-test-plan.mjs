import fs from "node:fs";
import path from "node:path";
import { channelTestRoots } from "../../test/vitest/vitest.channel-paths.mjs";
import { isAcpxExtensionRoot } from "../../test/vitest/vitest.extension-acpx-paths.mjs";
import { isBlueBubblesExtensionRoot } from "../../test/vitest/vitest.extension-bluebubbles-paths.mjs";
import { isDiffsExtensionRoot } from "../../test/vitest/vitest.extension-diffs-paths.mjs";
import { isFeishuExtensionRoot } from "../../test/vitest/vitest.extension-feishu-paths.mjs";
import { isIrcExtensionRoot } from "../../test/vitest/vitest.extension-irc-paths.mjs";
import { isMatrixExtensionRoot } from "../../test/vitest/vitest.extension-matrix-paths.mjs";
import { isMattermostExtensionRoot } from "../../test/vitest/vitest.extension-mattermost-paths.mjs";
import { isMemoryExtensionRoot } from "../../test/vitest/vitest.extension-memory-paths.mjs";
import { isMessagingExtensionRoot } from "../../test/vitest/vitest.extension-messaging-paths.mjs";
import { isMsTeamsExtensionRoot } from "../../test/vitest/vitest.extension-msteams-paths.mjs";
import { isProviderExtensionRoot } from "../../test/vitest/vitest.extension-provider-paths.mjs";
import { isTelegramExtensionRoot } from "../../test/vitest/vitest.extension-telegram-paths.mjs";
import { isVoiceCallExtensionRoot } from "../../test/vitest/vitest.extension-voice-call-paths.mjs";
import { isWhatsAppExtensionRoot } from "../../test/vitest/vitest.extension-whatsapp-paths.mjs";
import { isZaloExtensionRoot } from "../../test/vitest/vitest.extension-zalo-paths.mjs";
import { BUNDLED_PLUGIN_PATH_PREFIX, BUNDLED_PLUGIN_ROOT_DIR } from "./bundled-plugin-paths.mjs";
import { listAvailableExtensionIds } from "./changed-extensions.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
export const DEFAULT_EXTENSION_TEST_SHARD_COUNT = 6;
const EXTENSION_TEST_COST_MULTIPLIERS = {
  "test/vitest/vitest.extension-feishu.config.ts": 1.6,
  "test/vitest/vitest.extension-msteams.config.ts": 1.6,
  // This shared config is comparatively cheap per file, so raw file count
  // overstates its real wall-clock cost during CI shard planning.
  "test/vitest/vitest.extensions.config.ts": 0.45,
};

function normalizeRelative(inputPath) {
  return inputPath.split(path.sep).join("/");
}

function countTestFiles(rootPath) {
  let total = 0;
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
        total += 1;
      }
    }
  }

  return total;
}

function estimatePlanCost(config, testFileCount) {
  const multiplier = EXTENSION_TEST_COST_MULTIPLIERS[config] ?? 1;
  return Math.max(1, Math.ceil(testFileCount * multiplier));
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

export function resolveExtensionTestPlan(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const targetArg = params.targetArg;
  const extensionDir = resolveExtensionDirectory(targetArg, cwd);
  const extensionId = path.basename(extensionDir);
  const relativeExtensionDir = normalizeRelative(path.relative(repoRoot, extensionDir));

  const roots = [relativeExtensionDir];

  const usesChannelConfig = roots.some((root) => channelTestRoots.includes(root));
  const usesAcpxConfig = roots.some((root) => isAcpxExtensionRoot(root));
  const usesDiffsConfig = roots.some((root) => isDiffsExtensionRoot(root));
  const usesBlueBubblesConfig = roots.some((root) => isBlueBubblesExtensionRoot(root));
  const usesFeishuConfig = roots.some((root) => isFeishuExtensionRoot(root));
  const usesIrcConfig = roots.some((root) => isIrcExtensionRoot(root));
  const usesMattermostConfig = roots.some((root) => isMattermostExtensionRoot(root));
  const usesTelegramConfig = roots.some((root) => isTelegramExtensionRoot(root));
  const usesVoiceCallConfig = roots.some((root) => isVoiceCallExtensionRoot(root));
  const usesWhatsAppConfig = roots.some((root) => isWhatsAppExtensionRoot(root));
  const usesZaloConfig = roots.some((root) => isZaloExtensionRoot(root));
  const usesMatrixConfig = roots.some((root) => isMatrixExtensionRoot(root));
  const usesMemoryConfig = roots.some((root) => isMemoryExtensionRoot(root));
  const usesMsTeamsConfig = roots.some((root) => isMsTeamsExtensionRoot(root));
  const usesMessagingConfig = roots.some((root) => isMessagingExtensionRoot(root));
  const usesProviderConfig = roots.some((root) => isProviderExtensionRoot(root));
  const config = usesChannelConfig
    ? "test/vitest/vitest.extension-channels.config.ts"
    : usesAcpxConfig
      ? "test/vitest/vitest.extension-acpx.config.ts"
      : usesDiffsConfig
        ? "test/vitest/vitest.extension-diffs.config.ts"
        : usesBlueBubblesConfig
          ? "test/vitest/vitest.extension-bluebubbles.config.ts"
          : usesFeishuConfig
            ? "test/vitest/vitest.extension-feishu.config.ts"
            : usesIrcConfig
              ? "test/vitest/vitest.extension-irc.config.ts"
              : usesMattermostConfig
                ? "test/vitest/vitest.extension-mattermost.config.ts"
                : usesMatrixConfig
                  ? "test/vitest/vitest.extension-matrix.config.ts"
                  : usesTelegramConfig
                    ? "test/vitest/vitest.extension-telegram.config.ts"
                    : usesVoiceCallConfig
                      ? "test/vitest/vitest.extension-voice-call.config.ts"
                      : usesWhatsAppConfig
                        ? "test/vitest/vitest.extension-whatsapp.config.ts"
                        : usesZaloConfig
                          ? "test/vitest/vitest.extension-zalo.config.ts"
                          : usesMemoryConfig
                            ? "test/vitest/vitest.extension-memory.config.ts"
                            : usesMsTeamsConfig
                              ? "test/vitest/vitest.extension-msteams.config.ts"
                              : usesMessagingConfig
                                ? "test/vitest/vitest.extension-messaging.config.ts"
                                : usesProviderConfig
                                  ? "test/vitest/vitest.extension-providers.config.ts"
                                  : "test/vitest/vitest.extensions.config.ts";
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

  for (const plan of plans) {
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
    .map((group) => ({
      ...group,
      extensionIds: group.extensionIds.toSorted((left, right) => left.localeCompare(right)),
      roots: [...new Set(group.roots)],
    }))
    .toSorted((left, right) => left.config.localeCompare(right.config));

  return {
    extensionCount: plans.length,
    extensionIds: plans
      .map((plan) => plan.extensionId)
      .toSorted((left, right) => left.localeCompare(right)),
    estimatedCost: plans.reduce((sum, plan) => sum + plan.estimatedCost, 0),
    hasTests: plans.length > 0,
    planGroups,
    testFileCount: plans.reduce((sum, plan) => sum + plan.testFileCount, 0),
  };
}

export function resolveExtensionBatchPlan(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const extensionIds = params.extensionIds ?? listAvailableExtensionIds();
  const plans = extensionIds
    .map((extensionId) => resolveExtensionTestPlan({ cwd, targetArg: extensionId }))
    .filter((plan) => plan.hasTests);

  return mergeTestPlans(plans);
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

export function createExtensionTestShards(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const extensionIds = params.extensionIds ?? listAvailableExtensionIds();
  const shardCount = Math.max(1, Number.parseInt(String(params.shardCount ?? ""), 10) || 1);
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
    .map((shard, index) => ({
      index,
      checkName: `checks-node-extensions-shard-${index + 1}`,
      ...mergeTestPlans(shard.plans),
    }))
    .filter((shard) => shard.hasTests);
}
