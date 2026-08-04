// Test-project planning helpers used by scripts/run-vitest.mjs,
// scripts/test-projects.mjs, and focused tests. Exports are intentionally
// granular so project selection stays testable without spawning Vitest.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  agentVitestProjectOwners,
  embeddedAgentVitestProjectOwners,
  isAgentsCoreIsolatedTestFile,
} from "../test/vitest/vitest.agents-paths.mjs";
import { isChannelSurfaceTestFile } from "../test/vitest/vitest.channel-paths.mjs";
import {
  cliProcessTestFiles,
  isCliProcessTestFile,
} from "../test/vitest/vitest.cli-process-paths.mjs";
import {
  commandsLightTestFiles,
  isCommandsLightTarget,
  resolveCommandsLightIncludePattern,
} from "../test/vitest/vitest.commands-light-paths.mjs";
import {
  channelConfigContractPatterns,
  channelRegistryContractPatterns,
  channelSessionContractPatterns,
  channelSurfaceContractPatterns,
} from "../test/vitest/vitest.contracts-paths.mjs";
import { isAcpxExtensionRoot } from "../test/vitest/vitest.extension-acpx-paths.mjs";
import { isActiveMemoryExtensionRoot } from "../test/vitest/vitest.extension-active-memory-paths.mjs";
import { isBrowserExtensionRoot } from "../test/vitest/vitest.extension-browser-paths.mjs";
import { resolveSplitChannelExtensionShard } from "../test/vitest/vitest.extension-channel-split-paths.mjs";
import { isCodexExtensionRoot } from "../test/vitest/vitest.extension-codex-paths.mjs";
import { isDiffsExtensionRoot } from "../test/vitest/vitest.extension-diffs-paths.mjs";
import { isFeishuExtensionRoot } from "../test/vitest/vitest.extension-feishu-paths.mjs";
import { isIrcExtensionRoot } from "../test/vitest/vitest.extension-irc-paths.mjs";
import {
  isMatrixExtensionRoot,
  matrixExtensionTestRoots,
} from "../test/vitest/vitest.extension-matrix-paths.mjs";
import { isMattermostExtensionRoot } from "../test/vitest/vitest.extension-mattermost-paths.mjs";
import { isMediaExtensionRoot } from "../test/vitest/vitest.extension-media-paths.mjs";
import { isMemoryExtensionRoot } from "../test/vitest/vitest.extension-memory-paths.mjs";
import { isMessagingExtensionRoot } from "../test/vitest/vitest.extension-messaging-paths.mjs";
import { isMiscExtensionRoot } from "../test/vitest/vitest.extension-misc-paths.mjs";
import { isMsTeamsExtensionRoot } from "../test/vitest/vitest.extension-msteams-paths.mjs";
import {
  isProviderExtensionRoot,
  isProviderOpenAiExtensionRoot,
} from "../test/vitest/vitest.extension-provider-paths.mjs";
import { isQaExtensionRoot } from "../test/vitest/vitest.extension-qa-paths.mjs";
import { isTelegramExtensionRoot } from "../test/vitest/vitest.extension-telegram-paths.mjs";
import { isVoiceCallExtensionRoot } from "../test/vitest/vitest.extension-voice-call-paths.mjs";
import { isWhatsAppExtensionRoot } from "../test/vitest/vitest.extension-whatsapp-paths.mjs";
import { isZaloExtensionRoot } from "../test/vitest/vitest.extension-zalo-paths.mjs";
import {
  isPluginSdkLightTarget,
  pluginSdkLightTestFiles,
  resolvePluginSdkLightIncludePattern,
} from "../test/vitest/vitest.plugin-sdk-paths.mjs";
import { fullSuiteVitestShards } from "../test/vitest/vitest.test-shards.mjs";
import {
  isToolingIsolatedTestFile,
  toolingIsolatedTestFiles,
} from "../test/vitest/vitest.tooling-isolated-paths.mjs";
import {
  isUiIsolatedTestFile,
  uiIsolatedTestFiles,
} from "../test/vitest/vitest.ui-isolated-paths.mjs";
import {
  getUnitFastIsolatedTestFiles,
  getUnitFastTestFiles,
  getUnitFastTimerTestFiles,
  resolveUnitFastIsolatedTestIncludePattern,
  resolveUnitFastTestIncludePattern,
  resolveUnitFastTimerTestIncludePattern,
} from "../test/vitest/vitest.unit-fast-paths.mjs";
import {
  isBoundaryTestFile,
  isBundledPluginDependentUnitTestFile,
} from "../test/vitest/vitest.unit-paths.mjs";
import {
  detectChangedLanes,
  listChangedPathsFromGit as listChangedPathsFromGitSource,
} from "./changed-lanes.mjs";
import { getChangedPathFacts } from "./lib/changed-path-facts.mjs";
import { createExtensionTestProcessTargetChunks } from "./lib/extension-test-plan.mjs";
import {
  GATEWAY_SERVER_TEST_PROCESS_COUNT,
  listGatewayServerTestTargets,
  splitTestTargetChunks as splitTargetChunks,
} from "./lib/gateway-server-test-plan.mjs";
import { isCiLikeEnv, resolveLocalFullSuiteProfile } from "./lib/vitest-local-scheduling.mjs";
import {
  DEFAULT_VITEST_NO_OUTPUT_HEARTBEAT_MS,
  resolveDefaultVitestNoOutputTimeoutMs,
  resolveVitestCliEntry,
  resolveVitestNodeArgs,
} from "./run-vitest.mjs";

const DEFAULT_VITEST_CONFIG = "test/vitest/vitest.unit.config.ts";
const AGENTS_EMBEDDED_AGENT_TEST_ROOT = agentVitestProjectOwners.embedded.root;
const AGENTS_CORE_ISOLATED_VITEST_CONFIG = agentVitestProjectOwners.coreIsolated.config;
const AGENTS_CORE_VITEST_CONFIG = agentVitestProjectOwners.core.config;
const AGENTS_EMBEDDED_AGENT_VITEST_CONFIG = agentVitestProjectOwners.embedded.config;
const AGENTS_EMBEDDED_AGENT_INCOMPLETE_TURN_VITEST_CONFIG =
  agentVitestProjectOwners.embeddedIncompleteTurn.config;
const AGENTS_EMBEDDED_AGENT_OVERFLOW_COMPACTION_VITEST_CONFIG =
  agentVitestProjectOwners.embeddedOverflowCompaction.config;
const AGENTS_EMBEDDED_AGENT_RUN_VITEST_CONFIG = agentVitestProjectOwners.embeddedRun.config;
const AGENTS_SUPPORT_VITEST_CONFIG = agentVitestProjectOwners.support.config;
const AGENTS_TOOLS_VITEST_CONFIG = agentVitestProjectOwners.tools.config;
const AGENTS_VITEST_CONFIG = agentVitestProjectOwners.all.config;
const ACP_VITEST_CONFIG = "test/vitest/vitest.acp.config.ts";
const AUTO_REPLY_CORE_VITEST_CONFIG = "test/vitest/vitest.auto-reply-core.config.ts";
const AUTO_REPLY_VITEST_CONFIG = "test/vitest/vitest.auto-reply.config.ts";
const AUTO_REPLY_REPLY_VITEST_CONFIG = "test/vitest/vitest.auto-reply-reply.config.ts";
const AUTO_REPLY_TOP_LEVEL_VITEST_CONFIG = "test/vitest/vitest.auto-reply-top-level.config.ts";
const BOUNDARY_VITEST_CONFIG = "test/vitest/vitest.boundary.config.ts";
const BUNDLED_VITEST_CONFIG = "test/vitest/vitest.bundled.config.ts";
const CHANNEL_VITEST_CONFIG = "test/vitest/vitest.channels.config.ts";
const CLI_PROCESS_VITEST_CONFIG = "test/vitest/vitest.cli-process.config.ts";
const CLI_VITEST_CONFIG = "test/vitest/vitest.cli.config.ts";
const COMMANDS_LIGHT_VITEST_CONFIG = "test/vitest/vitest.commands-light.config.ts";
const COMMANDS_VITEST_CONFIG = "test/vitest/vitest.commands.config.ts";
const CONTRACTS_CHANNEL_CONFIG_VITEST_CONFIG =
  "test/vitest/vitest.contracts-channel-config.config.ts";
const CONTRACTS_CHANNEL_REGISTRY_VITEST_CONFIG =
  "test/vitest/vitest.contracts-channel-registry.config.ts";
const CONTRACTS_CHANNEL_SESSION_VITEST_CONFIG =
  "test/vitest/vitest.contracts-channel-session.config.ts";
const CONTRACTS_CHANNEL_SURFACE_VITEST_CONFIG =
  "test/vitest/vitest.contracts-channel-surface.config.ts";
const CONTRACTS_PLUGIN_VITEST_CONFIG = "test/vitest/vitest.contracts-plugin.config.ts";
const CRON_VITEST_CONFIG = "test/vitest/vitest.cron.config.ts";
const DAEMON_VITEST_CONFIG = "test/vitest/vitest.daemon.config.ts";
const E2E_VITEST_CONFIG = "test/vitest/vitest.e2e.config.ts";
const EXTENSION_ACTIVE_MEMORY_VITEST_CONFIG =
  "test/vitest/vitest.extension-active-memory.config.ts";
const EXTENSION_ACPX_VITEST_CONFIG = "test/vitest/vitest.extension-acpx.config.ts";
const EXTENSION_BROWSER_VITEST_CONFIG = "test/vitest/vitest.extension-browser.config.ts";
const EXTENSION_CODEX_VITEST_CONFIG = "test/vitest/vitest.extension-codex.config.ts";
const EXTENSION_CODEX_APP_SERVER_ATTEMPT_VITEST_CONFIG =
  "test/vitest/vitest.extension-codex-app-server-attempt.config.ts";
const EXTENSION_CODEX_APP_SERVER_ATTEMPT_EXTRA_VITEST_CONFIG =
  "test/vitest/vitest.extension-codex-app-server-attempt-extra.config.ts";
const EXTENSION_CODEX_APP_SERVER_ATTEMPT_LIGHT_VITEST_CONFIG =
  "test/vitest/vitest.extension-codex-app-server-attempt-light.config.ts";
const EXTENSION_CODEX_APP_SERVER_ATTEMPT_SUPPORT_VITEST_CONFIG =
  "test/vitest/vitest.extension-codex-app-server-attempt-support.config.ts";
const EXTENSION_CODEX_APP_SERVER_RUNTIME_VITEST_CONFIG =
  "test/vitest/vitest.extension-codex-app-server-runtime.config.ts";
const EXTENSION_CODEX_APP_SERVER_SUPPORT_VITEST_CONFIG =
  "test/vitest/vitest.extension-codex-app-server-support.config.ts";
const EXTENSION_CODEX_APP_SERVER_TOOLS_VITEST_CONFIG =
  "test/vitest/vitest.extension-codex-app-server-tools.config.ts";
const EXTENSION_CODEX_SURFACE_VITEST_CONFIG =
  "test/vitest/vitest.extension-codex-surface.config.ts";
const EXTENSION_CHANNELS_VITEST_CONFIG = "test/vitest/vitest.extension-channels.config.ts";
const EXTENSION_DIFFS_VITEST_CONFIG = "test/vitest/vitest.extension-diffs.config.ts";
const EXTENSION_DISCORD_VITEST_CONFIG = "test/vitest/vitest.extension-discord.config.ts";
const EXTENSION_FEISHU_VITEST_CONFIG = "test/vitest/vitest.extension-feishu.config.ts";
const EXTENSION_IMESSAGE_VITEST_CONFIG = "test/vitest/vitest.extension-imessage.config.ts";
const EXTENSION_IRC_VITEST_CONFIG = "test/vitest/vitest.extension-irc.config.ts";
const EXTENSION_LINE_VITEST_CONFIG = "test/vitest/vitest.extension-line.config.ts";
const EXTENSION_MATTERMOST_VITEST_CONFIG = "test/vitest/vitest.extension-mattermost.config.ts";
const EXTENSION_MEDIA_VITEST_CONFIG = "test/vitest/vitest.extension-media.config.ts";
const EXTENSION_MATRIX_VITEST_CONFIG = "test/vitest/vitest.extension-matrix.config.ts";
const EXTENSION_MEMORY_VITEST_CONFIG = "test/vitest/vitest.extension-memory.config.ts";
const EXTENSION_MSTEAMS_VITEST_CONFIG = "test/vitest/vitest.extension-msteams.config.ts";
const EXTENSION_MESSAGING_VITEST_CONFIG = "test/vitest/vitest.extension-messaging.config.ts";
const EXTENSION_MISC_VITEST_CONFIG = "test/vitest/vitest.extension-misc.config.ts";
const EXTENSION_PROVIDER_OPENAI_VITEST_CONFIG =
  "test/vitest/vitest.extension-provider-openai.config.ts";
const EXTENSION_PROVIDERS_VITEST_CONFIG = "test/vitest/vitest.extension-providers.config.ts";
const EXTENSION_QA_VITEST_CONFIG = "test/vitest/vitest.extension-qa.config.ts";
const EXTENSION_SIGNAL_VITEST_CONFIG = "test/vitest/vitest.extension-signal.config.ts";
const EXTENSION_SLACK_VITEST_CONFIG = "test/vitest/vitest.extension-slack.config.ts";
const EXTENSION_TELEGRAM_VITEST_CONFIG = "test/vitest/vitest.extension-telegram.config.ts";
const EXTENSION_VOICE_CALL_VITEST_CONFIG = "test/vitest/vitest.extension-voice-call.config.ts";
const EXTENSION_WHATSAPP_VITEST_CONFIG = "test/vitest/vitest.extension-whatsapp.config.ts";
const EXTENSION_ZALO_VITEST_CONFIG = "test/vitest/vitest.extension-zalo.config.ts";
const EXTENSIONS_VITEST_CONFIG = "test/vitest/vitest.extensions.config.ts";
const FULL_AGENTIC_VITEST_CONFIG = "test/vitest/vitest.full-agentic.config.ts";
const FULL_EXTENSIONS_VITEST_CONFIG = "test/vitest/vitest.full-extensions.config.ts";
const GATEWAY_CLIENT_VITEST_CONFIG = "test/vitest/vitest.gateway-client.config.ts";
const GATEWAY_CORE_VITEST_CONFIG = "test/vitest/vitest.gateway-core.config.ts";
const GATEWAY_METHODS_VITEST_CONFIG = "test/vitest/vitest.gateway-methods.config.ts";
const GATEWAY_SERVER_VITEST_CONFIG = "test/vitest/vitest.gateway-server.config.ts";
const GATEWAY_VITEST_CONFIG = "test/vitest/vitest.gateway.config.ts";
const HOOKS_VITEST_CONFIG = "test/vitest/vitest.hooks.config.ts";
const INFRA_VITEST_CONFIG = "test/vitest/vitest.infra.config.ts";
const MEDIA_VITEST_CONFIG = "test/vitest/vitest.media.config.ts";
const MEDIA_UNDERSTANDING_VITEST_CONFIG = "test/vitest/vitest.media-understanding.config.ts";
const LOGGING_VITEST_CONFIG = "test/vitest/vitest.logging.config.ts";
const PLUGIN_SDK_LIGHT_VITEST_CONFIG = "test/vitest/vitest.plugin-sdk-light.config.ts";
const PLUGIN_SDK_VITEST_CONFIG = "test/vitest/vitest.plugin-sdk.config.ts";
const PLUGINS_VITEST_CONFIG = "test/vitest/vitest.plugins.config.ts";
const UNIT_FAST_VITEST_CONFIG = "test/vitest/vitest.unit-fast.config.ts";
const UNIT_FAST_ISOLATED_VITEST_CONFIG = "test/vitest/vitest.unit-fast-isolated.config.ts";
const UNIT_FAST_FAKE_TIMERS_VITEST_CONFIG = "test/vitest/vitest.unit-fast-fake-timers.config.ts";
const UNIT_SECURITY_VITEST_CONFIG = "test/vitest/vitest.unit-security.config.ts";
const UNIT_SRC_VITEST_CONFIG = "test/vitest/vitest.unit-src.config.ts";
const UNIT_SUPPORT_VITEST_CONFIG = "test/vitest/vitest.unit-support.config.ts";

const FULL_SUITE_CONFIG_WEIGHT = new Map([
  [GATEWAY_VITEST_CONFIG, 180],
  [GATEWAY_SERVER_VITEST_CONFIG, 180],
  [GATEWAY_CORE_VITEST_CONFIG, 179],
  [GATEWAY_CLIENT_VITEST_CONFIG, 178],
  [GATEWAY_METHODS_VITEST_CONFIG, 177],
  [COMMANDS_VITEST_CONFIG, 175],
  [AGENTS_CORE_VITEST_CONFIG, 170],
  [AGENTS_EMBEDDED_AGENT_VITEST_CONFIG, 169],
  [AGENTS_EMBEDDED_AGENT_INCOMPLETE_TURN_VITEST_CONFIG, 169],
  [AGENTS_EMBEDDED_AGENT_OVERFLOW_COMPACTION_VITEST_CONFIG, 169],
  [AGENTS_EMBEDDED_AGENT_RUN_VITEST_CONFIG, 169],
  [AGENTS_SUPPORT_VITEST_CONFIG, 168],
  [AGENTS_TOOLS_VITEST_CONFIG, 167],
  [EXTENSION_CODEX_VITEST_CONFIG, 168],
  [EXTENSION_CODEX_APP_SERVER_ATTEMPT_VITEST_CONFIG, 168],
  [EXTENSION_CODEX_APP_SERVER_ATTEMPT_EXTRA_VITEST_CONFIG, 118],
  [EXTENSION_CODEX_APP_SERVER_ATTEMPT_LIGHT_VITEST_CONFIG, 82],
  [EXTENSION_CODEX_APP_SERVER_ATTEMPT_SUPPORT_VITEST_CONFIG, 80],
  [EXTENSION_CODEX_APP_SERVER_RUNTIME_VITEST_CONFIG, 88],
  [EXTENSION_CODEX_APP_SERVER_TOOLS_VITEST_CONFIG, 78],
  [EXTENSION_CODEX_APP_SERVER_SUPPORT_VITEST_CONFIG, 72],
  [EXTENSION_CODEX_SURFACE_VITEST_CONFIG, 68],
  [EXTENSION_VOICE_CALL_VITEST_CONFIG, 169],
  [EXTENSIONS_VITEST_CONFIG, 168],
  [EXTENSION_PROVIDER_OPENAI_VITEST_CONFIG, 167],
  ["test/vitest/vitest.runtime-config.config.ts", 166],
  [CONTRACTS_CHANNEL_CONFIG_VITEST_CONFIG, 85],
  [CONTRACTS_CHANNEL_SURFACE_VITEST_CONFIG, 60],
  [CONTRACTS_CHANNEL_SESSION_VITEST_CONFIG, 50],
  [CONTRACTS_CHANNEL_REGISTRY_VITEST_CONFIG, 35],
  [CONTRACTS_PLUGIN_VITEST_CONFIG, 20],
  ["test/vitest/vitest.tasks.config.ts", 165],
  [CHANNEL_VITEST_CONFIG, 164],
  [UNIT_FAST_VITEST_CONFIG, 160],
  [UNIT_FAST_ISOLATED_VITEST_CONFIG, 159],
  [AUTO_REPLY_REPLY_VITEST_CONFIG, 155],
  [INFRA_VITEST_CONFIG, 145],
  ["test/vitest/vitest.secrets.config.ts", 140],
  [CRON_VITEST_CONFIG, 135],
  ["test/vitest/vitest.wizard.config.ts", 130],
  [UNIT_SRC_VITEST_CONFIG, 125],
  [EXTENSION_MATRIX_VITEST_CONFIG, 100],
  [EXTENSION_DISCORD_VITEST_CONFIG, 98],
  [EXTENSION_PROVIDERS_VITEST_CONFIG, 96],
  [EXTENSION_TELEGRAM_VITEST_CONFIG, 94],
  [EXTENSION_WHATSAPP_VITEST_CONFIG, 92],
  [AUTO_REPLY_CORE_VITEST_CONFIG, 90],
  [CLI_PROCESS_VITEST_CONFIG, 87],
  [CLI_VITEST_CONFIG, 86],
  [MEDIA_VITEST_CONFIG, 84],
  [PLUGINS_VITEST_CONFIG, 82],
  [BUNDLED_VITEST_CONFIG, 80],
  [EXTENSION_SLACK_VITEST_CONFIG, 78],
  [COMMANDS_LIGHT_VITEST_CONFIG, 48],
  [PLUGIN_SDK_VITEST_CONFIG, 46],
  [AUTO_REPLY_TOP_LEVEL_VITEST_CONFIG, 45],
  [PLUGIN_SDK_LIGHT_VITEST_CONFIG, 38],
  [DAEMON_VITEST_CONFIG, 36],
  [BOUNDARY_VITEST_CONFIG, 34],
  ["test/vitest/vitest.tooling.config.ts", 32],
  ["test/vitest/vitest.tooling-isolated.config.ts", 1],
  [UNIT_SECURITY_VITEST_CONFIG, 30],
  [UNIT_SUPPORT_VITEST_CONFIG, 28],
  [EXTENSION_ZALO_VITEST_CONFIG, 24],
  [EXTENSION_IRC_VITEST_CONFIG, 20],
  [EXTENSION_FEISHU_VITEST_CONFIG, 18],
  [EXTENSION_MATTERMOST_VITEST_CONFIG, 16],
  [EXTENSION_MESSAGING_VITEST_CONFIG, 14],
  [EXTENSION_IMESSAGE_VITEST_CONFIG, 13],
  [EXTENSION_LINE_VITEST_CONFIG, 12],
  [EXTENSION_SIGNAL_VITEST_CONFIG, 11],
  [EXTENSION_ACPX_VITEST_CONFIG, 10],
  [EXTENSION_DIFFS_VITEST_CONFIG, 8],
  [EXTENSION_ACTIVE_MEMORY_VITEST_CONFIG, 7],
  [EXTENSION_MEMORY_VITEST_CONFIG, 6],
  [EXTENSION_MSTEAMS_VITEST_CONFIG, 4],
]);

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

