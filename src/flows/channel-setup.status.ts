import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { listChatChannels } from "../channels/chat-meta.js";
import { listChannelPluginCatalogEntries } from "../channels/plugins/catalog.js";
import { listChannelSetupPlugins } from "../channels/plugins/setup-registry.js";
import type { ChannelSetupPlugin } from "../channels/plugins/setup-wizard-types.js";
import type { ChannelMeta } from "../channels/plugins/types.core.js";
import { formatChannelPrimerLine, formatChannelSelectionLine } from "../channels/registry.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveChannelSetupEntries } from "../commands/channel-setup/discovery.js";
import { shouldShowChannelInSetup } from "../commands/channel-setup/discovery.js";
import { resolveChannelSetupWizardAdapterForPlugin } from "../commands/channel-setup/registry.js";
import type {
  ChannelSetupWizardAdapter,
  ChannelSetupStatus,
  SetupChannelsOptions,
} from "../commands/channel-setup/types.js";
import type { ChannelChoice } from "../commands/onboard-types.js";
import { isChannelConfigured } from "../config/channel-configured.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  findBundledPluginSourceInMap,
  resolveBundledPluginSources,
  type BundledPluginSource,
} from "../plugins/bundled-sources.js";
import { formatDocsLink } from "../terminal/links.js";
import { sanitizeTerminalText } from "../terminal/safe-text.js";
import { t, wizardT } from "../wizard/i18n/index.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { FlowContribution } from "./types.js";

type ChannelStatusSummary = {
  installedPlugins: ChannelSetupPlugin[];
  catalogEntries: ReturnType<typeof listChannelPluginCatalogEntries>;
  installedCatalogEntries: ReturnType<typeof listChannelPluginCatalogEntries>;
  statusByChannel: Map<ChannelChoice, ChannelSetupStatus>;
  statusLines: string[];
};

type ChannelSetupSelectionContribution = FlowContribution & {
  kind: "channel";
  surface: "setup";
  channel: ChannelChoice;
  source: "catalog" | "core" | "plugin";
};

type ChannelSetupSelectionEntry = {
  id: ChannelChoice;
  meta: {
    id: string;
    label: string;
    selectionLabel?: string;
    exposure?: { setup?: boolean };
    showConfigured?: boolean;
    showInSetup?: boolean;
  };
};

const CHANNEL_PRIMER_BLURB_KEYS: Record<string, string> = {
  clickclack: "wizard.channelsPrimer.blurbs.clickclack",
  discord: "wizard.channelsPrimer.blurbs.discord",
  feishu: "wizard.channelsPrimer.blurbs.feishu",
  googlechat: "wizard.channelsPrimer.blurbs.googlechat",
  imessage: "wizard.channelsPrimer.blurbs.imessage",
  irc: "wizard.channelsPrimer.blurbs.irc",
  line: "wizard.channelsPrimer.blurbs.line",
  mattermost: "wizard.channelsPrimer.blurbs.mattermost",
  matrix: "wizard.channelsPrimer.blurbs.matrix",
  msteams: "wizard.channelsPrimer.blurbs.msteams",
  "nextcloud-talk": "wizard.channelsPrimer.blurbs.nextcloudTalk",
  nostr: "wizard.channelsPrimer.blurbs.nostr",
  qqbot: "wizard.channelsPrimer.blurbs.qqbot",
  signal: "wizard.channelsPrimer.blurbs.signal",
  slack: "wizard.channelsPrimer.blurbs.slack",
  "synology-chat": "wizard.channelsPrimer.blurbs.synologyChat",
  telegram: "wizard.channelsPrimer.blurbs.telegram",
  tlon: "wizard.channelsPrimer.blurbs.tlon",
  twitch: "wizard.channelsPrimer.blurbs.twitch",
  wecom: "wizard.channelsPrimer.blurbs.wecom",
  whatsapp: "wizard.channelsPrimer.blurbs.whatsapp",
  yuanbao: "wizard.channelsPrimer.blurbs.yuanbao",
  zalo: "wizard.channelsPrimer.blurbs.zalo",
  zalouser: "wizard.channelsPrimer.blurbs.zalouser",
};

