// Builds CI node/Vitest shard plans from the full suite configuration.
import { relative } from "node:path";
import { commandsLightTestFiles } from "../../test/vitest/vitest.commands-light-paths.mjs";
import { fullSuiteVitestShards } from "../../test/vitest/vitest.test-shards.mjs";
import { listTrackedTestFiles } from "./list-test-files.mjs";

const EXCLUDED_FULL_SUITE_SHARDS = new Set([
  "test/vitest/vitest.full-core-contracts.config.ts",
  "test/vitest/vitest.full-core-bundled.config.ts",
  "test/vitest/vitest.full-extensions.config.ts",
]);

const EXCLUDED_PROJECT_CONFIGS = new Set(["test/vitest/vitest.channels.config.ts"]);
const DEFAULT_NODE_TEST_RUNNER = "blacksmith-8vcpu-ubuntu-2404";
const RELEASE_ONLY_PLUGIN_SHARDS = new Set(["agentic-plugins"]);
function listTestFiles(rootDir) {
  return listTrackedTestFiles(rootDir);
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
  if (name.startsWith("oauth-tls-preflight.doctor")) {
    return "agentic-commands-doctor-auth";
  }
  if (name.startsWith("doctor")) {
    if (name.startsWith("doctor/shared/") || name.startsWith("doctor/")) {
      return "agentic-commands-doctor-shared";
    }
    if (name.startsWith("doctor-auth")) {
      return "agentic-commands-doctor-auth";
    }
    if (
      name.startsWith("doctor-config") ||
      name.startsWith("doctor-legacy-config") ||
      name.startsWith("doctor-state")
    ) {
      return "agentic-commands-doctor-config-state";
    }
    if (
      name.startsWith("doctor-cron") ||
      name.startsWith("doctor-heartbeat") ||
      name.startsWith("doctor-session")
    ) {
      return "agentic-commands-doctor-sessions-cron";
    }
    if (name.startsWith("doctor-gateway")) {
      return "agentic-commands-doctor-gateway";
    }
    if (name.startsWith("doctor-device")) {
      return "agentic-commands-doctor-device";
    }
    if (name.startsWith("doctor-platform")) {
      return "agentic-commands-doctor-platform";
    }
    if (name.startsWith("doctor-whatsapp")) {
      return "agentic-commands-doctor-whatsapp";
    }
    if (name.startsWith("doctor-workspace")) {
      return "agentic-commands-doctor-workspace";
    }
    if (
      name.startsWith("doctor-browser") ||
      name.startsWith("doctor-plugin") ||
      name.startsWith("doctor-skill") ||
      name.startsWith("doctor-memory") ||
      name.startsWith("doctor-claude")
    ) {
      return "agentic-commands-doctor-plugins-tools";
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
    if (commandsLightTests.has(file) || file.endsWith(".e2e.test.ts")) {
      continue;
    }
    const shardName = resolveCommandShardName(file);
    groups.set(shardName, [...(groups.get(shardName) ?? []), file]);
  }

  return [
    "agentic-commands-agent-channel",
    "agentic-commands-doctor",
    "agentic-commands-doctor-auth",
    "agentic-commands-doctor-config-state",
    "agentic-commands-doctor-device",
    "agentic-commands-doctor-gateway",
    "agentic-commands-doctor-platform",
    "agentic-commands-doctor-plugins-tools",
    "agentic-commands-doctor-sessions-cron",
    "agentic-commands-doctor-shared",
    "agentic-commands-doctor-whatsapp",
    "agentic-commands-doctor-workspace",
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

function resolveAgentCoreShardName(file) {
  const name = relative("src/agents", file).replaceAll("\\", "/");
  if (
    name.startsWith("auth") ||
    name.includes("auth") ||
    name.includes("oauth") ||
    name.includes("credential") ||
    name.includes("api-key") ||
    name.includes("token")
  ) {
    return "agentic-agents-core-auth";
  }
  if (
    name.startsWith("model") ||
    name.includes("provider") ||
    name.includes("openai") ||
    name.includes("anthropic") ||
    name.includes("gemini") ||
    name.includes("moonshot") ||
    name.includes("minimax") ||
    name.includes("xai") ||
    name.includes("zai") ||
    name.includes("chutes") ||
    name.includes("catalog")
  ) {
    return "agentic-agents-core-models";
  }
  if (
    name.startsWith("agent-tools") ||
    name.startsWith("openclaw-tools") ||
    name.startsWith("bash-tools") ||
    name.startsWith("tool") ||
    name.startsWith("apply-patch") ||
    name.startsWith("exec") ||
    name.startsWith("sandbox")
  ) {
    return "agentic-agents-core-tools";
  }
  if (
    name.startsWith("subagent") ||
    name.startsWith("spawn") ||
    name.startsWith("embedded-agent-subscribe")
  ) {
    return "agentic-agents-core-subagents";
  }
  if (
    name.startsWith("embedded-agent-runner") ||
    name.startsWith("cli-runner") ||
    name.startsWith("agent-command") ||
    name.startsWith("command") ||
    name.includes("compaction") ||
    name.includes("session")
  ) {
    return "agentic-agents-core-runner";
  }
  return "agentic-agents-core-runtime";
}

function createAgentCoreSplitShards() {
  const groups = new Map();
  for (const file of listTestFiles("src/agents")) {
    const name = relative("src/agents", file).replaceAll("\\", "/");
    if (name.includes("/")) {
      continue;
    }
    const shardName = resolveAgentCoreShardName(file);
    groups.set(shardName, [...(groups.get(shardName) ?? []), file]);
  }

  return [
    "agentic-agents-core-auth",
    "agentic-agents-core-models",
    "agentic-agents-core-tools",
    "agentic-agents-core-subagents",
    "agentic-agents-core-runner",
    "agentic-agents-core-runtime",
  ]
    .map((shardName) => ({
      configs: ["test/vitest/vitest.agents-core.config.ts"],
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

function resolveGatewayStartupShardName(file) {
  const name = relative("src/gateway", file).replaceAll("\\", "/");
  if (name.startsWith("server-startup-config") || name.startsWith("server-startup-early")) {
    return "agentic-control-plane-startup-config";
  }
  if (
    name.startsWith("server-runtime") ||
    name.startsWith("server.health") ||
    name.startsWith("server.lazy") ||
    name.startsWith("server/health-state") ||
    name.startsWith("server/readiness")
  ) {
    return "agentic-control-plane-startup-health-runtime";
  }
  if (name.startsWith("server-restart") || name === "server-close.test.ts") {
    return "agentic-control-plane-startup-restart-close";
  }
  return "agentic-control-plane-startup-core";
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
  if (
    name.startsWith("server-startup") ||
    name.startsWith("server-restart") ||
    name.startsWith("server-runtime") ||
    name.startsWith("server.lazy") ||
    name.startsWith("server.health") ||
    name.startsWith("server/health-state") ||
    name.startsWith("server/readiness") ||
    name === "server-close.test.ts"
  ) {
    return resolveGatewayStartupShardName(file);
  }
  if (name.includes("cron")) {
    return "agentic-control-plane-runtime-cron";
  }
  if (name.includes("network")) {
    return "agentic-control-plane-runtime-network";
  }
  if (
    name.includes("plugin") ||
    name.includes("hooks") ||
    name.includes("http") ||
    name.includes("ws-connection")
  ) {
    return "agentic-control-plane-http-plugin-ws";
  }
  if (name.startsWith("server-")) {
    return "agentic-control-plane-runtime-server";
  }
  if (name.startsWith("server.config-patch")) {
    return "agentic-control-plane-runtime-config";
  }
  if (name.startsWith("server.shared-token")) {
    return "agentic-control-plane-runtime-shared-token";
  }
  if (
    name.startsWith("server.control-ui-root") ||
    name.startsWith("server.ios-client-id") ||
    name.startsWith("server.minimal-channel-pin") ||
    name.startsWith("server.tools-catalog")
  ) {
    return "agentic-control-plane-runtime-ui-tools";
  }
  if (name.startsWith("server/")) {
    return "agentic-control-plane-runtime-events";
  }
  if (name.startsWith("server.") || name.startsWith("server/")) {
    return "agentic-control-plane-runtime-state";
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
    "agentic-control-plane-http-plugin-ws",
    "agentic-control-plane-runtime",
    "agentic-control-plane-runtime-config",
    "agentic-control-plane-runtime-cron",
    "agentic-control-plane-runtime-events",
    "agentic-control-plane-runtime-network",
    "agentic-control-plane-runtime-server",
    "agentic-control-plane-runtime-shared-token",
    "agentic-control-plane-runtime-state",
    "agentic-control-plane-runtime-ui-tools",
    "agentic-control-plane-startup-config",
    "agentic-control-plane-startup-core",
    "agentic-control-plane-startup-health-runtime",
    "agentic-control-plane-startup-restart-close",
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

function resolveCronShardName(file) {
  const name = relative("src/cron", file).replaceAll("\\", "/");
  if (name.startsWith("isolated-agent")) {
    return "core-runtime-cron-isolated-agent";
  }
  if (name.startsWith("service")) {
    return "core-runtime-cron-service";
  }
  return "core-runtime-cron-core";
}

function createCronSplitShards() {
  const groups = new Map();
  for (const file of listTestFiles("src/cron")) {
    const shardName = resolveCronShardName(file);
    groups.set(shardName, [...(groups.get(shardName) ?? []), file]);
  }

  return ["core-runtime-cron-core", "core-runtime-cron-isolated-agent", "core-runtime-cron-service"]
    .map((shardName) => ({
      configs: ["test/vitest/vitest.cron.config.ts"],
      includePatterns: groups.get(shardName) ?? [],
      requiresDist: false,
      shardName,
    }))
    .filter((shard) => shard.includePatterns.length > 0);
}

function resolveInfraShardName(file) {
  const name = relative("src/infra", file).replaceAll("\\", "/");
  if (name.startsWith("approval") || name.startsWith("exec")) {
    return "core-runtime-infra-approval-exec";
  }
  if (name.startsWith("heartbeat-runner")) {
    return "core-runtime-infra-heartbeat-runner";
  }
  if (name.startsWith("heartbeat")) {
    return "core-runtime-infra-heartbeat-core";
  }
  if (name.startsWith("outbound/message-action")) {
    return "core-runtime-infra-outbound-actions";
  }
  if (name.startsWith("outbound/")) {
    return "core-runtime-infra-outbound-core";
  }
  if (
    name.startsWith("net/") ||
    name.startsWith("install") ||
    name.startsWith("npm") ||
    name.startsWith("brew") ||
    name.startsWith("binaries")
  ) {
    return "core-runtime-infra-net-install";
  }
  if (name.startsWith("device")) {
    return "core-runtime-infra-device";
  }
  if (name.startsWith("gateway-lock") || name.startsWith("gateway-process-argv")) {
    return "core-runtime-infra-gateway-lock-argv";
  }
  if (name.startsWith("gateway-processes")) {
    return "core-runtime-infra-gateway-processes";
  }
  if (name.startsWith("gateway-watch")) {
    return "core-runtime-infra-gateway-watch";
  }
  if (name.startsWith("node") || name.startsWith("bonjour") || name.startsWith("network")) {
    return "core-runtime-infra-network-node";
  }
  if (
    name.startsWith("archive") ||
    name.startsWith("backup") ||
    name.startsWith("diagnostic") ||
    name.startsWith("diagnostics")
  ) {
    return "core-runtime-infra-diagnostics-state";
  }
  if (
    name.startsWith("command-analysis/") ||
    name.startsWith("command-explainer/") ||
    name.startsWith("file-") ||
    name.startsWith("fs-") ||
    name.startsWith("json") ||
    name.startsWith("path") ||
    name.startsWith("shell") ||
    name.startsWith("tmp-openclaw-dir")
  ) {
    return "core-runtime-infra-files-commands";
  }
  if (name.startsWith("provider-usage") || name.startsWith("push-")) {
    return "core-runtime-infra-provider-push";
  }
  if (
    name.startsWith("kysely") ||
    name.startsWith("session") ||
    name.startsWith("sqlite") ||
    name.startsWith("stale-lock") ||
    name.startsWith("state-migrations")
  ) {
    return "core-runtime-infra-storage-state";
  }
  if (
    name.startsWith("channel") ||
    name.startsWith("plugin") ||
    name.startsWith("pairing") ||
    name.startsWith("voicewake")
  ) {
    return "core-runtime-infra-channel-plugin";
  }
  if (
    name.startsWith("package") ||
    name.startsWith("ports") ||
    name.startsWith("process") ||
    name.startsWith("restart") ||
    name.startsWith("runtime") ||
    name.startsWith("run-node") ||
    name.startsWith("system") ||
    name.startsWith("update")
  ) {
    return "core-runtime-infra-system-runtime";
  }
  if (
    name.startsWith("dotenv") ||
    name.startsWith("env") ||
    name.startsWith("gemini-auth") ||
    name.startsWith("google-api") ||
    name.startsWith("home-dir") ||
    name.startsWith("host-env") ||
    name.startsWith("openclaw-exec-env") ||
    name.startsWith("secret") ||
    name.startsWith("secure-random")
  ) {
    return "core-runtime-infra-env-auth";
  }
  if (
    name.startsWith("build-stamp") ||
    name.startsWith("changelog") ||
    name.startsWith("clawhub") ||
    name.startsWith("detect-package-manager") ||
    name.startsWith("git-") ||
    name.startsWith("openclaw-root") ||
    name.startsWith("tsdown") ||
    name.startsWith("vitest")
  ) {
    return "core-runtime-infra-repo-tooling";
  }
  if (
    name.startsWith("scp") ||
    name.startsWith("ssh") ||
    name.startsWith("tailnet") ||
    name.startsWith("tailscale") ||
    name.startsWith("tcp") ||
    name.startsWith("tls/") ||
    name.startsWith("transport") ||
    name.startsWith("widearea") ||
    name.startsWith("windows") ||
    name.startsWith("ws") ||
    name.startsWith("wsl")
  ) {
    return "core-runtime-infra-network-platform";
  }
  if (
    name.startsWith("abort") ||
    name.startsWith("backoff") ||
    name.startsWith("errors") ||
    name.startsWith("fatal-error") ||
    name.startsWith("fetch") ||
    name.startsWith("fixed-window") ||
    name.startsWith("format-time/") ||
    name.startsWith("http-body") ||
    name.startsWith("parse-finite-number") ||
    name.startsWith("plain-object") ||
    name.startsWith("prototype-keys") ||
    name.startsWith("retry") ||
    name.startsWith("warning-filter")
  ) {
    return "core-runtime-infra-core-utils";
  }
  if (
    name.startsWith("browser") ||
    name.startsWith("cli-") ||
    name.startsWith("clipboard") ||
    name.startsWith("control-ui") ||
    name.startsWith("embedded") ||
    name.startsWith("is-main")
  ) {
    return "core-runtime-infra-cli-ui";
  }
  if (
    name.startsWith("agent-events") ||
    name.startsWith("event-session") ||
    name.startsWith("infra-") ||
    name.startsWith("non-fatal") ||
    name.startsWith("supervisor") ||
    name.startsWith("unhandled")
  ) {
    return "core-runtime-infra-events-runtime";
  }
  if (
    name.startsWith("boundary") ||
    name.startsWith("hardlink") ||
    name.startsWith("replace-file") ||
    name.startsWith("resolve-system-bin") ||
    name.startsWith("safe-package-install") ||
    name.startsWith("stable-node-path") ||
    name.startsWith("watch-node")
  ) {
    return "core-runtime-infra-file-safety";
  }
  if (name.startsWith("dedupe") || name.startsWith("disk-space")) {
    return "core-runtime-infra-misc-dedupe-disk";
  }
  if (
    name.startsWith("inline-option-token") ||
    name.startsWith("map-size") ||
    name.startsWith("machine-name")
  ) {
    return "core-runtime-infra-misc-values";
  }
  if (name.startsWith("os-summary")) {
    return "core-runtime-infra-misc-os";
  }
  return "core-runtime-infra-misc";
}

function createInfraSplitShards() {
  const groups = new Map();
  for (const file of listTestFiles("src/infra")) {
    const shardName = resolveInfraShardName(file);
    groups.set(shardName, [...(groups.get(shardName) ?? []), file]);
  }

  return [
    "core-runtime-infra-approval-exec",
    "core-runtime-infra-channel-plugin",
    "core-runtime-infra-cli-ui",
    "core-runtime-infra-device",
    "core-runtime-infra-diagnostics-state",
    "core-runtime-infra-core-utils",
    "core-runtime-infra-env-auth",
    "core-runtime-infra-events-runtime",
    "core-runtime-infra-file-safety",
    "core-runtime-infra-files-commands",
    "core-runtime-infra-gateway-lock-argv",
    "core-runtime-infra-gateway-processes",
    "core-runtime-infra-gateway-watch",
    "core-runtime-infra-heartbeat-core",
    "core-runtime-infra-heartbeat-runner",
    "core-runtime-infra-misc",
    "core-runtime-infra-misc-dedupe-disk",
    "core-runtime-infra-misc-os",
    "core-runtime-infra-misc-values",
    "core-runtime-infra-net-install",
    "core-runtime-infra-network-node",
    "core-runtime-infra-network-platform",
    "core-runtime-infra-outbound-actions",
    "core-runtime-infra-outbound-core",
    "core-runtime-infra-provider-push",
    "core-runtime-infra-repo-tooling",
    "core-runtime-infra-storage-state",
    "core-runtime-infra-system-runtime",
  ]
    .map((shardName) => ({
      configs: ["test/vitest/vitest.infra.config.ts"],
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
        shardName: "core-unit-fast",
        configs: [
          "test/vitest/vitest.unit-fast.config.ts",
          "test/vitest/vitest.unit-fast-fake-timers.config.ts",
        ],
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
  [
    "core-unit-support",
    [
      {
        shardName: "core-unit-support",
        configs: ["test/vitest/vitest.unit-support.config.ts"],
        requiresDist: false,
      },
    ],
  ],
  [
    "core-runtime",
    [
      {
        shardName: "core-runtime-hooks",
        configs: ["test/vitest/vitest.hooks.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
      },
      ...createInfraSplitShards(),
      {
        shardName: "core-runtime-secrets",
        configs: ["test/vitest/vitest.secrets.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
      },
      {
        shardName: "core-runtime-infra-process",
        configs: [
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
          "test/vitest/vitest.shared-core.config.ts",
          "test/vitest/vitest.tasks.config.ts",
          "test/vitest/vitest.utils.config.ts",
        ],
        requiresDist: false,
      },
      ...createCronSplitShards(),
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
      ...createAgentCoreSplitShards(),
      {
        shardName: "agentic-agents-embedded",
        configs: ["test/vitest/vitest.agents-embedded-agent.config.ts"],
        requiresDist: false,
      },
      {
        shardName: "agentic-agents-support",
        configs: ["test/vitest/vitest.agents-support.config.ts"],
        requiresDist: false,
      },
      {
        shardName: "agentic-agents-tools",
        configs: ["test/vitest/vitest.agents-tools.config.ts"],
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

/** Create node test shard descriptors for CI, optionally excluding release-only plugin shards. */
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
            runner: splitShard.runner ?? DEFAULT_NODE_TEST_RUNNER,
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
        runner: DEFAULT_NODE_TEST_RUNNER,
        requiresDist: DIST_DEPENDENT_NODE_SHARD_NAMES.has(shard.name),
      },
    ];
  });
}