function uniqueOrdered(values) {
  return [...new Set(values)];
}

function isPathAtOrUnder(relative, root) {
  return relative === root || relative.startsWith(`${root}/`);
}

/**
 * Orders full-suite specs so expensive shards start first in parallel runs.
 */
export function orderFullSuiteSpecsForParallelRun(specs, shardTimings = new Map()) {
  const sortedSpecs = specs.toSorted((a, b) => {
    const weightDelta =
      resolveConfigSortWeight(b.config, shardTimings) -
      resolveConfigSortWeight(a.config, shardTimings);
    if (weightDelta !== 0) {
      return weightDelta;
    }
    return a.config.localeCompare(b.config);
  });
  return interleaveSlowAndFastSpecs(sortedSpecs);
}
const PROCESS_VITEST_CONFIG = "test/vitest/vitest.process.config.ts";
const RUNTIME_CONFIG_VITEST_CONFIG = "test/vitest/vitest.runtime-config.config.ts";
const SECRETS_VITEST_CONFIG = "test/vitest/vitest.secrets.config.ts";
const SHARED_CORE_VITEST_CONFIG = "test/vitest/vitest.shared-core.config.ts";
const TASKS_VITEST_CONFIG = "test/vitest/vitest.tasks.config.ts";
const TOOLING_DOCKER_VITEST_CONFIG = "test/vitest/vitest.tooling-docker.config.ts";
const TOOLING_ISOLATED_VITEST_CONFIG = "test/vitest/vitest.tooling-isolated.config.ts";
const TOOLING_VITEST_CONFIG = "test/vitest/vitest.tooling.config.ts";
const TOOLING_DOCKER_TEST_TARGET = "test/scripts/docker-build-helper.test.ts";
const BROAD_TOOLING_SCRIPT_TEST_PATTERNS = new Set([
  "test/scripts/**/*.test.ts",
  "test/scripts/*.test.ts",
]);
const BROAD_TOOLING_SCRIPT_TEST_TARGET_CHUNK_SIZE = 60;
const FULL_SUITE_AGENTS_CORE_TEST_TARGET_CHUNK_COUNT = 6;
const FULL_SUITE_TOOLING_TEST_TARGET_CHUNK_SIZE = 2;
const FULL_SUITE_UNIT_FAST_TEST_TARGET_CHUNK_SIZE = 70;
const TUI_VITEST_CONFIG = "test/vitest/vitest.tui.config.ts";
const TUI_PTY_VITEST_CONFIG = "test/vitest/vitest.tui-pty.config.ts";
const UI_VITEST_CONFIG = "test/vitest/vitest.ui.config.ts";
const UI_E2E_VITEST_CONFIG = "test/vitest/vitest.ui-e2e.config.ts";
const UI_ISOLATED_VITEST_CONFIG = "test/vitest/vitest.ui-isolated.config.ts";
const UTILS_VITEST_CONFIG = "test/vitest/vitest.utils.config.ts";
const WIZARD_VITEST_CONFIG = "test/vitest/vitest.wizard.config.ts";
const INCLUDE_FILE_ENV_KEY = "OPENCLAW_VITEST_INCLUDE_FILE";
const FS_MODULE_CACHE_PATH_ENV_KEY = "OPENCLAW_VITEST_FS_MODULE_CACHE_PATH";
const FAILED_SHARD_DIGEST_LIMIT = 12;
const CHANGED_ARGS_PATTERN = /^--changed(?:=(.+))?$/u;
const VITEST_CONFIG_BY_KIND = {
  unitFast: UNIT_FAST_VITEST_CONFIG,
  unitFastIsolated: UNIT_FAST_ISOLATED_VITEST_CONFIG,
  unitFastFakeTimers: UNIT_FAST_FAKE_TIMERS_VITEST_CONFIG,
  boundary: BOUNDARY_VITEST_CONFIG,
  toolingDocker: TOOLING_DOCKER_VITEST_CONFIG,
  toolingIsolated: TOOLING_ISOLATED_VITEST_CONFIG,
  tooling: TOOLING_VITEST_CONFIG,
  contractsChannelSurface: CONTRACTS_CHANNEL_SURFACE_VITEST_CONFIG,
  contractsChannelConfig: CONTRACTS_CHANNEL_CONFIG_VITEST_CONFIG,
  contractsChannelRegistry: CONTRACTS_CHANNEL_REGISTRY_VITEST_CONFIG,
  contractsChannelSession: CONTRACTS_CHANNEL_SESSION_VITEST_CONFIG,
  contractsPlugin: CONTRACTS_PLUGIN_VITEST_CONFIG,
  bundled: BUNDLED_VITEST_CONFIG,
  gateway: GATEWAY_VITEST_CONFIG,
  gatewayCore: GATEWAY_CORE_VITEST_CONFIG,
  gatewayClient: GATEWAY_CLIENT_VITEST_CONFIG,
  gatewayMethods: GATEWAY_METHODS_VITEST_CONFIG,
  gatewayServer: GATEWAY_SERVER_VITEST_CONFIG,
  hooks: HOOKS_VITEST_CONFIG,
  infra: INFRA_VITEST_CONFIG,
  runtimeConfig: RUNTIME_CONFIG_VITEST_CONFIG,
  cron: CRON_VITEST_CONFIG,
  daemon: DAEMON_VITEST_CONFIG,
  media: MEDIA_VITEST_CONFIG,
  logging: LOGGING_VITEST_CONFIG,
  pluginSdkLight: PLUGIN_SDK_LIGHT_VITEST_CONFIG,
  pluginSdk: PLUGIN_SDK_VITEST_CONFIG,
  process: PROCESS_VITEST_CONFIG,
  secrets: SECRETS_VITEST_CONFIG,
  sharedCore: SHARED_CORE_VITEST_CONFIG,
  tasks: TASKS_VITEST_CONFIG,
  tui: TUI_VITEST_CONFIG,
  tuiPty: TUI_PTY_VITEST_CONFIG,
  mediaUnderstanding: MEDIA_UNDERSTANDING_VITEST_CONFIG,
  acp: ACP_VITEST_CONFIG,
  cliProcess: CLI_PROCESS_VITEST_CONFIG,
  cli: CLI_VITEST_CONFIG,
  commandLight: COMMANDS_LIGHT_VITEST_CONFIG,
  command: COMMANDS_VITEST_CONFIG,
  autoReply: AUTO_REPLY_VITEST_CONFIG,
  autoReplyCore: AUTO_REPLY_CORE_VITEST_CONFIG,
  autoReplyReply: AUTO_REPLY_REPLY_VITEST_CONFIG,
  autoReplyTopLevel: AUTO_REPLY_TOP_LEVEL_VITEST_CONFIG,
  agentCore: AGENTS_CORE_VITEST_CONFIG,
  agentEmbedded: AGENTS_EMBEDDED_AGENT_VITEST_CONFIG,
  agentEmbeddedIncompleteTurn: AGENTS_EMBEDDED_AGENT_INCOMPLETE_TURN_VITEST_CONFIG,
  agentEmbeddedOverflowCompaction: AGENTS_EMBEDDED_AGENT_OVERFLOW_COMPACTION_VITEST_CONFIG,
  agentEmbeddedRun: AGENTS_EMBEDDED_AGENT_RUN_VITEST_CONFIG,
  agentSupport: AGENTS_SUPPORT_VITEST_CONFIG,
  agentTools: AGENTS_TOOLS_VITEST_CONFIG,
  agent: AGENTS_VITEST_CONFIG,
  agentsCoreIsolated: AGENTS_CORE_ISOLATED_VITEST_CONFIG,
  agentsCore: AGENTS_CORE_VITEST_CONFIG,
  agentsSupport: AGENTS_SUPPORT_VITEST_CONFIG,
  agentsTools: AGENTS_TOOLS_VITEST_CONFIG,
  plugin: PLUGINS_VITEST_CONFIG,
  ui: UI_VITEST_CONFIG,
  uiIsolated: UI_ISOLATED_VITEST_CONFIG,
  uiE2e: UI_E2E_VITEST_CONFIG,
  unitSrc: UNIT_SRC_VITEST_CONFIG,
  unitSecurity: UNIT_SECURITY_VITEST_CONFIG,
  unitSupport: UNIT_SUPPORT_VITEST_CONFIG,
  utils: UTILS_VITEST_CONFIG,
  wizard: WIZARD_VITEST_CONFIG,
  e2e: E2E_VITEST_CONFIG,
  extensionActiveMemory: EXTENSION_ACTIVE_MEMORY_VITEST_CONFIG,
  extensionAcpx: EXTENSION_ACPX_VITEST_CONFIG,
  extensionCodex: EXTENSION_CODEX_VITEST_CONFIG,
  extensionDiffs: EXTENSION_DIFFS_VITEST_CONFIG,
  extensionBrowser: EXTENSION_BROWSER_VITEST_CONFIG,
  extensionDiscord: EXTENSION_DISCORD_VITEST_CONFIG,
  extensionFeishu: EXTENSION_FEISHU_VITEST_CONFIG,
  extensionImessage: EXTENSION_IMESSAGE_VITEST_CONFIG,
  extensionIrc: EXTENSION_IRC_VITEST_CONFIG,
  extensionLine: EXTENSION_LINE_VITEST_CONFIG,
  extensionMattermost: EXTENSION_MATTERMOST_VITEST_CONFIG,
  extensionChannel: EXTENSION_CHANNELS_VITEST_CONFIG,
  extensionTelegram: EXTENSION_TELEGRAM_VITEST_CONFIG,
  extensionVoiceCall: EXTENSION_VOICE_CALL_VITEST_CONFIG,
  extensionWhatsApp: EXTENSION_WHATSAPP_VITEST_CONFIG,
  extensionZalo: EXTENSION_ZALO_VITEST_CONFIG,
  extensionMatrix: EXTENSION_MATRIX_VITEST_CONFIG,
  extensionMedia: EXTENSION_MEDIA_VITEST_CONFIG,
  extensionMemory: EXTENSION_MEMORY_VITEST_CONFIG,
  extensionMisc: EXTENSION_MISC_VITEST_CONFIG,
  extensionMsTeams: EXTENSION_MSTEAMS_VITEST_CONFIG,
  extensionMessaging: EXTENSION_MESSAGING_VITEST_CONFIG,
  extensionProviderOpenAi: EXTENSION_PROVIDER_OPENAI_VITEST_CONFIG,
  extensionProvider: EXTENSION_PROVIDERS_VITEST_CONFIG,
  extensionQa: EXTENSION_QA_VITEST_CONFIG,
  extensionSignal: EXTENSION_SIGNAL_VITEST_CONFIG,
  extensionSlack: EXTENSION_SLACK_VITEST_CONFIG,
  extensionFull: FULL_EXTENSIONS_VITEST_CONFIG,
  channel: CHANNEL_VITEST_CONFIG,
  extension: EXTENSIONS_VITEST_CONFIG,
};
const BROAD_CHANGED_FALLBACK_PATTERNS = [
  /^package\.json$/u,
  /^pnpm-lock\.yaml$/u,
  /^test\/setup(?:\.shared|\.extensions|-openclaw-runtime)?\.ts$/u,
  /^vitest(?:\..+)?\.(?:config\.ts|paths\.mjs)$/u,
  /^test\/vitest\/vitest\.(?:config|shared\.config|scoped-config|performance-config)\.ts$/u,
  /^test\/helpers\//u,
];
const PRECISE_SOURCE_TEST_TARGETS = new Map([
  ...[
    "src/system-agent/setup-inference-persist.ts",
    "src/agents/embedded-agent-runner/run/attempt-dispatch-preparation.ts",
    "src/agents/embedded-agent-runner/run/run-attempt-dispatch.ts",
  ].map((sourcePath) => [
    sourcePath,
    [
      "src/agents/embedded-agent-runner/run.overflow-compaction.loop.test.ts",
      "src/commands/onboard-guided.inference.e2e.test.ts",
    ],
  ]),
  [
    "src/plugins/contracts/tts-contract-suites.ts",
    [
      "src/plugins/contracts/core-extension-facade-boundary.test.ts",
      "src/plugins/contracts/tts.contract.test.ts",
    ],
  ],
]);
const RUNTIME_SIDECAR_BASELINE_OWNER_TEST_TARGETS = ["src/plugins/bundled-plugin-metadata.test.ts"];
const RUNTIME_SIDECAR_PATH_CONSUMER_TEST_TARGETS = [
  ...RUNTIME_SIDECAR_BASELINE_OWNER_TEST_TARGETS,
  "src/infra/update-global.test.ts",
  "src/infra/update-runner.test.ts",
  "test/openclaw-npm-postpublish-verify.test.ts",
];
const GITHUB_YAML_PINNING_GUARD_TEST_TARGETS = ["test/scripts/ci-workflow-guards.test.ts"];
const GROUP_VISIBLE_REPLY_TEST_TARGETS = [
  "src/auto-reply/reply/dispatch-acp.test.ts",
  "src/auto-reply/reply/dispatch-from-config.test.ts",
  "src/auto-reply/reply/followup-runner.test.ts",
  "src/auto-reply/reply/groups.test.ts",
  "extensions/discord/src/monitor/message-handler.process.test.ts",
  "extensions/slack/src/monitor.tool-result.test.ts",
];
const GROUP_VISIBLE_REPLY_PROMPT_TEST_TARGETS = [
  "src/agents/system-prompt.test.ts",
  ...GROUP_VISIBLE_REPLY_TEST_TARGETS,
];
const CHANNEL_CONTRACT_REGISTRY_BACKED_TARGETS = [
  "directory",
  "plugin",
  "surfaces-only",
  "threading",
].flatMap((suite) =>
  "abcdefgh"
    .split("")
    .map(
      (shard) =>
        `src/channels/plugins/contracts/${suite}.registry-backed-shard-${shard}.contract.test.ts`,
    ),
);
const TEST_HELPER_NORMALIZE_TEXT_TARGETS = [
  "src/auto-reply/reply/commands-status.test.ts",
  "src/auto-reply/status.test.ts",
  "src/tui/components/chat-log.test.ts",
];
const HAPPY_PATH_PROMPT_SNAPSHOT_HELPER_TEST_TARGETS = ["test/scripts/prompt-snapshots.test.ts"];
const APPCAST_TEST_TARGETS = ["test/appcast.test.ts", "test/scripts/make-appcast.test.ts"];
const CODEX_VERSION_CONTRACT_TEST_TARGETS = [
  "extensions/codex/src/manifest.test.ts",
  "extensions/openai/openai-provider.test.ts",
  "test/scripts/codex-client-version-contract.test.ts",
];
const SOURCE_TEST_TARGETS = new Map([
  ...PRECISE_SOURCE_TEST_TARGETS,
  ["extensions/codex/package.json", CODEX_VERSION_CONTRACT_TEST_TARGETS],
  ["extensions/codex/src/app-server/version.ts", CODEX_VERSION_CONTRACT_TEST_TARGETS],
  ["src/test-utils/openclaw-test-state.ts", ["src/test-utils/openclaw-test-state.test.ts"]],
  [
    "src/channels/plugins/contracts/test-helpers/manifest.ts",
    [
      ...CHANNEL_CONTRACT_REGISTRY_BACKED_TARGETS,
      "src/channels/plugins/contracts/registry.contract.test.ts",
      "src/channels/plugins/contracts/session-binding.registry-backed.contract.test.ts",
    ],
  ],
  [
    "src/channels/plugins/contracts/test-helpers/registry-backed-contract-shards.ts",
    CHANNEL_CONTRACT_REGISTRY_BACKED_TARGETS,
  ],
  ["test/helpers/normalize-text.ts", TEST_HELPER_NORMALIZE_TEXT_TARGETS],
  [
    "test/helpers/agents/happy-path-prompt-snapshots.ts",
    HAPPY_PATH_PROMPT_SNAPSHOT_HELPER_TEST_TARGETS,
  ],
  [
    "test/e2e/qa-lab/runtime/qa-otel-smoke-runtime.ts",
    ["test/e2e/qa-lab/runtime/qa-otel-smoke.e2e.test.ts"],
  ],
  [
    "test/e2e/qa-lab/runtime/heartbeat-active-hours-runtime.ts",
    ["test/e2e/qa-lab/runtime/heartbeat-active-hours-runtime.test.ts"],
  ],
  [
    "test/e2e/qa-lab/runtime/telegram-bot-token-runtime.ts",
    ["test/e2e/qa-lab/runtime/telegram-bot-token-runtime.test.ts"],
  ],
  ["src/plugins/runtime-sidecar-paths-baseline.ts", RUNTIME_SIDECAR_BASELINE_OWNER_TEST_TARGETS],
  ["src/plugins/runtime-sidecar-paths.ts", RUNTIME_SIDECAR_PATH_CONSUMER_TEST_TARGETS],
  ["ui/config/control-ui-chunking.ts", ["ui/src/app/control-ui-chunking.test.ts"]],
  ["ui/config/control-ui-locales.ts", ["ui/src/app/vite-config.node.test.ts"]],
  [
    "src/plugin-sdk/test-helpers/directory-ids.ts",
    [
      "extensions/discord/src/directory-contract.test.ts",
      "extensions/slack/src/directory-contract.test.ts",
      "extensions/telegram/src/directory-contract.test.ts",
    ],
  ],
  [
    "src/plugin-sdk/channel-reply-pipeline.ts",
    ["src/plugins/contracts/plugin-sdk-subpaths.test.ts", ...GROUP_VISIBLE_REPLY_TEST_TARGETS],
  ],
  ["src/plugin-sdk/reply-runtime.ts", ["src/plugins/contracts/plugin-sdk-subpaths.test.ts"]],
  ["extensions/google-meet/index.ts", ["extensions/google-meet/index.test.ts"]],
  [
    "extensions/google-meet/src/cli.ts",
    [
      "extensions/google-meet/src/cli-artifacts.test.ts",
      "extensions/google-meet/src/cli-runtime.test.ts",
      "extensions/google-meet/src/cli.test.ts",
    ],
  ],
  [
    "extensions/google-meet/src/cli-artifact-commands.ts",
    ["extensions/google-meet/src/cli-artifacts.test.ts"],
  ],
  [
    "extensions/google-meet/src/cli-export.ts",
    ["extensions/google-meet/src/cli-artifacts.test.ts"],
  ],
  [
    "extensions/google-meet/src/cli-space-commands.ts",
    ["extensions/google-meet/src/cli-artifacts.test.ts"],
  ],
  [
    "extensions/google-meet/src/cli-runtime-commands.ts",
    ["extensions/google-meet/src/cli-runtime.test.ts"],
  ],
  ["extensions/google-meet/src/cli-doctor.ts", ["extensions/google-meet/src/cli.test.ts"]],
  [
    "extensions/google-meet/src/cli-command-context.ts",
    [
      "extensions/google-meet/src/cli-artifacts.test.ts",
      "extensions/google-meet/src/cli-runtime.test.ts",
      "extensions/google-meet/src/cli.test.ts",
    ],
  ],
  [
    "extensions/google-meet/src/cli-shared.ts",
    [
      "extensions/google-meet/src/cli-artifacts.test.ts",
      "extensions/google-meet/src/cli-runtime.test.ts",
      "extensions/google-meet/src/cli.test.ts",
    ],
  ],
  ["extensions/google-meet/src/create.ts", ["extensions/google-meet/index.test.ts"]],
  ["extensions/google-meet/src/oauth.ts", ["extensions/google-meet/src/oauth.test.ts"]],
  [
    "extensions/discord/src/monitor/message-handler.ts",
    [
      "extensions/discord/src/channel-actions.contract.test.ts",
      "extensions/discord/src/channel.message-adapter.test.ts",
      "extensions/discord/src/channel.test.ts",
      "extensions/discord/src/durable-delivery.test.ts",
      "extensions/discord/src/monitor/message-handler.bot-self-filter.test.ts",
      "extensions/discord/src/monitor/message-handler.queue.test.ts",
      "extensions/discord/src/monitor/provider.skill-dedupe.test.ts",
      "extensions/discord/src/monitor/provider.test.ts",
    ],
  ],
  ["src/commands/doctor-memory-search.ts", ["src/commands/doctor-memory-search.test.ts"]],
  [
    "src/commitments/model-selection.runtime.ts",
    ["src/commitments/runtime.test.ts", "src/agents/model-selection.test.ts"],
  ],
  ["src/agents/live-model-turn-probes.ts", ["src/agents/live-model-turn-probes.test.ts"]],
  [
    "src/plugins/provider-auth-choice.ts",
    ["src/commands/auth-choice.apply.plugin-provider.test.ts", "src/commands/auth-choice.test.ts"],
  ],
  [
    "src/secrets/provider-env-vars.ts",
    ["src/secrets/provider-env-vars.dynamic.test.ts", "src/secrets/provider-env-vars.test.ts"],
  ],
  [
    "packages/memory-host-sdk/src/host/embedding-defaults.ts",
    ["packages/memory-host-sdk/src/host/embeddings.test.ts"],
  ],
  ["src/auto-reply/reply/dispatch-from-config.ts", GROUP_VISIBLE_REPLY_TEST_TARGETS],
  ["src/auto-reply/reply/source-reply-delivery-mode.ts", GROUP_VISIBLE_REPLY_TEST_TARGETS],
  [
    "src/auto-reply/reply/effective-reply-route.ts",
    [
      "src/auto-reply/reply/effective-reply-route.test.ts",
      "src/auto-reply/reply/dispatch-from-config.test.ts",
    ],
  ],
  ["src/auto-reply/reply/get-reply-run.ts", ["src/auto-reply/reply/followup-runner.test.ts"]],
  ["src/auto-reply/reply/groups.ts", GROUP_VISIBLE_REPLY_TEST_TARGETS],
  ["src/auto-reply/get-reply-options.types.ts", GROUP_VISIBLE_REPLY_TEST_TARGETS],
  ["src/agents/system-prompt.ts", GROUP_VISIBLE_REPLY_PROMPT_TEST_TARGETS],
  ["src/config/types.messages.ts", GROUP_VISIBLE_REPLY_TEST_TARGETS],
  ["src/config/zod-schema.core.ts", GROUP_VISIBLE_REPLY_TEST_TARGETS],
  ["src/auto-reply/reply/commands-acp.ts", ["src/auto-reply/reply/commands-acp.test.ts"]],
  [
    "src/auto-reply/reply/dispatch-acp-command-bypass.ts",
    ["src/auto-reply/reply/dispatch-acp-command-bypass.test.ts"],
  ],
]);
const GENERATED_CHANGED_TEST_TARGET_PATTERNS = [
  /^extensions\/[^/]+\/src\/host\/.+\/\.bundle\.hash$/u,
  /^extensions\/[^/]+\/src\/host\/.+\/[^/]+\.bundle\.js$/u,
];
const SOURCE_ROOTS_FOR_IMPORT_GRAPH = [
  "src",
  "extensions",
  "packages",
  "ui/src",
  "ui/config",
  "test",
];
const IMPORTABLE_FILE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const IMPORT_GRAPH_GREP_PATHS = SOURCE_ROOTS_FOR_IMPORT_GRAPH.flatMap((root) =>
  IMPORTABLE_FILE_EXTENSIONS.map((ext) => `:(glob)${root}/**/*${ext}`),
);
const TOOLING_IMPORT_GRAPH_ROOTS = [...SOURCE_ROOTS_FOR_IMPORT_GRAPH, "scripts"];
const TOOLING_IMPORTABLE_FILE_EXTENSIONS = [
  ...IMPORTABLE_FILE_EXTENSIONS,
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];
const TOOLING_IMPORT_GRAPH_GREP_PATHS = TOOLING_IMPORT_GRAPH_ROOTS.flatMap((root) =>
  TOOLING_IMPORTABLE_FILE_EXTENSIONS.map((ext) => `:(glob)${root}/**/*${ext}`),
);
const IMPORT_SPECIFIER_PATTERN =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;
const REEXPORT_SPECIFIER_PATTERN =
  /\bexport\s+(?:type\s+)?(?:\*\s+(?:as\s+\w+\s+)?from\s+|[^"']+?\s+from\s+)["']([^"']+)["']/gu;
const BROAD_CHANGED_ENV_KEY = "OPENCLAW_TEST_CHANGED_BROAD";
const VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY = "OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS";
const VITEST_NO_OUTPUT_HEARTBEAT_ENV_KEY = "OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS";
const VITEST_NO_OUTPUT_RETRY_ENV_KEY = "OPENCLAW_VITEST_NO_OUTPUT_RETRY";
/** Default no-output timeout applied to test-projects Vitest children. */
export const DEFAULT_TEST_PROJECTS_VITEST_NO_OUTPUT_TIMEOUT_MS = String(900_000);
/** Default heartbeat interval applied to test-projects Vitest children. */
export const DEFAULT_TEST_PROJECTS_VITEST_NO_OUTPUT_HEARTBEAT_MS = String(
  DEFAULT_VITEST_NO_OUTPUT_HEARTBEAT_MS,
);

export function formatNoChangedTestTargetLines(skippedBroadFallbackPaths) {
  if (skippedBroadFallbackPaths.length === 0) {
    return ["[test] no changed test targets; skipping Vitest."];
  }

  return [
    "[test] no precise changed test targets; skipping Vitest.",
    `[test] ${skippedBroadFallbackPaths.length} changed path${
      skippedBroadFallbackPaths.length === 1 ? "" : "s"
    } require broad Vitest fallback:`,
    ...skippedBroadFallbackPaths.map((changedPath) => `[test]   ${changedPath}`),
    "[test] run `OPENCLAW_TEST_CHANGED_BROAD=1 pnpm test:changed` for broad coverage.",
  ];
}

const EXPLICIT_SOURCE_FULL_IMPORT_GRAPH_THRESHOLD = 12;
function resolveTestProjectsVitestNoOutputTimeoutMs(config) {
  const directRunnerTimeoutMs = resolveDefaultVitestNoOutputTimeoutMs(["run", "--config", config]);
  return String(
    Math.max(Number(DEFAULT_TEST_PROJECTS_VITEST_NO_OUTPUT_TIMEOUT_MS), directRunnerTimeoutMs),
  );
}
const VITEST_CONFIG_TARGET_KIND_BY_PATH = new Map(
  Object.entries(VITEST_CONFIG_BY_KIND).map(([kind, config]) => [config, kind]),
);
const RUNNABLE_VITEST_CONFIG_TARGETS = new Set([
  "vitest.config.ts",
  DEFAULT_VITEST_CONFIG,
  ...Object.values(VITEST_CONFIG_BY_KIND),
  ...fullSuiteVitestShards.flatMap((shard) => [shard.config, ...shard.projects]),
]);
export const CHANNEL_CONTRACT_CONFIG_PATTERNS = new Map([
  [CONTRACTS_CHANNEL_SURFACE_VITEST_CONFIG, channelSurfaceContractPatterns],
  [CONTRACTS_CHANNEL_CONFIG_VITEST_CONFIG, channelConfigContractPatterns],
  [CONTRACTS_CHANNEL_REGISTRY_VITEST_CONFIG, channelRegistryContractPatterns],
  [CONTRACTS_CHANNEL_SESSION_VITEST_CONFIG, channelSessionContractPatterns],
]);

function normalizePathPattern(value) {
  return value.replaceAll("\\", "/");
}

function listRepoFilesRecursive(root, cwd) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return listRepoFilesRecursive(absolute, cwd);
    }
    if (!entry.isFile()) {
      return [];
    }
    return [normalizePathPattern(path.relative(cwd, absolute))];
  });
}