function buildChannelSetupSelectionContribution(params: {
  channel: ChannelChoice;
  label: string;
  hint?: string;
  source: "catalog" | "core" | "plugin";
}): ChannelSetupSelectionContribution {
  return {
    id: `channel:setup:${params.channel}`,
    kind: "channel",
    surface: "setup",
    channel: params.channel,
    option: {
      value: params.channel,
      label: params.label,
      ...(params.hint ? { hint: params.hint } : {}),
    },
    source: params.source,
  };
}

function formatSetupSelectionLabel(label: string, fallback: string): string {
  return (
    sanitizeTerminalText(label).trim() ||
    sanitizeTerminalText(fallback).trim() ||
    "<invalid channel>"
  );
}

function formatSetupSelectionHint(hint: string | undefined): string | undefined {
  if (!hint) {
    return undefined;
  }
  return sanitizeTerminalText(hint) || undefined;
}

function formatSetupDisplayText(value: string | undefined, fallback = ""): string {
  return (
    sanitizeTerminalText(value ?? "").trim() ||
    sanitizeTerminalText(fallback).trim() ||
    "<invalid channel>"
  );
}

function formatSetupFreeText(value: string | undefined): string {
  return sanitizeTerminalText(value ?? "").trim();
}

function formatSetupOptionalDisplayText(value: string | undefined): string | undefined {
  const safe = sanitizeTerminalText(value ?? "").trim();
  return safe || undefined;
}

function formatSetupDisplayList(values: readonly string[] | undefined): string[] | undefined {
  const safe = (values ?? []).flatMap((value) => {
    const sanitized = formatSetupOptionalDisplayText(value);
    return sanitized ? [sanitized] : [];
  });
  return safe.length > 0 ? safe : undefined;
}

function formatSetupDisplayMeta(meta: ChannelMeta): ChannelMeta {
  const safeId = formatSetupDisplayText(meta.id, "<invalid channel>");
  const safeLabel = formatSetupDisplayText(meta.label, safeId);
  const safeSelectionDocsPrefix = formatSetupOptionalDisplayText(meta.selectionDocsPrefix);
  const safeSelectionExtras = formatSetupDisplayList(meta.selectionExtras);
  return {
    ...meta,
    id: safeId,
    label: safeLabel,
    selectionLabel: formatSetupDisplayText(meta.selectionLabel, safeLabel),
    docsPath: formatSetupDisplayText(meta.docsPath, "/"),
    ...(meta.docsLabel ? { docsLabel: formatSetupDisplayText(meta.docsLabel, safeId) } : {}),
    blurb: formatSetupFreeText(meta.blurb),
    ...(safeSelectionDocsPrefix ? { selectionDocsPrefix: safeSelectionDocsPrefix } : {}),
    ...(safeSelectionExtras ? { selectionExtras: safeSelectionExtras } : {}),
  };
}

function formatChannelPrimerBlurb(channel: { id: string; blurb: string }): string {
  const key = CHANNEL_PRIMER_BLURB_KEYS[channel.id];
  if (!key) {
    return channel.blurb;
  }
  const englishBlurb = wizardT(key, undefined, { locale: "en" });
  return channel.blurb === englishBlurb ? t(key) : channel.blurb;
}

function formatChannelSelectionMeta(meta: ChannelMeta): ChannelMeta {
  return formatSetupDisplayMeta({
    ...meta,
    blurb: formatChannelPrimerBlurb(meta),
    selectionDocsPrefix: meta.selectionDocsPrefix ?? t("common.docs"),
  });
}

