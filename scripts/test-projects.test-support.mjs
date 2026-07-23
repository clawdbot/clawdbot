// Test-project planning helpers used by scripts/run-vitest.mjs,
// scripts/test-projects.mjs, and focused tests. Exports are intentionally
// granular so project selection stays testable without spawning Vitest.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  agentsCoreIsolatedTestFiles,
  isAgentsCoreIsolatedTestFile,
} from "../test/vitest/vitest.agents-paths.mjs";
import { isChannelSurfaceTestFile } from "../test/vitest/vitest.channel-paths.mjs";
import {
  commandsLightTestFiles,
  isCommandsLightTarget,
  resolveCommandsLightIncludePattern,
} from "../test/vitest/vitest.commands-light-paths.mjs";
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
import { isCiLikeEnv, resolveLocalFullSuiteProfile } from "./lib/vitest-local-scheduling.mjs";
import {
  DEFAULT_VITEST_NO_OUTPUT_HEARTBEAT_MS,
  resolveDefaultVitestNoOutputTimeoutMs,
  resolveVitestCliEntry,
  resolveVitestNodeArgs,
} from "./run-vitest.mjs";

const DEFAULT_VITEST_CONFIG = "test/vitest/vitest.unit.config.ts";
const AGENTS_CORE_ISOLATED_VITEST_CONFIG = "test/vitest/vitest.agents-core-isolated.config.ts";
const AGENTS_CORE_VITEST_CONFIG = "test/vitest/vitest.agents-core.config.ts";
const AGENTS_EMBEDDED_AGENT_VITEST_CONFIG = "test/vitest/vitest.agents-embedded-agent.config.ts";
const AGENTS_SUPPORT_VITEST_CONFIG = "test/vitest/vitest.agents-support.config.ts";
const AGENTS_TOOLS_VITEST_CONFIG = "test/vitest/vitest.agents-tools.config.ts";
const AGENTS_VITEST_CONFIG = "test/vitest/vitest.agents.config.ts";
const ACP_VITEST_CONFIG = "test/vitest/vitest.acp.config.ts";
const AUTO_REPLY_CORE_VITEST_CONFIG = "test/vitest/vitest.auto-reply-core.config.ts";
const AUTO_REPLY_VITEST_CONFIG = "test/vitest/vitest.auto-reply.config.ts";
const AUTO_REPLY_REPLY_VITEST_CONFIG = "test/vitest/vitest.auto-reply-reply.config.ts";
const AUTO_REPLY_TOP_LEVEL_VITEST_CONFIG = "test/vitest/vitest.auto-reply-top-level.config.ts";
const BOUNDARY_VITEST_CONFIG = "test/vitest/vitest.boundary.config.ts";
const BUNDLED_VITEST_CONFIG = "test/vitest/vitest.bundled.config.ts";
const CHANNEL_VITEST_CONFIG = "test/vitest/vitest.channels.config.ts";
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
const UTILS_VITEST_CONFIG = "test/vitest/vitest.utils.config.ts";
const WIZARD_VITEST_CONFIG = "test/vitest/vitest.wizard.config.ts";
const INCLUDE_FILE_ENV_KEY = "OPENCLAW_VITEST_INCLUDE_FILE";
const FS_MODULE_CACHE_PATH_ENV_KEY = "OPENCLAW_VITEST_FS_MODULE_CACHE_PATH";
const FAILED_SHARD_DIGEST_LIMIT = 12;
const CHANGED_ARGS_PATTERN = /^--changed(?:=(.+))?$/u;
const VITEST_CONFIG_BY_KIND = {
  acp: ACP_VITEST_CONFIG,
  agentCore: AGENTS_CORE_VITEST_CONFIG,
  agentEmbedded: AGENTS_EMBEDDED_AGENT_VITEST_CONFIG,
  agentSupport: AGENTS_SUPPORT_VITEST_CONFIG,
  agentTools: AGENTS_TOOLS_VITEST_CONFIG,
  agent: AGENTS_VITEST_CONFIG,
  agentsCoreIsolated: AGENTS_CORE_ISOLATED_VITEST_CONFIG,
  agentsCore: AGENTS_CORE_VITEST_CONFIG,
  agentsSupport: AGENTS_SUPPORT_VITEST_CONFIG,
  agentsTools: AGENTS_TOOLS_VITEST_CONFIG,
  autoReplyCore: AUTO_REPLY_CORE_VITEST_CONFIG,
  autoReplyReply: AUTO_REPLY_REPLY_VITEST_CONFIG,
  autoReplyTopLevel: AUTO_REPLY_TOP_LEVEL_VITEST_CONFIG,
  autoReply: AUTO_REPLY_VITEST_CONFIG,
  boundary: BOUNDARY_VITEST_CONFIG,
  bundled: BUNDLED_VITEST_CONFIG,
  channel: CHANNEL_VITEST_CONFIG,
  cli: CLI_VITEST_CONFIG,
  command: COMMANDS_VITEST_CONFIG,
  commandLight: COMMANDS_LIGHT_VITEST_CONFIG,
  contractsChannelConfig: CONTRACTS_CHANNEL_CONFIG_VITEST_CONFIG,
  contractsChannelRegistry: CONTRACTS_CHANNEL_REGISTRY_VITEST_CONFIG,
  contractsChannelSession: CONTRACTS_CHANNEL_SESSION_VITEST_CONFIG,
  contractsChannelSurface: CONTRACTS_CHANNEL_SURFACE_VITEST_CONFIG,
  contractsPlugin: CONTRACTS_PLUGIN_VITEST_CONFIG,
  cron: CRON_VITEST_CONFIG,
  daemon: DAEMON_VITEST_CONFIG,
  e2e: E2E_VITEST_CONFIG,
  extension: EXTENSIONS_VITEST_CONFIG,
  extensionFull: FULL_EXTENSIONS_VITEST_CONFIG,
  extensionActiveMemory: EXTENSION_ACTIVE_MEMORY_VITEST_CONFIG,
  extensionAcpx: EXTENSION_ACPX_VITEST_CONFIG,
  extensionBrowser: EXTENSION_BROWSER_VITEST_CONFIG,
  extensionChannel: EXTENSION_CHANNELS_VITEST_CONFIG,
  extensionCodex: EXTENSION_CODEX_VITEST_CONFIG,
  extensionDiffs: EXTENSION_DIFFS_VITEST_CONFIG,
  extensionDiscord: EXTENSION_DISCORD_VITEST_CONFIG,
  extensionFeishu: EXTENSION_FEISHU_VITEST_CONFIG,
  extensionImessage: EXTENSION_IMESSAGE_VITEST_CONFIG,
  extensionIrc: EXTENSION_IRC_VITEST_CONFIG,
  extensionLine: EXTENSION_LINE_VITEST_CONFIG,
  extensionMatrix: EXTENSION_MATRIX_VITEST_CONFIG,
  extensionMattermost: EXTENSION_MATTERMOST_VITEST_CONFIG,
  extensionMedia: EXTENSION_MEDIA_VITEST_CONFIG,
  extensionMemory: EXTENSION_MEMORY_VITEST_CONFIG,
  extensionMessaging: EXTENSION_MESSAGING_VITEST_CONFIG,
  extensionMisc: EXTENSION_MISC_VITEST_CONFIG,
  extensionMsTeams: EXTENSION_MSTEAMS_VITEST_CONFIG,
  extensionProviderOpenAi: EXTENSION_PROVIDER_OPENAI_VITEST_CONFIG,
  extensionProvider: EXTENSION_PROVIDERS_VITEST_CONFIG,
  extensionQa: EXTENSION_QA_VITEST_CONFIG,
  extensionSignal: EXTENSION_SIGNAL_VITEST_CONFIG,
  extensionSlack: EXTENSION_SLACK_VITEST_CONFIG,
  extensionTelegram: EXTENSION_TELEGRAM_VITEST_CONFIG,
  extensionVoiceCall: EXTENSION_VOICE_CALL_VITEST_CONFIG,
  extensionWhatsApp: EXTENSION_WHATSAPP_VITEST_CONFIG,
  extensionZalo: EXTENSION_ZALO_VITEST_CONFIG,
  gatewayClient: GATEWAY_CLIENT_VITEST_CONFIG,
  gatewayCore: GATEWAY_CORE_VITEST_CONFIG,
  gatewayMethods: GATEWAY_METHODS_VITEST_CONFIG,
  gatewayServer: GATEWAY_SERVER_VITEST_CONFIG,
  gateway: GATEWAY_VITEST_CONFIG,
  hooks: HOOKS_VITEST_CONFIG,
  infra: INFRA_VITEST_CONFIG,
  logging: LOGGING_VITEST_CONFIG,
  media: MEDIA_VITEST_CONFIG,
  mediaUnderstanding: MEDIA_UNDERSTANDING_VITEST_CONFIG,
  plugin: PLUGINS_VITEST_CONFIG,
  pluginSdk: PLUGIN_SDK_VITEST_CONFIG,
  pluginSdkLight: PLUGIN_SDK_LIGHT_VITEST_CONFIG,
  process: PROCESS_VITEST_CONFIG,
  unitFast: UNIT_FAST_VITEST_CONFIG,
  unitFastIsolated: UNIT_FAST_ISOLATED_VITEST_CONFIG,
  unitFastFakeTimers: UNIT_FAST_FAKE_TIMERS_VITEST_CONFIG,
  unitSecurity: UNIT_SECURITY_VITEST_CONFIG,
  unitSrc: UNIT_SRC_VITEST_CONFIG,
  unitSupport: UNIT_SUPPORT_VITEST_CONFIG,
  runtimeConfig: RUNTIME_CONFIG_VITEST_CONFIG,
  secrets: SECRETS_VITEST_CONFIG,
  sharedCore: SHARED_CORE_VITEST_CONFIG,
  tasks: TASKS_VITEST_CONFIG,
  toolingDocker: TOOLING_DOCKER_VITEST_CONFIG,
  toolingIsolated: TOOLING_ISOLATED_VITEST_CONFIG,
  tooling: TOOLING_VITEST_CONFIG,
  tui: TUI_VITEST_CONFIG,
  tuiPty: TUI_PTY_VITEST_CONFIG,
  ui: UI_VITEST_CONFIG,
  uiE2e: UI_E2E_VITEST_CONFIG,
  utils: UTILS_VITEST_CONFIG,
  wizard: WIZARD_VITEST_CONFIG,
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
  [
    "src/plugins/contracts/tts-contract-suites.ts",
    [
      "src/plugins/contracts/core-extension-facade-boundary.test.ts",
      "src/plugins/contracts/tts.contract.test.ts",
    ],
  ],
]);
const PLUGIN_SDK_ENTRY_METADATA_TEST_TARGETS = [
  "src/plugins/contracts/plugin-sdk-index.bundle.test.ts",
  "src/plugins/contracts/plugin-sdk-package-contract-guardrails.test.ts",
  "src/plugins/contracts/plugin-sdk-subpaths.test.ts",
  "src/plugins/contracts/extension-package-project-boundaries.test.ts",
  "test/scripts/plugin-sdk-surface-report.test.ts",
  "test/scripts/build-all.test.ts",
  "test/release-check.test.ts",
  "test/scripts/prepare-extension-package-boundary-artifacts.test.ts",
  "test/scripts/ts-topology.test.ts",
  TOOLING_VITEST_CONFIG,
];
const RUNTIME_SIDECAR_BASELINE_OWNER_TEST_TARGETS = ["src/plugins/bundled-plugin-metadata.test.ts"];
const RUNTIME_SIDECAR_PATH_CONSUMER_TEST_TARGETS = [
  ...RUNTIME_SIDECAR_BASELINE_OWNER_TEST_TARGETS,
  "src/infra/update-global.test.ts",
  "src/infra/update-runner.test.ts",
  "test/openclaw-npm-postpublish-verify.test.ts",
];
const OFFICIAL_EXTERNAL_CATALOG_TEST_TARGETS = [
  "src/plugins/official-external-plugin-catalog.test.ts",
  "test/release-check.test.ts",
];
const RECOMMENDED_TOOL_INSTALLS_TEST_TARGETS = [
  "src/plugins/recommended-tool-installs.test.ts",
  "test/release-check.test.ts",
];
const DOCKERFILE_CACHE_AND_DIGEST_TEST_TARGETS = [
  "src/docker-build-cache.test.ts",
  "src/docker-image-digests.test.ts",
];
const ROOT_DOCKERFILE_TEST_TARGETS = [
  ...DOCKERFILE_CACHE_AND_DIGEST_TEST_TARGETS,
  "src/dockerfile.test.ts",
  "test/scripts/test-install-sh-docker.test.ts",
];
const INSTALL_DOCKERFILE_TEST_TARGETS = [
  ...DOCKERFILE_CACHE_AND_DIGEST_TEST_TARGETS,
  "test/scripts/test-install-sh-docker.test.ts",
];
const LIVE_MEDIA_RUNNER_IMAGE_TEST_TARGETS = ["test/scripts/package-acceptance-workflow.test.ts"];
const GITHUB_YAML_PINNING_GUARD_TEST_TARGETS = ["test/scripts/ci-workflow-guards.test.ts"];
const GITHUB_WORKFLOW_OWNER_TEST_TARGETS = new Map([
  [
    ".github/workflows/ci-build-artifacts-testbox.yml",
    ["test/scripts/install-trufflehog.test.ts", "test/scripts/package-acceptance-workflow.test.ts"],
  ],
  [
    ".github/workflows/ci-check-arm-testbox.yml",
    ["test/scripts/install-trufflehog.test.ts", "test/scripts/package-acceptance-workflow.test.ts"],
  ],
  [
    ".github/workflows/ci-check-testbox.yml",
    [
      "test/scripts/changed-lanes.test.ts",
      "test/scripts/install-trufflehog.test.ts",
      "test/scripts/package-acceptance-workflow.test.ts",
    ],
  ],
  [
    ".github/workflows/ci.yml",
    [
      "test/scripts/changed-lanes.test.ts",
      "test/scripts/check-workflows.test.ts",
      "test/scripts/plugin-contract-test-plan.test.ts",
      "test/scripts/plugin-prerelease-test-plan.test.ts",
      "test/scripts/verify-pr-hosted-gates.test.ts",
    ],
  ],
  [".github/workflows/crabbox-hydrate.yml", ["test/scripts/package-acceptance-workflow.test.ts"]],
  [".github/workflows/dependency-guard.yml", ["test/scripts/dependency-guard-workflow.test.ts"]],
  [".github/workflows/docker-release.yml", ["src/dockerfile.test.ts"]],
  [
    ".github/workflows/full-release-validation.yml",
    [
      "src/dockerfile.test.ts",
      "test/scripts/package-acceptance-workflow.test.ts",
      "test/scripts/plugin-prerelease-test-plan.test.ts",
    ],
  ],
  [
    ".github/workflows/install-smoke.yml",
    [
      "test/scripts/install-smoke-no-push-workflow.test.ts",
      "test/scripts/test-install-sh-docker.test.ts",
    ],
  ],
  [
    ".github/workflows/install-smoke-reusable.yml",
    [
      "test/scripts/install-smoke-no-push-workflow.test.ts",
      "test/scripts/test-install-sh-docker.test.ts",
    ],
  ],
  [
    ".github/workflows/ios-periphery-comment.yml",
    ["test/scripts/ios-periphery-comment-workflow.test.ts"],
  ],
  [
    ".github/workflows/ios-periphery.yml",
    [
      "test/scripts/ios-periphery-comment-workflow.test.ts",
      "test/scripts/periphery-scope-workflows.test.ts",
    ],
  ],
  [
    ".github/workflows/macos-periphery.yml",
    [
      "test/scripts/ios-periphery-comment-workflow.test.ts",
      "test/scripts/periphery-scope-workflows.test.ts",
    ],
  ],
  [
    ".github/workflows/shared-openclawkit-periphery.yml",
    [
      "test/scripts/periphery-intersection.test.ts",
      "test/scripts/periphery-scope-workflows.test.ts",
    ],
  ],
  [
    ".github/workflows/live-media-runner-image.yml",
    ["test/scripts/package-acceptance-workflow.test.ts"],
  ],
  [".github/workflows/macos-release.yml", ["test/scripts/package-acceptance-workflow.test.ts"]],
  [
    ".github/workflows/mantis-scenario.yml",
    ["test/scripts/mantis-telegram-desktop-proof-workflow.test.ts"],
  ],
  [
    ".github/workflows/mantis-telegram-desktop-proof.yml",
    [
      "test/scripts/mantis-telegram-desktop-proof-workflow.test.ts",
      "test/scripts/package-acceptance-workflow.test.ts",
    ],
  ],
  [
    ".github/workflows/mantis-web-ui-chat-proof.yml",
    [
      "test/scripts/mantis-web-ui-chat-proof-workflow.test.ts",
      "test/scripts/package-acceptance-workflow.test.ts",
    ],
  ],
  [
    ".github/workflows/mantis-discord-smoke.yml",
    ["test/scripts/package-acceptance-workflow.test.ts"],
  ],
  [
    ".github/workflows/mantis-discord-status-reactions.yml",
    ["test/scripts/package-acceptance-workflow.test.ts"],
  ],
  [
    ".github/workflows/mantis-discord-thread-attachment.yml",
    ["test/scripts/package-acceptance-workflow.test.ts"],
  ],
  [
    ".github/workflows/mantis-slack-desktop-smoke.yml",
    ["test/scripts/package-acceptance-workflow.test.ts"],
  ],
  [
    ".github/workflows/mantis-telegram-live.yml",
    [
      "test/scripts/mantis-telegram-desktop-proof-workflow.test.ts",
      "test/scripts/package-acceptance-workflow.test.ts",
    ],
  ],
  [
    ".github/workflows/npm-telegram-beta-e2e.yml",
    ["test/scripts/package-acceptance-workflow.test.ts"],
  ],
  [".github/workflows/android-release.yml", ["test/scripts/package-acceptance-workflow.test.ts"]],
  [
    ".github/workflows/openclaw-cross-os-release-checks-reusable.yml",
    [
      "test/scripts/openclaw-cross-os-release-checks.test.ts",
      "test/scripts/openclaw-cross-os-release-workflow.test.ts",
      "test/scripts/package-acceptance-workflow.test.ts",
    ],
  ],
  [
    ".github/workflows/openclaw-live-and-e2e-checks-reusable.yml",
    [
      "test/scripts/package-acceptance-workflow.test.ts",
      "test/scripts/release-workflow-matrix-plan.test.ts",
      "test/scripts/test-install-sh-docker.test.ts",
    ],
  ],
  [
    ".github/workflows/openclaw-npm-release.yml",
    [
      "test/openclaw-npm-postpublish-verify.test.ts",
      "test/scripts/package-acceptance-workflow.test.ts",
    ],
  ],
  [
    ".github/workflows/openclaw-performance.yml",
    ["test/scripts/openclaw-performance-workflow.test.ts"],
  ],
  [
    ".github/workflows/openclaw-release-checks.yml",
    [
      "test/scripts/openclaw-cross-os-release-checks.test.ts",
      "test/scripts/package-acceptance-workflow.test.ts",
      "test/scripts/plugin-prerelease-test-plan.test.ts",
      "test/scripts/test-install-sh-docker.test.ts",
    ],
  ],
  [
    ".github/workflows/openclaw-release-publish.yml",
    ["test/scripts/package-acceptance-workflow.test.ts"],
  ],
  [
    ".github/workflows/openclaw-scheduled-live-checks.yml",
    [
      "test/scripts/package-acceptance-workflow.test.ts",
      "test/scripts/release-no-push-workflow.test.ts",
    ],
  ],
  [
    ".github/workflows/openclaw-stable-main-closeout.yml",
    ["test/scripts/package-acceptance-workflow.test.ts"],
  ],
  [
    ".github/workflows/package-acceptance.yml",
    ["test/scripts/package-acceptance-workflow.test.ts"],
  ],
  [
    ".github/workflows/plugin-clawhub-new.yml",
    [
      "test/scripts/package-acceptance-workflow.test.ts",
      "test/scripts/plugin-clawhub-new-workflow.test.ts",
    ],
  ],
  [
    ".github/workflows/plugin-clawhub-release.yml",
    ["test/scripts/package-acceptance-workflow.test.ts"],
  ],
  [
    ".github/workflows/plugin-npm-release.yml",
    [
      "test/scripts/package-acceptance-workflow.test.ts",
      "test/scripts/plugin-npm-extended-stable-workflow.test.ts",
    ],
  ],
  [".github/workflows/plugin-prerelease.yml", ["test/scripts/plugin-prerelease-test-plan.test.ts"]],
  [
    ".github/workflows/qa-live-transports-convex.yml",
    ["test/scripts/package-acceptance-workflow.test.ts"],
  ],
  [
    ".github/workflows/sandbox-common-smoke.yml",
    ["test/scripts/sandbox-common-smoke-workflow.test.ts"],
  ],
  [
    ".github/workflows/security-sensitive-guard.yml",
    ["test/scripts/security-sensitive-guard-workflow.test.ts"],
  ],
  [".github/workflows/tui-pty.yml", ["test/scripts/package-acceptance-workflow.test.ts"]],
  [".github/workflows/update-migration.yml", ["test/scripts/package-acceptance-workflow.test.ts"]],
  [
    ".github/workflows/website-installer-sync.yml",
    ["test/scripts/website-installer-sync-workflow.test.ts"],
  ],
  [
    ".github/workflows/windows-node-release.yml",
    ["test/scripts/package-acceptance-workflow.test.ts"],
  ],
  [".github/workflows/windows-testbox-probe.yml", ["test/scripts/check-workflows.test.ts"]],
]);
const TOOLING_SOURCE_TEST_TARGETS = new Map([
  ["Dockerfile", ROOT_DOCKERFILE_TEST_TARGETS],
  [
    ".agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs",
    ["test/scripts/release-notes-ledger.test.ts", "test/scripts/verify-release-notes.test.ts"],
  ],
  [".crabbox.yaml", ["test/scripts/package-acceptance-workflow.test.ts"]],
  [".github/actions/detect-docs-changes/action.yml", ["test/scripts/ci-workflow-guards.test.ts"]],
  [
    ".github/actions/create-generated-pr-tokens/action.yml",
    ["test/scripts/ci-workflow-guards.test.ts"],
  ],
  [".github/actions/publish-generated-pr/action.yml", ["test/scripts/ci-workflow-guards.test.ts"]],
  [
    ".github/actions/docker-e2e-plan/action.yml",
    ["test/scripts/package-acceptance-workflow.test.ts", "test/scripts/ci-workflow-guards.test.ts"],
  ],
  [".github/actions/ensure-base-commit/action.yml", ["test/scripts/ci-workflow-guards.test.ts"]],
  [
    ".github/actions/setup-node-env/action.yml",
    [
      "test/scripts/install-trufflehog.test.ts",
      "test/scripts/package-acceptance-workflow.test.ts",
      "test/scripts/ci-workflow-guards.test.ts",
    ],
  ],
  [
    ".github/actions/setup-node-env/dependency-fingerprint.mjs",
    ["test/scripts/ci-workflow-guards.test.ts"],
  ],
  [
    ".github/actions/setup-node-env/sticky-importers.sh",
    ["test/scripts/ci-workflow-guards.test.ts"],
  ],
  [
    ".github/actions/setup-node-env/verify-importers.mjs",
    ["test/scripts/ci-workflow-guards.test.ts"],
  ],
  [
    ".github/actions/setup-pnpm-store-cache/action.yml",
    ["test/scripts/package-acceptance-workflow.test.ts", "test/scripts/ci-workflow-guards.test.ts"],
  ],
  [
    ".github/actions/setup-pnpm-store-cache/ensure-node.sh",
    ["test/scripts/setup-pnpm-store-cache-ensure-node.test.ts"],
  ],
  [".github/images/live-media-runner/Dockerfile", LIVE_MEDIA_RUNNER_IMAGE_TEST_TARGETS],
  [".github/workflows/auto-response.yml", ["test/scripts/ci-workflow-guards.test.ts"]],
  [".github/workflows/ci.yml", ["test/scripts/ci-workflow-guards.test.ts"]],
  [".github/workflows/clawsweeper-dispatch.yml", ["test/scripts/ci-workflow-guards.test.ts"]],
  [".github/workflows/labeler.yml", ["test/scripts/ci-workflow-guards.test.ts"]],
  [".github/workflows/real-behavior-proof.yml", ["test/scripts/ci-workflow-guards.test.ts"]],
  [
    ".github/workflows/security-sensitive-guard.yml",
    ["test/scripts/security-sensitive-guard-workflow.test.ts"],
  ],
  [
    ".github/workflows/ci-check-testbox.yml",
    ["test/scripts/ci-workflow-guards.test.ts", "test/scripts/package-acceptance-workflow.test.ts"],
  ],
  [
    ".github/workflows/ci-check-arm-testbox.yml",
    ["test/scripts/ci-workflow-guards.test.ts", "test/scripts/package-acceptance-workflow.test.ts"],
  ],
  [
    ".github/workflows/crabbox-hydrate.yml",
    ["test/scripts/ci-workflow-guards.test.ts", "test/scripts/package-acceptance-workflow.test.ts"],
  ],
  [
    ".github/workflows/live-media-runner-image.yml",
    [...LIVE_MEDIA_RUNNER_IMAGE_TEST_TARGETS, "test/scripts/ci-workflow-guards.test.ts"],
  ],
  [
    ".github/workflows/openclaw-live-and-e2e-checks-reusable.yml",
    ["test/scripts/package-acceptance-workflow.test.ts", "test/scripts/ci-workflow-guards.test.ts"],
  ],
  [
    ".github/workflows/openclaw-release-checks.yml",
    ["test/scripts/package-acceptance-workflow.test.ts"],
  ],
  ["scripts/clawtributors-map.json", ["test/scripts/update-clawtributors.test.ts"]],
  ["scripts/tsconfig.json", ["test/scripts/oxlint-config.test.ts"]],
  [
    "tsconfig.scripts.json",
    ["test/scripts/changed-lanes.test.ts", "test/scripts/test-projects.test.ts"],
  ],
  ["scripts/build-all.mjs", ["test/scripts/build-all.test.ts"]],
  ["scripts/build-stamp.mjs", ["src/infra/build-stamp.test.ts"]],
  ["scripts/crabbox-wrapper-providers.mjs", ["test/scripts/crabbox-wrapper.test.ts"]],
  ["scripts/crabbox-wrapper.mjs", ["test/scripts/crabbox-wrapper.test.ts"]],
  ["scripts/github/barnacle-auto-response.mjs", ["test/scripts/barnacle-auto-response.test.ts"]],
  ["scripts/changed-lanes.mjs", ["test/scripts/changed-lanes.test.ts"]],
  [
    "scripts/lib/ci-changed-node-test-plan.d.mts",
    ["test/scripts/ci-changed-node-test-plan.test.ts"],
  ],
  ["scripts/lib/ci-changed-node-test-plan.mjs", ["test/scripts/ci-changed-node-test-plan.test.ts"]],
  ["scripts/check.mjs", ["test/scripts/check.test.ts"]],
  ["scripts/check-changed.mjs", ["test/scripts/changed-lanes.test.ts"]],
  ["scripts/check-env-var-count.mjs", ["test/scripts/check-env-var-count.test.ts"]],
  ["scripts/check-env-var-count.d.mts", ["test/scripts/check-env-var-count.test.ts"]],
  ["config/env-var-count-budget.txt", ["test/scripts/check-env-var-count.test.ts"]],
  ["scripts/check-max-lines-ratchet.mjs", ["test/scripts/check-max-lines-ratchet.test.ts"]],
  [
    "scripts/check-native-state-schema-version.mjs",
    ["test/scripts/check-native-state-schema-version.test.ts"],
  ],
  ["config/max-lines-baseline.txt", ["test/scripts/check-max-lines-ratchet.test.ts"]],
  [".oxlintrc.json", ["test/scripts/oxlint-config.test.ts"]],
  [
    "scripts/check-changelog-attributions.mjs",
    ["test/scripts/check-changelog-attributions.test.ts"],
  ],
  [
    "scripts/check-composite-action-input-interpolation.py",
    ["test/scripts/check-composite-action-input-interpolation.test.ts"],
  ],
  ["scripts/check-dependency-pins.mjs", ["test/scripts/check-dependency-pins.test.ts"]],
  ["scripts/check-deadcode-unused-files.mjs", ["test/scripts/check-deadcode-unused-files.test.ts"]],
  ["scripts/check-dynamic-import-warts.mjs", ["test/scripts/check-dynamic-import-warts.test.ts"]],
  ["scripts/generate-prompt-snapshots.ts", ["test/scripts/prompt-snapshots.test.ts"]],
  [
    "scripts/generate-runtime-sidecar-paths-baseline.ts",
    RUNTIME_SIDECAR_BASELINE_OWNER_TEST_TARGETS,
  ],
  [
    "scripts/lib/config-boundary-guard.mjs",
    [
      "src/plugins/contracts/config-boundary-guard.test.ts",
      "src/plugins/contracts/deprecated-internal-config-api.test.ts",
    ],
  ],
  [
    "scripts/lib/deprecated-config-api-guard.mjs",
    ["src/plugins/contracts/deprecated-internal-config-api.test.ts"],
  ],
  [
    "scripts/lib/extension-package-boundary.ts",
    ["src/plugins/contracts/extension-package-project-boundaries.test.ts"],
  ],
  ["scripts/check-extension-plugin-sdk-boundary.mjs", ["test/extension-import-boundaries.test.ts"]],
  ["scripts/check-no-conflict-markers.mjs", ["test/scripts/check-no-conflict-markers.test.ts"]],
  [
    "scripts/check-plugin-extension-import-boundary.mjs",
    ["test/plugin-extension-import-boundary.test.ts"],
  ],
  [
    "scripts/check-sdk-package-extension-import-boundary.mjs",
    ["test/extension-import-boundaries.test.ts"],
  ],
  ["scripts/check-src-extension-import-boundary.mjs", ["test/extension-import-boundaries.test.ts"]],
  [
    "scripts/lib/guard-inventory-utils.mjs",
    [
      "test/extension-import-boundaries.test.ts",
      "test/plugin-extension-import-boundary.test.ts",
      "test/architecture-smells.test.ts",
      "test/web-provider-boundary.test.ts",
      "test/test-helper-extension-import-boundary.test.ts",
      "test/scripts/extension-import-boundary-checker.test.ts",
      "src/plugins/contracts/plugin-sdk-subpaths.test.ts",
    ],
  ],
  [
    "scripts/check-test-helper-extension-import-boundary.mjs",
    ["test/test-helper-extension-import-boundary.test.ts"],
  ],
  [
    "scripts/check-workflows.mjs",
    [
      "test/scripts/check-composite-action-input-interpolation.test.ts",
      "test/scripts/check-no-conflict-markers.test.ts",
      "test/scripts/ci-workflow-guards.test.ts",
    ],
  ],
  [
    "scripts/ci-changed-scope.mjs",
    ["src/scripts/ci-changed-scope.test.ts", "test/scripts/control-ui-i18n.test.ts"],
  ],
  ["scripts/periphery-intersection.mjs", ["test/scripts/periphery-intersection.test.ts"]],
  ["scripts/ci-docker-pull-retry.sh", ["test/scripts/ci-docker-pull-retry.test.ts"]],
  ["scripts/control-ui-i18n.ts", ["test/scripts/control-ui-i18n.test.ts"]],
  ["scripts/apple-app-i18n.ts", ["test/scripts/apple-app-i18n.test.ts"]],
  [
    "scripts/native-app-i18n.ts",
    ["test/scripts/native-app-i18n.test.ts", "test/scripts/ci-workflow-guards.test.ts"],
  ],
  ["scripts/android-app-i18n.ts", ["test/scripts/android-app-i18n.test.ts"]],
  [
    "scripts/copy-bundled-plugin-metadata.mjs",
    ["src/plugins/copy-bundled-plugin-metadata.test.ts", "src/infra/run-node.test.ts"],
  ],
  [
    "scripts/e2e/agent-bundle-mcp-tools-docker.sh",
    [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "test/scripts/plugin-prerelease-test-plan.test.ts",
      "src/agents/agent-bundle-mcp-runtime.test.ts",
      "src/agents/agent-bundle-mcp-tools.materialize.test.ts",
    ],
  ],
  [
    "test/e2e/qa-lab/runtime/agent-bundle-mcp-tools-docker-client.ts",
    [
      "src/agents/agent-bundle-mcp-runtime.test.ts",
      "src/agents/agent-bundle-mcp-tools.materialize.test.ts",
    ],
  ],
  [
    "scripts/e2e/codex-media-path-docker.sh",
    [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "test/scripts/codex-media-path-client.test.ts",
    ],
  ],
  [
    "scripts/e2e/codex-npm-plugin-live-docker.sh",
    [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "test/scripts/package-acceptance-workflow.test.ts",
    ],
  ],
  [
    "scripts/e2e/codex-on-demand-docker.sh",
    ["test/scripts/docker-build-helper.test.ts", "test/scripts/docker-e2e-plan.test.ts"],
  ],
  [
    "scripts/e2e/system-agent-first-run-docker.sh",
    [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "test/scripts/docker-e2e-system-agent.test.ts",
    ],
  ],
  [
    "test/e2e/qa-lab/runtime/system-agent-first-run-docker-client.ts",
    [
      "test/scripts/docker-e2e-system-agent.test.ts",
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
    "scripts/e2e/system-agent-first-run-spec.json",
    [
      "test/scripts/docker-e2e-system-agent.test.ts",
      "src/system-agent/operations.test.ts",
      "src/system-agent/audit.test.ts",
    ],
  ],
  [
    "scripts/e2e/system-agent-rescue-docker.sh",
    [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "test/scripts/docker-e2e-system-agent.test.ts",
    ],
  ],
  [
    "scripts/e2e/system-agent-rescue-docker-client.ts",
    [
      "test/scripts/docker-e2e-system-agent.test.ts",
      "src/system-agent/rescue-policy.test.ts",
      "src/system-agent/rescue-message.test.ts",
      "src/system-agent/operations.test.ts",
      "src/system-agent/audit.test.ts",
    ],
  ],
  [
    "scripts/e2e/commitments-safety-docker-client.ts",
    [
      "test/scripts/docker-e2e-clients.test.ts",
      "src/commitments/runtime.test.ts",
      "src/commitments/store.test.ts",
    ],
  ],
  [
    "scripts/e2e/commitments-safety-docker.sh",
    [
      "test/scripts/docker-e2e-clients.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "src/commitments/runtime.test.ts",
      "src/commitments/store.test.ts",
    ],
  ],
  [
    "scripts/e2e/session-runtime-context-docker-client.ts",
    [
      "test/scripts/docker-e2e-clients.test.ts",
      "src/agents/embedded-agent-runner/run/runtime-context-prompt.test.ts",
      "src/agents/embedded-agent-runner/transcript-rewrite.test.ts",
    ],
  ],
  [
    "scripts/e2e/session-runtime-context-docker.sh",
    [
      "test/scripts/docker-e2e-clients.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "src/agents/embedded-agent-runner/run/runtime-context-prompt.test.ts",
      "src/agents/embedded-agent-runner/transcript-rewrite.test.ts",
    ],
  ],
  [
    "scripts/e2e/mcp-channels-docker.sh",
    [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-observability.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "test/scripts/plugin-prerelease-test-plan.test.ts",
    ],
  ],
  [
    "test/e2e/qa-lab/runtime/mcp-channels-docker-client.ts",
    ["test/scripts/docker-e2e-plan.test.ts", "test/scripts/plugin-prerelease-test-plan.test.ts"],
  ],
  [
    "test/e2e/qa-lab/runtime/mcp-channels.fixture.ts",
    [
      "test/e2e/qa-lab/runtime/mcp-gateway-transport.e2e.test.ts",
      "test/scripts/cron-mcp-cleanup-docker-client.test.ts",
    ],
  ],
  [
    "test/e2e/qa-lab/runtime/mcp-client-temp-state.fixture.ts",
    ["test/e2e/qa-lab/runtime/mcp-gateway-transport.e2e.test.ts"],
  ],
  ["scripts/e2e/mcp-channels-seed.ts", ["test/scripts/docker-e2e-seeds.test.ts"]],
  ["scripts/e2e/docker-openai-seed.ts", ["test/scripts/docker-e2e-seeds.test.ts"]],
  [
    "scripts/e2e/mcp-code-mode-gateway-docker.sh",
    [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "test/scripts/plugin-prerelease-test-plan.test.ts",
      "test/scripts/mcp-code-mode-gateway-client.test.ts",
      "test/scripts/session-log-mentions.test.ts",
    ],
  ],
  [
    "scripts/e2e/mcp-code-mode-gateway-live-docker.sh",
    [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "test/scripts/plugin-prerelease-test-plan.test.ts",
      "test/scripts/mcp-code-mode-gateway-client.test.ts",
      "test/scripts/session-log-mentions.test.ts",
    ],
  ],
  ["scripts/e2e/mcp-code-mode-gateway-seed.ts", ["test/scripts/docker-e2e-seeds.test.ts"]],
  [
    "scripts/e2e/lib/mcp-code-mode-probe-server.ts",
    ["test/scripts/docker-e2e-seeds.test.ts", "test/scripts/mcp-code-mode-gateway-client.test.ts"],
  ],
  [
    "scripts/e2e/cron-cli-docker.sh",
    ["test/scripts/docker-build-helper.test.ts", "test/scripts/docker-e2e-observability.test.ts"],
  ],
  [
    "scripts/e2e/cron-mcp-cleanup-docker.sh",
    [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-observability.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "test/scripts/plugin-prerelease-test-plan.test.ts",
      "test/scripts/cron-mcp-cleanup-docker-client.test.ts",
      "test/scripts/docker-e2e-seeds.test.ts",
    ],
  ],
  [
    "scripts/e2e/cron-mcp-cleanup-docker-client.ts",
    [
      "test/scripts/cron-mcp-cleanup-docker-client.test.ts",
      "src/gateway/server.cron.test.ts",
      "src/gateway/server-methods/agent.test.ts",
      "src/cron/isolated-agent/run.fast-mode.test.ts",
      "src/cron/active-jobs-manual-run.test.ts",
    ],
  ],
  [
    "scripts/mcp-code-mode-gateway-e2e.ts",
    [
      "test/scripts/mcp-code-mode-gateway-client.test.ts",
      "test/scripts/session-log-mentions.test.ts",
    ],
  ],
  ["scripts/dependency-changes-report.mjs", ["test/scripts/dependency-changes-report.test.ts"]],
  [
    "scripts/github/dependency-guard.mjs",
    [
      "test/scripts/dependency-guard-script.test.ts",
      "test/scripts/dependency-guard-workflow.test.ts",
    ],
  ],
  [
    "scripts/github/guard-shared.mjs",
    [
      "test/scripts/dependency-guard-script.test.ts",
      "test/scripts/dependency-guard-workflow.test.ts",
      "test/scripts/security-sensitive-guard-script.test.ts",
      "test/scripts/security-sensitive-guard-workflow.test.ts",
    ],
  ],
  ["scripts/github/resolve-openclaw-ref.sh", ["test/scripts/resolve-openclaw-ref.test.ts"]],
  ["scripts/ci-hydrate-testbox-env.sh", ["test/scripts/ci-hydrate-testbox-env.test.ts"]],
  ["scripts/install-trufflehog.sh", ["test/scripts/install-trufflehog.test.ts"]],
  [
    "scripts/github/run-openclaw-cross-os-release-checks.sh",
    ["test/scripts/openclaw-cross-os-release-workflow.test.ts"],
  ],
  ["scripts/mobile-release-ref.ts", ["test/scripts/mobile-release-ref.test.ts"]],
  ["scripts/apple-release-source-check.sh", ["test/scripts/apple-release-source-check.test.ts"]],
  ["scripts/compare-release-evidence-zip.py", ["test/scripts/package-acceptance-workflow.test.ts"]],
  ["scripts/android-release.sh", ["test/scripts/android-release-wrapper-args.test.ts"]],
  ["scripts/android-release-signing.mjs", ["test/scripts/android-release-signing.test.ts"]],
  ["scripts/android-release-upload.sh", ["test/scripts/android-release-wrapper-args.test.ts"]],
  [
    "apps/android/scripts/build-release-artifacts.ts",
    ["test/scripts/android-release-artifacts.test.ts"],
  ],
  ["apps/android/fastlane/Fastfile", ["test/scripts/android-release-fastlane-gates.test.ts"]],
  ["scripts/ios-release-archive.sh", ["test/scripts/ios-release-wrapper-args.test.ts"]],
  [
    "scripts/ios-release-prepare.sh",
    ["test/scripts/ios-release-prepare.test.ts", "test/scripts/ios-release-wrapper-args.test.ts"],
  ],
  ["scripts/ios-release-signing.mjs", ["test/scripts/ios-release-signing.test.ts"]],
  ["apps/ios/fastlane/Fastfile", ["test/scripts/ios-release-fastlane-gates.test.ts"]],
  [
    "scripts/ios-release-upload.sh",
    [
      "test/scripts/ios-release-wrapper-args.test.ts",
      "test/scripts/ios-release-fastlane-gates.test.ts",
    ],
  ],
  ["scripts/ios-validate-app-store-ipa.sh", ["test/scripts/ios-validate-app-store-ipa.test.ts"]],
  ["scripts/lib/restart-mac-gateway.sh", ["test/scripts/restart-mac.test.ts"]],
  [
    "scripts/openclaw-release-clawhub-runtime-state.ts",
    ["test/scripts/openclaw-release-clawhub-runtime-state.test.ts"],
  ],
  ["scripts/openclaw-release-clawhub-plan.ts", ["test/scripts/release-wrapper-scripts.test.ts"]],
  [
    "scripts/plan-release-workflow-matrix.mjs",
    ["test/scripts/release-workflow-matrix-plan.test.ts"],
  ],
  ["scripts/release-fast-pretag-check.sh", ["test/scripts/package-acceptance-workflow.test.ts"]],
  ["scripts/openclaw-npm-resume-run.mjs", ["test/scripts/openclaw-npm-resume-run.test.ts"]],
  ["scripts/plugin-clawhub-release-check.ts", ["test/scripts/release-wrapper-scripts.test.ts"]],
  ["scripts/plugin-clawhub-release-plan.ts", ["test/scripts/release-wrapper-scripts.test.ts"]],
  ["scripts/plugin-npm-release-check.ts", ["test/scripts/release-wrapper-scripts.test.ts"]],
  ["scripts/plugin-npm-release-plan.ts", ["test/scripts/release-wrapper-scripts.test.ts"]],
  [
    "scripts/plugin-release-pretag-pack-check.ts",
    ["test/scripts/plugin-release-pretag-pack-check.test.ts"],
  ],
  ["scripts/release-verify-beta.ts", ["test/scripts/release-wrapper-scripts.test.ts"]],
  [
    "scripts/validate-release-publish-approval.mjs",
    ["test/scripts/validate-release-publish-approval.test.ts"],
  ],
  [
    "scripts/github/security-sensitive-guard.mjs",
    [
      "test/scripts/security-sensitive-guard-script.test.ts",
      "test/scripts/security-sensitive-guard-workflow.test.ts",
    ],
  ],
  [
    "scripts/dependency-ownership-surface-report.mjs",
    ["test/scripts/dependency-ownership-surface-report.test.ts"],
  ],
  [
    "scripts/dependency-vulnerability-gate.mjs",
    ["test/scripts/dependency-vulnerability-gate.test.ts"],
  ],
  [
    "scripts/deadcode-unused-files.allowlist.mjs",
    ["test/scripts/check-deadcode-unused-files.test.ts"],
  ],
  ["scripts/docs-list.js", ["test/scripts/docs-list.test.ts"]],
  ["scripts/docs-link-audit.mjs", ["src/scripts/docs-link-audit.test.ts"]],
  ["scripts/lib/arg-utils.mjs", ["test/scripts/arg-utils.test.ts"]],
  [
    "scripts/lib/android-version.ts",
    ["test/scripts/android-version.test.ts", "test/scripts/android-pin-version.test.ts"],
  ],
  [
    "scripts/lib/bundled-plugin-build-entries.mjs",
    ["test/scripts/bundled-plugin-build-entries.test.ts", "test/release-check.test.ts"],
  ],
  [
    "scripts/lib/bundled-plugin-source-utils.mjs",
    ["test/scripts/bundled-plugin-source-utils.test.ts"],
  ],
  ["scripts/lib/bundled-runtime-sidecar-paths.json", RUNTIME_SIDECAR_PATH_CONSUMER_TEST_TARGETS],
  ["scripts/lib/changed-extensions.mjs", ["test/scripts/test-extension.test.ts"]],
  ["scripts/lib/dev-tooling-safety.ts", ["test/scripts/dev-tooling-safety.test.ts"]],
  [
    "scripts/lib/dependency-ownership.json",
    ["test/scripts/dependency-ownership-surface-report.test.ts"],
  ],
  [
    "scripts/lib/deprecated-plugin-sdk-usage.mjs",
    ["test/scripts/check-deprecated-api-usage.test.ts"],
  ],
  [
    "scripts/lib/plugin-sdk-deprecated-barrel-subpaths.json",
    PLUGIN_SDK_ENTRY_METADATA_TEST_TARGETS,
  ],
  [
    "scripts/lib/plugin-sdk-deprecated-public-subpaths.json",
    [
      "test/scripts/check-deprecated-api-usage.test.ts",
      "src/plugins/contracts/plugin-sdk-package-contract-guardrails.test.ts",
      "test/scripts/plugin-sdk-surface-report.test.ts",
      "test/scripts/build-all.test.ts",
    ],
  ],
  ["scripts/lib/plugin-sdk-entrypoints.json", PLUGIN_SDK_ENTRY_METADATA_TEST_TARGETS],
  ["scripts/lib/plugin-sdk-entries.mjs", PLUGIN_SDK_ENTRY_METADATA_TEST_TARGETS],
  [
    "scripts/lib/plugin-sdk-private-local-only-subpaths.json",
    PLUGIN_SDK_ENTRY_METADATA_TEST_TARGETS,
  ],
  [
    "scripts/lib/official-external-channel-catalog.json",
    [...OFFICIAL_EXTERNAL_CATALOG_TEST_TARGETS, "test/official-channel-catalog.test.ts"],
  ],
  ["scripts/lib/official-external-plugin-catalog.json", OFFICIAL_EXTERNAL_CATALOG_TEST_TARGETS],
  ["scripts/lib/official-external-provider-catalog.json", OFFICIAL_EXTERNAL_CATALOG_TEST_TARGETS],
  ["scripts/lib/recommended-tool-installs.json", RECOMMENDED_TOOL_INSTALLS_TEST_TARGETS],
  ["scripts/lib/direct-run.mjs", ["test/scripts/changed-lanes.test.ts"]],
  ["scripts/prompt-snapshot-files.ts", ["test/scripts/prompt-snapshots.test.ts"]],
  [
    "scripts/docker/cleanup-smoke/Dockerfile",
    [...DOCKERFILE_CACHE_AND_DIGEST_TEST_TARGETS, "test/scripts/docker-build-helper.test.ts"],
  ],
  ["scripts/docker/cleanup-smoke/run.sh", ["test/scripts/docker-build-helper.test.ts"]],
  ["scripts/docker/install-sh-e2e/Dockerfile", INSTALL_DOCKERFILE_TEST_TARGETS],
  [
    "scripts/docker/install-sh-e2e/run.sh",
    ["test/scripts/docker-build-helper.test.ts", "test/scripts/test-install-sh-docker.test.ts"],
  ],
  [
    "scripts/docker/install-sh-common/cli-verify.sh",
    ["test/scripts/test-install-sh-docker.test.ts"],
  ],
  [
    "scripts/docker/install-sh-common/version-parse.sh",
    ["test/scripts/test-install-sh-docker.test.ts"],
  ],
  ["scripts/docker/install-sh-nonroot/Dockerfile", INSTALL_DOCKERFILE_TEST_TARGETS],
  ["scripts/docker/install-sh-nonroot/run.sh", ["test/scripts/test-install-sh-docker.test.ts"]],
  ["scripts/docker/install-sh-smoke/Dockerfile", INSTALL_DOCKERFILE_TEST_TARGETS],
  ["scripts/docker/install-sh-smoke/run.sh", ["test/scripts/test-install-sh-docker.test.ts"]],
  [
    "scripts/docker/sandbox/Dockerfile",
    [...DOCKERFILE_CACHE_AND_DIGEST_TEST_TARGETS, "src/dockerfile.test.ts"],
  ],
  [
    "scripts/docker/sandbox/Dockerfile.browser",
    [...DOCKERFILE_CACHE_AND_DIGEST_TEST_TARGETS, "src/agents/sandbox/browser.create.test.ts"],
  ],
  ["scripts/docker/sandbox/Dockerfile.common", ["src/docker-build-cache.test.ts"]],
  [
    "scripts/e2e/Dockerfile",
    [
      ...DOCKERFILE_CACHE_AND_DIGEST_TEST_TARGETS,
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
    ],
  ],
  [
    "scripts/e2e/Dockerfile.qr-import",
    [...DOCKERFILE_CACHE_AND_DIGEST_TEST_TARGETS, "test/scripts/docker-build-helper.test.ts"],
  ],
  [
    "scripts/e2e/plugin-binding-command-escape.Dockerfile",
    [
      "src/docker-image-digests.test.ts",
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
    ],
  ],
  ["scripts/lib/docker-e2e-container.sh", ["test/scripts/docker-build-helper.test.ts"]],
  ["scripts/lib/docker-e2e-package.sh", ["test/scripts/docker-build-helper.test.ts"]],
  [
    "scripts/lib/docker-e2e-plan.mjs",
    [
      "test/scripts/docker-e2e-plan.test.ts",
      "test/scripts/docker-all-scheduler.test.ts",
      "test/scripts/plugin-prerelease-test-plan.test.ts",
    ],
  ],
  ["scripts/lib/format-generated-module.mjs", ["test/scripts/format-generated-module.test.ts"]],
  ["scripts/lib/ios-version.ts", ["test/scripts/ios-version.test.ts"]],
  ["scripts/lib/live-docker-stage.sh", ["test/scripts/live-docker-stage.test.ts"]],
  ["scripts/live-docker-stage-private-sdk-exports.mjs", ["test/scripts/live-docker-stage.test.ts"]],
  [
    "scripts/lib/local-heavy-check-runtime.d.mts",
    ["test/scripts/local-heavy-check-runtime.test.ts"],
  ],
  ["scripts/lib/local-heavy-check-runtime.mjs", ["test/scripts/local-heavy-check-runtime.test.ts"]],
  ["scripts/lib/kova-report-gate.mjs", ["test/scripts/kova-report-gate.test.ts"]],
  ["scripts/lib/kova-report-publish-files.mjs", ["test/scripts/kova-report-publish-files.test.ts"]],
  ["scripts/lib/kova-report-selector.mjs", ["test/scripts/kova-report-selector.test.ts"]],
  ["scripts/lib/kova-workflow-evidence.mjs", ["test/scripts/kova-workflow-evidence.test.ts"]],
  ["scripts/lib/managed-child-process.mjs", ["test/scripts/managed-child-process.test.ts"]],
  [
    "scripts/lib/windows-taskkill.mjs",
    ["test/scripts/managed-child-process.test.ts", "test/scripts/run-with-env.test.ts"],
  ],
  [
    "scripts/lib/windows-taskkill.d.mts",
    ["test/scripts/managed-child-process.test.ts", "test/scripts/run-with-env.test.ts"],
  ],
  [
    "scripts/lib/local-build-metadata.mjs",
    [
      "src/infra/build-stamp.test.ts",
      "test/scripts/runtime-postbuild-stamp.test.ts",
      "src/infra/run-node.test.ts",
      "src/infra/package-dist-inventory.test.ts",
      "test/release-check.test.ts",
      "test/openclaw-npm-release-check.test.ts",
      "test/scripts/check-gateway-watch-regression.test.ts",
      "test/scripts/check-openclaw-package-tarball.test.ts",
      "test/scripts/openclaw-cross-os-release-checks.test.ts",
    ],
  ],
  [
    "scripts/lib/local-build-metadata-paths.mjs",
    [
      "src/infra/build-stamp.test.ts",
      "test/scripts/runtime-postbuild-stamp.test.ts",
      "src/infra/run-node.test.ts",
      "src/infra/package-dist-inventory.test.ts",
      "test/release-check.test.ts",
      "test/openclaw-npm-release-check.test.ts",
      "test/scripts/check-gateway-watch-regression.test.ts",
      "test/scripts/check-openclaw-package-tarball.test.ts",
      "test/scripts/openclaw-cross-os-release-checks.test.ts",
    ],
  ],
  ["scripts/lib/npm-verify-exec.ts", ["test/scripts/npm-verify-exec.test.ts"]],
  ["scripts/lib/openclaw-test-state.mjs", ["test/scripts/openclaw-test-state.test.ts"]],
  [
    "scripts/lib/workspace-bootstrap-smoke.mjs",
    ["test/release-check.test.ts", "test/openclaw-npm-release-check.test.ts"],
  ],
  [
    "scripts/lib/package-dist-imports.mjs",
    [
      "test/scripts/check-package-dist-imports.test.ts",
      "test/scripts/check-openclaw-package-tarball.test.ts",
      "test/scripts/postinstall-bundled-plugins.test.ts",
      "test/release-check.test.ts",
    ],
  ],
  [
    "scripts/lib/build-metadata.sh",
    [
      "src/docker-setup.e2e.test.ts",
      "test/scripts/apple-release-source-check.test.ts",
      "test/scripts/ios-version.test.ts",
      "test/scripts/package-mac-app.test.ts",
      "test/scripts/test-install-sh-docker.test.ts",
    ],
  ],
  [
    "scripts/lib/plistbuddy.sh",
    [
      "test/scripts/create-dmg.test.ts",
      "test/scripts/package-mac-app.test.ts",
      "test/scripts/package-mac-dist.test.ts",
    ],
  ],
  [
    "scripts/lib/swift-toolchain.sh",
    ["test/scripts/package-mac-app.test.ts", "test/scripts/package-mac-dist.test.ts"],
  ],
  [
    "scripts/lib/plugin-npm-runtime-build.mjs",
    ["test/scripts/plugin-npm-runtime-build-args.test.ts", "test/plugin-npm-runtime-build.test.ts"],
  ],
  [
    "scripts/lib/npm-publish-plan.mjs",
    [
      "test/npm-publish-plan.test.ts",
      "test/openclaw-npm-release-check.test.ts",
      "test/openclaw-npm-postpublish-verify.test.ts",
      "test/plugin-npm-release.test.ts",
      "test/plugin-clawhub-release.test.ts",
      "test/scripts/release-upgrade-baseline.test.ts",
      "test/scripts/android-version.test.ts",
      "test/scripts/ios-version.test.ts",
      "test/scripts/upgrade-survivor-baselines.test.ts",
      "test/scripts/upgrade-survivor-config-recipe.test.ts",
    ],
  ],
  ["scripts/sync-codex-model-prompt-fixture.ts", ["test/scripts/prompt-snapshots.test.ts"]],
  [
    "scripts/lib/npm-pack-budget.mjs",
    ["test/release-check.test.ts", "test/scripts/test-install-sh-docker.test.ts"],
  ],
  [
    "scripts/lib/npm-pack-budget.d.mts",
    ["test/release-check.test.ts", "test/scripts/test-install-sh-docker.test.ts"],
  ],
  ["scripts/lib/openclaw-release-clawhub-plan.ts", ["test/plugin-clawhub-release.test.ts"]],
  [
    "scripts/lib/actions-artifact-archive.mjs",
    ["test/scripts/plugin-publication-artifact.test.ts"],
  ],
  [
    "scripts/lib/clawhub-bootstrap-artifact.mjs",
    [
      "test/scripts/clawhub-bootstrap-artifact.test.ts",
      "test/scripts/verify-clawhub-published-artifact.test.ts",
    ],
  ],
  ["scripts/plugin-publication-artifact.mjs", ["test/scripts/plugin-publication-artifact.test.ts"]],
  [
    "scripts/materialize-clawhub-cli.sh",
    [
      "test/scripts/package-acceptance-workflow.test.ts",
      "test/scripts/plugin-clawhub-new-workflow.test.ts",
    ],
  ],
  [
    ".github/release/clawhub-cli/package.json",
    [
      "test/scripts/package-acceptance-workflow.test.ts",
      "test/scripts/plugin-clawhub-new-workflow.test.ts",
    ],
  ],
  [
    ".github/release/clawhub-cli/package-lock.json",
    [
      "test/scripts/package-acceptance-workflow.test.ts",
      "test/scripts/plugin-clawhub-new-workflow.test.ts",
    ],
  ],
  [
    "scripts/verify-clawhub-published-artifact.mjs",
    ["test/scripts/verify-clawhub-published-artifact.test.ts"],
  ],
  ["scripts/plugin-clawhub-publish.sh", ["test/plugin-clawhub-release.test.ts"]],
  ["scripts/lib/release-beta-verifier.ts", ["test/scripts/release-beta-verifier.test.ts"]],
  [
    "scripts/lib/plugin-clawhub-release.ts",
    ["test/plugin-clawhub-release.test.ts", "test/plugin-npm-release.test.ts"],
  ],
  [
    "scripts/lib/plugin-npm-release.ts",
    ["test/plugin-npm-release.test.ts", "test/plugin-clawhub-release.test.ts"],
  ],
  [
    "scripts/lib/plugin-npm-package-manifest.mjs",
    [
      "test/scripts/plugin-npm-package-manifest-args.test.ts",
      "test/plugin-npm-package-manifest.test.ts",
    ],
  ],
  [
    "scripts/lib/plugin-package-dependencies.mjs",
    ["test/scripts/plugin-package-dependencies.test.ts"],
  ],
  ["scripts/proxy-install-ca.mjs", ["test/scripts/proxy-install-ca.test.ts"]],
  ["scripts/release-preflight.mjs", ["test/scripts/release-preflight.test.ts"]],
  [
    "scripts/lib/plugin-npm-runtime-assets.mjs",
    ["test/scripts/plugin-npm-runtime-build-args.test.ts"],
  ],
  [
    "scripts/lib/generated-text-asset.mjs",
    [
      "extensions/browser/scripts/build-copilot-runtime.test.ts",
      "test/scripts/build-diffs-viewer-runtime.test.ts",
      "test/scripts/bundled-plugin-assets.test.ts",
    ],
  ],
  [
    "scripts/lib/static-extension-assets.mjs",
    [
      "test/scripts/bundled-plugin-assets.test.ts",
      "test/scripts/runtime-postbuild.test.ts",
      "src/infra/run-node.test.ts",
      "test/scripts/plugin-npm-runtime-build-args.test.ts",
    ],
  ],
  ["scripts/lib/stable-release-closeout.mjs", ["test/stable-release-closeout.test.ts"]],
  ["scripts/lib/source-file-scan-cache.mjs", ["test/scripts/source-file-scan-cache.test.ts"]],
  [
    "scripts/lib/extension-source-classifier.mjs",
    [
      "test/scripts/extension-source-classifier.test.ts",
      "src/channels/plugins/contracts/channel-import-guardrails.test.ts",
    ],
  ],
  ["scripts/lib/test-group-report.mjs", ["test/scripts/test-group-report.test.ts"]],
  ["scripts/lib/ts-topology/analyze.ts", ["test/scripts/ts-topology.test.ts"]],
  ["scripts/lib/ts-topology/reports.ts", ["test/scripts/ts-topology.test.ts"]],
  ["scripts/lib/ts-topology/scope.ts", ["test/scripts/ts-topology.test.ts"]],
  ["scripts/lib/ts-guard-utils.mjs", ["test/scripts/ts-guard-utils.test.ts"]],
  [
    "scripts/lib/tsgo-sparse-guard.mjs",
    ["test/scripts/run-tsgo.test.ts", "test/scripts/changed-lanes.test.ts"],
  ],
  ["scripts/lib/vitest-local-scheduling.mjs", ["test/scripts/vitest-local-scheduling.test.ts"]],
  [
    "scripts/mantis/build-telegram-evidence.mjs",
    ["test/scripts/mantis-build-telegram-evidence.test.ts"],
  ],
  [
    "scripts/mantis/build-telegram-desktop-proof-evidence.mjs",
    ["test/scripts/mantis-build-telegram-desktop-proof-evidence.test.ts"],
  ],
  [
    "scripts/mantis/build-web-ui-chat-evidence.mjs",
    ["test/scripts/mantis-web-ui-chat-evidence.test.ts"],
  ],
  ["scripts/mantis/publish-pr-evidence.mjs", ["test/scripts/mantis-publish-pr-evidence.test.ts"]],
  ["scripts/qa-e2e.ts", ["test/scripts/qa-e2e.test.ts"]],
  ["scripts/qa-lab-up.ts", ["test/scripts/qa-lab-up.test.ts"]],
  ["scripts/qa-coverage-report.ts", ["test/scripts/qa-report-cli.test.ts"]],
  ["scripts/qa-parity-report.ts", ["test/scripts/qa-report-cli.test.ts"]],
  ["scripts/qa/render-maturity-docs.ts", ["test/scripts/render-maturity-docs.test.ts"]],
  [
    "scripts/qa/ux-matrix-evidence-producer.ts",
    ["test/scripts/qa-ux-matrix-evidence-producer.test.ts"],
  ],
  [
    "scripts/run-vitest.mjs",
    [
      "test/scripts/run-vitest.test.ts",
      "test/scripts/test-projects.test.ts",
      "test/scripts/vitest-local-scheduling.test.ts",
    ],
  ],
  ["scripts/run-oxlint.mjs", ["test/scripts/run-oxlint.test.ts"]],
  ["scripts/run-oxlint-shards.mjs", ["test/scripts/run-oxlint.test.ts"]],
  ["scripts/run-lint.mjs", ["test/scripts/run-oxlint.test.ts"]],
  ["scripts/run-with-env.mjs", ["test/scripts/run-with-env.test.ts"]],
  ["scripts/run-node.mjs", ["src/infra/run-node.test.ts"]],
  [
    "scripts/stage-bundled-plugin-runtime.mjs",
    ["test/scripts/stage-bundled-plugin-runtime.test.ts"],
  ],
  ["scripts/watch-node.mjs", ["test/scripts/watch-node.test.ts"]],
  ["scripts/auth-monitor.sh", ["test/scripts/auth-monitor.test.ts"]],
  ["scripts/codespell-dictionary.txt", ["test/scripts/docs-spellcheck.test.ts"]],
  ["scripts/codespell-ignore.txt", ["test/scripts/docs-spellcheck.test.ts"]],
  ["scripts/docs-spellcheck.sh", ["test/scripts/docs-spellcheck.test.ts"]],
  ["scripts/mobile-reauth.sh", ["test/scripts/auth-monitor.test.ts"]],
  ["scripts/committer", ["test/scripts/committer.test.ts"]],
  ["scripts/gh-read", ["test/scripts/gh-read.test.ts"]],
  ["scripts/pr", ["test/scripts/pr-operation-lock.test.ts", "test/scripts/pr-wrappers.test.ts"]],
  ["scripts/pr-lib/operation-lock.sh", ["test/scripts/pr-operation-lock.test.ts"]],
  ["scripts/pr-lib/process-group-runner.mjs", ["test/scripts/pr-operation-lock.test.ts"]],
  ["scripts/pr-merge", ["test/scripts/pr-wrappers.test.ts"]],
  ["scripts/pr-prepare", ["test/scripts/pr-wrappers.test.ts"]],
  ["scripts/pr-review", ["test/scripts/pr-wrappers.test.ts"]],
  ["scripts/setup-auth-system.sh", ["test/scripts/auth-monitor.test.ts"]],
  ["scripts/systemd/openclaw-auth-monitor.service", ["test/scripts/auth-monitor.test.ts"]],
  ["scripts/systemd/openclaw-auth-monitor.timer", ["test/scripts/auth-monitor.test.ts"]],
  ["scripts/termux-auth-widget.sh", ["test/scripts/auth-monitor.test.ts"]],
  ["scripts/termux-quick-auth.sh", ["test/scripts/auth-monitor.test.ts"]],
  ["scripts/termux-sync-widget.sh", ["test/scripts/auth-monitor.test.ts"]],
  ["scripts/ci-run-timings.mjs", ["test/scripts/ci-run-timings.test.ts"]],
  ["scripts/docker-e2e.mjs", ["test/scripts/docker-e2e-helper-cli.test.ts"]],
  ["scripts/docker-e2e-rerun.mjs", ["test/scripts/docker-e2e-helper-cli.test.ts"]],
  ["scripts/docker-e2e-timings.mjs", ["test/scripts/docker-e2e-helper-cli.test.ts"]],
  ["scripts/e2e/bun-global-install-smoke.sh", ["test/scripts/test-install-sh-docker.test.ts"]],
  ["scripts/generate-npm-shrinkwrap.mjs", ["test/scripts/generate-npm-shrinkwrap.test.ts"]],
  ["scripts/npm-runner.d.mts", ["test/scripts/npm-runner.test.ts"]],
  ["scripts/pnpm-runner.d.mts", ["test/scripts/pnpm-runner.test.ts"]],
  [
    "scripts/install.sh",
    [
      "test/scripts/install-sh.test.ts",
      "test/scripts/test-install-sh-docker.test.ts",
      "test/scripts/website-installer-sync-workflow.test.ts",
      "test/scripts/openclaw-cross-os-release-checks.test.ts",
      "src/scripts/ci-changed-scope.test.ts",
    ],
  ],
  [
    "scripts/install.ps1",
    [
      "test/scripts/install-ps1.test.ts",
      "test/scripts/website-installer-sync-workflow.test.ts",
      "test/scripts/openclaw-cross-os-release-checks.test.ts",
      "src/scripts/ci-changed-scope.test.ts",
    ],
  ],
  ["scripts/podman/openclaw.container.in", ["test/scripts/test-install-sh-docker.test.ts"]],
  ["scripts/ios-run.sh", ["test/scripts/ios-run.test.ts"]],
  ["scripts/ios-write-version-xcconfig.sh", ["test/scripts/ios-version.test.ts"]],
  ["scripts/create-dmg.sh", ["test/scripts/create-dmg.test.ts"]],
  ["scripts/kova-ci-summary.mjs", ["test/scripts/kova-ci-summary.test.ts"]],
  ["scripts/make_appcast.sh", ["test/scripts/make-appcast.test.ts"]],
  ["scripts/ocm-npm-workspace-deps.mjs", ["test/scripts/ocm-npm-workspace-deps.test.ts"]],
  ["scripts/openclaw-npm-prepublish-verify.ts", ["test/openclaw-npm-prepublish-verify.test.ts"]],
  ["scripts/openclaw-npm-postpublish-verify.ts", ["test/openclaw-npm-postpublish-verify.test.ts"]],
  ["scripts/openclaw-npm-release-check.ts", ["test/openclaw-npm-release-check.test.ts"]],
  ["scripts/openclaw-prepack.ts", ["test/openclaw-prepack.test.ts"]],
  [
    "scripts/check-openclaw-package-tarball.mjs",
    ["test/scripts/check-openclaw-package-tarball.test.ts"],
  ],
  ["scripts/check-package-dist-imports.mjs", ["test/scripts/check-package-dist-imports.test.ts"]],
  [
    "scripts/check-plugin-npm-runtime-builds.mjs",
    ["test/scripts/plugin-npm-runtime-build-args.test.ts"],
  ],
  ["scripts/package-changelog.mjs", ["test/scripts/package-changelog.test.ts"]],
  ["scripts/render-github-release-notes.mjs", ["test/scripts/render-github-release-notes.test.ts"]],
  ["scripts/package-mac-app.sh", ["test/scripts/package-mac-app.test.ts"]],
  ["scripts/package-mac-dist.sh", ["test/scripts/package-mac-dist.test.ts"]],
  [
    "scripts/sparkle-build.ts",
    [
      "test/appcast.test.ts",
      "test/release-check.test.ts",
      "test/scripts/package-mac-app.test.ts",
      "test/scripts/package-mac-dist.test.ts",
    ],
  ],
  [
    "scripts/package-openclaw-for-docker.mjs",
    ["test/e2e/qa-lab/runtime/package-openclaw-for-docker.e2e.test.ts"],
  ],
  ["scripts/postinstall-bundled-plugins.mjs", ["test/scripts/postinstall-bundled-plugins.test.ts"]],
  ["scripts/prepare-git-hooks.mjs", ["test/scripts/prepare-git-hooks.test.ts"]],
  [
    "scripts/preinstall-package-manager-warning.mjs",
    ["test/scripts/preinstall-package-manager-warning.test.ts"],
  ],
  ["scripts/test-extension-batch.mjs", ["test/scripts/test-extension.test.ts"]],
  ["scripts/test-force.ts", ["test/scripts/test-force.test.ts"]],
  ["scripts/test-live.mjs", ["test/scripts/test-live.test.ts"]],
  [
    "scripts/test-install-sh-e2e-docker.sh",
    ["test/scripts/docker-build-helper.test.ts", "test/scripts/test-install-sh-docker.test.ts"],
  ],
  ["scripts/tsdown-build.mjs", ["test/scripts/tsdown-build.test.ts"]],
  ["scripts/verify.mjs", ["test/scripts/verify.test.ts"]],
  ["scripts/verify-pr-hosted-gates.mjs", ["test/scripts/verify-pr-hosted-gates.test.ts"]],
  [
    "scripts/write-plugin-sdk-entry-dts.ts",
    [
      "test/scripts/build-all.test.ts",
      "test/scripts/prepare-extension-package-boundary-artifacts.test.ts",
    ],
  ],
  ["scripts/zai-fallback-repro.ts", ["test/scripts/zai-fallback-repro.test.ts"]],
  ["scripts/fixtures/packed-plugin-sdk-type-smoke.ts", ["test/release-check.test.ts"]],
  ["scripts/repro/code-mode-namespace-live.ts", ["test/scripts/code-mode-namespace-live.test.ts"]],
  ["scripts/repro/tool-surface-live-bench.ts", ["test/scripts/tool-surface-live-bench.test.ts"]],
  [
    "scripts/repro/code-mode-namespace-live-docker.sh",
    ["test/scripts/code-mode-namespace-live.test.ts", "test/scripts/docker-build-helper.test.ts"],
  ],
  ["scripts/lib/extension-test-plan.mjs", ["test/scripts/test-extension.test.ts"]],
  ["scripts/lib/extension-vitest-paths.mjs", ["test/scripts/test-extension.test.ts"]],
  ["scripts/lib/vitest-batch-runner.mjs", ["test/scripts/test-extension.test.ts"]],
  ["scripts/lib/ci-node-test-plan.mjs", ["test/scripts/ci-node-test-plan.test.ts"]],
  [
    "scripts/lib/docker-e2e-scenarios.mjs",
    ["test/scripts/docker-e2e-plan.test.ts", "test/scripts/plugin-prerelease-test-plan.test.ts"],
  ],
  [
    "scripts/lib/plugin-prerelease-test-plan.mjs",
    ["test/scripts/plugin-prerelease-test-plan.test.ts"],
  ],
  [
    "scripts/e2e/kitchen-sink-plugin-docker.sh",
    [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/plugin-prerelease-test-plan.test.ts",
    ],
  ],
  [
    "scripts/e2e/kitchen-sink-rpc-docker.sh",
    [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/plugin-prerelease-test-plan.test.ts",
    ],
  ],
  [
    "scripts/e2e/kitchen-sink-rpc-walk.mjs",
    [
      "test/scripts/kitchen-sink-rpc-walk.test.ts",
      "test/scripts/plugin-prerelease-test-plan.test.ts",
    ],
  ],
  ["scripts/measure-rpc-rtt.mjs", ["test/scripts/measure-rpc-rtt.test.ts"]],
  [
    "scripts/e2e/telegram-user-crabbox-proof.ts",
    ["test/scripts/telegram-user-crabbox-proof.test.ts"],
  ],
  ["scripts/e2e/telegram-user-credential.ts", ["test/scripts/telegram-user-credential.test.ts"]],
  ["scripts/e2e/telegram-user-credential-io.ts", ["test/scripts/telegram-user-credential.test.ts"]],
  [
    "scripts/e2e/telegram-user-credential-paths.ts",
    ["test/scripts/telegram-user-credential.test.ts"],
  ],
  [
    "scripts/e2e/onboard-docker.sh",
    ["test/scripts/docker-build-helper.test.ts", "test/scripts/openclaw-test-state.test.ts"],
  ],
  [
    "scripts/e2e/agents-delete-shared-workspace-docker.sh",
    [
      "test/scripts/docker-e2e-plan.test.ts",
      "src/scripts/ci-changed-scope.test.ts",
      "src/commands/agents.delete.test.ts",
    ],
  ],
  [
    "scripts/e2e/browser-cdp-snapshot-docker.sh",
    [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/browser-cdp-snapshot.test.ts",
      "test/scripts/e2e-helper-env-limits.test.ts",
    ],
  ],
  [
    "scripts/e2e/config-reload-source-docker.sh",
    [
      "test/scripts/docker-e2e-plan.test.ts",
      "test/scripts/package-acceptance-workflow.test.ts",
      "test/scripts/fixture-config.test.ts",
      "test/scripts/e2e-mock-config-limits.test.ts",
      "src/gateway/config-reload.test.ts",
    ],
  ],
  ["scripts/e2e/lib/env-limits.mjs", ["test/scripts/e2e-helper-env-limits.test.ts"]],
  ["scripts/e2e/mock-openai-server.mjs", ["test/scripts/e2e-mock-config-limits.test.ts"]],
  [
    "scripts/e2e/gateway-network-docker.sh",
    [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "test/scripts/package-acceptance-workflow.test.ts",
      "test/scripts/gateway-network-client.test.ts",
      "src/scripts/ci-changed-scope.test.ts",
    ],
  ],
  [
    "scripts/e2e/npm-onboard-channel-agent-docker.sh",
    [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "test/scripts/package-acceptance-workflow.test.ts",
      "test/scripts/npm-onboard-channel-agent-assertions.test.ts",
      "test/scripts/plugin-prerelease-test-plan.test.ts",
    ],
  ],
  ["scripts/e2e/npm-telegram-live-docker.sh", ["test/scripts/npm-telegram-live.test.ts"]],
  ["scripts/e2e/npm-telegram-live-runner.ts", ["test/scripts/npm-telegram-live.test.ts"]],
  [
    "scripts/e2e/multi-node-update-docker.sh",
    ["test/scripts/docker-build-helper.test.ts", "test/scripts/docker-e2e-plan.test.ts"],
  ],
  [
    "scripts/e2e/doctor-install-switch-docker.sh",
    [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "test/scripts/package-acceptance-workflow.test.ts",
    ],
  ],
  [
    "scripts/e2e/update-channel-switch-docker.sh",
    [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "test/scripts/package-acceptance-workflow.test.ts",
    ],
  ],
  [
    "scripts/e2e/skill-install-docker.sh",
    [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "test/scripts/package-acceptance-workflow.test.ts",
      "test/scripts/e2e-shell-tempfiles.test.ts",
    ],
  ],
  [
    "scripts/e2e/upgrade-survivor-docker.sh",
    [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "test/scripts/package-acceptance-workflow.test.ts",
      "test/scripts/upgrade-survivor-probe-gateway.test.ts",
      "test/scripts/upgrade-survivor-assertions.test.ts",
      "test/scripts/openclaw-test-state.test.ts",
    ],
  ],
  ["scripts/e2e/plugin-lifecycle-matrix-docker.sh", ["test/scripts/docker-build-helper.test.ts"]],
  [
    "scripts/e2e/bundled-plugin-install-uninstall-docker.sh",
    [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "test/scripts/plugin-prerelease-test-plan.test.ts",
      "test/scripts/bundled-plugin-install-uninstall-probe.test.ts",
    ],
  ],
  [
    "scripts/e2e/lib/plugin-lifecycle-matrix/measure.mjs",
    ["test/scripts/plugin-lifecycle-measure.test.ts"],
  ],
  [
    "scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs",
    ["test/scripts/bundled-plugin-install-uninstall-probe.test.ts"],
  ],
  [
    "scripts/e2e/lib/bundled-plugin-install-uninstall/sweep.sh",
    ["test/scripts/bundled-plugin-install-uninstall-probe.test.ts"],
  ],
  [
    "scripts/e2e/lib/bun-global-install/assertions.mjs",
    ["test/scripts/test-install-sh-docker.test.ts"],
  ],
  [
    "scripts/e2e/lib/auth-profile-store-assertions.mjs",
    [
      "test/scripts/release-scenarios-assertions.test.ts",
      "test/scripts/npm-onboard-channel-agent-assertions.test.ts",
    ],
  ],
  [
    "scripts/e2e/lib/codex-npm-plugin-live/assertions.mjs",
    ["test/scripts/codex-install-assertions.test.ts", "test/scripts/docker-build-helper.test.ts"],
  ],
  [
    "scripts/e2e/lib/codex-npm-plugin-live/followthrough-turn.mjs",
    ["test/scripts/docker-build-helper.test.ts"],
  ],
  ["scripts/e2e/lib/codex-install-utils.mjs", ["test/scripts/codex-install-assertions.test.ts"]],
  [
    "scripts/e2e/lib/codex-on-demand/assertions.mjs",
    ["test/scripts/codex-install-assertions.test.ts"],
  ],
  [
    "scripts/e2e/lib/clawhub-fixture-server.cjs",
    [
      "test/scripts/clawhub-fixture-server.test.ts",
      "test/scripts/plugin-prerelease-test-plan.test.ts",
    ],
  ],
  ["scripts/e2e/lib/config-reload/assert-log.mjs", ["test/scripts/e2e-mock-config-limits.test.ts"]],
  [
    "scripts/e2e/lib/config-reload/mutate-metadata.mjs",
    ["test/scripts/config-reload-mutate-metadata.test.ts"],
  ],
  [
    "scripts/e2e/lib/docker-stats/assert-resource-ceiling.mjs",
    ["test/scripts/docker-stats-resource-ceiling.test.ts"],
  ],
  [
    "scripts/e2e/lib/doctor-install-switch/scenario.sh",
    ["test/scripts/docker-build-helper.test.ts"],
  ],
  [
    "scripts/e2e/lib/doctor-install-switch/write-wrapper.mjs",
    ["test/scripts/doctor-install-switch-wrapper.test.ts"],
  ],
  [
    "scripts/e2e/lib/doctor-install-switch/shims/loginctl",
    ["test/scripts/docker-build-helper.test.ts"],
  ],
  [
    "scripts/e2e/lib/doctor-install-switch/shims/systemctl",
    ["test/scripts/docker-build-helper.test.ts"],
  ],
  [
    "scripts/e2e/lib/fixture.mjs",
    [
      "test/scripts/fixture-config.test.ts",
      "test/scripts/fixtures-workspace.test.ts",
      "test/scripts/fixture-plugin-commands.test.ts",
    ],
  ],
  ["scripts/e2e/lib/fixtures/config.mjs", ["test/scripts/fixture-config.test.ts"]],
  ["scripts/e2e/lib/fixtures/common.mjs", ["test/scripts/fixture-common.test.ts"]],
  ["scripts/e2e/lib/fixtures/mock-openai-config.mjs", ["test/scripts/mock-openai-config.test.ts"]],
  ["scripts/e2e/lib/fixtures/plugins.mjs", ["test/scripts/fixture-plugin-commands.test.ts"]],
  [
    "scripts/e2e/lib/codex-app-server-fixture.mjs",
    [
      "test/scripts/codex-media-path-client.test.ts",
      "test/e2e/qa-lab/runtime/codex-auth-product-proof.e2e.test.ts",
    ],
  ],
  [
    "scripts/e2e/lib/codex-media-path/jsonl-request-tail.mjs",
    [
      "test/scripts/codex-media-path-client.test.ts",
      "test/e2e/qa-lab/runtime/codex-auth-product-proof.e2e.test.ts",
    ],
  ],
  [
    "scripts/e2e/lib/incremental-line-reader.mjs",
    [
      "test/scripts/incremental-line-reader.test.ts",
      "test/scripts/config-reload-log-scanner.test.ts",
      "test/scripts/codex-media-path-client.test.ts",
      "test/e2e/qa-lab/runtime/codex-auth-product-proof.e2e.test.ts",
    ],
  ],
  [
    "scripts/e2e/lib/kitchen-sink-plugin/sweep.sh",
    ["test/scripts/kitchen-sink-plugin-assertions.test.ts"],
  ],
  [
    "scripts/e2e/lib/mcp-code-mode-validation.ts",
    ["test/scripts/mcp-code-mode-gateway-client.test.ts"],
  ],
  [
    "scripts/e2e/lib/onboard/scenario.sh",
    ["test/scripts/e2e-shell-tempfiles.test.ts", "test/scripts/openclaw-test-state.test.ts"],
  ],
  ["scripts/e2e/lib/onboard/assert-config.mjs", ["test/scripts/onboard-config-fixtures.test.ts"]],
  ["scripts/e2e/lib/onboard/write-config.mjs", ["test/scripts/onboard-config-fixtures.test.ts"]],
  ["scripts/e2e/lib/package-compat.mjs", ["test/scripts/docker-build-helper.test.ts"]],
  [
    "scripts/e2e/lib/plugin-update/corrupt-update-scenario.sh",
    ["test/scripts/plugin-update-unchanged-docker.test.ts"],
  ],
  [
    "scripts/e2e/lib/plugin-update/probe.mjs",
    ["test/scripts/plugin-update-unchanged-docker.test.ts"],
  ],
  [
    "scripts/e2e/lib/plugin-update/registry-server.mjs",
    ["test/scripts/plugin-update-unchanged-docker.test.ts"],
  ],
  [
    "scripts/e2e/lib/plugin-update/unchanged-scenario.sh",
    ["test/scripts/plugin-update-unchanged-docker.test.ts"],
  ],
  [
    "scripts/e2e/plugin-update-unchanged-docker.sh",
    [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "test/scripts/plugin-prerelease-test-plan.test.ts",
      "test/scripts/plugin-update-unchanged-docker.test.ts",
    ],
  ],
  [
    "scripts/e2e/update-corrupt-plugin-docker.sh",
    [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "test/scripts/package-acceptance-workflow.test.ts",
      "test/scripts/plugin-update-unchanged-docker.test.ts",
    ],
  ],
  [
    "scripts/e2e/plugins-docker.sh",
    [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "test/scripts/plugins-assertions.test.ts",
    ],
  ],
  ["scripts/e2e/lib/plugins/clawhub.sh", ["test/scripts/plugins-assertions.test.ts"]],
  ["scripts/e2e/lib/plugins/fixtures.sh", ["test/scripts/plugins-assertions.test.ts"]],
  ["scripts/e2e/lib/plugins/marketplace.sh", ["test/scripts/plugins-assertions.test.ts"]],
  ["scripts/e2e/lib/plugins/sweep.sh", ["test/scripts/plugins-assertions.test.ts"]],
  [
    "scripts/e2e/lib/release-plugin-marketplace/scenario.sh",
    ["test/scripts/docker-build-helper.test.ts"],
  ],
  [
    "scripts/e2e/lib/release-typed-onboarding/scenario.sh",
    ["test/scripts/docker-build-helper.test.ts"],
  ],
  [
    "scripts/e2e/lib/release-upgrade-user-journey/scenario.sh",
    ["test/scripts/docker-build-helper.test.ts"],
  ],
  [
    "scripts/e2e/release-plugin-marketplace-docker.sh",
    [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "test/scripts/package-acceptance-workflow.test.ts",
    ],
  ],
  [
    "scripts/e2e/release-typed-onboarding-docker.sh",
    [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "test/scripts/package-acceptance-workflow.test.ts",
    ],
  ],
  [
    "scripts/e2e/release-upgrade-user-journey-docker.sh",
    [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "test/scripts/package-acceptance-workflow.test.ts",
    ],
  ],
  [
    "scripts/e2e/release-user-journey-docker.sh",
    [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "test/scripts/package-acceptance-workflow.test.ts",
      "test/scripts/release-user-journey-assertions.test.ts",
    ],
  ],
  [
    "scripts/e2e/lib/release-assertion-files.mjs",
    [
      "test/scripts/release-scenarios-assertions.test.ts",
      "test/scripts/release-user-journey-assertions.test.ts",
    ],
  ],
  ["scripts/e2e/lib/skills/clawhub-install-proof.sh", ["test/scripts/e2e-shell-tempfiles.test.ts"]],
  [
    "scripts/e2e/lib/update-channel-switch/assertions.mjs",
    ["test/scripts/docker-build-helper.test.ts"],
  ],
  [
    "scripts/e2e/live-plugin-tool-docker.sh",
    [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "test/scripts/live-plugin-tool-assertions.test.ts",
    ],
  ],
  [
    "scripts/e2e/openai-image-auth-docker.sh",
    [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "test/scripts/openai-image-auth-docker-client.test.ts",
      "extensions/openai/image-generation-provider.test.ts",
    ],
  ],
  [
    "test/e2e/qa-lab/runtime/openai-image-auth-docker-client.ts",
    [
      "test/scripts/openai-image-auth-docker-client.test.ts",
      "extensions/openai/image-generation-provider.test.ts",
      "src/image-generation/openai-compatible-image-provider.test.ts",
    ],
  ],
  [
    "test/e2e/qa-lab/runtime/codex-auth-app-server.fixture.mjs",
    ["test/e2e/qa-lab/runtime/codex-auth-product-proof.e2e.test.ts"],
  ],
  [
    "scripts/e2e/lib/openai-chat-tools/client.mjs",
    ["test/e2e/qa-lab/runtime/openai-compatible-chat-tools.e2e.test.ts"],
  ],
  [
    "scripts/e2e/lib/openai-chat-tools/scenario.sh",
    ["test/e2e/qa-lab/runtime/openai-compatible-chat-tools.e2e.test.ts"],
  ],
  [
    "scripts/e2e/lib/openai-chat-tools/write-config.mjs",
    ["test/e2e/qa-lab/runtime/openai-compatible-chat-tools.e2e.test.ts"],
  ],
  [
    "scripts/e2e/openai-chat-tools-docker.sh",
    [
      "test/e2e/qa-lab/runtime/openai-compatible-chat-tools.e2e.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
    ],
  ],
  [
    "scripts/e2e/lib/openai-web-search-minimal/assertions.mjs",
    ["test/e2e/qa-lab/runtime/openai-web-search-minimal-assertions.e2e.test.ts"],
  ],
  [
    "scripts/e2e/lib/openai-web-search-minimal/client.mjs",
    ["test/e2e/qa-lab/runtime/openai-web-search-minimal.e2e.test.ts"],
  ],
  [
    "scripts/e2e/lib/openai-web-search-minimal/mock-server.mjs",
    [
      "test/e2e/qa-lab/runtime/openai-web-search-minimal.e2e.test.ts",
      "test/e2e/qa-lab/runtime/openai-web-search-minimal-assertions.e2e.test.ts",
    ],
  ],
  [
    "scripts/e2e/lib/openai-web-search-minimal/scenario.sh",
    [
      "test/e2e/qa-lab/runtime/openai-web-search-minimal.e2e.test.ts",
      "test/e2e/qa-lab/runtime/openai-web-search-minimal-assertions.e2e.test.ts",
    ],
  ],
  [
    "scripts/e2e/openai-web-search-minimal-docker.sh",
    [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "test/e2e/qa-lab/runtime/openai-web-search-minimal.e2e.test.ts",
      "test/e2e/qa-lab/runtime/openai-web-search-minimal-assertions.e2e.test.ts",
    ],
  ],
  [
    "scripts/e2e/lib/openwebui/http-probe.mjs",
    ["test/e2e/qa-lab/runtime/openwebui-probe.e2e.test.ts"],
  ],
  ["scripts/e2e/lib/text-file-utils.mjs", ["test/scripts/e2e-text-file-utils.test.ts"]],
  [
    "scripts/e2e/openwebui-docker.sh",
    [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "test/e2e/qa-lab/runtime/openwebui-probe.e2e.test.ts",
      "test/scripts/fixture-config.test.ts",
    ],
  ],
  ["scripts/e2e/openwebui-probe.mjs", ["test/e2e/qa-lab/runtime/openwebui-probe.e2e.test.ts"]],
  [
    "scripts/e2e/plugin-binding-command-escape-docker.sh",
    [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "test/scripts/package-acceptance-workflow.test.ts",
    ],
  ],
  ["scripts/e2e/qr-import-docker.sh", ["test/scripts/docker-build-helper.test.ts"]],
  [
    "scripts/e2e/release-media-memory-docker.sh",
    ["test/scripts/docker-e2e-plan.test.ts", "test/scripts/release-media-memory-scenario.test.ts"],
  ],
  ["scripts/lib/vitest-shard-timings.mjs", ["test/scripts/vitest-shard-timings.test.ts"]],
  [
    "scripts/plugin-prerelease-liveish-matrix.mjs",
    ["test/scripts/plugin-prerelease-test-plan.test.ts"],
  ],
  ["scripts/test-projects.mjs", ["test/scripts/test-projects.test.ts"]],
  ["scripts/test-projects.test-support.d.mts", ["test/scripts/test-projects.test.ts"]],
  ["scripts/test-projects.test-support.mjs", ["test/scripts/test-projects.test.ts"]],
  ["scripts/dev/gateway-smoke.ts", ["test/e2e/qa-lab/runtime/gateway-smoke.e2e.test.ts"]],
  ["scripts/dev/test-device-pair-telegram.ts", ["test/scripts/test-device-pair-telegram.test.ts"]],
  [
    "test/e2e/qa-lab/media/hosted-media-provider-live.ts",
    ["test/e2e/qa-lab/media/hosted-media-provider-live.test.ts"],
  ],
  ["scripts/profile-extension-memory.mjs", ["test/scripts/profile-extension-memory.test.ts"]],
  [
    "scripts/openclaw-performance-source-summary.mjs",
    ["test/scripts/openclaw-performance-source-summary.test.ts"],
  ],
  ["scripts/check-gateway-cpu-scenarios.mjs", ["test/scripts/check-gateway-cpu-scenarios.test.ts"]],
  [
    "scripts/check-gateway-watch-regression.mjs",
    ["test/scripts/check-gateway-watch-regression.test.ts"],
  ],
  ["scripts/write-package-dist-inventory.ts", ["test/scripts/test-install-sh-docker.test.ts"]],
  ["scripts/e2e/cron-mcp-cleanup-seed.ts", ["test/scripts/docker-e2e-seeds.test.ts"]],
  ["scripts/bundled-plugin-assets.mjs", ["test/scripts/bundled-plugin-assets.test.ts"]],
  ["scripts/bundle-a2ui.mjs", ["test/scripts/bundled-plugin-assets.test.ts"]],
  ["scripts/build-discord-activity-sdk.mjs", ["test/scripts/bundled-plugin-assets.test.ts"]],
  ["scripts/build-diffs-viewer-runtime.mjs", ["test/scripts/build-diffs-viewer-runtime.test.ts"]],
  ["scripts/run-node-watch-paths.mjs", ["test/scripts/bundled-plugin-assets.test.ts"]],
  [
    "extensions/browser/scripts/build-copilot-runtime.mjs",
    ["extensions/browser/scripts/build-copilot-runtime.test.ts"],
  ],
  ["extensions/canvas/scripts/bundle-a2ui.mjs", ["extensions/canvas/scripts/bundle-a2ui.test.ts"]],
  ["extensions/canvas/scripts/copy-a2ui.mjs", ["extensions/canvas/scripts/copy-a2ui.test.ts"]],
]);

const CROSS_OS_RELEASE_CHECK_SOURCE_PATHS = [
  "scripts/openclaw-cross-os-release-checks.ts",
  "scripts/lib/cross-os-release-checks/agent.ts",
  "scripts/lib/cross-os-release-checks/config.ts",
  "scripts/lib/cross-os-release-checks/index.ts",
  "scripts/lib/cross-os-release-checks/install.ts",
  "scripts/lib/cross-os-release-checks/installed.ts",
  "scripts/lib/cross-os-release-checks/lanes.ts",
  "scripts/lib/cross-os-release-checks/logs.ts",
  "scripts/lib/cross-os-release-checks/network-smokes.ts",
  "scripts/lib/cross-os-release-checks/process.ts",
  "scripts/lib/cross-os-release-checks/reporting.ts",
  "scripts/lib/cross-os-release-checks/runtime.ts",
  "scripts/lib/cross-os-release-checks/shared.ts",
];
for (const sourcePath of CROSS_OS_RELEASE_CHECK_SOURCE_PATHS) {
  TOOLING_SOURCE_TEST_TARGETS.set(sourcePath, [
    "test/scripts/openclaw-cross-os-release-checks.test.ts",
  ]);
}

const TOOLING_DECLARATION_SOURCE_MIRRORS = [
  ["scripts/build-stamp.d.mts", "scripts/build-stamp.mjs"],
  ["scripts/ci-changed-scope.d.mts", "scripts/ci-changed-scope.mjs"],
  [
    "scripts/check-native-state-schema-version.d.mts",
    "scripts/check-native-state-schema-version.mjs",
  ],
  ["scripts/copy-bundled-plugin-metadata.d.mts", "scripts/copy-bundled-plugin-metadata.mjs"],
  ["scripts/docs-link-audit.d.mts", "scripts/docs-link-audit.mjs"],
  ["scripts/openclaw-npm-resume-run.d.mts", "scripts/openclaw-npm-resume-run.mjs"],
  ["scripts/periphery-intersection.d.mts", "scripts/periphery-intersection.mjs"],
  [
    "scripts/lib/bundled-plugin-build-entries.d.mts",
    "scripts/lib/bundled-plugin-build-entries.mjs",
  ],
  ["scripts/lib/config-boundary-guard.d.mts", "scripts/lib/config-boundary-guard.mjs"],
  ["scripts/lib/deprecated-config-api-guard.d.mts", "scripts/lib/deprecated-config-api-guard.mjs"],
  ["scripts/lib/extension-source-classifier.d.mts", "scripts/lib/extension-source-classifier.mjs"],
  ["scripts/lib/local-build-metadata-paths.d.mts", "scripts/lib/local-build-metadata-paths.mjs"],
  ["scripts/lib/local-build-metadata.d.mts", "scripts/lib/local-build-metadata.mjs"],
  ["scripts/lib/plugin-sdk-entries.d.mts", "scripts/lib/plugin-sdk-entries.mjs"],
  ["scripts/lib/vitest-local-scheduling.d.mts", "scripts/lib/vitest-local-scheduling.mjs"],
  ["scripts/run-node.d.mts", "scripts/run-node.mjs"],
  ["scripts/stage-bundled-plugin-runtime.d.mts", "scripts/stage-bundled-plugin-runtime.mjs"],
  ["scripts/watch-node.d.mts", "scripts/watch-node.mjs"],
];

for (const [declarationPath, implementationPath] of TOOLING_DECLARATION_SOURCE_MIRRORS) {
  const targets = TOOLING_SOURCE_TEST_TARGETS.get(implementationPath);
  if (targets === undefined) {
    throw new Error(`Missing changed-test route for declaration mirror ${implementationPath}`);
  }
  TOOLING_SOURCE_TEST_TARGETS.set(declarationPath, targets);
}

const TOOLING_TEST_TARGETS = new Map([
  ["test/scripts/auth-monitor.test.ts", ["test/scripts/auth-monitor.test.ts"]],
  ["test/scripts/barnacle-auto-response.test.ts", ["test/scripts/barnacle-auto-response.test.ts"]],
  ["test/scripts/changed-lanes.test.ts", ["test/scripts/changed-lanes.test.ts"]],
  [
    "test/scripts/check-deadcode-unused-files.test.ts",
    ["test/scripts/check-deadcode-unused-files.test.ts"],
  ],
  ["test/scripts/ci-docker-pull-retry.test.ts", ["test/scripts/ci-docker-pull-retry.test.ts"]],
  ["test/scripts/control-ui-i18n.test.ts", ["test/scripts/control-ui-i18n.test.ts"]],
  ["test/scripts/docker-build-helper.test.ts", ["test/scripts/docker-build-helper.test.ts"]],
  ["test/scripts/docs-spellcheck.test.ts", ["test/scripts/docs-spellcheck.test.ts"]],
  ["test/scripts/docker-e2e-helper-cli.test.ts", ["test/scripts/docker-e2e-helper-cli.test.ts"]],
  ["test/scripts/kova-ci-summary.test.ts", ["test/scripts/kova-ci-summary.test.ts"]],
  ["test/scripts/live-docker-stage.test.ts", ["test/scripts/live-docker-stage.test.ts"]],
  ["test/scripts/openclaw-test-state.test.ts", ["test/scripts/openclaw-test-state.test.ts"]],
  ["test/scripts/qa-lab-up.test.ts", ["test/scripts/qa-lab-up.test.ts"]],
  [
    "test/scripts/mantis-publish-pr-evidence.test.ts",
    ["test/scripts/mantis-publish-pr-evidence.test.ts"],
  ],
  [
    "test/scripts/mantis-build-telegram-evidence.test.ts",
    ["test/scripts/mantis-build-telegram-evidence.test.ts"],
  ],
  [
    "test/scripts/mantis-build-telegram-desktop-proof-evidence.test.ts",
    ["test/scripts/mantis-build-telegram-desktop-proof-evidence.test.ts"],
  ],
  [
    "test/scripts/mantis-web-ui-chat-evidence.test.ts",
    ["test/scripts/mantis-web-ui-chat-evidence.test.ts"],
  ],
  [
    "test/scripts/plugin-prerelease-test-plan.test.ts",
    ["test/scripts/plugin-prerelease-test-plan.test.ts"],
  ],
  ["test/scripts/pr-operation-lock.test.ts", ["test/scripts/pr-operation-lock.test.ts"]],
  ["test/scripts/pr-wrappers.test.ts", ["test/scripts/pr-wrappers.test.ts"]],
  ["test/scripts/test-projects.test.ts", ["test/scripts/test-projects.test.ts"]],
  [
    "test/scripts/vitest-local-scheduling.test.ts",
    ["test/scripts/vitest-local-scheduling.test.ts"],
  ],
  ["test/scripts/zai-fallback-repro.test.ts", ["test/scripts/zai-fallback-repro.test.ts"]],
]);
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
  ["extensions/google-meet/src/cli.ts", ["extensions/google-meet/src/cli.test.ts"]],
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
const GATEWAY_SERVER_FULL_SUITE_TARGET_CHUNK_COUNT = 4;
const GATEWAY_SERVER_BACKED_HTTP_TEST_TARGETS = new Set([
  "src/gateway/embeddings-http.test.ts",
  "src/gateway/models-http.test.ts",
  "src/gateway/openai-http.test.ts",
  "src/gateway/openresponses-http.test.ts",
  "src/gateway/probe.auth.integration.test.ts",
]);
const GATEWAY_SERVER_EXCLUDED_TEST_TARGETS = new Set([
  "src/gateway/gateway.test.ts",
  "src/gateway/server.startup-matrix-migration.integration.test.ts",
  "src/gateway/sessions-history-http.test.ts",
]);
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
// Duplicates the per-config pattern arrays in test/vitest/vitest.contracts-shared.ts
// because this file must stay loader-free plain JS. Drift silently drops
// contract files from lane routing, so test/scripts/test-projects.test.ts
// asserts both enumerations stay identical.
export const CHANNEL_CONTRACT_CONFIG_PATTERNS = new Map([
  [
    CONTRACTS_CHANNEL_SURFACE_VITEST_CONFIG,
    [
      "src/channels/plugins/contracts/channel-catalog.contract.test.ts",
      "src/channels/plugins/contracts/channel-import-guardrails.test.ts",
      "src/channels/plugins/contracts/group-policy.fallback.contract.test.ts",
      "src/channels/plugins/contracts/message-tool-artifact.contract.test.ts",
      "src/channels/plugins/contracts/outbound-payload.contract.test.ts",
      "src/channels/plugins/contracts/*-shard-a.contract.test.ts",
      "src/channels/plugins/contracts/*-shard-e.contract.test.ts",
    ],
  ],
  [
    CONTRACTS_CHANNEL_CONFIG_VITEST_CONFIG,
    [
      "src/channels/plugins/contracts/gateway-auth-artifact.contract.test.ts",
      "src/channels/plugins/contracts/plugins-core.authorize-config-write.policy.contract.test.ts",
      "src/channels/plugins/contracts/plugins-core.authorize-config-write.targets.contract.test.ts",
      "src/channels/plugins/contracts/plugins-core.catalog.entries.contract.test.ts",
      "src/channels/plugins/contracts/*-shard-b.contract.test.ts",
      "src/channels/plugins/contracts/*-shard-f.contract.test.ts",
    ],
  ],
  [
    CONTRACTS_CHANNEL_REGISTRY_VITEST_CONFIG,
    [
      "src/channels/plugins/contracts/plugin-shape.contract.test.ts",
      "src/channels/plugins/contracts/plugins-core.catalog.paths.contract.test.ts",
      "src/channels/plugins/contracts/plugins-core.loader.contract.test.ts",
      "src/channels/plugins/contracts/plugins-core.registry.contract.test.ts",
      "src/channels/plugins/contracts/*-shard-c.contract.test.ts",
      "src/channels/plugins/contracts/*-shard-g.contract.test.ts",
    ],
  ],
  [
    CONTRACTS_CHANNEL_SESSION_VITEST_CONFIG,
    [
      "src/channels/plugins/contracts/plugins-core.resolve-config-writes.contract.test.ts",
      "src/channels/plugins/contracts/registry.contract.test.ts",
      "src/channels/plugins/contracts/session-binding.registry-backed.contract.test.ts",
      "src/channels/plugins/contracts/session-key-artifact.contract.test.ts",
      "src/channels/plugins/contracts/thread-binding-artifact.contract.test.ts",
      "src/channels/plugins/contracts/*-shard-d.contract.test.ts",
      "src/channels/plugins/contracts/*-shard-h.contract.test.ts",
    ],
  ],
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

function listGatewayFilesFromGit(cwd) {
  const result = spawnSync("git", ["ls-files", "--", "src/gateway"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => normalizePathPattern(line.trim()))
    .filter((line) => line.length > 0);
}

function isGatewayServerFullSuiteTarget(relative) {
  if (
    GATEWAY_SERVER_EXCLUDED_TEST_TARGETS.has(relative) ||
    relative.startsWith("src/gateway/server-methods/")
  ) {
    return false;
  }
  return (
    GATEWAY_SERVER_BACKED_HTTP_TEST_TARGETS.has(relative) ||
    (relative.startsWith("src/gateway/") &&
      path.posix.basename(relative).includes("server") &&
      relative.endsWith(".test.ts"))
  );
}

function resolveGatewayServerFullSuiteTargets(cwd) {
  const gatewayDir = path.join(cwd, "src/gateway");
  if (!fs.existsSync(gatewayDir)) {
    return [];
  }
  return (listGatewayFilesFromGit(cwd) ?? listRepoFilesRecursive(gatewayDir, cwd))
    .filter(isGatewayServerFullSuiteTarget)
    .toSorted((a, b) => a.localeCompare(b));
}

function splitTargetChunks(targets, chunkCount) {
  if (targets.length === 0) {
    return [];
  }
  const normalizedChunkCount = Math.min(chunkCount, targets.length);
  const baseSize = Math.floor(targets.length / normalizedChunkCount);
  const remainder = targets.length % normalizedChunkCount;
  const chunks = [];
  let offset = 0;
  for (let index = 0; index < normalizedChunkCount; index += 1) {
    const chunkSize = baseSize + (index < remainder ? 1 : 0);
    chunks.push(targets.slice(offset, offset + chunkSize));
    offset += chunkSize;
  }
  return chunks;
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
  const isolatedTests = new Set(agentsCoreIsolatedTestFiles);
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

function listImportGraphFiles(cwd, directory, files = []) {
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
        listImportGraphFiles(cwd, relative, files);
      }
      continue;
    }
    if (entry.isFile() && IMPORTABLE_FILE_EXTENSIONS.some((ext) => relative.endsWith(ext))) {
      files.push(relative);
    }
  }
  return files;
}

function resolveImportSpecifier(importer, specifier, fileSet) {
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
      candidates.push(
        ...IMPORTABLE_FILE_EXTENSIONS.map((candidateExt) => `${withoutExt}${candidateExt}`),
      );
    }
  } else {
    candidates.push(
      ...IMPORTABLE_FILE_EXTENSIONS.map((candidateExt) => `${base}${candidateExt}`),
      ...IMPORTABLE_FILE_EXTENSIONS.map((candidateExt) => `${base}/index${candidateExt}`),
    );
  }

  return candidates.find((candidate) => fileSet.has(candidate)) ?? null;
}

