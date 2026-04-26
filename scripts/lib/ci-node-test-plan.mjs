import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fullSuiteVitestShards } from "../../test/vitest/vitest.test-shards.mjs";

const EXCLUDED_FULL_SUITE_SHARDS = new Set([
  "test/vitest/vitest.full-core-contracts.config.ts",
  "test/vitest/vitest.full-core-bundled.config.ts",
  "test/vitest/vitest.full-extensions.config.ts",
]);

const EXCLUDED_PROJECT_CONFIGS = new Set(["test/vitest/vitest.channels.config.ts"]);
function listTestFiles(rootDir) {
  if (!existsSync(rootDir)) {
    return [];
  }

  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".test.ts")) {
        files.push(path.replaceAll("\\", "/"));
      }
    }
  };

  visit(rootDir);
  return files.toSorted((a, b) => a.localeCompare(b));
}

function createAutoReplyReplySplitShards() {
  const files = listTestFiles("src/auto-reply/reply");
  const groups = {
    "auto-reply-reply-agent-runner": [],
    "auto-reply-reply-commands": [],
    "auto-reply-reply-dispatch": [],
    "auto-reply-reply-state-routing": [],
  };

  for (const file of files) {
    const name = relative("src/auto-reply/reply", file).replaceAll("\\", "/");
    if (
      name.startsWith("agent-runner") ||
      name.startsWith("acp-") ||
      name === "abort.test.ts" ||
      name === "bash-command.stop.test.ts" ||
      name.startsWith("block-")
    ) {
      groups["auto-reply-reply-agent-runner"].push(file);
    } else if (name.startsWith("commands")) {
      groups["auto-reply-reply-commands"].push(file);
    } else if (
      name.startsWith("directive-") ||
      name.startsWith("dispatch") ||
      name.startsWith("followup-") ||
      name.startsWith("get-reply")
    ) {
      groups["auto-reply-reply-dispatch"].push(file);
    } else {
      groups["auto-reply-reply-state-routing"].push(file);
    }
  }

  const mergedGroups = {
    "auto-reply-reply-agent-runner": groups["auto-reply-reply-agent-runner"],
    "auto-reply-reply-dispatch": groups["auto-reply-reply-dispatch"],
    "auto-reply-reply-commands-state-routing": [
      ...groups["auto-reply-reply-commands"],
      ...groups["auto-reply-reply-state-routing"],
    ],
  };

  return Object.entries(mergedGroups)
    .map(([groupName, includePatterns]) => ({
      configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
      includePatterns,
      requiresDist: false,
      shardName: groupName,
    }))
    .filter((shard) => shard.includePatterns.length > 0);
}