function localizeChannelStatusLabel(label: string): string {
  switch (label) {
    case "configured":
      return t("wizard.channels.statusConfigured");
    case "not configured":
      return t("wizard.channels.statusNotConfigured");
    case "configured (plugin disabled)":
      return t("wizard.channels.statusConfiguredPluginDisabled");
    case "installed":
      return t("wizard.channels.statusInstalled");
    case "installed (plugin disabled)":
      return t("wizard.channels.statusInstalledPluginDisabled");
    case "bundled · enable to use":
      return t("wizard.channels.statusBundledEnable");
    case "install plugin to enable":
      return t("wizard.channels.statusInstallPluginEnable");
    case "needs app credentials":
      return t("wizard.channels.statusNeedsAppCredentials");
    case "needs app creds":
      return t("wizard.channels.statusNeedsAppCreds");
    case "needs auth":
      return t("wizard.channels.statusNeedsAuth");
    case "needs host + nick":
      return t("wizard.channels.statusNeedsHostNick");
    case "needs private key":
      return t("wizard.channels.statusNeedsPrivateKey");
    case "needs QR login":
      return t("wizard.channels.statusNeedsQrLogin");
    case "needs service account":
      return t("wizard.channels.statusNeedsServiceAccount");
    case "needs setup":
      return t("wizard.channels.statusNeedsSetup");
    case "needs token":
      return t("wizard.channels.statusNeedsToken");
    case "needs tokens":
      return t("wizard.channels.statusNeedsTokens");
    case "needs token + incoming webhook":
      return t("wizard.channels.statusNeedsTokenIncomingWebhook");
    case "needs token + secret":
      return t("wizard.channels.statusNeedsTokenSecret");
    case "needs token + url":
      return t("wizard.channels.statusNeedsTokenUrl");
    case "needs username, token, and clientId":
      return t("wizard.channels.statusNeedsUsernameTokenClientId");
    case "linked":
      return t("wizard.channels.statusLinked");
    case "logged in":
      return t("wizard.channels.statusLoggedIn");
    case "not linked":
      return t("wizard.channels.statusNotLinked");
    case "recommended · configured":
      return t("wizard.channels.statusRecommendedConfigured");
    case "recommended · logged in":
      return t("wizard.channels.statusRecommendedLoggedIn");
    case "recommended · newcomer-friendly":
      return t("wizard.channels.statusRecommendedNewcomerFriendly");
    case "recommended · QR login":
      return t("wizard.channels.statusRecommendedQrLogin");
    case "self-hosted chat":
      return t("wizard.channels.statusSelfHostedChat");
    case "signal-cli found":
      return t("wizard.channels.statusSignalCliFound");
    case "signal-cli missing":
      return t("wizard.channels.statusSignalCliMissing");
    case "urbit messenger":
      return t("wizard.channels.statusUrbitMessenger");
    case "configured (connection not verified)":
      return t("wizard.channels.statusConfiguredConnectionNotVerified");
    default:
      break;
  }
  const connectedAsPrefix = "connected as ";
  if (label.startsWith(connectedAsPrefix)) {
    return t("wizard.channels.statusConnectedAs", { name: label.slice(connectedAsPrefix.length) });
  }
  return label;
}

function localizeChannelStatusLine(line: string): string {
  const separator = ": ";
  const index = line.lastIndexOf(separator);
  if (index < 0) {
    return localizeChannelStatusLabel(line);
  }
  return `${line.slice(0, index + separator.length)}${localizeChannelStatusLabel(
    line.slice(index + separator.length),
  )}`;
}

function localizeChannelSetupStatus<T extends { selectionHint?: string; statusLines: string[] }>(
  status: T,
): T {
  return {
    ...status,
    statusLines: status.statusLines.map(localizeChannelStatusLine),
    ...(status.selectionHint
      ? { selectionHint: localizeChannelStatusLabel(status.selectionHint) }
      : {}),
  };
}

