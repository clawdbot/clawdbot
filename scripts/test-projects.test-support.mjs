import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isChannelSurfaceTestFile } from "../test/vitest/vitest.channel-paths.mjs";
import {
  isCommandsLightTarget,
  resolveCommandsLightIncludePattern,
} from "../test/vitest/vitest.commands-light-paths.mjs";
import { isAcpxExtensionRoot } from "../test/vitest/vitest.extension-acpx-paths.mjs";
import { isBlueBubblesExtensionRoot } from "../test/vitest/vitest.extension-bluebubbles-paths.mjs";
import { isBrowserExtensionRoot } from "../test/vitest/vitest.extension-browser-paths.mjs";
import { resolveSplitChannelExtensionShard } from "../test/vitest/vitest.extension-channel-split-paths.mjs";
import { isDiffsExtensionRoot } from "../test/vitest/vitest.extension-diffs-paths.mjs";
import { isFeishuExtensionRoot } from "../test/vitest/vitest.extension-feishu-paths.mjs";
import { isIrcExtensionRoot } from "../test/vitest/vitest.extension-irc-paths.mjs";
import { isMatrixExtensionRoot } from "../test/vitest/vitest.extension-matrix-paths.mjs";
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
  resolvePluginSdkLightIncludePattern,
} from "../test/vitest/vitest.plugin-sdk-paths.mjs";
import { fullSuiteVitestShards } from "../test/vitest/vitest.test-shards.mjs";
import { resolveUnitFastTestIncludePattern } from "../test/vitest/vitest.unit-fast-paths.mjs";
import {
  isBoundaryTestFile,
  isBundledPluginDependentUnitTestFile,
} from "../test/vitest/vitest.unit-paths.mjs";
import { detectChangedLanes } from "./changed-lanes.mjs";
import { isCiLikeEnv, resolveLocalFullSuiteProfile } from "./lib/vitest-local-scheduling.mjs";
import { resolveVitestCliEntry, resolveVitestNodeArgs } from "./run-vitest.mjs";