const SPLIT_NODE_SHARDS = new Map([
  [
    "core-unit-fast",
    [
      {
        shardName: "core-unit-fast-support",
        configs: [
          "test/vitest/vitest.unit-fast.config.ts",
          "test/vitest/vitest.unit-support.config.ts",
        ],
        includeExternalConfigs: true,
        requiresDist: false,
      },
    ],
  ],
  [
    "core-unit-src",
    [
      {
        shardName: "core-unit-src-security",
        configs: [
          "test/vitest/vitest.unit-src.config.ts",
          "test/vitest/vitest.unit-security.config.ts",
        ],
        includeExternalConfigs: true,
        requiresDist: false,
      },
    ],
  ],
  ["core-unit-security", []],
  ["core-unit-support", []],
  [
    "core-runtime",
    [
      {
        shardName: "core-runtime-infra",
        configs: [
          "test/vitest/vitest.infra.config.ts",
          "test/vitest/vitest.hooks.config.ts",
          "test/vitest/vitest.secrets.config.ts",
          "test/vitest/vitest.logging.config.ts",
          "test/vitest/vitest.process.config.ts",
          "test/vitest/vitest.runtime-config.config.ts",
        ],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
      },
      {
        shardName: "core-runtime-media-ui",
        configs: [
          "test/vitest/vitest.media.config.ts",
          "test/vitest/vitest.media-understanding.config.ts",
          "test/vitest/vitest.tui.config.ts",
          "test/vitest/vitest.ui.config.ts",
          "test/vitest/vitest.wizard.config.ts",
        ],
        requiresDist: false,
      },
      {
        shardName: "core-runtime-shared",
        configs: [
          "test/vitest/vitest.acp.config.ts",
          "test/vitest/vitest.cron.config.ts",
          "test/vitest/vitest.shared-core.config.ts",
          "test/vitest/vitest.tasks.config.ts",
          "test/vitest/vitest.utils.config.ts",
        ],
        requiresDist: false,
      },
    ],
  ],
  [
    "auto-reply",
    [
      {
        shardName: "auto-reply-core-top-level",
        configs: [
          "test/vitest/vitest.auto-reply-core.config.ts",
          "test/vitest/vitest.auto-reply-top-level.config.ts",
        ],
        requiresDist: false,
      },
      ...createAutoReplyReplySplitShards(),
    ],
  ],
  [
    "agentic",
    [
      {
        shardName: "agentic-control-plane",
        configs: ["test/vitest/vitest.gateway-server.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
      },
      {
        shardName: "agentic-commands",
        configs: [
          "test/vitest/vitest.cli.config.ts",
          "test/vitest/vitest.commands-light.config.ts",
          "test/vitest/vitest.commands.config.ts",
          "test/vitest/vitest.daemon.config.ts",
        ],
        requiresDist: false,
      },
      {
        shardName: "agentic-agents",
        configs: ["test/vitest/vitest.agents.config.ts"],
        requiresDist: false,
      },
      {
        shardName: "agentic-plugin-sdk",
        configs: [
          "test/vitest/vitest.gateway-core.config.ts",
          "test/vitest/vitest.gateway-client.config.ts",
          "test/vitest/vitest.gateway-methods.config.ts",
          "test/vitest/vitest.plugin-sdk-light.config.ts",
          "test/vitest/vitest.plugin-sdk.config.ts",
        ],
        requiresDist: false,
      },
      {
        shardName: "agentic-plugins",
        configs: ["test/vitest/vitest.plugins.config.ts"],
        requiresDist: false,
      },
    ],
  ],
]);
const DIST_DEPENDENT_NODE_SHARD_NAMES = new Set(["core-support-boundary"]);

function formatNodeTestShardCheckName(shardName) {
  const normalizedShardName = shardName.startsWith("core-unit-")
    ? `core-${shardName.slice("core-unit-".length)}`
    : shardName;
  return `checks-node-${normalizedShardName}`;
}

export function createNodeTestShards() {
  return fullSuiteVitestShards.flatMap((shard) => {
    if (EXCLUDED_FULL_SUITE_SHARDS.has(shard.config)) {
      return [];
    }

    const configs = shard.projects.filter((config) => !EXCLUDED_PROJECT_CONFIGS.has(config));
    if (configs.length === 0) {
      return [];
    }

    const splitShards = SPLIT_NODE_SHARDS.get(shard.name);
    if (splitShards) {
      return splitShards.flatMap((splitShard) => {
        const splitConfigs = splitShard.includeExternalConfigs
          ? splitShard.configs
          : splitShard.configs.filter((config) => configs.includes(config));
        if (splitConfigs.length === 0) {
          return [];
        }

        return [
          {
            checkName: formatNodeTestShardCheckName(splitShard.shardName),
            shardName: splitShard.shardName,
            configs: splitConfigs,
            ...(splitShard.includePatterns ? { includePatterns: splitShard.includePatterns } : {}),
            ...(splitShard.runner ? { runner: splitShard.runner } : {}),
            requiresDist: splitShard.requiresDist,
          },
        ];
      });
    }

    return [
      {
        checkName: formatNodeTestShardCheckName(shard.name),
        shardName: shard.name,
        configs,
        requiresDist: DIST_DEPENDENT_NODE_SHARD_NAMES.has(shard.name),
      },
    ];
  });
}
