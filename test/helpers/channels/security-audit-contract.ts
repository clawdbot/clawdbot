import type { OpenClawConfig } from "../../../src/config/config.js";
import type { SecurityAuditFinding } from "../../../src/security/audit.types.js";
import {
  loadBundledPluginPublicSurfaceSync,
  resolveRelativeBundledPluginPublicModuleId,
} from "../../../src/test-utils/bundled-plugin-public-surface.js";

type SecurityAuditAccount = {
  accountId: string;
  enabled?: boolean;
  token?: unknown;
  tokenSource?: string;
  config?: Record<string, unknown>;
  [key: string]: unknown;
};
type FlexibleSecurityAuditParams = {
  cfg?: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
  account: SecurityAuditAccount;
  accountId?: string | null;
  orderedAccountIds?: string[];
  hasExplicitAccountPath?: boolean;
};
type ConfigSecurityAuditParams = {
  cfg: OpenClawConfig;
};
type AsyncChannelSecurityAuditCollector = (
  params: FlexibleSecurityAuditParams,
) => Promise<SecurityAuditFinding[]>;
type SyncChannelSecurityAuditCollector = (
  params: FlexibleSecurityAuditParams,
) => SecurityAuditFinding[];
type ConfigSecurityAuditCollector = (params: ConfigSecurityAuditParams) => SecurityAuditFinding[];
type DiscordSecurityAuditSurface = {
  collectDiscordSecurityAuditFindings: AsyncChannelSecurityAuditCollector;
};
type FeishuSecuritySurface = {
  collectFeishuSecurityAuditFindings: ConfigSecurityAuditCollector;
};
type SlackSecuritySurface = {
  collectSlackSecurityAuditFindings: AsyncChannelSecurityAuditCollector;
};
type SynologyChatSecuritySurface = {
  collectSynologyChatSecurityAuditFindings: SyncChannelSecurityAuditCollector;
};
type TelegramSecuritySurface = {
  collectTelegramSecurityAuditFindings: AsyncChannelSecurityAuditCollector;
};
type ZalouserSecuritySurface = {
  collectZalouserSecurityAuditFindings: SyncChannelSecurityAuditCollector;
};

const discordSecurityAuditModuleId = resolveRelativeBundledPluginPublicModuleId({
  fromModuleUrl: import.meta.url,
  pluginId: "discord",
  artifactBasename: "security-audit-contract-api.js",
});
const slackSecurityModuleId = resolveRelativeBundledPluginPublicModuleId({
  fromModuleUrl: import.meta.url,
  pluginId: "slack",
  artifactBasename: "security-contract-api.js",
});
const telegramSecurityModuleId = resolveRelativeBundledPluginPublicModuleId({
  fromModuleUrl: import.meta.url,
  pluginId: "telegram",
  artifactBasename: "security-audit-contract-api.js",
});
let discordSecurityAuditSurfacePromise: Promise<DiscordSecurityAuditSurface> | undefined;
let slackSecuritySurfacePromise: Promise<SlackSecuritySurface> | undefined;
let telegramSecuritySurfacePromise: Promise<TelegramSecuritySurface> | undefined;

function loadDiscordSecurityAuditSurface(): Promise<DiscordSecurityAuditSurface> {
  discordSecurityAuditSurfacePromise ??= import(
    discordSecurityAuditModuleId
  ) as Promise<DiscordSecurityAuditSurface>;
  return discordSecurityAuditSurfacePromise;
}

function loadFeishuSecuritySurface(): FeishuSecuritySurface {
  return loadBundledPluginPublicSurfaceSync<FeishuSecuritySurface>({
    pluginId: "feishu",
    artifactBasename: "security-contract-api.js",
  });
}

function loadSlackSecuritySurface(): Promise<SlackSecuritySurface> {
  slackSecuritySurfacePromise ??= import(slackSecurityModuleId) as Promise<SlackSecuritySurface>;
  return slackSecuritySurfacePromise;
}

function loadSynologyChatSecuritySurface(): SynologyChatSecuritySurface {
  return loadBundledPluginPublicSurfaceSync<SynologyChatSecuritySurface>({
    pluginId: "synology-chat",
    artifactBasename: "contract-api.js",
  });
}

function loadTelegramSecuritySurface(): Promise<TelegramSecuritySurface> {
  telegramSecuritySurfacePromise ??= import(
    telegramSecurityModuleId
  ) as Promise<TelegramSecuritySurface>;
  return telegramSecuritySurfacePromise;
}

function loadZalouserSecuritySurface(): ZalouserSecuritySurface {
  return loadBundledPluginPublicSurfaceSync<ZalouserSecuritySurface>({
    pluginId: "zalouser",
    artifactBasename: "contract-api.js",
  });
}

export const collectDiscordSecurityAuditFindings: DiscordSecurityAuditSurface["collectDiscordSecurityAuditFindings"] =
  (async (...args) =>
    (await loadDiscordSecurityAuditSurface()).collectDiscordSecurityAuditFindings(
      ...args,
    )) as DiscordSecurityAuditSurface["collectDiscordSecurityAuditFindings"];

export const collectFeishuSecurityAuditFindings: FeishuSecuritySurface["collectFeishuSecurityAuditFindings"] =
  ((...args) =>
    loadFeishuSecuritySurface().collectFeishuSecurityAuditFindings(
      ...args,
    )) as FeishuSecuritySurface["collectFeishuSecurityAuditFindings"];

export const collectSlackSecurityAuditFindings: SlackSecuritySurface["collectSlackSecurityAuditFindings"] =
  (async (...args) =>
    (await loadSlackSecuritySurface()).collectSlackSecurityAuditFindings(
      ...args,
    )) as SlackSecuritySurface["collectSlackSecurityAuditFindings"];

export const collectSynologyChatSecurityAuditFindings: SynologyChatSecuritySurface["collectSynologyChatSecurityAuditFindings"] =
  ((...args) =>
    loadSynologyChatSecuritySurface().collectSynologyChatSecurityAuditFindings(
      ...args,
    )) as SynologyChatSecuritySurface["collectSynologyChatSecurityAuditFindings"];

export const collectTelegramSecurityAuditFindings: TelegramSecuritySurface["collectTelegramSecurityAuditFindings"] =
  (async (...args) =>
    (await loadTelegramSecuritySurface()).collectTelegramSecurityAuditFindings(
      ...args,
    )) as TelegramSecuritySurface["collectTelegramSecurityAuditFindings"];

export const collectZalouserSecurityAuditFindings: ZalouserSecuritySurface["collectZalouserSecurityAuditFindings"] =
  ((...args) =>
    loadZalouserSecuritySurface().collectZalouserSecurityAuditFindings(
      ...args,
    )) as ZalouserSecuritySurface["collectZalouserSecurityAuditFindings"];
