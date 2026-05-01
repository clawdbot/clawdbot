import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { commandsLightTestFiles } from "../../test/vitest/vitest.commands-light-paths.mjs";
import { fullSuiteVitestShards } from "../../test/vitest/vitest.test-shards.mjs";

const EXCLUDED_FULL_SUITE_SHARDS = new Set([
  "test/vitest/vitest.full-core-contracts.config.ts",
  "test/vitest/vitest.full-core-bundled.config.ts",
  "test/vitest/vitest.full-extensions.config.ts",
]);

const EXCLUDED_PROJECT_CONFIGS = new Set(["test/vitest/vitest.channels.config.ts"]);
const RELEASE_ONLY_PLUGIN_SHARDS = new Set(["agentic-plugins"]);
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
    "auto-reply-reply-session": [],
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
    } else if (name.startsWith("session")) {
      groups["auto-reply-reply-session"].push(file);
    } else {
      groups["auto-reply-reply-state-routing"].push(file);
    }
  }

  return Object.entries(groups)
    .map(([groupName, includePatterns]) => ({
      configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
      includePatterns,
      requiresDist: false,
      shardName: groupName,
    }))
    .filter((shard) => shard.includePatterns.length > 0);
}

function resolveCommandShardName(file) {
  const name = relative("src/commands", file).replaceAll("\\", "/");
  if (name.startsWith("agent") || name.startsWith("channel") || name === "message.test.ts") {
    return "agentic-commands-agent-channel";
  }
  if (name.startsWith("doctor")) {
    if (name.startsWith("doctor/shared/") || name.startsWith("doctor/")) {
      return "agentic-commands-doctor-shared";
    }
    return "agentic-commands-doctor";
  }
  if (
    name.startsWith("auth-choice") ||
    name.startsWith("configure") ||
    name.startsWith("onboard") ||
    name === "setup.test.ts"
  ) {
    return "agentic-commands-onboard-config";
  }
  if (
    name.startsWith("models/") ||
    name === "model-picker.test.ts" ||
    name === "openai-model-default.test.ts"
  ) {
    return "agentic-commands-models";
  }
  return "agentic-commands-status-tools";
}

function createAgenticCommandSplitShards() {
  const commandsLightTests = new Set(commandsLightTestFiles);
  const groups = new Map();
  for (const file of listTestFiles("src/commands")) {
    if (commandsLightTests.has(file)) {
      continue;
    }
    const shardName = resolveCommandShardName(file);
    groups.set(shardName, [...(groups.get(shardName) ?? []), file]);
  }

  return [
    "agentic-commands-agent-channel",
    "agentic-commands-doctor",
    "agentic-commands-doctor-shared",
    "agentic-commands-models",
    "agentic-commands-onboard-config",
    "agentic-commands-status-tools",
  ]
    .map((shardName) => ({
      configs: ["test/vitest/vitest.commands.config.ts"],
      includePatterns: groups.get(shardName) ?? [],
      requiresDist: false,
      shardName,
    }))
    .filter((shard) => shard.includePatterns.length > 0);
}

const GATEWAY_SERVER_BACKED_HTTP_TESTS = new Set([
  "src/gateway/embeddings-http.test.ts",
  "src/gateway/models-http.test.ts",
  "src/gateway/openai-http.test.ts",
  "src/gateway/openresponses-http.test.ts",
  "src/gateway/probe.auth.integration.test.ts",
]);

const GATEWAY_SERVER_EXCLUDED_TESTS = new Set([
  "src/gateway/gateway.test.ts",
  "src/gateway/server.startup-matrix-migration.integration.test.ts",
  "src/gateway/sessions-history-http.test.ts",
]);

function isGatewayServerTestFile(file) {
  return (
    file.startsWith("src/gateway/") &&
    !file.startsWith("src/gateway/server-methods/") &&
    !GATEWAY_SERVER_EXCLUDED_TESTS.has(file) &&
    (file.includes("server") || GATEWAY_SERVER_BACKED_HTTP_TESTS.has(file))
  );
}

function resolveGatewayServerShardName(file) {
  const name = relative("src/gateway", file).replaceAll("\\", "/");
  if (
    GATEWAY_SERVER_BACKED_HTTP_TESTS.has(file) ||
    name.startsWith("server.models") ||
    name.startsWith("server.talk")
  ) {
    return "agentic-control-plane-http-models";
  }
  if (
    name.startsWith("server.agent") ||
    name.startsWith("server.chat") ||
    name.startsWith("server.sessions")
  ) {
    return "agentic-control-plane-agent-chat";
  }
  if (
    name.includes("auth") ||
    name.includes("device") ||
    name.includes("node") ||
    name.includes("roles") ||
    name.includes("silent") ||
    name.includes("preauth") ||
    name.includes("control-plane-rate-limit")
  ) {
    return "agentic-control-plane-auth-node";
  }
  return "agentic-control-plane-runtime";
}

function createGatewayServerSplitShards() {
  const groups = new Map();
  for (const file of listTestFiles("src/gateway").filter(isGatewayServerTestFile)) {
    const shardName = resolveGatewayServerShardName(file);
    groups.set(shardName, [...(groups.get(shardName) ?? []), file]);
  }
  return [
    "agentic-control-plane-agent-chat",
    "agentic-control-plane-auth-node",
    "agentic-control-plane-http-models",
    "agentic-control-plane-runtime",
  ]
    .map((shardName) => ({
      configs: ["test/vitest/vitest.gateway-server.config.ts"],
      includePatterns: groups.get(shardName) ?? [],
      requiresDist: false,
      runner: "blacksmith-4vcpu-ubuntu-2404",
      shardName,
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
      ...createGatewayServerSplitShards(),
      {
        shardName: "agentic-cli",
        configs: ["test/vitest/vitest.cli.config.ts"],
        requiresDist: false,
      },
      {
        shardName: "agentic-command-support",
        configs: [
          "test/vitest/vitest.commands-light.config.ts",
          "test/vitest/vitest.daemon.config.ts",
        ],
        requiresDist: false,
      },
      ...createAgenticCommandSplitShards(),
      {
        shardName: "agentic-agents",
        configs: [
          "test/vitest/vitest.agents-core.config.ts",
          "test/vitest/vitest.agents-pi-embedded.config.ts",
          "test/vitest/vitest.agents-support.config.ts",
          "test/vitest/vitest.agents-tools.config.ts",
        ],
        requiresDist: false,
      },
      {
        shardName: "agentic-gateway-core",
        configs: [
          "test/vitest/vitest.gateway-core.config.ts",
          "test/vitest/vitest.gateway-client.config.ts",
        ],
        requiresDist: false,
      },
      {
        shardName: "agentic-gateway-methods",
        configs: ["test/vitest/vitest.gateway-methods.config.ts"],
        requiresDist: false,
      },
      {
        shardName: "agentic-plugin-sdk",
        configs: [
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

export function createNodeTestShards(options = {}) {
  const includeReleaseOnlyPluginShards = options.includeReleaseOnlyPluginShards ?? true;

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
        if (
          RELEASE_ONLY_PLUGIN_SHARDS.has(splitShard.shardName) &&
          !includeReleaseOnlyPluginShards
        ) {
          return [];
        }

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
