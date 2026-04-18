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
import { formatDocsLink } from "../terminal/links.js";
import { sanitizeTerminalText } from "../terminal/safe-text.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { FlowContribution } from "./types.js";

export type ChannelStatusSummary = {
  installedPlugins: ChannelSetupPlugin[];
  catalogEntries: ReturnType<typeof listChannelPluginCatalogEntries>;
  installedCatalogEntries: ReturnType<typeof listChannelPluginCatalogEntries>;
  statusByChannel: Map<ChannelChoice, ChannelSetupStatus>;
  statusLines: string[];
};

export type ChannelSetupSelectionContribution = FlowContribution & {
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
  const catalogStatuses = installableCatalogEntries.map((entry) => ({
    channel: entry.id,
    configured: false,
    statusLines: [
      `${formatSetupSelectionLabel(entry.meta.label, entry.id)}: install plugin to enable`,
    ],
    selectionHint: "plugin · install",
    quickstartScore: 0,
  }));
  const combinedStatuses = [
    ...statusEntries,
    ...fallbackStatuses,
    ...discoveredPluginStatuses,
    ...catalogStatuses,
  ];
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
    await params.prompter.note(statusLines.join("\n"), "Channel status");
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
        blurb: channel.blurb,
      }),
    ),
  );
  await prompter.note(
    [
      "DM security: default is pairing; unknown DMs get a pairing code.",
      `Approve with: ${formatCliCommand("openclaw pairing approve <channel> <code>")}`,
      'Public DMs require dmPolicy="open" + allowFrom=["*"].',
      "Multi-user DMs: run: " +
        formatCliCommand('openclaw config set session.dmScope "per-channel-peer"') +
        ' (or "per-account-channel-peer" for multi-account channels) to isolate sessions.',
      `Docs: ${formatDocsLink("/channels/pairing", "channels/pairing")}`,
      "",
      ...channelLines,
    ].join("\n"),
    "How channels work",
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
      formatChannelSelectionLine(formatSetupDisplayMeta(entry.meta), formatDocsLink),
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