/**
 * Hint shown next to an installable channel option in the selection menu when
 * we don't yet have a runtime-collected status. Mirrors the "configured" /
 * "installed" affordance other channels get so users can see "download from
 * <npm-spec>" before committing to install.
 *
 * Bundled channels (the plugin lives under `extensions/<id>` in the host
 * repo, e.g. Signal / Tlon / Twitch / Slack) are NOT downloaded from npm —
 * they ship with the host. Even when their `package.json` declares an
 * `npmSpec` (or the catalog falls back to the package name), surfacing
 * "download from <npm-spec>" misleads users into believing the plugin is
 * missing. For bundled channels we suppress the npm hint entirely so the
 * menu shows the same neutral "plugin · install" affordance used when no
 * npm source is known.
 */
export function resolveCatalogChannelSelectionHint(
  entry: { install?: { npmSpec?: string } },
  options?: { bundledLocalPath?: string | null },
): string {
  const npmSpec = entry.install?.npmSpec?.trim();
  if (npmSpec && !options?.bundledLocalPath) {
    return `download from ${formatSetupSelectionLabel(npmSpec, npmSpec)}`;
  }
  return "";
}

/**
 * Look up the bundled-source entry for a catalog channel, regardless of
 * whether the catalog refers to it by `pluginId` or `npmSpec`. We use this
 * to detect bundled channels in the selection menu so we can suppress the
 * misleading "download from <npm-spec>" hint for plugins that already ship
 * with the host (Signal / Tlon / Twitch / Slack ...).
 */
export function findBundledSourceForCatalogChannel(params: {
  bundled: ReadonlyMap<string, BundledPluginSource>;
  entry: { id: string; pluginId?: string; install?: { npmSpec?: string } };
}): BundledPluginSource | undefined {
  const pluginId = params.entry.pluginId?.trim() || params.entry.id.trim();
  if (pluginId) {
    const byId = findBundledPluginSourceInMap({
      bundled: params.bundled,
      lookup: { kind: "pluginId", value: pluginId },
    });
    if (byId) {
      return byId;
    }
  }
  const npmSpec = params.entry.install?.npmSpec?.trim();
  if (npmSpec) {
    return findBundledPluginSourceInMap({
      bundled: params.bundled,
      lookup: { kind: "npmSpec", value: npmSpec },
    });
  }
  return undefined;
}