let cachedBroadScriptTestTargets = null;
let cachedBroadScriptTestTargetsCwd = null;

function listBroadScriptTestTargets(pattern, cwd) {
  const root = path.join(cwd, "test/scripts");
  if (cachedBroadScriptTestTargetsCwd !== cwd) {
    // Broad-target expansion can ask for the same process-stable checkout twice.
    // Keep one inventory so planning does not repeat the directory walk.
    cachedBroadScriptTestTargets = fs.existsSync(root)
      ? listRepoFilesRecursive(root, cwd)
          .filter((file) => file.endsWith(".test.ts"))
          .toSorted((left, right) => left.localeCompare(right))
      : [];
    cachedBroadScriptTestTargetsCwd = cwd;
  }
  return cachedBroadScriptTestTargets.filter((file) => path.matchesGlob(file, pattern));
}

function listBroadToolingScriptTestTargets(pattern, cwd) {
  return listBroadScriptTestTargets(pattern, cwd).filter(
    (file) => classifyTarget(file, cwd) === "tooling",
  );
}

let cachedToolingFullSuiteTestTargets = null;
let cachedToolingFullSuiteTestTargetsCwd = null;

function listToolingFullSuiteTestTargets(cwd) {
  if (cachedToolingFullSuiteTestTargets && cachedToolingFullSuiteTestTargetsCwd === cwd) {
    return cachedToolingFullSuiteTestTargets;
  }
  // The CLI plans against one process-stable checkout. Reuse its inventory when
  // callers compare full-suite modes instead of walking the tree for every mode.
  cachedToolingFullSuiteTestTargets = uniqueOrdered(
    [path.join(cwd, "test"), path.join(cwd, "src", "scripts")].flatMap((root) =>
      fs.existsSync(root) ? listRepoFilesRecursive(root, cwd) : [],
    ),
  )
    // Explicit leaf targets bypass the config's live-test exclusion and produce an empty shard.
    .filter(
      (file) =>
        file.endsWith(".test.ts") &&
        !file.endsWith(".live.test.ts") &&
        classifyTarget(file, cwd) === "tooling",
    )
    .toSorted((left, right) => left.localeCompare(right));
  cachedToolingFullSuiteTestTargetsCwd = cwd;
  return cachedToolingFullSuiteTestTargets;
}

function listUnitFastFullSuiteTestTargets() {
  const timerTargets = new Set(getUnitFastTimerTestFiles());
  const isolatedTargets = new Set(getUnitFastIsolatedTestFiles());
  return getUnitFastTestFiles().filter(
    (file) => !timerTargets.has(file) && !isolatedTargets.has(file),
  );
}

function listAgentsCoreFullSuiteTestTargets(cwd) {
  const isolatedTests = new Set(agentVitestProjectOwners.coreIsolated.include);
  const agentsDir = path.join(cwd, "src/agents");
  if (!fs.existsSync(agentsDir)) {
    return [];
  }
  return fs
    .readdirSync(agentsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => `src/agents/${entry.name}`)
    .filter((file) => !isolatedTests.has(file))
    .toSorted((left, right) => left.localeCompare(right));
}

function createBroadToolingScriptPlans({ config, forwardedArgs, includePatterns, watchMode, cwd }) {
  if (watchMode || config !== TOOLING_VITEST_CONFIG || !includePatterns) {
    return null;
  }
  const [pattern] = includePatterns;
  const targets =
    includePatterns.length === 1 && BROAD_TOOLING_SCRIPT_TEST_PATTERNS.has(pattern)
      ? listBroadToolingScriptTestTargets(pattern, cwd)
      : includePatterns.every((target) => target.startsWith("test/scripts/"))
        ? includePatterns
        : [];
  if (targets.length <= BROAD_TOOLING_SCRIPT_TEST_TARGET_CHUNK_SIZE) {
    return null;
  }
  const chunkCount = Math.ceil(targets.length / BROAD_TOOLING_SCRIPT_TEST_TARGET_CHUNK_SIZE);
  const chunks = splitTargetChunks(targets, chunkCount);
  return chunks.length > 0
    ? chunks.map((chunk) => ({
        config,
        forwardedArgs,
        includePatterns: chunk,
        watchMode,
      }))
    : null;
}

function createBoundedExtensionPlans({ config, forwardedArgs, roots, watchMode }) {
  if (watchMode) {
    return null;
  }
  const chunks = createExtensionTestProcessTargetChunks(config, roots, forwardedArgs);
  if (chunks.length <= 1) {
    return null;
  }
  return chunks.map((includePatterns) => ({
    config,
    forwardedArgs,
    includePatterns,
    watchMode,
  }));
}

function expandBroadToolingScriptTargets(targetArgs, cwd, watchMode) {
  if (watchMode) {
    return targetArgs;
  }
  return uniqueOrdered(
    targetArgs.flatMap((targetArg) => {
      const pattern = toScopedIncludePattern(targetArg, cwd);
      if (!BROAD_TOOLING_SCRIPT_TEST_PATTERNS.has(pattern)) {
        return [targetArg];
      }
      const targets = listBroadScriptTestTargets(pattern, cwd);
      return targets.length > 0 ? targets : [targetArg];
    }),
  );
}

function isExistingPathTarget(arg, cwd) {
  return fs.existsSync(path.resolve(cwd, arg));
}

function isExistingFileTarget(arg, cwd) {
  try {
    return fs.statSync(path.resolve(cwd, arg)).isFile();
  } catch {
    return false;
  }
}

function isExistingDirectoryTarget(arg, cwd) {
  try {
    return fs.statSync(path.resolve(cwd, arg)).isDirectory();
  } catch {
    return false;
  }
}