const DEFAULT_VITEST_CONFIG = "test/vitest/vitest.unit.config.ts";
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
const EXTENSION_ACPX_VITEST_CONFIG = "test/vitest/vitest.extension-acpx.config.ts";
const EXTENSION_BLUEBUBBLES_VITEST_CONFIG = "test/vitest/vitest.extension-bluebubbles.config.ts";
const EXTENSION_BROWSER_VITEST_CONFIG = "test/vitest/vitest.extension-browser.config.ts";
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
const UNIT_SECURITY_VITEST_CONFIG = "test/vitest/vitest.unit-security.config.ts";
const UNIT_SRC_VITEST_CONFIG = "test/vitest/vitest.unit-src.config.ts";
const UNIT_SUPPORT_VITEST_CONFIG = "test/vitest/vitest.unit-support.config.ts";
const UNIT_UI_VITEST_CONFIG = "test/vitest/vitest.unit-ui.config.ts";
const PROCESS_VITEST_CONFIG = "test/vitest/vitest.process.config.ts";
const RUNTIME_CONFIG_VITEST_CONFIG = "test/vitest/vitest.runtime-config.config.ts";
const SECRETS_VITEST_CONFIG = "test/vitest/vitest.secrets.config.ts";
const SHARED_CORE_VITEST_CONFIG = "test/vitest/vitest.shared-core.config.ts";
const TASKS_VITEST_CONFIG = "test/vitest/vitest.tasks.config.ts";
const TOOLING_VITEST_CONFIG = "test/vitest/vitest.tooling.config.ts";
const TUI_VITEST_CONFIG = "test/vitest/vitest.tui.config.ts";
const UI_VITEST_CONFIG = "test/vitest/vitest.ui.config.ts";
const UTILS_VITEST_CONFIG = "test/vitest/vitest.utils.config.ts";
const WIZARD_VITEST_CONFIG = "test/vitest/vitest.wizard.config.ts";
const INCLUDE_FILE_ENV_KEY = "OPENCLAW_VITEST_INCLUDE_FILE";
const FS_MODULE_CACHE_PATH_ENV_KEY = "OPENCLAW_VITEST_FS_MODULE_CACHE_PATH";
const CHANGED_ARGS_PATTERN = /^--changed(?:=(.+))?$/u;
const VITEST_CONFIG_BY_KIND = {
  acp: ACP_VITEST_CONFIG,
  agent: AGENTS_VITEST_CONFIG,
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
  extensionAcpx: EXTENSION_ACPX_VITEST_CONFIG,
  extensionBlueBubbles: EXTENSION_BLUEBUBBLES_VITEST_CONFIG,
  extensionBrowser: EXTENSION_BROWSER_VITEST_CONFIG,
  extensionChannel: EXTENSION_CHANNELS_VITEST_CONFIG,
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
  unitSecurity: UNIT_SECURITY_VITEST_CONFIG,
  unitSrc: UNIT_SRC_VITEST_CONFIG,
  unitSupport: UNIT_SUPPORT_VITEST_CONFIG,
  unitUi: UNIT_UI_VITEST_CONFIG,
  runtimeConfig: RUNTIME_CONFIG_VITEST_CONFIG,
  secrets: SECRETS_VITEST_CONFIG,
  sharedCore: SHARED_CORE_VITEST_CONFIG,
  tasks: TASKS_VITEST_CONFIG,
  tooling: TOOLING_VITEST_CONFIG,
  tui: TUI_VITEST_CONFIG,
  ui: UI_VITEST_CONFIG,
  utils: UTILS_VITEST_CONFIG,
  wizard: WIZARD_VITEST_CONFIG,
};
const BROAD_CHANGED_RERUN_PATTERNS = [
  /^package\.json$/u,
  /^pnpm-lock\.yaml$/u,
  /^test\/setup(?:\.shared|\.extensions|-openclaw-runtime)?\.ts$/u,
  /^vitest(?:\..+)?\.(?:config\.ts|paths\.mjs)$/u,
  /^test\/vitest\/vitest\.(?:config|shared\.config|scoped-config|performance-config)\.ts$/u,
  /^test\/helpers\//u,
];
const TOOLING_SOURCE_TEST_TARGETS = new Map([
  ["scripts/changed-lanes.mjs", ["test/scripts/changed-lanes.test.ts"]],
  ["scripts/check-changed.mjs", ["test/scripts/changed-lanes.test.ts"]],
  ["scripts/lib/vitest-local-scheduling.mjs", ["test/scripts/vitest-local-scheduling.test.ts"]],
  [
    "scripts/run-vitest.mjs",
    ["test/scripts/test-projects.test.ts", "test/scripts/vitest-local-scheduling.test.ts"],
  ],
  ["scripts/test-extension-batch.mjs", ["test/scripts/test-extension.test.ts"]],
  ["scripts/lib/extension-test-plan.mjs", ["test/scripts/test-extension.test.ts"]],
  ["scripts/lib/vitest-batch-runner.mjs", ["test/scripts/test-extension.test.ts"]],
  ["scripts/test-projects.mjs", ["test/scripts/test-projects.test.ts"]],
  ["scripts/test-projects.test-support.d.mts", ["test/scripts/test-projects.test.ts"]],
  ["scripts/test-projects.test-support.mjs", ["test/scripts/test-projects.test.ts"]],
]);
const TOOLING_TEST_TARGETS = new Map([
  ["test/scripts/changed-lanes.test.ts", ["test/scripts/changed-lanes.test.ts"]],
  ["test/scripts/test-projects.test.ts", ["test/scripts/test-projects.test.ts"]],
  [
    "test/scripts/vitest-local-scheduling.test.ts",
    ["test/scripts/vitest-local-scheduling.test.ts"],
  ],
]);
const SOURCE_TEST_TARGETS = new Map([
  ["src/agents/live-model-turn-probes.ts", ["src/agents/live-model-turn-probes.test.ts"]],
  [
    "src/auto-reply/reply/dispatch-from-config.ts",
    ["src/auto-reply/reply/dispatch-from-config.test.ts"],
  ],
  [
    "src/auto-reply/reply/effective-reply-route.ts",
    [
      "src/auto-reply/reply/effective-reply-route.test.ts",
      "src/auto-reply/reply/dispatch-from-config.test.ts",
    ],
  ],
]);
const GENERATED_CHANGED_TEST_TARGETS = new Set([
  "src/canvas-host/a2ui/.bundle.hash",
  "src/canvas-host/a2ui/a2ui.bundle.js",
]);
const VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY = "OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS";
const VITEST_NO_OUTPUT_RETRY_ENV_KEY = "OPENCLAW_VITEST_NO_OUTPUT_RETRY";
export const DEFAULT_TEST_PROJECTS_VITEST_NO_OUTPUT_TIMEOUT_MS = "180000";
const VITEST_CONFIG_TARGET_KIND_BY_PATH = new Map(
  Object.entries(VITEST_CONFIG_BY_KIND).map(([kind, config]) => [config, kind]),
);
const CHANNEL_CONTRACT_CONFIG_PATTERNS = new Map([
  [
    CONTRACTS_CHANNEL_SURFACE_VITEST_CONFIG,
    [
      "src/channels/plugins/contracts/channel-catalog.contract.test.ts",
      "src/channels/plugins/contracts/channel-import-guardrails.test.ts",
      "src/channels/plugins/contracts/group-policy.fallback.contract.test.ts",
      "src/channels/plugins/contracts/outbound-payload.contract.test.ts",
      "src/channels/plugins/contracts/*-shard-a.contract.test.ts",
      "src/channels/plugins/contracts/*-shard-e.contract.test.ts",
    ],
  ],
  [
    CONTRACTS_CHANNEL_CONFIG_VITEST_CONFIG,
    [
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
      "src/channels/plugins/contracts/*-shard-d.contract.test.ts",
      "src/channels/plugins/contracts/*-shard-h.contract.test.ts",
    ],
  ],
]);