export async function collectChannelStatus(params: {
  cfg: OpenClawConfig;
  options?: SetupChannelsOptions;
  accountOverrides: Partial<Record<ChannelChoice, string>>;
  installedPlugins?: ChannelSetupPlugin[];
  resolveAdapter?: (channel: ChannelChoice) => ChannelSetupWizardAdapter | undefined;
}): Promise<ChannelStatusSummary> {
  const installedPlugins = params.installedPlugins ?? listChannelSetupPlugins();
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, resolveDefaultAgentId(params.cfg));
  const { installedCatalogEntries, installableCatalogEntries } = resolveChannelSetupEntries({
    cfg: params.cfg,
    installedPlugins,
    workspaceDir,
  });
  const bundledSources = resolveBundledPluginSources({ workspaceDir });
  const resolveAdapter =
    params.resolveAdapter ??
    ((channel: ChannelChoice) =>
      resolveChannelSetupWizardAdapterForPlugin(
        installedPlugins.find((plugin) => plugin.id === channel),
      ));
  const statusEntries = await Promise.all(
    installedPlugins.flatMap((plugin) => {
      if (!shouldShowChannelInSetup(plugin.meta)) {
        return [];
      }
      const adapter = resolveAdapter(plugin.id);
      if (!adapter) {
        return [];
      }
      return adapter.getStatus({
        cfg: params.cfg,
        options: params.options,
        accountOverrides: params.accountOverrides,
      });
    }),
  );
  const statusByChannel = new Map(statusEntries.map((entry) => [entry.channel, entry]));
  const fallbackStatuses = listChatChannels()
    .filter((meta) => shouldShowChannelInSetup(meta))
    .filter((meta) => !statusByChannel.has(meta.id))
    .map((meta) => {
      const configured = isChannelConfigured(params.cfg, meta.id);
      const statusLabel = configured ? "configured (plugin disabled)" : "not configured";
      return {
        channel: meta.id,
        configured,
        statusLines: [`${formatSetupSelectionLabel(meta.label, meta.id)}: ${statusLabel}`],
        selectionHint: configured ? "configured · plugin disabled" : "not configured",
        quickstartScore: 0,
      };
    });
  const discoveredPluginStatuses = installedCatalogEntries
    .filter((entry) => !statusByChannel.has(entry.id as ChannelChoice))
    .map((entry) => {
      const configured = isChannelConfigured(params.cfg, entry.id);
      const pluginEnabled =
        params.cfg.plugins?.entries?.[entry.pluginId ?? entry.id]?.enabled !== false;
      const statusLabel = configured
        ? pluginEnabled
          ? "configured"
          : "configured (plugin disabled)"
        : pluginEnabled
          ? "installed"
          : "installed (plugin disabled)";
      return {
        channel: entry.id as ChannelChoice,
        configured,
        statusLines: [`${formatSetupSelectionLabel(entry.meta.label, entry.id)}: ${statusLabel}`],
        selectionHint: statusLabel,
        quickstartScore: 0,
      };
    });
  const catalogStatuses = installableCatalogEntries.map((entry) => {
    const bundledLocalPath =
      findBundledSourceForCatalogChannel({ bundled: bundledSources, entry })?.localPath ?? null;
    const isBundled = Boolean(bundledLocalPath);
    // For bundled channels we already have the plugin code on disk; the user
    // just needs to enable + configure it. Reflect that in the status line so
    // it does not read like a fresh "install plugin to enable" download flow.
    const statusLabel = isBundled ? "bundled · enable to use" : "install plugin to enable";
    return {
      channel: entry.id,
      configured: false,
      statusLines: [`${formatSetupSelectionLabel(entry.meta.label, entry.id)}: ${statusLabel}`],
      selectionHint: resolveCatalogChannelSelectionHint(entry, { bundledLocalPath }),
      quickstartScore: 0,
    };
  });
  const combinedStatuses = [
    ...statusEntries,
    ...fallbackStatuses,
    ...discoveredPluginStatuses,
    ...catalogStatuses,
  ].map(localizeChannelSetupStatus);
  const mergedStatusByChannel = new Map(combinedStatuses.map((entry) => [entry.channel, entry]));
  const statusLines = combinedStatuses.flatMap((entry) => entry.statusLines);
  return {
    installedPlugins,
    catalogEntries: installableCatalogEntries,
    installedCatalogEntries,
    statusByChannel: mergedStatusByChannel,
    statusLines,
  };
}

export async function noteChannelStatus(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  options?: SetupChannelsOptions;
  accountOverrides?: Partial<Record<ChannelChoice, string>>;
  installedPlugins?: ChannelSetupPlugin[];
  resolveAdapter?: (channel: ChannelChoice) => ChannelSetupWizardAdapter | undefined;
}): Promise<void> {
  const { statusLines } = await collectChannelStatus({
    cfg: params.cfg,
    options: params.options,
    accountOverrides: params.accountOverrides ?? {},
    installedPlugins: params.installedPlugins,
    resolveAdapter: params.resolveAdapter,
  });
  if (statusLines.length > 0) {
    await params.prompter.note(statusLines.join("\n"), t("wizard.channels.statusTitle"));
  }
}