function isGlobTarget(arg) {
  return /[*?[\]{}]|[@+!]\(/u.test(arg);
}

function isFileLikeTarget(arg) {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(arg);
}

export function isTestFileTarget(arg) {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(arg);
}

function isTestSupportFileTarget(arg) {
  if (/(?:^|\/)(?:test-helpers|test-support)(?:\/|$)/u.test(arg)) {
    return true;
  }
  const basename = path.posix.basename(arg).replace(/\.[cm]?[jt]sx?$/u, "");
  return /(?:^|[._-])test-(?:helpers|support)(?:[._-]|$)/u.test(basename);
}

function isLikelyFileTarget(arg) {
  return /(?:^|\/)[^/]+\.[A-Za-z0-9]+$/u.test(arg);
}

function isPathLikeTargetArg(arg, cwd) {
  if (!arg || arg === "--" || arg.startsWith("-")) {
    return false;
  }
  const relative = toRepoRelativeTarget(arg, cwd);
  return (
    isGlobTarget(arg) ||
    isFileLikeTarget(arg) ||
    isVitestConfigPathLikeTarget(relative) ||
    isExistingPathTarget(arg, cwd) ||
    (path.posix.extname(relative) === "" &&
      /^(?:src|test|extensions|ui|packages|apps)\//u.test(relative)) ||
    Boolean(resolveExplicitTestPrefixTargets(arg, cwd)?.length)
  );
}

function toRepoRelativeTarget(arg, cwd) {
  if (isGlobTarget(arg)) {
    return normalizePathPattern(arg.replace(/^\.\//u, ""));
  }
  const absolute = path.resolve(cwd, arg);
  return normalizePathPattern(path.relative(cwd, absolute));
}

function toScopedIncludePattern(arg, cwd) {
  const relative = toRepoRelativeTarget(arg, cwd);
  if (isGlobTarget(relative) || isFileLikeTarget(relative)) {
    return relative;
  }
  if (isExistingFileTarget(arg, cwd) || isLikelyFileTarget(relative)) {
    const directory = normalizePathPattern(path.posix.dirname(relative));
    return directory === "." ? "**/*.test.ts" : `${directory}/**/*.test.ts`;
  }
  return `${relative.replace(/\/+$/u, "")}/**/*.test.ts`;
}

const EXPLICIT_TEST_TARGET_ROOTS = ["src", "test", "extensions", "ui", "packages", "apps"];
let cachedExplicitTestTargetFiles = null;
let cachedExplicitTestTargetFilesCwd = null;

function listExplicitTestTargetFilesFromGit(cwd) {
  const result = spawnSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...EXPLICIT_TEST_TARGET_ROOTS,
    ],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\0")
    .map((line) => normalizePathPattern(line.trim()))
    .filter((line) => line.length > 0 && isImportableGraphFile(line));
}

function listExplicitTestTargetFilesForCwd(cwd) {
  if (cachedExplicitTestTargetFiles && cachedExplicitTestTargetFilesCwd === cwd) {
    return cachedExplicitTestTargetFiles;
  }

  cachedExplicitTestTargetFiles =
    listExplicitTestTargetFilesFromGit(cwd) ??
    EXPLICIT_TEST_TARGET_ROOTS.flatMap((root) => listImportGraphFiles(cwd, root));
  cachedExplicitTestTargetFilesCwd = cwd;
  return cachedExplicitTestTargetFiles;
}

function resolveExplicitTestPrefixTargets(targetArg, cwd) {
  if (isExistingPathTarget(targetArg, cwd) || isGlobTarget(targetArg)) {
    return null;
  }
  const relative = toRepoRelativeTarget(targetArg, cwd).replace(/\/+$/u, "");
  if (!relative || isLikelyFileTarget(relative)) {
    return null;
  }
  const directory = path.posix.dirname(relative);
  const prefix = `${relative}.`;
  const targets = listExplicitTestTargetFilesForCwd(cwd).filter(
    (file) =>
      fs.existsSync(path.join(cwd, file)) &&
      path.posix.dirname(file) === directory &&
      file.startsWith(prefix) &&
      isTestFileTarget(file),
  );
  return targets.length > 0 ? targets.toSorted((left, right) => left.localeCompare(right)) : null;
}

function includePatternMatchesAnyFile(pattern, files) {
  return files.some((file) => file === pattern || path.matchesGlob(file, pattern));
}

function resolveExplicitSourceTestTargets(targetArg, cwd, options = {}) {
  const relative = toRepoRelativeTarget(targetArg, cwd);
  const kind = classifyTarget(targetArg, cwd);
  if (shouldUseWholeConfigTarget(kind, targetArg, cwd)) {
    return null;
  }
  if (!isExistingFileTarget(targetArg, cwd)) {
    return null;
  }
  if (isTestFileTarget(relative)) {
    return null;
  }
  const preciseTargets = resolvePreciseChangedTestTargets(relative, {
    cwd,
    forceFullImportGraph: options.forceFullImportGraph === true,
  });
  if (preciseTargets && preciseTargets.length > 0) {
    return [...new Set(preciseTargets)].toSorted((left, right) => left.localeCompare(right));
  }
  if (!isTestSupportFileTarget(relative)) {
    return null;
  }
  return [
    ...new Set(
      resolveAffectedTestsFromImportGraph(relative, cwd, {
        forceFull: options.forceFullImportGraph === true,
      }),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
}

function expandExplicitSourceTestTargets(targetArgs, cwd) {
  const sourceTargetCount = targetArgs.filter((targetArg) => {
    const relative = toRepoRelativeTarget(targetArg, cwd);
    return isExistingFileTarget(targetArg, cwd) && !isTestFileTarget(relative);
  }).length;
  const forceFullImportGraph = sourceTargetCount > EXPLICIT_SOURCE_FULL_IMPORT_GRAPH_THRESHOLD;
  return targetArgs.flatMap((targetArg) => {
    const relative = toRepoRelativeTarget(targetArg, cwd);
    const prefixTargets = resolveExplicitTestPrefixTargets(targetArg, cwd);
    if (prefixTargets) {
      return prefixTargets;
    }
    if (relative === "src/commands" && isExistingDirectoryTarget(targetArg, cwd)) {
      return [COMMANDS_LIGHT_VITEST_CONFIG, COMMANDS_VITEST_CONFIG];
    }
    // Contract directory targets must fan out to the owning contract lanes; the
    // generic channels/plugins projects exclude contracts/**, so routing a
    // contracts directory there silently runs zero tests (passWithNoTests).
    if (isExistingDirectoryTarget(targetArg, cwd)) {
      if (isPathAtOrUnder(relative, "src/channels/plugins/contracts")) {
        return [
          CONTRACTS_CHANNEL_SURFACE_VITEST_CONFIG,
          CONTRACTS_CHANNEL_CONFIG_VITEST_CONFIG,
          CONTRACTS_CHANNEL_REGISTRY_VITEST_CONFIG,
          CONTRACTS_CHANNEL_SESSION_VITEST_CONFIG,
        ];
      }
      if (isPathAtOrUnder(relative, "src/plugins/contracts")) {
        return [CONTRACTS_PLUGIN_VITEST_CONFIG];
      }
    }
    const exactDirectoryTargets = resolveExactSourceDirectoryTestTargets(targetArg, cwd);
    if (exactDirectoryTargets) {
      return exactDirectoryTargets;
    }
    const targets = resolveExplicitSourceTestTargets(targetArg, cwd, {
      forceFullImportGraph,
    });
    return targets && targets.length > 0 ? targets : [targetArg];
  });
}

const exactSourceDirectoryRoots = [
  "src/acp",
  "src/agents",
  "src/auto-reply",
  "src/channels",
  "src/cli",
  "src/commands",
  "src/config",
  "src/cron",
  "src/daemon",
  "src/gateway",
  "src/hooks",
  "src/infra",
  "src/logging",
  "src/media",
  "src/media-understanding",
  "src/plugin-sdk",
  "src/plugins",
  "src/process",
  "src/secrets",
  "src/shared",
  "src/tasks",
  "src/tui",
  "src/utils",
  "src/wizard",
  "ui/src",
];

function isExactSourceDirectoryTarget(relative) {
  return exactSourceDirectoryRoots.some((root) => isPathAtOrUnder(relative, root));
}

function resolveExactSourceDirectoryTestTargets(targetArg, cwd) {
  if (!isExistingDirectoryTarget(targetArg, cwd)) {
    return null;
  }
  const relative = toRepoRelativeTarget(targetArg, cwd).replace(/\/+$/u, "");
  if (!isExactSourceDirectoryTarget(relative)) {
    return null;
  }
  const prefix = `${relative}/`;
  const lightTargets = uniqueOrdered([
    ...getUnitFastTestFiles(),
    ...pluginSdkLightTestFiles,
    ...commandsLightTestFiles,
  ]).filter((file) => file.startsWith(prefix));
  return lightTargets.length > 0 ? [...lightTargets, targetArg] : null;
}

/**
 * Finds explicit test path targets that do not match any known project plan.
 */
export function findUnmatchedExplicitTestTargets(args, cwd = process.cwd()) {
  const { targetArgs } = parseTestProjectsArgs(args, cwd);
  if (targetArgs.length === 0) {
    return [];
  }

  let candidateFiles = null;
  const getCandidateFiles = () => {
    candidateFiles ??= listExplicitTestTargetFilesForCwd(cwd);
    return candidateFiles;
  };
  const unmatched = [];
  for (const targetArg of targetArgs) {
    const relative = toRepoRelativeTarget(targetArg, cwd);
    if (
      resolveVitestConfigTargetKind(relative) ||
      (isVitestConfigFileTarget(relative) && isExistingFileTarget(targetArg, cwd))
    ) {
      continue;
    }
    const kind = classifyTarget(targetArg, cwd);
    if (shouldUseWholeConfigTarget(kind, targetArg, cwd)) {
      continue;
    }
    if (isGlobTarget(relative)) {
      if (!includePatternMatchesAnyFile(relative, getCandidateFiles())) {
        unmatched.push({
          target: targetArg,
          reason: "glob-matched-no-files",
        });
      }
      continue;
    }

    const absolute = path.resolve(cwd, targetArg);
    if (!fs.existsSync(absolute)) {
      if (resolveExplicitTestPrefixTargets(targetArg, cwd)) {
        continue;
      }
      unmatched.push({
        target: targetArg,
        reason: "path-does-not-exist",
        ...(path.posix.extname(relative) === ""
          ? { includePattern: `${relative}{,.*}.{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}` }
          : {}),
      });
      continue;
    }

    if (isTestFileTarget(relative)) {
      continue;
    }

    const explicitSupportTargets = resolveExplicitSourceTestTargets(targetArg, cwd);
    if (explicitSupportTargets) {
      if (explicitSupportTargets.length === 0) {
        unmatched.push({
          target: targetArg,
          reason: "target-matched-no-test-files",
        });
      }
      continue;
    }

    const includePattern = toScopedIncludePattern(targetArg, cwd);
    if (!includePatternMatchesAnyFile(includePattern, getCandidateFiles())) {
      unmatched.push({
        target: targetArg,
        reason: "target-matched-no-test-files",
        includePattern,
      });
    }
  }
  return unmatched;
}

function isSkippedImportGraphDirectory(name) {
  return name === ".git" || name === "dist" || name === "node_modules" || name === "vendor";
}

function listImportGraphFiles(cwd, directory, files = [], extensions = IMPORTABLE_FILE_EXTENSIONS) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(cwd, directory), { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    const relative = normalizePathPattern(path.posix.join(directory, entry.name));
    if (entry.isDirectory()) {
      if (!isSkippedImportGraphDirectory(entry.name)) {
        listImportGraphFiles(cwd, relative, files, extensions);
      }
      continue;
    }
    if (entry.isFile() && extensions.some((ext) => relative.endsWith(ext))) {
      files.push(relative);
    }
  }
  return files;
}

function resolveImportSpecifier(
  importer,
  specifier,
  fileSet,
  extensions = IMPORTABLE_FILE_EXTENSIONS,
) {
  if (!specifier.startsWith(".")) {
    return null;
  }

  const importerDir = path.posix.dirname(importer);
  const base = normalizePathPattern(path.posix.normalize(path.posix.join(importerDir, specifier)));
  const candidates = [];
  const ext = path.posix.extname(base);
  if (ext) {
    candidates.push(base);
    if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
      const withoutExt = base.slice(0, -ext.length);
      candidates.push(...extensions.map((candidateExt) => `${withoutExt}${candidateExt}`));
    }
  } else {
    candidates.push(
      ...extensions.map((candidateExt) => `${base}${candidateExt}`),
      ...extensions.map((candidateExt) => `${base}/index${candidateExt}`),
    );
  }

  return candidates.find((candidate) => fileSet.has(candidate)) ?? null;
}

let cachedImportGraph = null;
let cachedImportGraphCwd = null;
const cachedImportGraphFiles = new Map();
const cachedImportGraphGrepMatches = new Map();
const cachedDirectImporters = new Map();

function isImportableGraphFile(relative) {
  return IMPORTABLE_FILE_EXTENSIONS.some((ext) => relative.endsWith(ext));
}

function listImportGraphFilesFromGit(cwd, roots, extensions) {
  const result = spawnSync("git", ["ls-files", "--", ...roots], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => normalizePathPattern(line.trim()))
    .filter((line) => line.length > 0 && extensions.some((ext) => line.endsWith(ext)));
}

function listImportGraphFilesForCwd(cwd, options = {}) {
  const tooling = options.tooling === true;
  const cacheKey = `${cwd}\0${tooling ? "tooling" : "source"}`;
  if (cachedImportGraphFiles.has(cacheKey)) {
    return cachedImportGraphFiles.get(cacheKey);
  }
  const roots = tooling ? TOOLING_IMPORT_GRAPH_ROOTS : SOURCE_ROOTS_FOR_IMPORT_GRAPH;
  const extensions = tooling ? TOOLING_IMPORTABLE_FILE_EXTENSIONS : IMPORTABLE_FILE_EXTENSIONS;
  const files =
    listImportGraphFilesFromGit(cwd, roots, extensions) ??
    roots.flatMap((root) => listImportGraphFiles(cwd, root, [], extensions));
  cachedImportGraphFiles.set(cacheKey, files);
  return files;
}

function stripImportableGraphExtension(relative, extensions = IMPORTABLE_FILE_EXTENSIONS) {
  for (const ext of extensions) {
    if (relative.endsWith(ext)) {
      return relative.slice(0, -ext.length);
    }
  }
  return relative;
}

function resolveImportGraphSearchTerms(relative, extensions = IMPORTABLE_FILE_EXTENSIONS) {
  const withoutExtension = stripImportableGraphExtension(relative, extensions);
  const basename = path.posix.basename(stripImportableGraphExtension(relative, extensions));
  if (basename === "index" || basename.length < 3) {
    return [];
  }
  const terms = [];
  const segments = withoutExtension.split("/");
  if (segments.length > 1) {
    terms.push(segments.slice(-2).join("/"), withoutExtension);
  }
  if (relative.startsWith("test/helpers/")) {
    return [...new Set(terms)];
  }
  terms.push(basename);
  return [...new Set(terms)];
}

function listImportGraphGrepMatches(cwd, term, options = {}) {
  const tooling = options.tooling === true;
  const cacheKey = `${cwd}\0${tooling ? "tooling" : "source"}\0${term}`;
  if (cachedImportGraphGrepMatches.has(cacheKey)) {
    return cachedImportGraphGrepMatches.get(cacheKey);
  }

  const result = spawnSync(
    "git",
    [
      "grep",
      "-l",
      "--fixed-strings",
      term,
      "--",
      ...(tooling ? TOOLING_IMPORT_GRAPH_GREP_PATHS : IMPORT_GRAPH_GREP_PATHS),
    ],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status === 1) {
    cachedImportGraphGrepMatches.set(cacheKey, []);
    return [];
  }
  if (result.status !== 0) {
    cachedImportGraphGrepMatches.set(cacheKey, null);
    return null;
  }
  const matches = result.stdout
    .split("\n")
    .map((line) => normalizePathPattern(line.trim()))
    .filter(
      (line) =>
        line.length > 0 &&
        (tooling
          ? TOOLING_IMPORTABLE_FILE_EXTENSIONS.some((ext) => line.endsWith(ext))
          : isImportableGraphFile(line)),
    );
  cachedImportGraphGrepMatches.set(cacheKey, matches);
  return matches;
}

function findDirectImportersWithGitGrep(cwd, importedFile, fileSet, options = {}) {
  const tooling = options.tooling === true;
  const cacheKey = `${cwd}\0${tooling ? "tooling" : "source"}\0${importedFile}`;
  if (cachedDirectImporters.has(cacheKey)) {
    return cachedDirectImporters.get(cacheKey);
  }

  const extensions = tooling ? TOOLING_IMPORTABLE_FILE_EXTENSIONS : IMPORTABLE_FILE_EXTENSIONS;
  const terms = resolveImportGraphSearchTerms(importedFile, extensions);
  if (terms.length === 0) {
    cachedDirectImporters.set(cacheKey, null);
    return null;
  }

  let skippedBroadTerm = false;
  const importers = [];
  for (const term of terms) {
    const candidates = listImportGraphGrepMatches(cwd, term, { tooling });
    if (!candidates) {
      cachedDirectImporters.set(cacheKey, null);
      return null;
    }
    if (candidates.length > 800) {
      skippedBroadTerm = true;
      continue;
    }
    for (const file of candidates) {
      if (file === importedFile || !fileSet.has(file) || importers.includes(file)) {
        continue;
      }
      let source;
      try {
        source = fs.readFileSync(path.join(cwd, file), "utf8");
      } catch {
        continue;
      }
      for (const match of source.matchAll(IMPORT_SPECIFIER_PATTERN)) {
        const imported = resolveImportSpecifier(
          file,
          match[1] ?? match[2] ?? "",
          fileSet,
          extensions,
        );
        if (imported === importedFile) {
          importers.push(file);
          break;
        }
      }
    }
    if (importedFile.startsWith("test/helpers/") && importers.length > 0 && term.includes("/")) {
      break;
    }
  }
  const result =
    skippedBroadTerm && importers.length === 0 && !importedFile.startsWith("test/helpers/")
      ? null
      : importers;
  cachedDirectImporters.set(cacheKey, result);
  return result;
}

function resolveAffectedTestsFromTargetedImportScan(changedPath, cwd, options = {}) {
  const normalized = normalizePathPattern(changedPath);
  const tooling = options.tooling === true;
  const files = listImportGraphFilesForCwd(cwd, { tooling });
  const fileSet = new Set(files);
  if (!fileSet.has(normalized)) {
    return [];
  }

  const testFiles = new Set(
    files.filter((file) => isTestFileTarget(file) && !file.endsWith(".live.test.ts")),
  );
  const queue = [normalized];
  const seen = new Set(queue);
  const targets = [];

  for (const current of queue) {
    const importers = findDirectImportersWithGitGrep(cwd, current, fileSet, { tooling });
    if (importers === null) {
      return null;
    }
    for (const importer of importers) {
      if (seen.has(importer)) {
        continue;
      }
      seen.add(importer);
      if (testFiles.has(importer)) {
        targets.push(importer);
        continue;
      }
      if (options.direct !== true) {
        queue.push(importer);
      }
    }
  }

  return [...new Set(targets)].toSorted((left, right) => left.localeCompare(right));
}

function getImportGraph(cwd) {
  if (cachedImportGraph && cachedImportGraphCwd === cwd) {
    return cachedImportGraph;
  }

  const files = listImportGraphFilesForCwd(cwd);
  const fileSet = new Set(files);
  const reverseImports = new Map();
  const reverseReexports = new Map();
  const testFiles = new Set(
    files.filter((file) => isTestFileTarget(file) && !file.endsWith(".live.test.ts")),
  );

  for (const file of files) {
    let source;
    try {
      source = fs.readFileSync(path.join(cwd, file), "utf8");
    } catch {
      continue;
    }
    for (const match of source.matchAll(IMPORT_SPECIFIER_PATTERN)) {
      const imported = resolveImportSpecifier(file, match[1] ?? match[2] ?? "", fileSet);
      if (!imported) {
        continue;
      }
      const importers = reverseImports.get(imported) ?? [];
      importers.push(file);
      reverseImports.set(imported, importers);
    }
    for (const match of source.matchAll(REEXPORT_SPECIFIER_PATTERN)) {
      const imported = resolveImportSpecifier(file, match[1] ?? "", fileSet);
      if (!imported) {
        continue;
      }
      const importers = reverseReexports.get(imported) ?? [];
      importers.push(file);
      reverseReexports.set(imported, importers);
    }
  }

  cachedImportGraph = { reverseImports, reverseReexports, testFiles };
  cachedImportGraphCwd = cwd;
  return cachedImportGraph;
}

/** Returns whether any changed path reaches one of the requested import-graph targets. */
export function hasImportGraphImpactOnTargets(changedPaths, targetPaths, cwd = process.cwd()) {
  const targets = new Set(targetPaths.map(normalizePathPattern));
  if (targets.size === 0) {
    return false;
  }

  const { reverseImports, reverseReexports } = getImportGraph(cwd);
  for (const changedPath of changedPaths) {
    const queue = [normalizePathPattern(changedPath)];
    const seen = new Set(queue);
    for (const current of queue) {
      if (targets.has(current)) {
        return true;
      }
      const importers = [
        ...(reverseImports.get(current) ?? []),
        ...(reverseReexports.get(current) ?? []),
      ];
      for (const importer of importers) {
        if (!seen.has(importer)) {
          seen.add(importer);
          queue.push(importer);
        }
      }
    }
  }
  return false;
}

function resolveAffectedTestsFromImportGraph(changedPath, cwd, options = {}) {
  const normalized = normalizePathPattern(changedPath);
  if (options.forceFull !== true) {
    const targetedTargets = resolveAffectedTestsFromTargetedImportScan(normalized, cwd);
    if (targetedTargets !== null) {
      return targetedTargets;
    }
  }

  const { reverseImports, testFiles } = getImportGraph(cwd);
  const queue = [normalized];
  const seen = new Set(queue);
  const targets = [];

  for (const current of queue) {
    for (const importer of reverseImports.get(current) ?? []) {
      if (seen.has(importer)) {
        continue;
      }
      seen.add(importer);
      if (testFiles.has(importer)) {
        targets.push(importer);
      }
      queue.push(importer);
    }
  }

  return [...new Set(targets)].toSorted((left, right) => left.localeCompare(right));
}

function resolveVitestConfigTargetKind(relative) {
  return VITEST_CONFIG_TARGET_KIND_BY_PATH.get(relative) ?? null;
}

function isVitestConfigPathLikeTarget(relative) {
  return (
    relative === "vitest.config.ts" || /^test\/vitest\/vitest\..+\.config\.ts$/u.test(relative)
  );
}

function isVitestConfigFileTarget(relative) {
  return RUNNABLE_VITEST_CONFIG_TARGETS.has(relative);
}

function isVitestConfigTargetForKind(kind, targetArg, cwd) {
  return resolveVitestConfigTargetKind(toRepoRelativeTarget(targetArg, cwd)) === kind;
}

function isControlUiE2eTarget(relative) {
  return (
    relative === "ui/src/test-helpers/control-ui-e2e.ts" ||
    relative === "ui/src/e2e" ||
    relative.startsWith("ui/src/e2e/") ||
    (relative.startsWith("ui/src/") && relative.endsWith(".e2e.test.ts"))
  );
}

function resolveChannelContractTargetKind(relative) {
  if (!relative.startsWith("src/channels/plugins/contracts/")) {
    return null;
  }
  for (const [config, patterns] of CHANNEL_CONTRACT_CONFIG_PATTERNS) {
    if (patterns.some((pattern) => path.matchesGlob(relative, pattern))) {
      return VITEST_CONFIG_TARGET_KIND_BY_PATH.get(config);
    }
  }
  return "contractsChannelSession";
}

function listChangedPathsFromGit(baseRef, cwd) {
  return listChangedPathsFromGitSource({ base: baseRef, cwd });
}

function extractChangedBaseRef(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const match = arg.match(CHANGED_ARGS_PATTERN);
    if (!match) {
      continue;
    }
    if (match[1]) {
      return match[1];
    }
    const nextArg = args[index + 1];
    return nextArg && nextArg !== "--" && !nextArg.startsWith("-") ? nextArg : "HEAD";
  }
  return null;
}

function stripChangedArgs(args) {
  const strippedArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const match = arg.match(CHANGED_ARGS_PATTERN);
    if (!match) {
      strippedArgs.push(arg);
      continue;
    }
    if (!match[1]) {
      const nextArg = args[index + 1];
      if (nextArg && nextArg !== "--" && !nextArg.startsWith("-")) {
        index += 1;
      }
    }
  }
  return strippedArgs;
}

function shouldKeepBroadChangedRun(changedPaths) {
  return changedPaths.some((changedPath) =>
    PRECISE_SOURCE_TEST_TARGETS.has(changedPath)
      ? false
      : BROAD_CHANGED_FALLBACK_PATTERNS.some((pattern) => pattern.test(changedPath)),
  );
}

function resolveToolingChangedTestTargets(changedPaths, cwd = process.cwd()) {
  const targets = [];
  for (const changedPath of changedPaths) {
    const testTargets =
      SOURCE_TEST_TARGETS.get(changedPath) ?? resolveToolingTestTargets(changedPath, cwd);
    if (!testTargets) {
      return null;
    }
    targets.push(...testTargets);
  }
  return [...new Set(targets)];
}

const TOOLING_SCRIPT_PATH_PATTERN = /^scripts\/(.+)\.(?:mjs|cjs|js|mts|cts|ts|sh|py|ps1)$/u;

function resolveConventionalToolingTestTargets(changedPath, cwd = process.cwd()) {
  const match = TOOLING_SCRIPT_PATH_PATTERN.exec(changedPath);
  if (!match) {
    return null;
  }
  const stem = match[1];
  const basename = path.posix.basename(stem);
  const dashedStem = stem.replaceAll("/", "-");
  const e2eLibStem = stem.startsWith("e2e/lib/") ? stem.slice("e2e/lib/".length) : null;
  const e2eLibDashedStem = e2eLibStem?.replaceAll("/", "-");
  const e2eLibParts = e2eLibStem?.split("/") ?? [];
  const e2eLibFamily = e2eLibParts.length > 1 ? e2eLibParts[0] : null;
  const e2eLibFamilyCandidates = e2eLibFamily
    ? [
        `test/scripts/${e2eLibFamily}.test.ts`,
        `test/scripts/${e2eLibFamily}-client.test.ts`,
        `test/scripts/${e2eLibFamily}-assertions.test.ts`,
        `test/scripts/${e2eLibFamily}-probe.test.ts`,
      ]
    : [];
  const candidates = [
    `test/scripts/${stem}.test.ts`,
    `test/scripts/${dashedStem}.test.ts`,
    `test/scripts/${basename}.test.ts`,
    ...(e2eLibDashedStem
      ? [`test/scripts/${e2eLibDashedStem}.test.ts`, `test/scripts/e2e-${e2eLibDashedStem}.test.ts`]
      : []),
    ...e2eLibFamilyCandidates,
    `src/scripts/${stem}.test.ts`,
    `src/scripts/${dashedStem}.test.ts`,
    `src/scripts/${basename}.test.ts`,
  ];
  const targets = candidates.filter((candidate) => fs.existsSync(path.join(cwd, candidate)));
  return targets.length > 0 ? targets : null;
}

function isToolingScriptPath(changedPath) {
  return TOOLING_SCRIPT_PATH_PATTERN.test(changedPath);
}

function resolveUpgradeSurvivorConfigRecipeTargets(changedPath) {
  if (!/^scripts\/e2e\/lib\/upgrade-survivor\/config-recipe\/[^/]+\.json$/u.test(changedPath)) {
    return null;
  }
  return ["test/scripts/upgrade-survivor-config-recipe.test.ts"];
}

function resolveDocsI18nBehaviorTargets(changedPath) {
  if (!/^scripts\/docs-i18n\/testdata\/behavior\/[^/]+\/[^/]+$/u.test(changedPath)) {
    return null;
  }
  return ["test/scripts/docs-i18n.test.ts"];
}

function resolveDocsI18nGoTargets(changedPath) {
  if (!/^scripts\/docs-i18n\/(?:go\.(?:mod|sum)|[^/]+\.go)$/u.test(changedPath)) {
    return null;
  }
  const targets = ["test/scripts/docs-i18n.test.ts"];
  if (changedPath === "scripts/docs-i18n/go.mod") {
    targets.push("test/scripts/ci-workflow-guards.test.ts");
  }
  return targets;
}

function resolveK8sManifestTargets(changedPath) {
  if (!/^scripts\/k8s\/manifests\/[^/]+\.yaml$/u.test(changedPath)) {
    return null;
  }
  return ["test/scripts/k8s-manifests.test.ts"];
}

function resolveParallelsToolingTestTargets(changedPath) {
  if (
    !/^scripts\/e2e\/parallels\/[^/]+\.ts$/u.test(changedPath) &&
    !/^scripts\/e2e\/parallels-(?:linux|macos|npm-update|windows)-smoke\.sh$/u.test(changedPath)
  ) {
    return null;
  }
  const targets = ["test/scripts/parallels-smoke-model.test.ts"];
  if (
    [
      "scripts/e2e/parallels/guest-transports.ts",
      "scripts/e2e/parallels/host-command.ts",
      "scripts/e2e/parallels/npm-update-scripts.ts",
      "scripts/e2e/parallels/npm-update-smoke.ts",
    ].includes(changedPath)
  ) {
    targets.push("test/scripts/parallels-npm-update-smoke.test.ts");
  }
  if (changedPath === "scripts/e2e/parallels/update-job-timeout.ts") {
    targets.push("test/scripts/parallels-update-job-timeout.test.ts");
  }
  return targets;
}

function resolveToolingTestOwnerTargets(...owners) {
  return owners.map((owner) => (owner.includes("/") ? owner : `test/scripts/${owner}.test.ts`));
}

const packageAcceptance = "package-acceptance-workflow";
const dockerBuild = "docker-build-helper";
const dockerE2e = "docker-e2e-plan";
const workflowGuards = "ci-workflow-guards";
const pluginPrerelease = "plugin-prerelease-test-plan";
const releaseCheck = "test/release-check.test.ts";
const installDocker = "test-install-sh-docker";
const changedScope = "src/scripts/ci-changed-scope.test.ts";
const dockerCache = "src/docker-build-cache.test.ts";
const dockerDigests = "src/docker-image-digests.test.ts";
const openaiChatToolsE2e = "test/e2e/qa-lab/runtime/openai-compatible-chat-tools.e2e.test.ts";
const npmPostpublish = "test/openclaw-npm-postpublish-verify.test.ts";
const crossOsReleaseChecks = "openclaw-cross-os-release-checks";
const runNode = "src/infra/run-node.test.ts";
const pluginSdkEntryOwners = [
  "src/plugins/contracts/plugin-sdk-index.bundle.test.ts",
  "src/plugins/contracts/plugin-sdk-package-contract-guardrails.test.ts",
  "src/plugins/contracts/plugin-sdk-subpaths.test.ts",
  "src/plugins/contracts/extension-package-project-boundaries.test.ts",
  "plugin-sdk-surface-report",
  "build-all",
  releaseCheck,
  "prepare-extension-package-boundary-artifacts",
  "ts-topology",
  "test/vitest/vitest.tooling.config.ts",
];

// Keep only genuinely ambiguous paths explicit; conventional discovery owns
// unambiguous scripts and direct imports without a second inventory.
const EXACT_TOOLING_TARGETS = new Map([
  [
    ".github/workflows/mantis-telegram-live.yml",
    ["mantis-telegram-desktop-proof-workflow", packageAcceptance, workflowGuards],
  ],
  [
    ".github/workflows/openclaw-live-and-e2e-checks-reusable.yml",
    [packageAcceptance, workflowGuards, "release-workflow-matrix-plan", installDocker],
  ],
  [
    ".github/workflows/plugin-npm-release.yml",
    [packageAcceptance, "plugin-npm-extended-stable-workflow", workflowGuards],
  ],
  [".github/workflows/qa-live-transports-convex.yml", [packageAcceptance, workflowGuards]],
  [".github/workflows/update-migration.yml", [packageAcceptance, workflowGuards]],
  [
    ".github/actions/setup-node-env/action.yml",
    ["install-trufflehog", packageAcceptance, workflowGuards],
  ],
  [".github/actions/setup-node-env/dependency-fingerprint.mjs", [workflowGuards]],
  [".github/actions/setup-pnpm-store-cache/action.yml", [packageAcceptance, workflowGuards]],
  [".github/actions/setup-pnpm-store-cache/ensure-node.sh", ["setup-pnpm-store-cache-ensure-node"]],
  ["test/e2e/qa-lab/runtime/mcp-channels-docker-client.ts", [dockerE2e, pluginPrerelease]],
  [
    "scripts/e2e/lib/mcp-code-mode-probe-server.ts",
    ["docker-e2e-seeds", "mcp-code-mode-gateway-client"],
  ],
  ["scripts/e2e/cron-cli-docker.sh", [dockerBuild, "docker-e2e-observability"]],
  ["scripts/ios-release-upload.sh", ["ios-release-wrapper-args", "ios-release-fastlane-gates"]],
  ["scripts/release-verify-beta.ts", ["release-wrapper-scripts"]],
  ["scripts/lib/bundled-plugin-build-entries.mjs", ["bundled-plugin-build-entries", releaseCheck]],
  ["scripts/lib/docker-e2e-package.sh", [dockerBuild]],
  [
    "scripts/lib/release-version.mjs",
    [
      "test/release-version.test.ts",
      "test/npm-publish-plan.test.ts",
      "test/openclaw-npm-release-check.test.ts",
      npmPostpublish,
      "test/plugin-npm-release.test.ts",
      "test/plugin-clawhub-release.test.ts",
      "android-version",
      "android-pin-version",
      "docker-release-policy",
      "ios-version",
      "openclaw-npm-extended-stable-release",
      "openclaw-npm-publish",
      "release-preflight",
      "release-prepare",
      "release-upgrade-baseline",
      "release-version",
      "upgrade-survivor-baselines",
      "upgrade-survivor-config-recipe",
    ],
  ],
  [
    "scripts/lib/clawhub-bootstrap-artifact.mjs",
    ["clawhub-bootstrap-artifact", "verify-clawhub-published-artifact"],
  ],
  [
    "scripts/lib/plugin-npm-release.ts",
    ["test/plugin-npm-release.test.ts", "test/plugin-clawhub-release.test.ts"],
  ],
  [
    "scripts/lib/extension-source-classifier.mjs",
    [
      "extension-source-classifier",
      "src/channels/plugins/contracts/channel-import-guardrails.test.ts",
    ],
  ],
  ["scripts/run-vitest.mjs", ["run-vitest", "test-projects", "vitest-local-scheduling"]],
  ["scripts/run-oxlint-shards.mjs", ["run-oxlint"]],
  ["scripts/lib/failed-trailer.mjs", ["run-oxlint", "run-tsgo", "run-vitest", "changed-lanes"]],
  ["scripts/docker-e2e-rerun.mjs", ["docker-e2e-helper-cli"]],
  ["scripts/openclaw-postpack.mjs", [TOOLING_VITEST_CONFIG]],
  ["scripts/openclaw-npm-prepublish-verify.ts", ["test/openclaw-npm-prepublish-verify.test.ts"]],
  ["scripts/lib/docker-e2e-scenarios.mjs", [dockerE2e, pluginPrerelease]],
  ["scripts/e2e/kitchen-sink-rpc-walk.mjs", ["kitchen-sink-rpc-walk", pluginPrerelease]],
  [
    "scripts/e2e/agents-delete-shared-workspace-docker.sh",
    [dockerE2e, changedScope, "src/commands/agents.delete.test.ts"],
  ],
  [
    "scripts/e2e/browser-cdp-snapshot-docker.sh",
    [dockerBuild, "browser-cdp-snapshot", "e2e-helper-env-limits"],
  ],
  [
    "scripts/e2e/config-reload-source-docker.sh",
    [
      dockerE2e,
      packageAcceptance,
      "fixture-config",
      "e2e-mock-config-limits",
      "src/gateway/config-reload.test.ts",
    ],
  ],
  [
    "scripts/e2e/gateway-network-docker.sh",
    [dockerBuild, dockerE2e, packageAcceptance, "gateway-network-client", changedScope],
  ],
  ["scripts/e2e/npm-telegram-live-runner.ts", ["npm-telegram-live"]],
  [
    "scripts/e2e/upgrade-survivor-docker.sh",
    [
      dockerBuild,
      dockerE2e,
      packageAcceptance,
      "upgrade-survivor-probe-gateway",
      "upgrade-survivor-assertions",
      "openclaw-test-state",
    ],
  ],
  [
    "scripts/e2e/bundled-plugin-install-uninstall-docker.sh",
    [dockerBuild, dockerE2e, pluginPrerelease, "bundled-plugin-install-uninstall-probe"],
  ],
  ["scripts/e2e/lib/plugin-update/corrupt-update-scenario.sh", ["plugin-update-unchanged-docker"]],
  ["scripts/e2e/lib/plugin-update/probe.mjs", ["plugin-update-unchanged-docker"]],
  ["scripts/e2e/lib/plugin-update/unchanged-scenario.sh", ["plugin-update-unchanged-docker"]],
  [
    "scripts/e2e/update-corrupt-plugin-docker.sh",
    [dockerBuild, dockerE2e, packageAcceptance, "plugin-update-unchanged-docker"],
  ],
  ["scripts/e2e/plugins-docker.sh", [dockerBuild, dockerE2e, "plugins-assertions"]],
  [
    "scripts/e2e/release-user-journey-docker.sh",
    [dockerBuild, dockerE2e, packageAcceptance, "release-user-journey-assertions"],
  ],
  [
    "scripts/e2e/openai-image-auth-docker.sh",
    [
      dockerBuild,
      dockerE2e,
      "openai-image-auth-docker-client",
      "extensions/openai/image-generation-provider.test.ts",
    ],
  ],
  ["scripts/e2e/lib/openai-chat-tools/client.mjs", [openaiChatToolsE2e]],
  [
    "scripts/e2e/lib/openai-web-search-minimal/client.mjs",
    ["test/e2e/qa-lab/runtime/openai-web-search-minimal.e2e.test.ts"],
  ],
  ["scripts/e2e/qr-import-docker.sh", [dockerBuild]],
  ["scripts/bundle-a2ui.mjs", ["bundled-plugin-assets"]],
]);

const SEMANTIC_TOOLING_TARGET_PATTERNS = [
  [/^scripts\/pr$/u, ["pr-merge", "pr-operation-lock", "pr-wrappers"]],
  [/^scripts\/lib\/windows-taskkill\.mjs$/u, ["managed-child-process", "run-with-env"]],
  [
    /^scripts\/lib\/config-boundary-guard\.mjs$/u,
    [
      "src/plugins/contracts/config-boundary-guard.test.ts",
      "src/plugins/contracts/deprecated-internal-config-api.test.ts",
    ],
  ],
  [
    /^\.github\/workflows\/ci\.yml$/u,
    [
      workflowGuards,
      "changed-lanes",
      "check-workflows",
      "plugin-contract-test-plan",
      pluginPrerelease,
      "verify-pr-hosted-gates",
    ],
  ],
  [
    /^\.github\/workflows\/ci-check-testbox\.yml$/u,
    [workflowGuards, packageAcceptance, "changed-lanes", "install-trufflehog"],
  ],
  [
    /^\.github\/workflows\/ci-check-arm-testbox\.yml$/u,
    [workflowGuards, packageAcceptance, "install-trufflehog"],
  ],
  [/^\.github\/workflows\/crabbox-hydrate\.yml$/u, [workflowGuards, packageAcceptance]],
  [
    /^\.github\/workflows\/ci-build-artifacts-testbox\.yml$/u,
    ["install-trufflehog", packageAcceptance, workflowGuards],
  ],
  [
    /^\.github\/workflows\/full-release-validation\.yml$/u,
    ["src/dockerfile.test.ts", packageAcceptance, pluginPrerelease],
  ],
  [
    /^\.github\/workflows\/openclaw-release-checks\.yml$/u,
    [packageAcceptance, crossOsReleaseChecks, pluginPrerelease, installDocker],
  ],
  [/^\.github\/workflows\/docker-release\.yml$/u, ["src/dockerfile.test.ts"]],
  [/^\.github\/workflows\/install-smoke\.yml$/u, ["install-smoke-no-push-workflow", installDocker]],
  [/^\.github\/workflows\/openclaw-performance\.yml$/u, ["openclaw-performance-workflow"]],
  [/^\.github\/workflows\/plugin-prerelease\.yml$/u, [pluginPrerelease]],
  [/^\.github\/workflows\/tui-pty\.yml$/u, [packageAcceptance]],
  [
    /^\.github\/workflows\/openclaw-cross-os-release-checks-reusable\.yml$/u,
    [crossOsReleaseChecks, "openclaw-cross-os-release-workflow", packageAcceptance],
  ],
  [
    /^\.github\/workflows\/(?:openclaw-release-publish|package-acceptance)\.yml$/u,
    [packageAcceptance],
  ],
  [
    /^\.github\/workflows\/plugin-clawhub-new\.yml$/u,
    [packageAcceptance, "plugin-clawhub-new-workflow"],
  ],
  [
    /^\.github\/workflows\/openclaw-npm-release\.yml$/u,
    [npmPostpublish, "openclaw-npm-extended-stable-workflow", packageAcceptance],
  ],
  [
    new RegExp(
      [
        "^\\.github\\/workflows\\/(?:auto-response|clawsweeper-dispatch|labeler|",
        "real-behavior-proof|stale)\\.yml$",
      ].join(""),
      "u",
    ),
    [workflowGuards],
  ],
  [
    new RegExp(
      [
        "^\\.github\\/workflows\\/mantis-(?:discord-(?:smoke|status-reactions|",
        "thread-attachment)|slack-desktop-smoke)\\.yml$",
      ].join(""),
      "u",
    ),
    [packageAcceptance, workflowGuards],
  ],
  [
    /^\.github\/workflows\/mantis-telegram-desktop-proof\.yml$/u,
    ["mantis-telegram-desktop-proof-workflow", packageAcceptance, workflowGuards],
  ],
  [
    /^\.github\/workflows\/mantis-web-ui-chat-proof\.yml$/u,
    ["mantis-web-ui-chat-proof-workflow", packageAcceptance, workflowGuards],
  ],
  [/^\.github\/workflows\/android-release\.yml$/u, [packageAcceptance, workflowGuards]],
  [/^\.github\/actions\/setup-node-env\/verify-importers\.mjs$/u, [workflowGuards]],
  [/^\.github\/actions\/ensure-base-commit\/action\.yml$/u, [workflowGuards]],
  [/^tsconfig\.scripts\.json$/u, ["changed-lanes", "test-projects"]],
  [/^scripts\/test-projects\.test-support\.mjs$/u, ["test-projects"]],
  [/^scripts\/ci-changed-scope\.mjs$/u, [changedScope, "control-ui-i18n"]],
  [/^scripts\/check-changed\.mjs$/u, ["changed-lanes"]],
  [
    new RegExp(
      [
        "^scripts\\/(?:generate-prompt-snapshots|prompt-snapshot-files|",
        "sync-codex-model-prompt-fixture)\\.ts$",
      ].join(""),
      "u",
    ),
    ["prompt-snapshots"],
  ],
  [/^scripts\/e2e\/npm-telegram-live-docker\.sh$/u, ["npm-telegram-live"]],
  [
    /^scripts\/package-openclaw-for-docker\.mjs$/u,
    ["test/e2e/qa-lab/runtime/package-openclaw-for-docker.e2e.test.ts"],
  ],
  [/^scripts\/run-node\.mjs$/u, [runNode]],
  [/^scripts\/pr-lib\/merge\.sh$/u, ["pr-merge"]],
  [/^scripts\/plugin-clawhub-publish\.sh$/u, ["test/plugin-clawhub-release.test.ts"]],
  [/^scripts\/openclaw-npm-postpublish-verify\.ts$/u, [npmPostpublish]],
  [
    /^scripts\/install\.ps1$/u,
    ["install-ps1", "website-installer-sync-workflow", crossOsReleaseChecks, changedScope],
  ],
  [/^scripts\/crabbox-wrapper(?:-providers)?\.mjs$/u, ["crabbox-wrapper"]],
  [
    /^scripts\/copy-bundled-plugin-metadata\.mjs$/u,
    ["src/plugins/copy-bundled-plugin-metadata.test.ts", runNode],
  ],
  [
    /^scripts\/github\/run-openclaw-cross-os-release-checks\.sh$/u,
    ["openclaw-cross-os-release-workflow"],
  ],
  [
    /^scripts\/write-plugin-sdk-entry-dts\.ts$/u,
    ["build-all", "prepare-extension-package-boundary-artifacts"],
  ],
  [/^scripts\/pr-lib\/worktree\.sh$/u, ["test/vitest/vitest.tooling.config.ts"]],
  [/^scripts\/dev\/gateway-smoke\.ts$/u, ["test/e2e/qa-lab/runtime/gateway-smoke.e2e.test.ts"]],
  [/^scripts\/e2e\/mock-openai-server\.mjs$/u, ["e2e-mock-config-limits"]],
  [/^apps\/android\/scripts\/build-release-artifacts\.ts$/u, ["android-release-artifacts"]],
  [
    new RegExp(
      [
        "^scripts\\/(?:auth-monitor|mobile-reauth|setup-auth-system|",
        "termux-(?:auth-widget|quick-auth|sync-widget))\\.sh$|",
        "^scripts\\/systemd\\/openclaw-auth-monitor\\.(?:service|timer)$",
      ].join(""),
      "u",
    ),
    ["auth-monitor"],
  ],
  [/^scripts\/native-app-i18n\.ts$/u, ["native-app-i18n", workflowGuards]],
  [
    /^scripts\/github\/(?:dependency-guard|guard-shared)\.mjs$/u,
    ["dependency-guard-script", "dependency-guard-workflow"],
  ],
  [
    /^scripts\/github\/(?:security-sensitive-guard|guard-shared)\.mjs$/u,
    ["security-sensitive-guard-script", "security-sensitive-guard-workflow"],
  ],
  [/^scripts\/plugin-clawhub-release-check\.ts$/u, ["release-wrapper-scripts"]],
  [
    /^scripts\/generate-runtime-sidecar-paths-baseline\.ts$/u,
    ["src/plugins/bundled-plugin-metadata.test.ts"],
  ],
  [
    /^scripts\/lib\/guard-inventory-utils\.mjs$/u,
    [
      "test/extension-import-boundaries.test.ts",
      "test/plugin-extension-import-boundary.test.ts",
      "test/architecture-smells.test.ts",
      "test/web-provider-boundary.test.ts",
      "test/test-helper-extension-import-boundary.test.ts",
      "extension-import-boundary-checker",
      "src/plugins/contracts/plugin-sdk-subpaths.test.ts",
    ],
  ],
  [
    /^scripts\/check-workflows\.mjs$/u,
    ["check-composite-action-input-interpolation", "check-no-conflict-markers", workflowGuards],
  ],
  [/^apps\/android\/fastlane\/Fastfile$/u, ["android-release-fastlane-gates"]],
  [/^apps\/ios\/fastlane\/Fastfile$/u, ["ios-release-fastlane-gates"]],
  [/^scripts\/ios-release-cut\.(?:sh|ts)$/u, ["ios-release-plan"]],
  [/^scripts\/ios-release-prepare\.sh$/u, ["ios-release-prepare", "ios-release-wrapper-args"]],
  [
    /^scripts\/lib\/bundled-runtime-sidecar-paths\.json$/u,
    [
      "src/plugins/bundled-plugin-metadata.test.ts",
      "src/infra/update-global.test.ts",
      "src/infra/update-runner.test.ts",
      npmPostpublish,
    ],
  ],
  [/^scripts\/lib\/android-version\.ts$/u, ["android-version", "android-pin-version"]],
  [/^scripts\/lib\/docker-e2e-plan\.mjs$/u, [dockerE2e, "docker-all-scheduler", pluginPrerelease]],
  [
    new RegExp(
      [
        "^scripts\\/lib\\/plugin-sdk-(?:deprecated-barrel-subpaths|entrypoints|",
        "private-local-only-subpaths)\\.json$",
      ].join(""),
      "u",
    ),
    pluginSdkEntryOwners,
  ],
  [
    /^scripts\/lib\/plugin-sdk-deprecated-public-subpaths\.json$/u,
    [
      "check-deprecated-api-usage",
      "src/plugins/contracts/plugin-sdk-package-contract-guardrails.test.ts",
      "plugin-sdk-surface-report",
      "build-all",
    ],
  ],
  [/^scripts\/lib\/plugin-sdk-entries\.mjs$/u, pluginSdkEntryOwners],
  [
    /^scripts\/lib\/official-external-channel-(?:catalog|seed)\.json$/u,
    [
      "src/plugins/official-external-plugin-catalog.test.ts",
      releaseCheck,
      "test/official-channel-catalog.test.ts",
    ],
  ],
  [
    /^scripts\/lib\/official-external-provider-catalog\.json$/u,
    ["src/plugins/official-external-plugin-catalog.test.ts", releaseCheck],
  ],
  [
    /^scripts\/lib\/official-external-plugin-catalog\.json$/u,
    ["src/plugins/official-external-plugin-catalog.test.ts", releaseCheck],
  ],
  [
    /^scripts\/lib\/workspace-bootstrap-smoke\.mjs$/u,
    [releaseCheck, "test/openclaw-npm-release-check.test.ts"],
  ],
  [/^scripts\/lib\/extension-test-plan\.mjs$/u, ["test-extension"]],
  [
    /^scripts\/lib\/recommended-tool-installs\.json$/u,
    ["src/plugins/recommended-tool-installs.test.ts", releaseCheck],
  ],
  [/^scripts\/docker\/install-sh-common\/version-parse\.sh$/u, [installDocker]],
  [
    /^scripts\/lib\/local-build-metadata(?:-paths)?\.mjs$/u,
    [
      "src/infra/build-stamp.test.ts",
      "runtime-postbuild-stamp",
      runNode,
      "src/infra/package-dist-inventory.test.ts",
      releaseCheck,
      "test/openclaw-npm-release-check.test.ts",
      "check-gateway-watch-regression",
      "check-openclaw-package-tarball",
      crossOsReleaseChecks,
    ],
  ],
  [
    /^scripts\/lib\/package-dist-imports\.mjs$/u,
    [
      "check-package-dist-imports",
      "check-openclaw-package-tarball",
      "postinstall-bundled-plugins",
      releaseCheck,
    ],
  ],
  [
    /^scripts\/lib\/build-metadata\.sh$/u,
    [
      "src/docker-setup.e2e.test.ts",
      "apple-release-source-check",
      "ios-version",
      "package-mac-app",
      installDocker,
    ],
  ],
  [/^scripts\/lib\/plistbuddy\.sh$/u, ["create-dmg", "package-mac-app", "package-mac-dist"]],
  [/^scripts\/lib\/swift-toolchain\.sh$/u, ["package-mac-app", "package-mac-dist"]],
  [
    /^scripts\/lib\/npm-publish-plan\.mjs$/u,
    [
      "test/npm-publish-plan.test.ts",
      "test/openclaw-npm-release-check.test.ts",
      npmPostpublish,
      "test/plugin-npm-release.test.ts",
      "test/plugin-clawhub-release.test.ts",
      "release-upgrade-baseline",
      "android-version",
      "ios-version",
      "upgrade-survivor-baselines",
      "upgrade-survivor-config-recipe",
    ],
  ],
  [/^scripts\/lib\/npm-pack-budget\.mjs$/u, [releaseCheck, installDocker]],
  [/^scripts\/lib\/actions-artifact-archive\.mjs$/u, ["plugin-publication-artifact"]],
  [
    /^scripts\/lib\/static-extension-assets\.mjs$/u,
    ["bundled-plugin-assets", "runtime-postbuild", runNode, "plugin-npm-runtime-build-args"],
  ],
  [
    /^scripts\/lib\/plugin-npm-runtime-build\.mjs$/u,
    ["plugin-npm-runtime-build-args", "test/plugin-npm-runtime-build.test.ts"],
  ],
  [/^scripts\/lib\/run-node\.mjs$/u, [runNode]],
  [
    /^\.agents\/skills\/openclaw-changelog-update\/scripts\/verify-release-notes\.mjs$/u,
    ["release-notes-ledger", "verify-release-notes"],
  ],
  [
    /^scripts\/e2e\/lib\/docker-stats\/assert-resource-ceiling\.mjs$/u,
    ["docker-stats-resource-ceiling"],
  ],
  [
    /^scripts\/e2e\/mcp-channels-docker\.sh$/u,
    [dockerBuild, "docker-e2e-observability", dockerE2e, pluginPrerelease],
  ],
  [
    /^scripts\/e2e\/cron-mcp-cleanup-docker\.sh$/u,
    [dockerBuild, "docker-e2e-observability", dockerE2e, pluginPrerelease],
  ],
  [
    /^scripts\/e2e\/mcp-code-mode-gateway-(?:live-)?docker\.sh$/u,
    [
      dockerBuild,
      dockerE2e,
      pluginPrerelease,
      "mcp-code-mode-gateway-client",
      "session-log-mentions",
    ],
  ],
  [
    /^scripts\/e2e\/agent-bundle-mcp-tools-docker\.sh$/u,
    [
      dockerBuild,
      dockerE2e,
      pluginPrerelease,
      "src/agents/agent-bundle-mcp-runtime.test.ts",
      "src/agents/agent-bundle-mcp-tools.materialize.test.ts",
    ],
  ],
  [/^scripts\/lib\/tsgo-sparse-guard\.mjs$/u, ["run-tsgo", "changed-lanes"]],
  [
    new RegExp(
      [
        "^(?:scripts\\/materialize-clawhub-cli\\.sh|",
        "\\.github\\/release\\/clawhub-cli\\/package(?:-lock)?\\.json)$",
      ].join(""),
      "u",
    ),
    [packageAcceptance, "plugin-clawhub-new-workflow"],
  ],
  [
    /^scripts\/lib\/generated-text-asset\.mjs$/u,
    [
      "extensions/browser/scripts/build-copilot-runtime.test.ts",
      "build-diffs-viewer-runtime",
      "bundled-plugin-assets",
    ],
  ],
  [/^scripts\/check-plugin-npm-runtime-builds\.mjs$/u, ["plugin-npm-runtime-build-args"]],
  [
    /^scripts\/install\.sh$/u,
    [
      "install-sh",
      installDocker,
      "website-installer-sync-workflow",
      crossOsReleaseChecks,
      changedScope,
    ],
  ],
  [
    /^scripts\/sparkle-build\.ts$/u,
    ["test/appcast.test.ts", releaseCheck, "package-mac-app", "package-mac-dist"],
  ],
  [
    /^test\/vitest\/vitest\.contracts-paths\.mjs$/u,
    [
      "test-projects",
      "test/vitest/vitest.contracts-channel-surface.config.ts",
      "test/vitest/vitest.contracts-channel-config.config.ts",
      "test/vitest/vitest.contracts-channel-registry.config.ts",
      "test/vitest/vitest.contracts-channel-session.config.ts",
    ],
  ],
  [/^scripts\/e2e\/openai-chat-tools-docker\.sh$/u, [openaiChatToolsE2e, dockerE2e]],
  [
    /^scripts\/e2e\/session-runtime-context-docker\.sh$/u,
    [
      "docker-e2e-clients",
      dockerE2e,
      "src/agents/embedded-agent-runner/run/runtime-context-prompt.test.ts",
      "src/agents/embedded-agent-runner/transcript-rewrite.test.ts",
    ],
  ],
  [
    new RegExp(
      [
        "^scripts\\/e2e\\/(?!(?:commitments-safety|config-reload-source|",
        "kitchen-sink-(?:plugin|rpc)|npm-telegram-live|onboard|openai-chat-tools|",
        "plugin-lifecycle-matrix|release-media-memory|session-runtime-context|",
        "update-corrupt-plugin)-docker\\.sh$).+-docker\\.sh$",
      ].join(""),
      "u",
    ),
    [dockerBuild, dockerE2e],
  ],
  [/^scripts\/e2e\/kitchen-sink-rpc-docker\.sh$/u, [dockerBuild, pluginPrerelease]],
  [/^scripts\/e2e\/kitchen-sink-plugin-docker\.sh$/u, [dockerBuild, pluginPrerelease]],
  [/^scripts\/e2e\/plugin-lifecycle-matrix-docker\.sh$/u, [dockerBuild]],
  [
    /^scripts\/e2e\/release-media-memory-docker\.sh$/u,
    [dockerE2e, "release-media-memory-scenario"],
  ],
  [/^scripts\/e2e\/codex-media-path-docker\.sh$/u, ["codex-media-path-client"]],
  [/^scripts\/e2e\/live-plugin-tool-docker\.sh$/u, ["live-plugin-tool-assertions"]],
  [
    /^scripts\/e2e\/commitments-safety-docker\.sh$/u,
    [
      "docker-e2e-clients",
      dockerE2e,
      "src/commitments/runtime.test.ts",
      "src/commitments/store.test.ts",
    ],
  ],
  [/^scripts\/e2e\/onboard-docker\.sh$/u, [dockerBuild, "openclaw-test-state"]],
  [
    new RegExp(
      [
        "^scripts\\/e2e\\/(?:codex-npm-plugin-live|config-reload-source|",
        "gateway-network|npm-onboard-channel-agent|doctor-install-switch|",
        "update-channel-switch|skill-install|upgrade-survivor|",
        "update-corrupt-plugin|release-(?:plugin-marketplace|typed-onboarding|",
        "upgrade-user-journey|user-journey)|plugin-binding-command-escape)-docker",
        "\\.sh$",
      ].join(""),
      "u",
    ),
    [packageAcceptance],
  ],
  [
    /^scripts\/e2e\/npm-onboard-channel-agent-docker\.sh$/u,
    ["npm-onboard-channel-agent-assertions"],
  ],
  [/^scripts\/docker\/cleanup-smoke\/Dockerfile$/u, [dockerCache, dockerDigests, dockerBuild]],
  [
    /^scripts\/docker\/install-sh-(?:e2e|nonroot|smoke)\/Dockerfile$/u,
    [dockerCache, dockerDigests, installDocker],
  ],
  [
    /^scripts\/docker\/sandbox\/Dockerfile$/u,
    [dockerCache, dockerDigests, "src/dockerfile.test.ts"],
  ],
  [
    /^scripts\/docker\/sandbox\/Dockerfile\.browser$/u,
    [dockerCache, dockerDigests, "src/agents/sandbox/browser.create.test.ts"],
  ],
  [/^scripts\/docker\/sandbox\/Dockerfile\.common$/u, [dockerCache]],
  [/^scripts\/e2e\/Dockerfile$/u, [dockerCache, dockerDigests, dockerBuild, dockerE2e]],
  [/^scripts\/e2e\/Dockerfile\.qr-import$/u, [dockerCache, dockerDigests, dockerBuild]],
  [
    /^scripts\/e2e\/plugin-binding-command-escape\.Dockerfile$/u,
    [dockerDigests, dockerBuild, dockerE2e],
  ],
  [
    new RegExp(
      [
        "^(?:scripts\\/e2e|test\\/e2e\\/qa-lab\\/runtime)\\/agent-bundle-mcp-tools-doc",
        "ker(?:-client)?\\.(?:sh|ts)$",
      ].join(""),
      "u",
    ),
    [
      "src/agents/agent-bundle-mcp-runtime.test.ts",
      "src/agents/agent-bundle-mcp-tools.materialize.test.ts",
    ],
  ],
  [/^scripts\/e2e\/system-agent-(?:first-run|rescue)-docker\.sh$/u, ["docker-e2e-system-agent"]],
  [
    /^test\/e2e\/qa-lab\/runtime\/system-agent-first-run-docker-client\.ts$/u,
    [
      "docker-e2e-system-agent",
      "src/cli/program/register.onboard.test.ts",
      "src/cli/run-main.test.ts",
      "src/cli/run-main.exit.test.ts",
      "src/commands/system-agent-with-inference.test.ts",
      "src/system-agent/assistant.configured.test.ts",
      "src/system-agent/assistant.test.ts",
      "src/system-agent/system-agent.test.ts",
      "src/system-agent/operations.test.ts",
      "src/system-agent/overview.test.ts",
      "src/system-agent/setup-inference.test.ts",
      "src/system-agent/audit.test.ts",
    ],
  ],
  [
    /^scripts\/e2e\/system-agent-first-run-spec\.json$/u,
    [
      "docker-e2e-system-agent",
      "src/system-agent/operations.test.ts",
      "src/system-agent/audit.test.ts",
    ],
  ],
  [
    /^scripts\/e2e\/system-agent-rescue-docker-client\.ts$/u,
    [
      "docker-e2e-system-agent",
      "src/system-agent/rescue-policy.test.ts",
      "src/system-agent/rescue-message.test.ts",
      "src/system-agent/operations.test.ts",
      "src/system-agent/audit.test.ts",
    ],
  ],
  [
    /^scripts\/e2e\/commitments-safety-docker(?:-client)?\.(?:sh|ts)$/u,
    ["docker-e2e-clients", "src/commitments/runtime.test.ts", "src/commitments/store.test.ts"],
  ],
  [
    /^scripts\/e2e\/session-runtime-context-docker(?:-client)?\.(?:sh|ts)$/u,
    [
      "docker-e2e-clients",
      "src/agents/embedded-agent-runner/run/runtime-context-prompt.test.ts",
      "src/agents/embedded-agent-runner/transcript-rewrite.test.ts",
    ],
  ],
  [
    new RegExp(
      [
        "^(?:scripts\\/e2e\\/(?!(?:cron-mcp-cleanup-docker-client\\.ts)$)(?:agent-bu",
        "ndle-mcp-tools|mcp-[^/]+-docker|cron-mcp-cleanup-docker|",
        "bundled-plugin-install-uninstall|plugin-update-unchanged).+|",
        "test\\/e2e\\/qa-lab\\/runtime\\/mcp-channels-docker-client\\.ts)$",
      ].join(""),
      "u",
    ),
    [pluginPrerelease, dockerE2e],
  ],
  [
    new RegExp(
      [
        "^(?:scripts\\/e2e\\/mcp-code-mode-gateway-(?:docker|live-docker|",
        "docker-client).+|scripts\\/mcp-code-mode-gateway-e2e\\.ts)$",
      ].join(""),
      "u",
    ),
    ["mcp-code-mode-gateway-client", "session-log-mentions"],
  ],
  [
    /^(?:scripts\/e2e\/(?:mcp-channels|mcp-code-mode-gateway|cron-mcp-cleanup)-seed\.ts)$/u,
    ["docker-e2e-seeds"],
  ],
  [
    /^scripts\/e2e\/(?:mcp-channels|cron-cli|cron-mcp-cleanup)-docker\.sh$/u,
    ["docker-e2e-observability"],
  ],
  [
    /^scripts\/e2e\/cron-mcp-cleanup-docker-client\.ts$/u,
    [
      "cron-mcp-cleanup-docker-client",
      "src/gateway/server.cron.test.ts",
      "src/gateway/server-methods/agent.test.ts",
      "src/cron/isolated-agent/run.fast-mode.test.ts",
      "src/cron/active-jobs-manual-run.test.ts",
    ],
  ],
  [
    /^scripts\/e2e\/cron-mcp-cleanup-docker\.sh$/u,
    ["cron-mcp-cleanup-docker-client", "docker-e2e-seeds"],
  ],
  [
    /^test\/e2e\/qa-lab\/runtime\/mcp-channels\.fixture\.ts$/u,
    ["test/e2e/qa-lab/runtime/mcp-gateway-transport.e2e.test.ts", "cron-mcp-cleanup-docker-client"],
  ],
  [
    /^scripts\/e2e\/lib\/auth-profile-store-assertions\.mjs$/u,
    ["release-scenarios-assertions", "npm-onboard-channel-agent-assertions"],
  ],
  [
    /^scripts\/lib\/plugin-npm-package-manifest\.mjs$/u,
    ["plugin-npm-package-manifest-args", "test/plugin-npm-package-manifest.test.ts"],
  ],
  [
    /^scripts\/e2e\/lib\/release-assertion-files\.mjs$/u,
    ["release-scenarios-assertions", "release-user-journey-assertions"],
  ],
  [/^scripts\/e2e\/lib\/fixtures\/config\.mjs$/u, ["fixture-config"]],
  [/^scripts\/e2e\/lib\/fixtures\/plugins\.mjs$/u, ["fixture-plugin-commands"]],
  [
    /^scripts\/e2e\/lib\/codex-app-server-fixture\.mjs$/u,
    ["codex-media-path-client", "test/e2e/qa-lab/runtime/codex-auth-product-proof.e2e.test.ts"],
  ],
  [
    /^scripts\/e2e\/lib\/incremental-line-reader\.mjs$/u,
    [
      "incremental-line-reader",
      "config-reload-log-scanner",
      "codex-media-path-client",
      "test/e2e/qa-lab/runtime/codex-auth-product-proof.e2e.test.ts",
    ],
  ],
  [
    /^scripts\/e2e\/lib\/fixture\.mjs$/u,
    ["fixture-config", "fixtures-workspace", "fixture-plugin-commands"],
  ],
  [
    /^test\/e2e\/qa-lab\/runtime\/openai-image-auth-docker-client\.ts$/u,
    [
      "openai-image-auth-docker-client",
      "extensions/openai/image-generation-provider.test.ts",
      "src/image-generation/openai-compatible-image-provider.test.ts",
    ],
  ],
  [
    /^test\/e2e\/qa-lab\/runtime\/codex-auth-app-server\.fixture\.mjs$/u,
    ["test/e2e/qa-lab/runtime/codex-auth-product-proof.e2e.test.ts"],
  ],
  [
    /^scripts\/e2e\/lib\/openai-web-search-minimal\/(?:mock-server\.mjs|scenario\.sh)$/u,
    [
      "test/e2e/qa-lab/runtime/openai-web-search-minimal.e2e.test.ts",
      "test/e2e/qa-lab/runtime/openai-web-search-minimal-assertions.e2e.test.ts",
    ],
  ],
  [
    /^scripts\/e2e\/lib\/openwebui\/http-probe\.mjs$/u,
    ["test/e2e/qa-lab/runtime/openwebui-probe.e2e.test.ts"],
  ],
  [
    /^scripts\/e2e\/(?:browser-cdp-snapshot-docker\.sh|lib\/env-limits\.mjs)$/u,
    ["e2e-helper-env-limits"],
  ],
  [/^scripts\/e2e\/skill-install-docker\.sh$/u, ["e2e-shell-tempfiles"]],
  [/^scripts\/e2e\/npm-onboard-channel-agent-docker\.sh$/u, [pluginPrerelease]],
  [
    /^scripts\/e2e\/lib\/clawhub-fixture-server\.cjs$/u,
    ["clawhub-fixture-server", pluginPrerelease],
  ],
  [
    /^scripts\/e2e\/lib\/codex-media-path\/jsonl-request-tail\.mjs$/u,
    ["codex-media-path-client", "test/e2e/qa-lab/runtime/codex-auth-product-proof.e2e.test.ts"],
  ],
  [
    /^scripts\/e2e\/lib\/codex-npm-plugin-live\/assertions\.mjs$/u,
    ["codex-install-assertions", dockerBuild],
  ],
  [
    /^scripts\/e2e\/(?:lib\/openai-chat-tools\/scenario\.sh|openai-chat-tools-docker\.sh)$/u,
    [openaiChatToolsE2e],
  ],
  [/^scripts\/e2e\/lib\/openai-chat-tools\/write-config\.mjs$/u, [openaiChatToolsE2e]],
  [
    /^scripts\/e2e\/openai-web-search-minimal-docker\.sh$/u,
    [
      "test/e2e/qa-lab/runtime/openai-web-search-minimal.e2e.test.ts",
      "test/e2e/qa-lab/runtime/openai-web-search-minimal-assertions.e2e.test.ts",
    ],
  ],
  [
    /^scripts\/e2e\/openwebui-docker\.sh$/u,
    ["test/e2e/qa-lab/runtime/openwebui-probe.e2e.test.ts", "fixture-config"],
  ],
];
function resolveSemanticToolingTargets(changedPath) {
  return SEMANTIC_TOOLING_TARGET_PATTERNS.flatMap(([pattern, owners]) =>
    pattern.test(changedPath) ? resolveToolingTestOwnerTargets(...owners) : [],
  );
}

function resolveGithubYamlGuardTargets(changedPath) {
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/u.test(changedPath)) {
    return GITHUB_YAML_PINNING_GUARD_TEST_TARGETS;
  }
  if (/^\.github\/actions\/.+\.ya?ml$/u.test(changedPath)) {
    return GITHUB_YAML_PINNING_GUARD_TEST_TARGETS;
  }
  return null;
}