function normalizePathPattern(value) {
  return value.replaceAll("\\", "/");
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

function isGlobTarget(arg) {
  return /[*?[\]{}]/u.test(arg);
}

function isFileLikeTarget(arg) {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(arg);
}

function isLikelyFileTarget(arg) {
  return /(?:^|\/)[^/]+\.[A-Za-z0-9]+$/u.test(arg);
}

function isPathLikeTargetArg(arg, cwd) {
  if (!arg || arg === "--" || arg.startsWith("-")) {
    return false;
  }
  return isExistingPathTarget(arg, cwd) || isGlobTarget(arg) || isFileLikeTarget(arg);
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

function resolveVitestConfigTargetKind(relative) {
  return VITEST_CONFIG_TARGET_KIND_BY_PATH.get(relative) ?? null;
}

function isVitestConfigTargetForKind(kind, targetArg, cwd) {
  return resolveVitestConfigTargetKind(toRepoRelativeTarget(targetArg, cwd)) === kind;
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
      "outbound-payload.contract.test.ts",
    ].includes(name)
  ) {
    return "contractsChannelSurface";
  }
  if (
    [
      "plugins-core.authorize-config-write.policy.contract.test.ts",
      "plugins-core.authorize-config-write.targets.contract.test.ts",
      "plugins-core.catalog.entries.contract.test.ts",
    ].includes(name)
  ) {
    return "contractsChannelConfig";
  }
  if (
    [
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
  return [
    ...new Set([
      ...runGitNameOnlyDiff(cwd, [`${baseRef}...HEAD`]),
      ...runGitNameOnlyDiff(cwd, ["--cached", "--diff-filter=ACMR"]),
      ...runGitNameOnlyDiff(cwd, ["--diff-filter=ACMR"]),
      ...runGitLsFiles(cwd, ["--others", "--exclude-standard"]),
    ]),
  ].toSorted((left, right) => left.localeCompare(right));
}

function runGitNameOnlyDiff(cwd, extraArgs) {
  return execFileSync("git", ["diff", "--name-only", ...extraArgs], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .split("\n")
    .map((line) => normalizePathPattern(line.trim()))
    .filter((line) => line.length > 0);
}

function runGitLsFiles(cwd, extraArgs) {
  return execFileSync("git", ["ls-files", ...extraArgs], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .split("\n")
    .map((line) => normalizePathPattern(line.trim()))
    .filter((line) => line.length > 0);
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
    BROAD_CHANGED_RERUN_PATTERNS.some((pattern) => pattern.test(changedPath)),
  );
}

function resolveToolingChangedTestTargets(changedPaths) {
  const targets = [];
  for (const changedPath of changedPaths) {
    const testTargets =
      TOOLING_SOURCE_TEST_TARGETS.get(changedPath) ?? TOOLING_TEST_TARGETS.get(changedPath);
    if (!testTargets) {
      return null;
    }
    targets.push(...testTargets);
  }
  return [...new Set(targets)];
}

function isRoutableChangedTarget(changedPath) {
  if (GENERATED_CHANGED_TEST_TARGETS.has(changedPath)) {
    return false;
  }
  if (changedPath.endsWith(".live.test.ts")) {
    return false;
  }
  return /^(?:src|test|extensions|ui|packages)(?:\/|$)/u.test(changedPath);
}

export function resolveChangedTestTargetPlan(changedPaths) {
  if (changedPaths.length === 0) {
    return { mode: "none", targets: [] };
  }
  const toolingTargets = resolveToolingChangedTestTargets(changedPaths);
  if (toolingTargets) {
    return { mode: "targets", targets: toolingTargets };
  }
  if (shouldKeepBroadChangedRun(changedPaths)) {
    return { mode: "broad", targets: [] };
  }
  const changedLanes = detectChangedLanes(changedPaths);
  if (changedLanes.lanes.all) {
    return { mode: "broad", targets: [] };
  }
  const targets = changedPaths.flatMap((changedPath) => {
    const mappedTargets = SOURCE_TEST_TARGETS.get(changedPath);
    if (mappedTargets) {
      return mappedTargets;
    }
    return isRoutableChangedTarget(changedPath) ? [changedPath] : [];
  });
  if (changedLanes.extensionImpactFromCore) {
    targets.push("extensions");
  }
  return { mode: "targets", targets: [...new Set(targets)] };
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
) {
  const baseRef = extractChangedBaseRef(args);
  if (!baseRef) {
    return null;
  }
  const changedPaths = listChangedPaths(baseRef, cwd);
  const plan = resolveChangedTestTargetPlan(changedPaths);
  if (plan.mode === "broad") {
    return null;
  }
  return plan.targets;
}

function classifyTarget(arg, cwd) {
  const relative = toRepoRelativeTarget(arg, cwd);
  const configTargetKind = resolveVitestConfigTargetKind(relative);
  if (configTargetKind) {
    return configTargetKind;
  }
  if (resolveUnitFastTestIncludePattern(relative)) {
    return "unitFast";
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
  if (relative === "extensions") {
    return "extensionFull";
  }
  if (relative.startsWith("extensions/")) {
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
    if (isDiffsExtensionRoot(extensionRoot)) {
      return "extensionDiffs";
    }
    if (isBlueBubblesExtensionRoot(extensionRoot)) {
      return "extensionBlueBubbles";
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
  const channelContractKind = resolveChannelContractTargetKind(relative);
  if (channelContractKind) {
    return channelContractKind;
  }
  if (relative.startsWith("src/plugins/contracts/")) {
    return "contractsPlugin";
  }
  if (isChannelSurfaceTestFile(relative)) {
    return "channel";
  }
  if (isBoundaryTestFile(relative)) {
    return "boundary";
  }
  if (
    relative.startsWith("test/") ||
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
  if (relative.startsWith("src/channels/")) {
    return "channel";
  }
  if (relative.startsWith("src/gateway/")) {
    return "gateway";
  }
  if (relative.startsWith("src/hooks/")) {
    return "hooks";
  }
  if (relative.startsWith("src/infra/")) {
    return "infra";
  }
  if (relative.startsWith("src/config/")) {
    return "runtimeConfig";
  }
  if (relative.startsWith("src/cron/")) {
    return "cron";
  }
  if (relative.startsWith("src/daemon/")) {
    return "daemon";
  }
  if (relative.startsWith("src/media-understanding/")) {
    return "mediaUnderstanding";
  }
  if (relative.startsWith("src/media/")) {
    return "media";
  }
  if (relative.startsWith("src/logging/")) {
    return "logging";
  }
  if (relative.startsWith("src/plugin-sdk/")) {
    return isPluginSdkLightTarget(relative) ? "pluginSdkLight" : "pluginSdk";
  }
  if (relative.startsWith("src/process/")) {
    return "process";
  }
  if (relative.startsWith("src/secrets/")) {
    return "secrets";
  }
  if (relative.startsWith("src/shared/")) {
    return "sharedCore";
  }
  if (relative.startsWith("src/tasks/")) {
    return "tasks";
  }
  if (relative.startsWith("src/tui/")) {
    return "tui";
  }
  if (relative.startsWith("src/acp/")) {
    return "acp";
  }
  if (relative.startsWith("src/cli/")) {
    return "cli";
  }
  if (relative.startsWith("src/commands/")) {
    return isCommandsLightTarget(relative) ? "commandLight" : "command";
  }
  if (relative.startsWith("src/auto-reply/")) {
    return "autoReply";
  }
  if (relative.startsWith("src/agents/")) {
    return "agent";
  }
  if (relative.startsWith("src/plugins/")) {
    return "plugin";
  }
  if (relative.startsWith("ui/src/ui/")) {
    return "ui";
  }
  if (relative.startsWith("src/utils/")) {
    return "utils";
  }
  if (relative.startsWith("src/wizard/")) {
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

function createVitestArgs(params) {
  return [
    "exec",
    "node",
    ...resolveVitestNodeArgs(params.env),
    resolveVitestCliEntry(),
    ...(params.watchMode ? [] : ["run"]),
    "--config",
    params.config,
    ...params.forwardedArgs,
  ];
}

export function parseTestProjectsArgs(args, cwd = process.cwd()) {
  const forwardedArgs = [];
  const targetArgs = [];
  let watchMode = false;

  for (const arg of args) {
    if (arg === "--") {
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
) {
  const { forwardedArgs, targetArgs, watchMode } = parseTestProjectsArgs(args, cwd);
  const changedTargetArgs =
    targetArgs.length === 0 ? resolveChangedTargetArgs(args, cwd, listChangedPaths) : null;
  const activeTargetArgs = changedTargetArgs ?? targetArgs;
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

  const groupedTargets = new Map();
  for (const targetArg of activeTargetArgs) {
    const kind = classifyTarget(targetArg, cwd);
    const current = groupedTargets.get(kind) ?? [];
    current.push(targetArg);
    groupedTargets.set(kind, current);
  }

  if (watchMode && groupedTargets.size > 1) {
    throw new Error(
      "watch mode with mixed test suites is not supported; target one suite at a time or use a dedicated suite command",
    );
  }

  const nonTargetArgs = activeForwardedArgs.filter((arg) => !activeTargetArgs.includes(arg));
  const orderedKinds = [
    "unitFast",
    "default",
    "boundary",
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
    "mediaUnderstanding",
    "acp",
    "cli",
    "commandLight",
    "command",
    "autoReply",
    "autoReplyCore",
    "autoReplyReply",
    "autoReplyTopLevel",
    "agent",
    "plugin",
    "ui",
    "unitSrc",
    "unitSecurity",
    "unitSupport",
    "unitUi",
    "utils",
    "wizard",
    "e2e",
    "extensionAcpx",
    "extensionDiffs",
    "extensionBlueBubbles",
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
        plans.push({
          config,
          forwardedArgs: nonTargetArgs,
          includePatterns: null,
          watchMode,
        });
      }
      continue;
    }
    const config = VITEST_CONFIG_BY_KIND[kind] ?? DEFAULT_VITEST_CONFIG;
    const useCliTargetArgs =
      kind === "e2e" ||
      (kind === "default" &&
        grouped.every((targetArg) => isFileLikeTarget(toRepoRelativeTarget(targetArg, cwd))));
    const useWholeConfigTarget = grouped.some((targetArg) =>
      isVitestConfigTargetForKind(kind, targetArg, cwd),
    );
    const includePatterns = useCliTargetArgs
      ? null
      : useWholeConfigTarget
        ? null
        : grouped.flatMap((targetArg) => {
            const lightLanePatterns = resolveLightLaneIncludePatterns(kind, targetArg, cwd);
            return lightLanePatterns ?? [toScopedIncludePattern(targetArg, cwd)];
          });
    const scopedTargetArgs = useCliTargetArgs ? grouped : [];
    plans.push({
      config,
      forwardedArgs: [...nonTargetArgs, ...scopedTargetArgs],
      includePatterns,
      watchMode,
    });
  }
  return plans;
}

export function buildFullSuiteVitestRunPlans(args, cwd = process.cwd()) {
  const { forwardedArgs, watchMode } = parseTestProjectsArgs(args, cwd);
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
  const parallelShardCount = Number.parseInt(process.env.OPENCLAW_TEST_PROJECTS_PARALLEL ?? "", 10);
  const expandToProjectConfigs =
    process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS === "1" ||
    (Number.isFinite(parallelShardCount) && parallelShardCount > 1) ||
    shouldUseLocalFullSuiteParallelByDefault(process.env);
  return fullSuiteVitestShards.flatMap((shard) => {
    if (
      process.env.OPENCLAW_TEST_SKIP_FULL_EXTENSIONS_SHARD === "1" &&
      shard.config === FULL_EXTENSIONS_VITEST_CONFIG
    ) {
      return [];
    }
    const expandShard = expandToProjectConfigs || shard.config === FULL_EXTENSIONS_VITEST_CONFIG;
    const configs = expandShard ? shard.projects : [shard.config];
    return configs.map((config) => ({
      config,
      forwardedArgs,
      includePatterns: null,
      watchMode: false,
    }));
  });
}

export function shouldUseLocalFullSuiteParallelByDefault(env = process.env) {
  if (hasConservativeVitestWorkerBudget(env)) {
    return false;
  }
  return (
    env.OPENCLAW_TEST_PROJECTS_SERIAL !== "1" && env.CI !== "true" && env.GITHUB_ACTIONS !== "true"
  );
}

function parsePositiveInt(value) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function hasConservativeVitestWorkerBudget(env) {
  const workerBudget = parsePositiveInt(
    env.OPENCLAW_VITEST_MAX_WORKERS ?? env.OPENCLAW_TEST_WORKERS,
  );
  return workerBudget !== null && workerBudget <= 1;
}

export function resolveParallelFullSuiteConcurrency(specCount, env = process.env, hostInfo) {
  const override = parsePositiveInt(env.OPENCLAW_TEST_PROJECTS_PARALLEL);
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
  if (baseEnv[FS_MODULE_CACHE_PATH_ENV_KEY]?.trim()) {
    return specs;
  }
  const cwd = params.cwd ?? process.cwd();
  return specs.map((spec, index) => {
    if (spec.env?.[FS_MODULE_CACHE_PATH_ENV_KEY]?.trim()) {
      return spec;
    }
    const cacheSegment = sanitizeVitestCachePathSegment(`${index}-${spec.config}`);
    return {
      ...spec,
      env: {
        ...spec.env,
        [FS_MODULE_CACHE_PATH_ENV_KEY]: path.join(
          cwd,
          "node_modules",
          ".experimental-vitest-cache",
          cacheSegment,
        ),
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
  if (Object.hasOwn(baseEnv, VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY)) {
    return specs;
  }
  return specs.map((spec) => {
    if (spec.watchMode || Object.hasOwn(spec.env ?? {}, VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY)) {
      return spec;
    }
    return {
      ...spec,
      env: {
        ...spec.env,
        [VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY]: DEFAULT_TEST_PROJECTS_VITEST_NO_OUTPUT_TIMEOUT_MS,
      },
    };
  });
}

export function shouldRetryVitestNoOutputTimeout(env = process.env) {
  const value = env[VITEST_NO_OUTPUT_RETRY_ENV_KEY]?.trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(value ?? "");
}

export function createVitestRunSpecs(args, params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const baseEnv = params.baseEnv ?? process.env;
  const plans = filterPlansForContractIncludeFile(buildVitestRunPlans(args, cwd), baseEnv);
  return plans.map((plan, index) => {
    const includeFilePath = plan.includePatterns
      ? path.join(
          params.tempDir ?? os.tmpdir(),
          `openclaw-vitest-include-${process.pid}-${Date.now()}-${index}.json`,
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
  if (env.OPENCLAW_TEST_PROJECTS_FORCE_LOCK === "1") {
    return true;
  }

  return !(
    runSpecs.length === 1 &&
    runSpecs[0]?.config === TOOLING_VITEST_CONFIG &&
    runSpecs[0]?.watchMode === false &&
    Array.isArray(runSpecs[0]?.includePatterns) &&
    runSpecs[0].includePatterns.length > 0
  );
}

export function writeVitestIncludeFile(filePath, includePatterns) {
  fs.writeFileSync(filePath, `${JSON.stringify(includePatterns, null, 2)}\n`);
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