export async function noteChannelPrimer(
  prompter: WizardPrompter,
  channels: Array<{ id: ChannelChoice; blurb: string; label: string }>,
): Promise<void> {
  const channelLines = channels.map((channel) =>
    formatChannelPrimerLine(
      formatSetupDisplayMeta({
        id: channel.id,
        label: channel.label,
        selectionLabel: channel.label,
        docsPath: "/",
        blurb: formatChannelPrimerBlurb(channel),
      }),
    ),
  );
  await prompter.note(
    [
      t("wizard.channelsPrimer.inboundSafety"),
      t("wizard.channelsPrimer.approveWith", {
        command: formatCliCommand("openclaw pairing approve <channel> <code>"),
      }),
      t("wizard.channelsPrimer.openDm"),
      t("wizard.channelsPrimer.multiUserDm", {
        command: formatCliCommand('openclaw config set session.dmScope "per-channel-peer"'),
      }),
      t("wizard.channelsPrimer.docs", {
        link: formatDocsLink("/channels/pairing", "channels/pairing"),
      }),
      "",
      ...channelLines,
    ].join("\n"),
    t("wizard.channelsPrimer.title"),
  );
}

export function resolveQuickstartDefault(
  statusByChannel: Map<ChannelChoice, { quickstartScore?: number }>,
): ChannelChoice | undefined {
  let best: { channel: ChannelChoice; score: number } | null = null;
  for (const [channel, status] of statusByChannel) {
    if (status.quickstartScore == null) {
      continue;
    }
    if (!best || status.quickstartScore > best.score) {
      best = { channel, score: status.quickstartScore };
    }
  }
  return best?.channel;
}

export function resolveChannelSelectionNoteLines(params: {
  cfg: OpenClawConfig;
  installedPlugins: ChannelSetupPlugin[];
  selection: ChannelChoice[];
}): string[] {
  const { entries } = resolveChannelSetupEntries({
    cfg: params.cfg,
    installedPlugins: params.installedPlugins,
    workspaceDir: resolveAgentWorkspaceDir(params.cfg, resolveDefaultAgentId(params.cfg)),
  });
  const selectionNotes = new Map<string, string>();
  for (const entry of entries) {
    selectionNotes.set(
      entry.id,
      formatChannelSelectionLine(formatChannelSelectionMeta(entry.meta), formatDocsLink),
    );
  }
  return params.selection
    .map((channel) => selectionNotes.get(channel))
    .filter((line): line is string => Boolean(line));
}

export function resolveChannelSetupSelectionContributions(params: {
  entries: ChannelSetupSelectionEntry[];
  statusByChannel: Map<ChannelChoice, { selectionHint?: string }>;
  resolveDisabledHint: (channel: ChannelChoice) => string | undefined;
}): ChannelSetupSelectionContribution[] {
  const bundledChannelIds = new Set(listChatChannels().map((channel) => channel.id));
  return params.entries
    .filter((entry) => shouldShowChannelInSetup(entry.meta))
    .toSorted((left, right) => compareChannelSetupSelectionEntries(left, right))
    .map((entry) => {
      const disabledHint = params.resolveDisabledHint(entry.id);
      const statusHint = params.statusByChannel.get(entry.id)?.selectionHint;
      const hint = [statusHint, disabledHint].filter(Boolean).join(" · ") || undefined;
      return buildChannelSetupSelectionContribution({
        channel: entry.id,
        label: formatSetupSelectionLabel(entry.meta.selectionLabel ?? entry.meta.label, entry.id),
        hint: formatSetupSelectionHint(hint),
        source: bundledChannelIds.has(entry.id) ? "core" : "plugin",
      });
    });
}

function compareChannelSetupSelectionEntries(
  left: ChannelSetupSelectionEntry,
  right: ChannelSetupSelectionEntry,
): number {
  const leftLabel = left.meta.selectionLabel ?? left.meta.label;
  const rightLabel = right.meta.selectionLabel ?? right.meta.label;
  return (
    leftLabel.localeCompare(rightLabel, undefined, { numeric: true, sensitivity: "base" }) ||
    left.id.localeCompare(right.id, undefined, { numeric: true, sensitivity: "base" })
  );
}