function resolveDirectToolingReferenceTests(changedPath, cwd) {
  const normalized = normalizePathPattern(changedPath);
  return (listImportGraphGrepMatches(cwd, normalized, { tooling: true }) ?? []).filter(
    (file) =>
      file !== "test/scripts/test-projects.test.ts" &&
      !file.endsWith(".live.test.ts") &&
      isTestFileTarget(file) &&
      fs
        .readFileSync(path.join(cwd, file), "utf8")
        .match(/[A-Za-z0-9_.@+/-]{4,}/gu)
        ?.includes(normalized),
  );
}

function resolveToolingTestTargets(changedPath, cwd = process.cwd()) {
  if (changedPath.startsWith("test/scripts/") && isTestFileTarget(changedPath)) {
    return [changedPath];
  }
  if (BROAD_CHANGED_FALLBACK_PATTERNS.some((pattern) => pattern.test(changedPath))) {
    return null;
  }
  // Declarations and implementations share the same owner; deriving the
  // sibling also covers newly added script declarations without an inventory.
  const implementationPath = changedPath.endsWith(".d.mts")
    ? changedPath.replace(/\.d\.mts$/u, ".mjs")
    : changedPath;
  const exactOwners = EXACT_TOOLING_TARGETS.get(implementationPath);
  if (exactOwners) {
    return resolveToolingTestOwnerTargets(...exactOwners);
  }
  const semanticTargets = resolveSemanticToolingTargets(implementationPath);
  const facts = getChangedPathFacts(changedPath);
  const hasToolingOwner =
    semanticTargets.length > 0 ||
    facts.surface === "rootTooling" ||
    changedPath === "Dockerfile" ||
    changedPath === ".crabbox.yaml" ||
    changedPath.startsWith(".agents/") ||
    isToolingScriptPath(implementationPath) ||
    (facts.surface === "app" && /\/(?:fastlane|scripts)\//u.test(changedPath)) ||
    (facts.surface === "extension" && /\/(?:scripts\/|package\.json$)/u.test(changedPath)) ||
    (facts.surface === "rootTest" && changedPath.startsWith("test/e2e/qa-lab/"));
  if (!hasToolingOwner) {
    return null;
  }
  const crossOsReleaseTargets =
    implementationPath === "scripts/openclaw-cross-os-release-checks.ts" ||
    implementationPath.startsWith("scripts/lib/cross-os-release-checks/")
      ? ["test/scripts/openclaw-cross-os-release-checks.test.ts"]
      : null;
  const explicitTargets =
    (changedPath === "Dockerfile"
      ? [
          "src/docker-build-cache.test.ts",
          "src/docker-image-digests.test.ts",
          "src/dockerfile.test.ts",
          "test/scripts/test-install-sh-docker.test.ts",
        ]
      : changedPath === ".crabbox.yaml"
        ? ["test/scripts/package-acceptance-workflow.test.ts"]
        : null) ??
    crossOsReleaseTargets ??
    resolveUpgradeSurvivorConfigRecipeTargets(implementationPath) ??
    resolveDocsI18nBehaviorTargets(implementationPath) ??
    resolveDocsI18nGoTargets(implementationPath) ??
    resolveK8sManifestTargets(implementationPath) ??
    resolveParallelsToolingTestTargets(implementationPath);
  const githubYamlGuardTargets = resolveGithubYamlGuardTargets(implementationPath);
  const conventionalTargets = resolveConventionalToolingTestTargets(implementationPath, cwd);
  const hasDirectOwner = Boolean(
    explicitTargets?.length ||
    githubYamlGuardTargets?.length ||
    semanticTargets.length ||
    conventionalTargets?.length,
  );
  const importGraphResult =
    !hasDirectOwner &&
    TOOLING_IMPORTABLE_FILE_EXTENSIONS.some((ext) => implementationPath.endsWith(ext))
      ? resolveAffectedTestsFromTargetedImportScan(implementationPath, cwd, {
          tooling: true,
          direct: true,
        })
      : [];
  const importGraphTargets = importGraphResult ?? [];
  const referenceTargets =
    semanticTargets.length === 0 && (githubYamlGuardTargets || !hasDirectOwner)
      ? resolveDirectToolingReferenceTests(implementationPath, cwd)
      : [];
  const targets = [
    ...(explicitTargets ?? []),
    ...semanticTargets,
    ...(conventionalTargets ?? []),
    ...importGraphTargets,
    ...referenceTargets,
    ...(githubYamlGuardTargets ?? []),
  ];
  if (targets.length > 0) {
    return uniqueOrdered(targets);
  }
  return isToolingScriptPath(implementationPath) || facts.surface === "rootTooling"
    ? [TOOLING_VITEST_CONFIG]
    : null;
}

function shouldUseBroadChangedTargets(env = process.env) {
  const value = env[BROAD_CHANGED_ENV_KEY]?.trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(value ?? "");
}

function isRoutableChangedTarget(changedPath) {
  if (GENERATED_CHANGED_TEST_TARGET_PATTERNS.some((pattern) => pattern.test(changedPath))) {
    return false;
  }
  if (changedPath.endsWith(".live.test.ts")) {
    return false;
  }
  const surface = getChangedPathFacts(changedPath).surface;
  return (
    ["source", "package", "extension", "rootTest"].includes(surface) ||
    changedPath === "ui" ||
    changedPath.startsWith("ui/") ||
    ["src", "test", "extensions", "packages"].includes(changedPath)
  );
}

function resolveSiblingTestTarget(changedPath, cwd) {
  if (!/\.[cm]?tsx?$/u.test(changedPath) || isTestFileTarget(changedPath)) {
    return null;
  }
  const withoutExtension = changedPath.replace(/\.[cm]?tsx?$/u, "");
  const sibling = `${withoutExtension}.test.ts`;
  return fs.existsSync(path.join(cwd, sibling)) ? sibling : null;
}

function shouldCombineSiblingTestWithImportGraph(changedPath) {
  return changedPath.startsWith("test/helpers/");
}

function shouldRouteChangedTargetWithoutImportGraph(changedPath) {
  return changedPath.endsWith(".live.test.ts") || changedPath.startsWith("ui/src/");
}

function resolvePromptSnapshotFixtureTargets(changedPath) {
  if (!/^test\/fixtures\/agents\/prompt-snapshots\/.+\.(?:json|md)$/u.test(changedPath)) {
    return null;
  }
  return ["test/scripts/prompt-snapshots.test.ts"];
}

function resolveAppcastTargets(changedPath) {
  return changedPath === "appcast.xml" ? APPCAST_TEST_TARGETS : null;
}

function resolvePreciseChangedTestTargets(changedPath, options) {
  const cwd = options.cwd ?? process.cwd();
  const mappedTargets =
    SOURCE_TEST_TARGETS.get(changedPath) ??
    resolveToolingTestTargets(changedPath, cwd) ??
    resolveAppcastTargets(changedPath) ??
    resolvePromptSnapshotFixtureTargets(changedPath);
  if (mappedTargets) {
    return mappedTargets;
  }
  if (isRoutableChangedTarget(changedPath) && isTestFileTarget(changedPath)) {
    return [changedPath];
  }
  const siblingTest = resolveSiblingTestTarget(changedPath, cwd);
  if (
    siblingTest &&
    !shouldCombineSiblingTestWithImportGraph(changedPath) &&
    options.combineSiblingWithImportGraph !== true
  ) {
    return [siblingTest];
  }
  if (shouldRouteChangedTargetWithoutImportGraph(changedPath)) {
    return changedPath.startsWith("ui/src/") ? [changedPath] : null;
  }
  if (options.skipImportGraph === true) {
    return null;
  }
  const facts = getChangedPathFacts(changedPath);
  if (
    facts.surface === "source" ||
    facts.surface === "package" ||
    facts.surface === "extension" ||
    changedPath.startsWith("test/helpers/") ||
    changedPath.startsWith("ui/src/") ||
    changedPath.startsWith("ui/config/")
  ) {
    const affectedTests = resolveAffectedTestsFromImportGraph(changedPath, cwd, {
      forceFull: options.forceFullImportGraph === true,
    });
    if (affectedTests.length > 0) {
      return siblingTest ? uniqueOrdered([siblingTest, ...affectedTests]) : affectedTests;
    }
  }
  return siblingTest ? [siblingTest] : null;
}

function isDeletedChangedTestTarget(changedPath, cwd) {
  return isTestFileTarget(changedPath) && !fs.existsSync(path.join(cwd, changedPath));
}

/**
 * Maps changed repo paths to the smallest useful Vitest target plan.
 */
export function resolveChangedTestTargetPlan(changedPaths, options = {}) {
  if (changedPaths.length === 0) {
    return { mode: "none", targets: [] };
  }
  const cwd = options.cwd ?? process.cwd();
  const executableChangedPaths = changedPaths.filter(
    (changedPath) => !isDeletedChangedTestTarget(changedPath, cwd),
  );
  const toolingTargets = resolveToolingChangedTestTargets(executableChangedPaths, cwd);
  if (toolingTargets) {
    return { mode: "targets", targets: toolingTargets };
  }
  const changedLanes = detectChangedLanes(executableChangedPaths);
  const env = options.env ?? {};
  const useBroadFallback = options.broad ?? shouldUseBroadChangedTargets(env);
  const skipImportGraph = changedLanes.lanes.all && !useBroadFallback;
  const targets = [];
  const skippedBroadFallbackPaths = [];
  for (const changedPath of executableChangedPaths) {
    const preciseTargets = resolvePreciseChangedTestTargets(changedPath, {
      ...options,
      skipImportGraph,
    });
    if (preciseTargets) {
      targets.push(...preciseTargets);
      continue;
    }
    const needsBroadFallback = shouldKeepBroadChangedRun([changedPath]) || changedLanes.lanes.all;
    if (needsBroadFallback) {
      if (useBroadFallback) {
        return { mode: "broad", targets: [] };
      }
      skippedBroadFallbackPaths.push(changedPath);
      continue;
    }
    if (isRoutableChangedTarget(changedPath)) {
      targets.push(changedPath);
    }
  }
  if (
    useBroadFallback &&
    options.includeExtensionImpact !== false &&
    changedLanes.extensionImpactFromCore
  ) {
    targets.push("extensions");
  }
  const plan = { mode: "targets", targets: [...new Set(targets)] };
  if (skippedBroadFallbackPaths.length > 0) {
    plan.skippedBroadFallbackPaths = [...new Set(skippedBroadFallbackPaths)];
  }
  return plan;
}

export function listFullExtensionVitestProjectConfigs() {
  return (
    fullSuiteVitestShards.find((shard) => shard.config === FULL_EXTENSIONS_VITEST_CONFIG)
      ?.projects ?? []
  );
}

export function resolveChangedTargetArgs(
  args,
  cwd = process.cwd(),
  listChangedPaths = listChangedPathsFromGit,
  options = {},
) {
  const plan = resolveChangedTestTargetPlanForArgs(args, cwd, listChangedPaths, options);
  if (!plan) {
    return null;
  }
  if (plan.mode === "broad") {
    return null;
  }
  return plan.targets;
}

export function resolveChangedTestTargetPlanForArgs(
  args,
  cwd = process.cwd(),
  listChangedPaths = listChangedPathsFromGit,
  options = {},
) {
  const baseRef = extractChangedBaseRef(args);
  if (!baseRef) {
    return null;
  }
  const changedPaths = listChangedPaths(baseRef, cwd);
  return resolveChangedTestTargetPlan(changedPaths, {
    cwd,
    ...options,
  });
}

function classifyTarget(arg, cwd) {
  const relative = toRepoRelativeTarget(arg, cwd);
  const configTargetKind = resolveVitestConfigTargetKind(relative);
  if (configTargetKind) {
    return configTargetKind;
  }
  if (isAgentsCoreIsolatedTestFile(relative)) {
    return agentVitestProjectOwners.coreIsolated.kind;
  }
  if (isControlUiE2eTarget(relative)) {
    return "uiE2e";
  }
  if (isUiIsolatedTestFile(relative)) {
    return "uiIsolated";
  }
  if (isPathAtOrUnder(relative, "ui/src")) {
    return "ui";
  }
  if (relative.startsWith("src/tui/tui-pty-")) {
    return "tuiPty";
  }
  if (relative.endsWith(".e2e.test.ts")) {
    return "e2e";
  }
  if (
    relative === "src/gateway/gateway.test.ts" ||
    relative === "src/gateway/server.startup-matrix-migration.integration.test.ts" ||
    relative === "src/gateway/sessions-history-http.test.ts"
  ) {
    return "e2e";
  }
  const channelContractKind = resolveChannelContractTargetKind(relative);
  if (channelContractKind) {
    return channelContractKind;
  }
  if (relative.startsWith("src/plugins/contracts/")) {
    return "contractsPlugin";
  }
  if (resolveUnitFastTimerTestIncludePattern(relative)) {
    return "unitFastFakeTimers";
  }
  if (resolveUnitFastIsolatedTestIncludePattern(relative)) {
    return "unitFastIsolated";
  }
  if (resolveUnitFastTestIncludePattern(relative)) {
    return "unitFast";
  }
  if (relative === "extensions") {
    return "extensionFull";
  }
  if (getChangedPathFacts(relative).surface === "extension") {
    const extensionRoot = relative.split("/").slice(0, 2).join("/");
    const splitChannelShard = resolveSplitChannelExtensionShard(extensionRoot);
    if (splitChannelShard) {
      return splitChannelShard.kind;
    }
    if (isProviderOpenAiExtensionRoot(extensionRoot)) {
      return "extensionProviderOpenAi";
    }
    if (isQaExtensionRoot(extensionRoot)) {
      return "extensionQa";
    }
    if (isChannelSurfaceTestFile(relative)) {
      return "extensionChannel";
    }
    if (isAcpxExtensionRoot(extensionRoot)) {
      return "extensionAcpx";
    }
    if (isActiveMemoryExtensionRoot(extensionRoot)) {
      return "extensionActiveMemory";
    }
    if (isCodexExtensionRoot(extensionRoot)) {
      return "extensionCodex";
    }
    if (isDiffsExtensionRoot(extensionRoot)) {
      return "extensionDiffs";
    }
    if (isBrowserExtensionRoot(extensionRoot)) {
      return "extensionBrowser";
    }
    if (isFeishuExtensionRoot(extensionRoot)) {
      return "extensionFeishu";
    }
    if (isIrcExtensionRoot(extensionRoot)) {
      return "extensionIrc";
    }
    if (isMattermostExtensionRoot(extensionRoot)) {
      return "extensionMattermost";
    }
    if (isTelegramExtensionRoot(extensionRoot)) {
      return "extensionTelegram";
    }
    if (isVoiceCallExtensionRoot(extensionRoot)) {
      return "extensionVoiceCall";
    }
    if (isWhatsAppExtensionRoot(extensionRoot)) {
      return "extensionWhatsApp";
    }
    if (isZaloExtensionRoot(extensionRoot)) {
      return "extensionZalo";
    }
    if (isMatrixExtensionRoot(extensionRoot)) {
      return "extensionMatrix";
    }
    if (isMediaExtensionRoot(extensionRoot)) {
      return "extensionMedia";
    }
    if (isMemoryExtensionRoot(extensionRoot)) {
      return "extensionMemory";
    }
    if (isMsTeamsExtensionRoot(extensionRoot)) {
      return "extensionMsTeams";
    }
    if (isMessagingExtensionRoot(extensionRoot)) {
      return "extensionMessaging";
    }
    if (isMiscExtensionRoot(extensionRoot)) {
      return "extensionMisc";
    }
    return isProviderExtensionRoot(extensionRoot) ? "extensionProvider" : "extension";
  }
  if (isChannelSurfaceTestFile(relative)) {
    return "channel";
  }
  if (isBoundaryTestFile(relative)) {
    return "boundary";
  }
  if (isToolingIsolatedTestFile(relative)) {
    return "toolingIsolated";
  }
  if (relative === TOOLING_DOCKER_TEST_TARGET) {
    return "toolingDocker";
  }
  if (
    relative.startsWith("test/") ||
    relative === "src/scripts" ||
    relative.startsWith("src/scripts/") ||
    relative === "src/config/doc-baseline.integration.test.ts" ||
    relative === "src/config/schema.base.generated.test.ts" ||
    relative === "src/config/schema.help.quality.test.ts"
  ) {
    return "tooling";
  }
  if (isBundledPluginDependentUnitTestFile(relative)) {
    return "bundled";
  }
  if (isPathAtOrUnder(relative, "src/channels")) {
    return "channel";
  }
  if (isPathAtOrUnder(relative, "src/gateway")) {
    return "gateway";
  }
  if (
    isPathAtOrUnder(relative, "packages/gateway-client") ||
    isPathAtOrUnder(relative, "packages/gateway-protocol")
  ) {
    return "gatewayClient";
  }
  if (isPathAtOrUnder(relative, "src/hooks")) {
    return "hooks";
  }
  if (isPathAtOrUnder(relative, "src/infra")) {
    return "infra";
  }
  if (isPathAtOrUnder(relative, "src/config")) {
    return "runtimeConfig";
  }
  if (isPathAtOrUnder(relative, "src/cron")) {
    return "cron";
  }
  if (isPathAtOrUnder(relative, "src/daemon")) {
    return "daemon";
  }
  if (isPathAtOrUnder(relative, "src/media-understanding")) {
    return "mediaUnderstanding";
  }
  if (isPathAtOrUnder(relative, "src/media")) {
    return "media";
  }
  if (isPathAtOrUnder(relative, "src/logging")) {
    return "logging";
  }
  if (isPathAtOrUnder(relative, "src/plugin-sdk")) {
    return isPluginSdkLightTarget(relative) ? "pluginSdkLight" : "pluginSdk";
  }
  if (isPathAtOrUnder(relative, "src/process")) {
    return "process";
  }
  if (isPathAtOrUnder(relative, "src/secrets")) {
    return "secrets";
  }
  if (isPathAtOrUnder(relative, "src/shared")) {
    return "sharedCore";
  }
  if (isPathAtOrUnder(relative, "src/tasks")) {
    return "tasks";
  }
  if (isPathAtOrUnder(relative, "src/tui")) {
    return "tui";
  }
  if (isPathAtOrUnder(relative, "src/acp")) {
    return "acp";
  }
  if (isCliProcessTestFile(relative)) {
    return "cliProcess";
  }
  if (isPathAtOrUnder(relative, "src/cli")) {
    return "cli";
  }
  if (isPathAtOrUnder(relative, "src/commands")) {
    return isCommandsLightTarget(relative) ? "commandLight" : "command";
  }
  if (isPathAtOrUnder(relative, "src/auto-reply")) {
    return "autoReply";
  }
  if (isPathAtOrUnder(relative, agentVitestProjectOwners.all.root)) {
    // Focused runs must preserve the full suite's isolated harness and hook-timeout contracts.
    if (
      relative === agentVitestProjectOwners.all.root ||
      relative === AGENTS_EMBEDDED_AGENT_TEST_ROOT
    ) {
      return agentVitestProjectOwners.all.kind;
    }
    if (agentVitestProjectOwners.embeddedIncompleteTurn.include.includes(relative)) {
      return agentVitestProjectOwners.embeddedIncompleteTurn.kind;
    }
    if (agentVitestProjectOwners.embeddedOverflowCompaction.include.includes(relative)) {
      return agentVitestProjectOwners.embeddedOverflowCompaction.kind;
    }
    if (isPathAtOrUnder(relative, agentVitestProjectOwners.embeddedRun.root)) {
      return agentVitestProjectOwners.embeddedRun.kind;
    }
    if (isPathAtOrUnder(relative, AGENTS_EMBEDDED_AGENT_TEST_ROOT)) {
      return isGlobTarget(relative)
        ? agentVitestProjectOwners.all.kind
        : agentVitestProjectOwners.embedded.kind;
    }
    if (isPathAtOrUnder(relative, agentVitestProjectOwners.tools.root)) {
      return agentVitestProjectOwners.tools.kind;
    }
    if (isGlobTarget(relative)) {
      const owner = relative.slice(agentVitestProjectOwners.all.root.length + 1).split("/", 1)[0];
      return isGlobTarget(owner)
        ? agentVitestProjectOwners.all.kind
        : agentVitestProjectOwners.support.kind;
    }
    return isFileLikeTarget(relative) &&
      path.posix.dirname(relative) === agentVitestProjectOwners.core.root
      ? agentVitestProjectOwners.core.kind
      : agentVitestProjectOwners.support.kind;
  }
  if (isPathAtOrUnder(relative, "src/plugins")) {
    return "plugin";
  }
  if (isPathAtOrUnder(relative, "src/utils")) {
    return "utils";
  }
  if (isPathAtOrUnder(relative, "src/wizard")) {
    return "wizard";
  }
  return "default";
}

function resolveLightLaneIncludePatterns(kind, targetArg, cwd) {
  const relative = toRepoRelativeTarget(targetArg, cwd);
  if (kind === "unitFast") {
    const includePattern = resolveUnitFastTestIncludePattern(relative);
    return includePattern ? [includePattern] : null;
  }
  if (kind === "unitFastFakeTimers") {
    const includePattern = resolveUnitFastTimerTestIncludePattern(relative);
    return includePattern ? [includePattern] : null;
  }
  if (kind === "unitFastIsolated") {
    const includePattern = resolveUnitFastIsolatedTestIncludePattern(relative);
    return includePattern ? [includePattern] : null;
  }
  if (kind === "pluginSdkLight") {
    const includePattern = resolvePluginSdkLightIncludePattern(relative);
    return includePattern ? [includePattern] : null;
  }
  if (kind === "commandLight") {
    const includePattern = resolveCommandsLightIncludePattern(relative);
    return includePattern ? [includePattern] : null;
  }
  return null;
}

function shouldUseWholeConfigTarget(kind, targetArg, cwd) {
  if (isVitestConfigTargetForKind(kind, targetArg, cwd)) {
    return true;
  }
  if (kind === "uiE2e") {
    const relative = toRepoRelativeTarget(targetArg, cwd);
    return relative === "ui/src/test-helpers/control-ui-e2e.ts";
  }
  if (kind !== "ui") {
    return false;
  }
  const relative = toRepoRelativeTarget(targetArg, cwd);
  if (isTestFileTarget(relative)) {
    return false;
  }
  return relative.startsWith("ui/src/");
}

function createVitestArgs(params) {
  return [
    "exec",
    "node",
    ...resolveVitestNodeArgs(params.env),
    resolveVitestCliEntry(),
    ...(params.watchMode ? [] : ["run"]),
    "--config",
    params.config,
    ...(params.config === UI_E2E_VITEST_CONFIG ? ["--configLoader", "runner"] : []),
    ...params.forwardedArgs,
  ];
}

export function createVitestPreflightPnpmArgs(config) {
  if (config !== UI_E2E_VITEST_CONFIG) {
    return null;
  }
  return ["exec", "node", "scripts/ensure-playwright-chromium.mjs"];
}

export function parseTestProjectsArgs(args, cwd = process.cwd()) {
  const forwardedArgs = [];
  const targetArgs = [];
  let watchMode = false;
  let passthrough = false;

  for (const arg of args) {
    if (arg === "--") {
      if (targetArgs.length > 0) {
        passthrough = true;
      }
      continue;
    }
    if (passthrough) {
      if (arg === "--watch") {
        watchMode = true;
      }
      forwardedArgs.push(arg);
      continue;
    }
    if (arg === "--watch") {
      watchMode = true;
      continue;
    }
    if (isPathLikeTargetArg(arg, cwd)) {
      targetArgs.push(arg);
    }
    forwardedArgs.push(arg);
  }

  return { forwardedArgs, targetArgs, watchMode };
}

export function buildVitestRunPlans(
  args,
  cwd = process.cwd(),
  listChangedPaths = listChangedPathsFromGit,
  options = {},
) {
  const { forwardedArgs, targetArgs, watchMode } = parseTestProjectsArgs(args, cwd);
  const changedTargetArgs =
    targetArgs.length === 0 ? resolveChangedTargetArgs(args, cwd, listChangedPaths, options) : null;
  const requestedTargetArgs = changedTargetArgs ?? targetArgs;
  const activeTargetArgs = expandBroadToolingScriptTargets(
    expandExplicitSourceTestTargets(requestedTargetArgs, cwd),
    cwd,
    watchMode,
  );
  const activeForwardedArgs =
    changedTargetArgs !== null ? stripChangedArgs(forwardedArgs) : forwardedArgs;
  if (changedTargetArgs !== null && activeTargetArgs.length === 0) {
    return [];
  }
  if (activeTargetArgs.length === 0) {
    return [
      {
        config: DEFAULT_VITEST_CONFIG,
        forwardedArgs: activeForwardedArgs,
        includePatterns: null,
        watchMode,
      },
    ];
  }

  const nonTargetArgs = activeForwardedArgs.filter((arg) => !requestedTargetArgs.includes(arg));
  const explicitConfigTargets = activeTargetArgs.map((targetArg) =>
    toRepoRelativeTarget(targetArg, cwd),
  );
  if (explicitConfigTargets.every(isVitestConfigFileTarget)) {
    if (watchMode && explicitConfigTargets.length > 1) {
      throw new Error(
        "watch mode with mixed test suites is not supported; target one suite at a time or use a dedicated suite command",
      );
    }
    return explicitConfigTargets.map((config) => ({
      config,
      forwardedArgs: nonTargetArgs,
      includePatterns: null,
      watchMode,
    }));
  }

  const groupedTargets = new Map();
  for (const targetArg of activeTargetArgs) {
    if (!watchMode && toRepoRelativeTarget(targetArg, cwd) === AGENTS_EMBEDDED_AGENT_TEST_ROOT) {
      // The recursive parent spans four harness owners; keep every isolated project intact.
      for (const { kind, include: targets } of embeddedAgentVitestProjectOwners) {
        const current = groupedTargets.get(kind) ?? [];
        for (const target of targets) {
          if (!current.includes(target)) {
            current.push(target);
          }
        }
        groupedTargets.set(kind, current);
      }
      continue;
    }

    const kind = classifyTarget(targetArg, cwd);
    const current = groupedTargets.get(kind) ?? [];
    current.push(targetArg);
    groupedTargets.set(kind, current);
  }
  const toolingTargets = groupedTargets.get("tooling") ?? [];
  if (
    !watchMode &&
    toolingTargets.some((targetArg) =>
      includePatternMatchesAnyFile(toScopedIncludePattern(targetArg, cwd), [
        TOOLING_DOCKER_TEST_TARGET,
      ]),
    )
  ) {
    const current = groupedTargets.get("toolingDocker") ?? [];
    if (!current.includes(TOOLING_DOCKER_TEST_TARGET)) {
      current.push(TOOLING_DOCKER_TEST_TARGET);
      groupedTargets.set("toolingDocker", current);
    }
  }
  const impliedToolingIsolatedTargets = !watchMode
    ? toolingIsolatedTestFiles.filter((file) =>
        toolingTargets.some((targetArg) =>
          includePatternMatchesAnyFile(toScopedIncludePattern(targetArg, cwd), [file]),
        ),
      )
    : [];
  if (impliedToolingIsolatedTargets.length > 0) {
    const current = groupedTargets.get("toolingIsolated") ?? [];
    for (const target of impliedToolingIsolatedTargets) {
      if (!current.includes(target)) {
        current.push(target);
      }
    }
    groupedTargets.set("toolingIsolated", current);
  }
  const uiTargets = groupedTargets.get("ui") ?? [];
  const impliedUiIsolatedTargets = uiIsolatedTestFiles.filter((file) =>
    uiTargets.some((targetArg) =>
      includePatternMatchesAnyFile(toScopedIncludePattern(targetArg, cwd), [file]),
    ),
  );
  if (impliedUiIsolatedTargets.length > 0) {
    const current = groupedTargets.get("uiIsolated") ?? [];
    for (const target of impliedUiIsolatedTargets) {
      if (!current.includes(target)) {
        current.push(target);
      }
    }
    groupedTargets.set("uiIsolated", current);
  }
  const cliTargets = groupedTargets.get("cli") ?? [];
  const impliedCliProcessTargets = cliProcessTestFiles.filter((file) =>
    cliTargets.some((targetArg) =>
      includePatternMatchesAnyFile(toScopedIncludePattern(targetArg, cwd), [file]),
    ),
  );
  if (impliedCliProcessTargets.length > 0) {
    const current = groupedTargets.get("cliProcess") ?? [];
    for (const target of impliedCliProcessTargets) {
      if (!current.includes(target)) {
        current.push(target);
      }
    }
    groupedTargets.set("cliProcess", current);
  }

  if (watchMode && groupedTargets.size > 1) {
    throw new Error(
      "watch mode with mixed test suites is not supported; target one suite at a time or use a dedicated suite command",
    );
  }

  const orderedKinds = Object.keys(VITEST_CONFIG_BY_KIND);
  orderedKinds.splice(orderedKinds.indexOf("boundary"), 0, "default");
  const plans = [];
  for (const kind of orderedKinds) {
    const grouped = groupedTargets.get(kind);
    if (!grouped || grouped.length === 0) {
      continue;
    }
    if (kind === "extensionFull") {
      const configs = watchMode
        ? [FULL_EXTENSIONS_VITEST_CONFIG]
        : listFullExtensionVitestProjectConfigs();
      for (const config of configs) {
        const plan = {
          config,
          forwardedArgs: nonTargetArgs,
          includePatterns: null,
          watchMode,
        };
        const boundedPlans = createBoundedExtensionPlans({
          config,
          forwardedArgs: nonTargetArgs,
          roots: matrixExtensionTestRoots,
          watchMode,
        });
        plans.push(...(boundedPlans ?? [plan]));
      }
      continue;
    }
    const config = VITEST_CONFIG_BY_KIND[kind] ?? DEFAULT_VITEST_CONFIG;
    const useCliTargetArgs =
      kind === "e2e" ||
      (kind === "default" &&
        grouped.every((targetArg) => isFileLikeTarget(toRepoRelativeTarget(targetArg, cwd))));
    const useWholeConfigTarget = grouped.some((targetArg) =>
      shouldUseWholeConfigTarget(kind, targetArg, cwd),
    );
    const includePatterns = useCliTargetArgs
      ? null
      : useWholeConfigTarget
        ? null
        : uniqueOrdered(
            grouped.flatMap((targetArg) => {
              const lightLanePatterns = resolveLightLaneIncludePatterns(kind, targetArg, cwd);
              return lightLanePatterns ?? [toScopedIncludePattern(targetArg, cwd)];
            }),
          );
    const scopedTargetArgs = useCliTargetArgs ? uniqueOrdered(grouped) : [];
    const forwardedPlanArgs = [...nonTargetArgs, ...scopedTargetArgs];
    const broadToolingScriptPlans = createBroadToolingScriptPlans({
      config,
      cwd,
      forwardedArgs: forwardedPlanArgs,
      includePatterns,
      watchMode,
    });
    if (broadToolingScriptPlans) {
      plans.push(...broadToolingScriptPlans);
      continue;
    }
    const boundedExtensionRoots = grouped.flatMap((targetArg) => {
      const root = toRepoRelativeTarget(targetArg, cwd);
      return isMatrixExtensionRoot(root) && isExistingDirectoryTarget(targetArg, cwd) ? [root] : [];
    });
    const boundedRootsCoverGroupedTargets = grouped.every((targetArg) => {
      const relativeTarget = toRepoRelativeTarget(targetArg, cwd);
      return boundedExtensionRoots.some(
        (root) => relativeTarget === root || relativeTarget.startsWith(`${root}/`),
      );
    });
    const boundedExtensionPlans =
      boundedExtensionRoots.length > 0 && boundedRootsCoverGroupedTargets
        ? createBoundedExtensionPlans({
            config,
            forwardedArgs: forwardedPlanArgs,
            roots: boundedExtensionRoots,
            watchMode,
          })
        : null;
    if (boundedExtensionPlans) {
      plans.push(...boundedExtensionPlans);
      continue;
    }
    plans.push({
      config,
      forwardedArgs: forwardedPlanArgs,
      includePatterns,
      watchMode,
    });
  }
  return plans;
}

export function buildFullSuiteVitestRunPlans(args, cwd = process.cwd()) {
  const { forwardedArgs, targetArgs, watchMode } = parseTestProjectsArgs(args, cwd);
  if (watchMode) {
    return [
      {
        config: "vitest.config.ts",
        forwardedArgs,
        includePatterns: null,
        watchMode,
      },
    ];
  }
  const parallelShardCount = parsePositiveInt(
    process.env.OPENCLAW_TEST_PROJECTS_PARALLEL,
    "OPENCLAW_TEST_PROJECTS_PARALLEL",
  );
  const expandToProjectConfigs =
    process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS === "1" ||
    (Number.isFinite(parallelShardCount) && parallelShardCount > 1) ||
    shouldExpandLocalFullSuiteShardsByDefault(process.env);
  return fullSuiteVitestShards.flatMap((shard) => {
    if (
      process.env.OPENCLAW_TEST_SKIP_FULL_EXTENSIONS_SHARD === "1" &&
      shard.config === FULL_EXTENSIONS_VITEST_CONFIG
    ) {
      return [];
    }
    // The remote Testbox full gate runs every agentic and extension project in one process tree.
    // Bound project and worker lifetimes before either aggregate reaches V8's heap limit.
    const expandShard =
      expandToProjectConfigs ||
      (process.env.OPENCLAW_TESTBOX_REMOTE_RUN === "1" &&
        (shard.config === FULL_AGENTIC_VITEST_CONFIG ||
          shard.config === FULL_EXTENSIONS_VITEST_CONFIG));
    const configs = expandShard ? shard.projects : [shard.config];
    return configs.flatMap((config) => {
      if (expandShard && targetArgs.length === 0) {
        let chunks = [];
        if (config === AGENTS_CORE_VITEST_CONFIG) {
          // A single non-isolated agents-core process grows until its worker can
          // exit under the full-suite memory load. Bound each process lifetime.
          chunks = splitTargetChunks(
            listAgentsCoreFullSuiteTestTargets(cwd),
            FULL_SUITE_AGENTS_CORE_TEST_TARGET_CHUNK_COUNT,
          );
        } else if (config === UNIT_FAST_VITEST_CONFIG) {
          const targets = listUnitFastFullSuiteTestTargets();
          const chunkCount = Math.ceil(
            targets.length / FULL_SUITE_UNIT_FAST_TEST_TARGET_CHUNK_SIZE,
          );
          chunks = splitTargetChunks(targets, chunkCount);
        } else if (config === TOOLING_VITEST_CONFIG) {
          // Tooling tests spawn package managers and native helpers. Keep native
          // process lifetime short enough that unrelated files cannot crash together.
          const targets = listToolingFullSuiteTestTargets(cwd);
          const chunkCount = Math.ceil(targets.length / FULL_SUITE_TOOLING_TEST_TARGET_CHUNK_SIZE);
          chunks = splitTargetChunks(targets, chunkCount);
        } else if (config === GATEWAY_SERVER_VITEST_CONFIG) {
          chunks = splitTargetChunks(
            listGatewayServerTestTargets(cwd),
            GATEWAY_SERVER_TEST_PROCESS_COUNT,
          );
        } else if (config === EXTENSION_MATRIX_VITEST_CONFIG) {
          chunks = createExtensionTestProcessTargetChunks(
            config,
            matrixExtensionTestRoots,
            forwardedArgs,
          );
        }
        if (chunks.length > 0) {
          return chunks.map((targets) => ({
            config,
            forwardedArgs: [...forwardedArgs, ...targets],
            includePatterns: null,
            watchMode: false,
          }));
        }
      }
      return [
        {
          config,
          forwardedArgs,
          includePatterns: null,
          watchMode: false,
        },
      ];
    });
  });
}

function shouldUseLocalFullSuiteParallelByDefault(env = process.env) {
  if (hasConservativeVitestWorkerBudget(env)) {
    return false;
  }
  return env.OPENCLAW_TEST_PROJECTS_SERIAL !== "1" && !isCiLikeEnv(env);
}

function shouldExpandLocalFullSuiteShardsByDefault(env = process.env) {
  return !isCiLikeEnv(env);
}

function parsePositiveInt(value, label) {
  const text = value?.trim();
  if (!text) {
    return null;
  }
  if (!/^\d+$/u.test(text)) {
    throw new Error(`${label} must be a positive integer; got: ${value}`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer; got: ${value}`);
  }
  return parsed;
}

function hasConservativeVitestWorkerBudget(env) {
  const workerBudget = parsePositiveInt(
    env.OPENCLAW_VITEST_MAX_WORKERS ?? env.OPENCLAW_TEST_WORKERS,
    env.OPENCLAW_VITEST_MAX_WORKERS === undefined
      ? "OPENCLAW_TEST_WORKERS"
      : "OPENCLAW_VITEST_MAX_WORKERS",
  );
  return workerBudget !== null && workerBudget <= 1;
}

const FULL_EXTENSIONS_CONFIG = "test/vitest/vitest.full-extensions.config.ts";
const FULL_EXTENSIONS_MIN_HEAP_MB = 8192;

function ensureMaxOldSpaceSize(nodeOptions, minimumMb) {
  const normalized = nodeOptions?.trim() ?? "";
  const matches = Array.from(
    normalized.matchAll(/(^|\s)--max[-_]old[-_]space[-_]size(?:=|\s+)(\d+)(?=\s|$)/gu),
  );
  const match = matches.at(-1);
  if (!match) {
    return [normalized, `--max-old-space-size=${minimumMb}`].filter(Boolean).join(" ");
  }
  const currentMb = Number(match[2]);
  if (Number.isSafeInteger(currentMb) && currentMb >= minimumMb) {
    return normalized;
  }
  const start = match.index;
  const replacement = match[0].replace(/\d+$/u, String(minimumMb));
  return `${normalized.slice(0, start)}${replacement}${normalized.slice(start + match[0].length)}`;
}

export function applyFullExtensionsHeapBudget(specs, params = {}) {
  const baseEnv = params.env ?? {};
  return specs.map((spec) =>
    spec.config === FULL_EXTENSIONS_CONFIG
      ? {
          ...spec,
          env: {
            ...spec.env,
            NODE_OPTIONS: ensureMaxOldSpaceSize(
              spec.env?.NODE_OPTIONS ?? baseEnv.NODE_OPTIONS,
              FULL_EXTENSIONS_MIN_HEAP_MB,
            ),
          },
        }
      : spec,
  );
}

export function resolveParallelFullSuiteConcurrency(specCount, envInput, hostInfo) {
  let env = envInput;
  env ??= process.env;
  const override = parsePositiveInt(
    env.OPENCLAW_TEST_PROJECTS_PARALLEL,
    "OPENCLAW_TEST_PROJECTS_PARALLEL",
  );
  if (override !== null) {
    return Math.min(override, specCount);
  }
  if (env.OPENCLAW_TEST_PROJECTS_SERIAL === "1") {
    return 1;
  }
  if (isCiLikeEnv(env)) {
    return 1;
  }
  if (hasConservativeVitestWorkerBudget(env)) {
    return 1;
  }
  if (
    env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS !== "1" &&
    !shouldUseLocalFullSuiteParallelByDefault(env)
  ) {
    return 1;
  }
  return Math.min(resolveLocalFullSuiteProfile(env, hostInfo).shardParallelism, specCount);
}

function sanitizeVitestCachePathSegment(value) {
  return (
    value
      .replace(/[^a-zA-Z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 180) || "default"
  );
}

export function applyParallelVitestCachePaths(specs, params = {}) {
  const baseEnv = params.env ?? process.env;
  const cwd = params.cwd ?? process.cwd();
  const configuredCacheRoot = baseEnv[FS_MODULE_CACHE_PATH_ENV_KEY]?.trim() || undefined;
  // CI publishes a persistent cache root, not a writer-safe leaf. Every
  // concurrent Vitest process still needs its own live directory below it.
  const cacheRoot =
    configuredCacheRoot ?? path.join(cwd, "node_modules", ".experimental-vitest-cache");
  return specs.map((spec, index) => {
    const specCachePath = spec.env?.[FS_MODULE_CACHE_PATH_ENV_KEY]?.trim();
    if (specCachePath && specCachePath !== configuredCacheRoot) {
      return spec;
    }
    const cacheSegment = sanitizeVitestCachePathSegment(`${index}-${spec.config}`);
    return {
      ...spec,
      env: {
        ...spec.env,
        [FS_MODULE_CACHE_PATH_ENV_KEY]: path.join(cacheRoot, cacheSegment),
      },
    };
  });
}

export function applyDefaultMultiSpecVitestCachePaths(specs, params = {}) {
  if (specs.length <= 1 || specs.some((spec) => spec.watchMode)) {
    return specs;
  }
  return applyParallelVitestCachePaths(specs, params);
}

export function applyDefaultVitestNoOutputTimeout(specs, params = {}) {
  const baseEnv = params.env ?? process.env;
  if (
    Object.hasOwn(baseEnv, VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY) &&
    Object.hasOwn(baseEnv, VITEST_NO_OUTPUT_HEARTBEAT_ENV_KEY)
  ) {
    return specs;
  }
  return specs.map((spec) => {
    if (spec.watchMode) {
      return spec;
    }
    const env = spec.env ?? {};
    const nextEnv = { ...env };
    if (
      !Object.hasOwn(baseEnv, VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY) &&
      !Object.hasOwn(env, VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY)
    ) {
      nextEnv[VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY] = resolveTestProjectsVitestNoOutputTimeoutMs(
        spec.config,
      );
    }
    if (
      !Object.hasOwn(baseEnv, VITEST_NO_OUTPUT_HEARTBEAT_ENV_KEY) &&
      !Object.hasOwn(env, VITEST_NO_OUTPUT_HEARTBEAT_ENV_KEY)
    ) {
      nextEnv[VITEST_NO_OUTPUT_HEARTBEAT_ENV_KEY] =
        DEFAULT_TEST_PROJECTS_VITEST_NO_OUTPUT_HEARTBEAT_MS;
    }
    return {
      ...spec,
      env: nextEnv,
    };
  });
}

export function shouldRetryVitestNoOutputTimeout(env = process.env) {
  const value = env[VITEST_NO_OUTPUT_RETRY_ENV_KEY]?.trim().toLowerCase();
  if (value === undefined && isCiLikeEnv(env)) {
    return false;
  }
  return !["0", "false", "no", "off"].includes(value ?? "");
}

// Shards may pin a short no-output window so the known warm-cache stall dies
// fast (see AGENTS_CORE_RUNTIME_ENV in ci-node-test-plan.mjs). A cold Vitest
// module cache makes those same imports legitimately silent for minutes, so
// the retry attempt must get the full watchdog window or it re-dies at the
// short limit and the job fails without ever running a test.
const RETRY_NO_OUTPUT_TIMEOUT_FLOOR_MS = 300_000;

export function withRetryNoOutputTimeout(spec) {
  const current = Number(spec.env?.[VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY]);
  if (!Number.isFinite(current) || current <= 0 || current >= RETRY_NO_OUTPUT_TIMEOUT_FLOOR_MS) {
    return spec;
  }
  return {
    ...spec,
    env: {
      ...spec.env,
      [VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY]: String(RETRY_NO_OUTPUT_TIMEOUT_FLOOR_MS),
    },
  };
}

export function createVitestRunSpecs(args, params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const baseEnv = params.baseEnv ?? process.env;
  const plans = filterPlansForContractIncludeFile(
    buildVitestRunPlans(args, cwd, listChangedPathsFromGit, { env: baseEnv }),
    baseEnv,
  );
  return plans.map((plan, index) => {
    const includeFilePath = plan.includePatterns
      ? path.join(
          params.tempDir ?? os.tmpdir(),
          `openclaw-vitest-include-${randomUUID()}-${index}.json`,
        )
      : null;
    return {
      config: plan.config,
      env: includeFilePath
        ? {
            ...baseEnv,
            [INCLUDE_FILE_ENV_KEY]: includeFilePath,
          }
        : baseEnv,
      includeFilePath,
      includePatterns: plan.includePatterns,
      pnpmArgs: createVitestArgs(plan),
      preflightPnpmArgs: createVitestPreflightPnpmArgs(plan.config),
      watchMode: plan.watchMode,
    };
  });
}

function loadIncludePatternsForSpecFilter(env) {
  const filePath = env[INCLUDE_FILE_ENV_KEY]?.trim();
  if (!filePath) {
    return null;
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((value) => typeof value === "string" && value.length > 0);
}

function includePatternMatchesConfig(candidate, configPatterns) {
  return configPatterns.some(
    (pattern) => path.matchesGlob(candidate, pattern) || path.matchesGlob(pattern, candidate),
  );
}

function filterPlansForContractIncludeFile(plans, env) {
  const includePatterns = loadIncludePatternsForSpecFilter(env);
  if (!includePatterns) {
    return plans;
  }
  return plans.filter((plan) => {
    const configPatterns = CHANNEL_CONTRACT_CONFIG_PATTERNS.get(plan.config);
    if (!configPatterns) {
      return true;
    }
    return includePatterns.some((candidate) =>
      includePatternMatchesConfig(candidate, configPatterns),
    );
  });
}

export function shouldAcquireLocalHeavyCheckLock(runSpecs, env = process.env) {
  if (env.OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD === "1") {
    return false;
  }

  if (env.OPENCLAW_TEST_PROJECTS_FORCE_LOCK === "1") {
    return true;
  }

  return !(
    runSpecs.length === 1 &&
    (runSpecs[0]?.config === TOOLING_VITEST_CONFIG ||
      runSpecs[0]?.config === TOOLING_ISOLATED_VITEST_CONFIG) &&
    runSpecs[0]?.watchMode === false &&
    Array.isArray(runSpecs[0]?.includePatterns) &&
    runSpecs[0].includePatterns.length > 0
  );
}

function expandVitestIncludePatterns(includePatterns, cwd) {
  const candidateFiles = includePatterns.some(isGlobTarget)
    ? listExplicitTestTargetFilesForCwd(cwd)
    : [];
  return uniqueOrdered(
    includePatterns.flatMap((pattern) => {
      if (!isGlobTarget(pattern)) {
        return [pattern];
      }
      return candidateFiles.filter((file) => path.matchesGlob(file, pattern));
    }),
  );
}

export function writeVitestIncludeFile(filePath, includePatterns, options = {}) {
  // Shared Vitest projects intersect this file with their ownership globs.
  // One-shot runs emit concrete paths; watch runs retain globs for new files.
  const expandedPatterns =
    options.expandGlobs === false
      ? includePatterns
      : expandVitestIncludePatterns(includePatterns, options.cwd ?? process.cwd());
  fs.writeFileSync(filePath, `${JSON.stringify(expandedPatterns, null, 2)}\n`);
}

function shellQuote(value) {
  const text = `${value}`;
  if (text === "") {
    return "''";
  }
  if (/^[A-Za-z0-9_./:=@%+-]+$/u.test(text)) {
    return text;
  }
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function formatFailedShardRerunCommand(failure) {
  const includePatterns = failure.includePatterns ?? [];
  if (includePatterns.length > 0) {
    return ["pnpm", "test", ...includePatterns.map(shellQuote), "--", "--reporter=verbose"].join(
      " ",
    );
  }
  return [
    "node",
    "scripts/run-vitest.mjs",
    "run",
    "--config",
    shellQuote(failure.config),
    "--reporter=verbose",
  ].join(" ");
}

function formatFailedShardStatus(failure) {
  const details = [];
  if (failure.code !== undefined && failure.code !== null) {
    details.push(`exit ${failure.code}`);
  }
  if (failure.signal) {
    details.push(`signal ${failure.signal}`);
  }
  if (failure.noOutputTimedOut) {
    details.push("no-output timeout");
  }
  return details.length > 0 ? ` (${details.join(", ")})` : "";
}

export function formatFailedShardDigest(failures, options = {}) {
  if (failures.length === 0) {
    return [];
  }

  const limit = options.limit ?? FAILED_SHARD_DIGEST_LIMIT;
  const orderedFailures = failures.toSorted((left, right) => {
    const leftOrder = typeof left.order === "number" ? left.order : Number.MAX_SAFE_INTEGER;
    const rightOrder = typeof right.order === "number" ? right.order : Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.config.localeCompare(right.config);
  });
  const shown = orderedFailures.slice(0, limit);
  const lines = [`[test] failed shard digest (${failures.length}):`];
  for (const failure of shown) {
    const includes =
      failure.includePatterns?.length > 0
        ? ` includes=${failure.includePatterns.map(shellQuote).join(",")}`
        : "";
    lines.push(`[test] - ${failure.config}${formatFailedShardStatus(failure)}${includes}`);
    lines.push(`[test]   rerun: ${formatFailedShardRerunCommand(failure)}`);
  }
  if (shown.length < failures.length) {
    lines.push(`[test] - ... ${failures.length - shown.length} more failed shard(s) omitted`);
  }
  return lines;
}

export function buildVitestArgs(args, cwd = process.cwd()) {
  const [plan] = buildVitestRunPlans(args, cwd);
  if (!plan) {
    return createVitestArgs({
      config: DEFAULT_VITEST_CONFIG,
      forwardedArgs: [],
      watchMode: false,
    });
  }
  return createVitestArgs(plan);
}