let cachedImportGraph = null;
let cachedImportGraphCwd = null;
let cachedImportGraphFiles = null;
let cachedImportGraphFilesCwd = null;
const cachedImportGraphGrepMatches = new Map();
const cachedDirectImporters = new Map();

function isImportableGraphFile(relative) {
  return IMPORTABLE_FILE_EXTENSIONS.some((ext) => relative.endsWith(ext));
}

function listImportGraphFilesFromGit(cwd) {
  const result = spawnSync("git", ["ls-files", "--", ...SOURCE_ROOTS_FOR_IMPORT_GRAPH], {
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
    .filter((line) => line.length > 0 && isImportableGraphFile(line));
}

function listImportGraphFilesForCwd(cwd) {
  if (cachedImportGraphFiles && cachedImportGraphFilesCwd === cwd) {
    return cachedImportGraphFiles;
  }

  cachedImportGraphFiles =
    listImportGraphFilesFromGit(cwd) ??
    SOURCE_ROOTS_FOR_IMPORT_GRAPH.flatMap((root) => listImportGraphFiles(cwd, root));
  cachedImportGraphFilesCwd = cwd;
  return cachedImportGraphFiles;
}

function stripImportableGraphExtension(relative) {
  for (const ext of IMPORTABLE_FILE_EXTENSIONS) {
    if (relative.endsWith(ext)) {
      return relative.slice(0, -ext.length);
    }
  }
  return relative;
}

function resolveImportGraphSearchTerms(relative) {
  const withoutExtension = stripImportableGraphExtension(relative);
  const basename = path.posix.basename(stripImportableGraphExtension(relative));
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

function listImportGraphGrepMatches(cwd, term) {
  const cacheKey = `${cwd}\0${term}`;
  if (cachedImportGraphGrepMatches.has(cacheKey)) {
    return cachedImportGraphGrepMatches.get(cacheKey);
  }

  const result = spawnSync(
    "git",
    ["grep", "-l", "--fixed-strings", term, "--", ...IMPORT_GRAPH_GREP_PATHS],
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
    .filter((line) => line.length > 0 && isImportableGraphFile(line));
  cachedImportGraphGrepMatches.set(cacheKey, matches);
  return matches;
}

function findDirectImportersWithGitGrep(cwd, importedFile, fileSet) {
  const cacheKey = `${cwd}\0${importedFile}`;
  if (cachedDirectImporters.has(cacheKey)) {
    return cachedDirectImporters.get(cacheKey);
  }

  const terms = resolveImportGraphSearchTerms(importedFile);
  if (terms.length === 0) {
    cachedDirectImporters.set(cacheKey, null);
    return null;
  }

  let skippedBroadTerm = false;
  const importers = [];
  for (const term of terms) {
    const candidates = listImportGraphGrepMatches(cwd, term);
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
        const imported = resolveImportSpecifier(file, match[1] ?? match[2] ?? "", fileSet);
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

function resolveAffectedTestsFromTargetedImportScan(changedPath, cwd) {
  const normalized = normalizePathPattern(changedPath);
  const files = listImportGraphFilesForCwd(cwd);
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
    const importers = findDirectImportersWithGitGrep(cwd, current, fileSet);
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
      queue.push(importer);
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
  const name = path.posix.basename(relative);
  if (/-shard-[ae]\.contract\.test\.ts$/u.test(name)) {
    return "contractsChannelSurface";
  }
  if (/-shard-[bf]\.contract\.test\.ts$/u.test(name)) {
    return "contractsChannelConfig";
  }
  if (/-shard-[cg]\.contract\.test\.ts$/u.test(name)) {
    return "contractsChannelRegistry";
  }
  if (/-shard-[dh]\.contract\.test\.ts$/u.test(name)) {
    return "contractsChannelSession";
  }
  if (
    [
      "channel-catalog.contract.test.ts",
      "channel-import-guardrails.test.ts",
      "group-policy.fallback.contract.test.ts",
      "message-tool-artifact.contract.test.ts",
      "outbound-payload.contract.test.ts",
    ].includes(name)
  ) {
    return "contractsChannelSurface";
  }
  if (
    [
      "gateway-auth-artifact.contract.test.ts",
      "plugins-core.authorize-config-write.policy.contract.test.ts",
      "plugins-core.authorize-config-write.targets.contract.test.ts",
      "plugins-core.catalog.entries.contract.test.ts",
    ].includes(name)
  ) {
    return "contractsChannelConfig";
  }
  if (
    [
      "plugin-shape.contract.test.ts",
      "plugins-core.catalog.paths.contract.test.ts",
      "plugins-core.loader.contract.test.ts",
      "plugins-core.registry.contract.test.ts",
    ].includes(name)
  ) {
    return "contractsChannelRegistry";
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
    const testTargets = resolveToolingTestTargets(changedPath, cwd);
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

function resolveGithubYamlGuardTargets(changedPath) {
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/u.test(changedPath)) {
    return GITHUB_YAML_PINNING_GUARD_TEST_TARGETS;
  }
  if (/^\.github\/actions\/.+\.ya?ml$/u.test(changedPath)) {
    return GITHUB_YAML_PINNING_GUARD_TEST_TARGETS;
  }
  return null;
}

function resolveGithubWorkflowOwnerTargets(changedPath) {
  return GITHUB_WORKFLOW_OWNER_TEST_TARGETS.get(changedPath) ?? null;
}

function resolveToolingTestTargets(changedPath, cwd = process.cwd()) {
  const explicitTargets =
    TOOLING_SOURCE_TEST_TARGETS.get(changedPath) ??
    TOOLING_TEST_TARGETS.get(changedPath) ??
    resolveUpgradeSurvivorConfigRecipeTargets(changedPath) ??
    resolveDocsI18nBehaviorTargets(changedPath) ??
    resolveDocsI18nGoTargets(changedPath) ??
    resolveK8sManifestTargets(changedPath) ??
    resolveParallelsToolingTestTargets(changedPath);
  const githubWorkflowOwnerTargets = resolveGithubWorkflowOwnerTargets(changedPath);
  const githubYamlGuardTargets = resolveGithubYamlGuardTargets(changedPath);
  const conventionalTargets = resolveConventionalToolingTestTargets(changedPath, cwd);
  const targets = [
    ...(explicitTargets ?? []),
    ...(githubWorkflowOwnerTargets ?? []),
    ...(githubYamlGuardTargets ?? []),
    ...(conventionalTargets ?? []),
  ];
  if (targets.length > 0) {
    return uniqueOrdered(targets);
  }
  return isToolingScriptPath(changedPath) ? [TOOLING_VITEST_CONFIG] : null;
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
    resolveToolingTestTargets(changedPath) ??
    SOURCE_TEST_TARGETS.get(changedPath) ??
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
    return "agentsCoreIsolated";
  }
  if (isControlUiE2eTarget(relative)) {
    return "uiE2e";
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
  if (isPathAtOrUnder(relative, "src/cli")) {
    return "cli";
  }
  if (isPathAtOrUnder(relative, "src/commands")) {
    return isCommandsLightTarget(relative) ? "commandLight" : "command";
  }
  if (isPathAtOrUnder(relative, "src/auto-reply")) {
    return "autoReply";
  }
  if (isPathAtOrUnder(relative, "src/agents")) {
    return "agent";
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

  if (watchMode && groupedTargets.size > 1) {
    throw new Error(
      "watch mode with mixed test suites is not supported; target one suite at a time or use a dedicated suite command",
    );
  }

  const orderedKinds = [
    "unitFast",
    "unitFastIsolated",
    "unitFastFakeTimers",
    "default",
    "boundary",
    "toolingDocker",
    "toolingIsolated",
    "tooling",
    "contractsChannelSurface",
    "contractsChannelConfig",
    "contractsChannelRegistry",
    "contractsChannelSession",
    "contractsPlugin",
    "bundled",
    "gateway",
    "gatewayCore",
    "gatewayClient",
    "gatewayMethods",
    "gatewayServer",
    "hooks",
    "infra",
    "runtimeConfig",
    "cron",
    "daemon",
    "media",
    "logging",
    "pluginSdkLight",
    "pluginSdk",
    "process",
    "secrets",
    "sharedCore",
    "tasks",
    "tui",
    "tuiPty",
    "mediaUnderstanding",
    "acp",
    "cli",
    "commandLight",
    "command",
    "autoReply",
    "autoReplyCore",
    "autoReplyReply",
    "autoReplyTopLevel",
    "agentCore",
    "agentEmbedded",
    "agentSupport",
    "agentTools",
    "agent",
    "agentsCoreIsolated",
    "agentsCore",
    "agentsSupport",
    "agentsTools",
    "plugin",
    "ui",
    "uiE2e",
    "unitSrc",
    "unitSecurity",
    "unitSupport",
    "utils",
    "wizard",
    "e2e",
    "extensionActiveMemory",
    "extensionAcpx",
    "extensionCodex",
    "extensionDiffs",
    "extensionBrowser",
    "extensionDiscord",
    "extensionFeishu",
    "extensionImessage",
    "extensionIrc",
    "extensionLine",
    "extensionMattermost",
    "extensionChannel",
    "extensionTelegram",
    "extensionVoiceCall",
    "extensionWhatsApp",
    "extensionZalo",
    "extensionMatrix",
    "extensionMedia",
    "extensionMemory",
    "extensionMisc",
    "extensionMsTeams",
    "extensionMessaging",
    "extensionProviderOpenAi",
    "extensionProvider",
    "extensionQa",
    "extensionSignal",
    "extensionSlack",
    "extensionFull",
    "channel",
    "extension",
  ];
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
    const expandShard = expandToProjectConfigs;
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
            resolveGatewayServerFullSuiteTargets(cwd),
            GATEWAY_SERVER_FULL_SUITE_TARGET_CHUNK_COUNT,
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
