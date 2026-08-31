// Implements `openclaw channels list` across runtime accounts, local config, and catalog-only entries.
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import type { ChannelPluginCatalogEntry } from "../../channels/plugins/catalog.js";
import { isChannelVisibleInConfiguredLists } from "../../channels/plugins/exposure.js";
import { listReadOnlyChannelPluginsForConfig } from "../../channels/plugins/read-only.js";
import { resolveChannelAccountSnapshot } from "../../channels/plugins/status.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import {
  normalizeRuntimeChannelAccountSnapshots,
  resolveChannelAccountStatusRows,
  type RuntimeChannelStatusPayload,
} from "../../channels/status/read-model.js";
import { callGateway } from "../../gateway/call.js";
import { resolvePluginControlPlaneWorkspace } from "../../plugins/control-plane-workspace.js";
import { resolveMissingOfficialExternalChannelPluginRepairHint } from "../../plugins/official-external-plugin-repair-hints.js";
import { resolvePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { listManifestInstalledChannelIds } from "../channel-setup/discovery.js";
import { listTrustedChannelPluginCatalogEntries } from "../channel-setup/trusted-catalog.js";
import {
  formatChannelAccountLabel,
  NO_CONFIGURED_CHAT_CHANNELS_LINE,
  requireValidChannelConfig,
} from "./shared.js";

export type ChannelsListOptions = {
  json?: boolean;
  all?: boolean;
};

async function readGatewayChannelStatus(): Promise<RuntimeChannelStatusPayload | null> {
  try {
    return (await callGateway({
      method: "channels.status",
      params: { probe: false, timeoutMs: 5_000 },
      timeoutMs: 5_000,
    })) as RuntimeChannelStatusPayload;
  } catch {
    return null;
  }
}

const colorValue = (value: string) => {
  if (value === "none") {
    return theme.error(value);
  }
  if (value === "env") {
    return theme.accent(value);
  }
  return theme.success(value);
};

function formatEnabled(value: boolean | undefined): string {
  return value === false ? theme.error("disabled") : theme.success("enabled");
}

function formatConfigured(value: boolean): string {
  return value ? theme.success("configured") : theme.warn("not configured");
}

function formatInstalled(value: boolean): string {
  return value ? theme.success("installed") : theme.warn("not installed");
}

function formatCredentialSource(source?: string, status?: string): string {
  const value = source || "none";
  if (status === "configured_unavailable" && value !== "none") {
    return theme.warn(`${value}-unavailable`);
  }
  return colorValue(value);
}

function formatTokenSource(source?: string, status?: string): string {
  return `token=${formatCredentialSource(source, status)}`;
}

function formatSource(label: string, source?: string, status?: string): string {
  return `${label}=${formatCredentialSource(source, status)}`;
}

function formatLinked(value: boolean): string {
  return value ? theme.success("linked") : theme.warn("not linked");
}

function shouldShowConfigured(channel: ChannelPlugin): boolean {
  return isChannelVisibleInConfiguredLists(channel.meta);
}

function formatAccountLine(params: {
  channel: ChannelPlugin;
  snapshot: ChannelAccountSnapshot;
  installed: boolean;
}): string {
  const { channel, snapshot, installed } = params;
  const label = formatChannelAccountLabel({
    channel: channel.id,
    accountId: snapshot.accountId,
    name: snapshot.name,
    channelLabel: channel.meta.label ?? channel.id,
    channelStyle: theme.accent,
    accountStyle: theme.heading,
  });
  const bits: string[] = [];
  bits.push(formatInstalled(installed));
  if (shouldShowConfigured(channel) && typeof snapshot.configured === "boolean") {
    bits.push(formatConfigured(snapshot.configured));
  }
  if (typeof snapshot.enabled === "boolean") {
    bits.push(formatEnabled(snapshot.enabled));
  }
  if (snapshot.linked !== undefined) {
    bits.push(formatLinked(snapshot.linked));
  }
  if (snapshot.tokenSource) {
    bits.push(formatTokenSource(snapshot.tokenSource, snapshot.tokenStatus));
  }
  if (snapshot.botTokenSource) {
    bits.push(formatSource("bot", snapshot.botTokenSource, snapshot.botTokenStatus));
  }
  if (snapshot.appTokenSource) {
    bits.push(formatSource("app", snapshot.appTokenSource, snapshot.appTokenStatus));
  }
  if (snapshot.baseUrl) {
    bits.push(`base=${theme.muted(snapshot.baseUrl)}`);
  }
  return `- ${label}: ${bits.join(", ")}`;
}

function formatCatalogOnlyLine(params: {
  entry: ChannelPluginCatalogEntry;
  installed: boolean;
  configured: boolean;
  repairHint?: string;
}): string {
  const { entry, installed, configured, repairHint } = params;
  const channelText = theme.accent(entry.meta.label ?? entry.id);
  const bits: string[] = [
    formatInstalled(installed),
    formatConfigured(configured),
    formatEnabled(false),
  ];
  if (repairHint) {
    bits.push(repairHint);
  }
  return `- ${channelText}: ${bits.join(", ")}`;
}

/** Print or serialize configured, available, and installable chat channel accounts. */
export async function channelsListCommand(
  opts: ChannelsListOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const cfg = await requireValidChannelConfig(runtime, { skipPluginValidation: true });
  if (!cfg) {
    return;
  }
  const showAll = opts.all === true;
  const workspace = resolvePluginControlPlaneWorkspace({
    config: cfg,
    env: process.env,
  });
  const workspaceDir = workspace.workspaceDir;
  // Plugin metadata is process-stable. Resolve it once and carry its manifest,
  // discovery, and installed-index facts through every list projection.
  const metadataSnapshot = resolvePluginMetadataSnapshot({
    config: cfg,
    ...(workspaceDir ? { workspaceDir } : {}),
    env: process.env,
    allowWorkspaceScopedCurrent: true,
  });

  // JSON needs only manifest-backed account ids. Text keeps setup-backed snapshots
  // because its credential/status details are part of the human output contract.
  const plugins = opts.json
    ? listReadOnlyChannelPluginsForConfig(cfg, { metadataSnapshot })
    : listReadOnlyChannelPluginsForConfig(cfg, {
        includeSetupFallbackPlugins: true,
        metadataSnapshot,
      });
  const catalogEntries = listTrustedChannelPluginCatalogEntries({
    cfg,
    ...(workspaceDir ? { workspaceDir } : {}),
    ...(metadataSnapshot.discovery ? { discovery: metadataSnapshot.discovery } : {}),
  });
  const runtimeAccountsByChannel =
    opts.json === true
      ? new Map<string, ChannelAccountSnapshot[]>()
      : normalizeRuntimeChannelAccountSnapshots(await readGatewayChannelStatus());
  // Installed ids are one prepared manifest fact set for the invocation. Rebuilding
  // discovery for each catalog row turns this read into a full filesystem walk per row.
  const manifestInstalledChannelIds = new Set<string>(
    listManifestInstalledChannelIds({
      cfg,
      ...(workspaceDir ? { workspaceDir } : {}),
      index: metadataSnapshot.index,
    }),
  );
  const installedByChannelId = new Map(
    catalogEntries.map((entry) => [entry.id, manifestInstalledChannelIds.has(entry.id)]),
  );
  // Metadata-backed plugins are installed by definition; catalog-only rows use
  // the manifest snapshot above because no plugin projection exists for them.
  const isInstalled = (channelId: string): boolean => installedByChannelId.get(channelId) ?? true;

  type AccountLineSource = {
    plugin: ChannelPlugin;
    snapshot: ChannelAccountSnapshot;
    installed: boolean;
  };
  const accountLines: AccountLineSource[] = [];
  const accountIdsByPlugin = new Map(
    plugins.map((plugin) => [plugin.id, plugin.config.listAccountIds(cfg) ?? []]),
  );
  const renderedChannelIds = new Set(
    plugins
      .filter(
        (plugin) =>
          (accountIdsByPlugin.get(plugin.id)?.length ?? 0) > 0 ||
          (showAll && shouldShowConfigured(plugin)),
      )
      .map((plugin) => plugin.id),
  );

  for (const plugin of opts.json ? [] : plugins) {
    const accountIds = accountIdsByPlugin.get(plugin.id) ?? [];
    if (accountIds && accountIds.length > 0) {
      const runtimeAccounts = runtimeAccountsByChannel.get(plugin.id) ?? [];
      const rows = await resolveChannelAccountStatusRows({
        localAccountIds: accountIds,
        runtimeAccounts,
        resolveLocalSnapshot: (accountId) =>
          resolveChannelAccountSnapshot({ plugin, cfg, accountId }),
      });
      for (const row of rows) {
        accountLines.push({
          plugin,
          snapshot: row.snapshot,
          installed: isInstalled(plugin.id),
        });
      }
      continue;
    }
    if (!showAll) {
      continue;
    }
    if (!shouldShowConfigured(plugin)) {
      continue;
    }
    // --all: surface installed-but-unconfigured plugins (bundled, or
    // catalog plugins that already landed on disk) so users can see the
    // full set of channels they could enable without first running
    // `channels add`. Use the channel's default account so the snapshot
    // can reflect "not configured / not enabled" state.
    const snapshot = await resolveChannelAccountSnapshot({
      plugin,
      cfg,
      accountId: "default",
    });
    const runtimeSnapshot = runtimeAccountsByChannel
      .get(plugin.id)
      ?.find((account) => account.accountId === "default");
    accountLines.push({
      plugin,
      snapshot: runtimeSnapshot ?? snapshot,
      installed: isInstalled(plugin.id),
    });
  }

  // Catalog entries that are not already represented by a plugin row above can
  // still be useful in two shapes:
  //   1. Catalog plugin package is not yet installed on disk — rendered as
  //      `not installed, not configured, disabled` so the channel still
  //      appears in the listing as installable.
  //   2. Catalog plugin package IS installed but the user has no config
  //      entry for the channel, AND the read-only loader did not surface
  //      a plugin object for it (because it only activates based on
  //      configured channels). These would otherwise silently disappear
  //      from the listing — render them as `installed, not configured,
  //      disabled` so operators can tell the plugin is ready to configure.
  // Without --all, keep this limited to configured channels whose official
  // external plugin owner is missing, otherwise `channels list` can claim
  // there are no configured channels even though openclaw.json has one.
  const catalogOnlyLines = catalogEntries
    .filter((entry) => !renderedChannelIds.has(entry.id))
    .map((entry) => {
      const hint = resolveMissingOfficialExternalChannelPluginRepairHint({
        config: cfg,
        channelId: entry.id,
        ...(workspaceDir ? { workspaceDir } : {}),
        manifestRecords: metadataSnapshot.plugins,
      });
      return {
        entry,
        installed: isInstalled(entry.id),
        configured: Boolean(hint),
        repairHint: hint ? `run ${hint.installCommand} or ${hint.doctorFixCommand}` : undefined,
      };
    })
    .filter((line) => showAll || line.configured);

  if (opts.json) {
    type JsonChannelEntry = {
      accounts: string[];
      installed: boolean;
      origin: "configured" | "available" | "installable";
    };
    const chat: Record<string, JsonChannelEntry> = {};
    for (const plugin of plugins) {
      const accountIds = accountIdsByPlugin.get(plugin.id) ?? [];
      const installed = isInstalled(plugin.id);
      if (accountIds && accountIds.length > 0) {
        chat[plugin.id] = {
          accounts: accountIds,
          installed,
          origin: "configured",
        };
      } else if (showAll && shouldShowConfigured(plugin)) {
        chat[plugin.id] = {
          accounts: [],
          installed,
          origin: "available",
        };
      }
    }
    for (const line of catalogOnlyLines) {
      chat[line.entry.id] = {
        accounts: [],
        installed: line.installed,
        origin: line.configured ? "configured" : line.installed ? "available" : "installable",
      };
    }
    writeRuntimeJson(runtime, {
      chat,
      ...(workspace.diagnostic ? { diagnostics: [workspace.diagnostic] } : {}),
    });
    return;
  }

  const lines: string[] = [];
  lines.push(theme.heading("Chat channels:"));
  if (workspace.diagnostic) {
    lines.push(theme.warn(`- ${workspace.diagnostic.message}`));
  }
  if (accountLines.length === 0 && catalogOnlyLines.length === 0) {
    lines.push(
      theme.muted(showAll ? "- no chat channels found" : NO_CONFIGURED_CHAT_CHANNELS_LINE),
    );
  } else {
    for (const line of accountLines) {
      lines.push(
        formatAccountLine({
          channel: line.plugin,
          snapshot: line.snapshot,
          installed: line.installed,
        }),
      );
    }
    for (const line of catalogOnlyLines) {
      lines.push(
        formatCatalogOnlyLine({
          entry: line.entry,
          installed: line.installed,
          configured: line.configured,
          ...(line.repairHint ? { repairHint: line.repairHint } : {}),
        }),
      );
    }
  }

  runtime.log(lines.join("\n"));

  runtime.log("");
  runtime.log(
    theme.muted(
      "Model provider usage moved out of `channels list` — see `openclaw status` or `openclaw models list`.",
    ),
  );
  runtime.log(`Docs: ${formatDocsLink("/gateway/configuration", "gateway/configuration")}`);
}
