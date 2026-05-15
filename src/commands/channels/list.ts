import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { ChannelPluginCatalogEntry } from "../../channels/plugins/catalog.js";
import { isChannelVisibleInConfiguredLists } from "../../channels/plugins/exposure.js";
import { listReadOnlyChannelPluginsForConfig } from "../../channels/plugins/read-only.js";
import { buildChannelAccountSnapshot } from "../../channels/plugins/status.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import {
  normalizeRuntimeChannelAccountSnapshots,
  resolveChannelAccountStatusRows,
  type RuntimeChannelStatusPayload,
} from "../../channels/status/read-model.js";
import { callGateway } from "../../gateway/call.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { isCatalogChannelInstalled } from "../channel-setup/discovery.js";
import { listTrustedChannelPluginCatalogEntries } from "../channel-setup/trusted-catalog.js";
import { formatChannelAccountLabel, requireValidConfig } from "./shared.js";

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
}): string {
  const { entry, installed } = params;
  const channelText = theme.accent(entry.meta.label ?? entry.id);
  const bits: string[] = [
    formatInstalled(installed),
    formatConfigured(false),
    formatEnabled(false),
  ];
  return `- ${channelText}: ${bits.join(", ")}`;
}

export async function channelsListCommand(
  opts: ChannelsListOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }
  const showAll = opts.all === true;

  const plugins = listReadOnlyChannelPluginsForConfig(cfg, {
    includeSetupFallbackPlugins: true,
  });
  const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
  const catalogEntries = listTrustedChannelPluginCatalogEntries({
    cfg,
    ...(workspaceDir ? { workspaceDir } : {}),
  });
  const runtimeAccountsByChannel =
    opts.json === true
      ? new Map<string, ChannelAccountSnapshot[]>()
      : normalizeRuntimeChannelAccountSnapshots(await readGatewayChannelStatus());
  const installedByChannelId = new Map<string, boolean>();
  for (const entry of catalogEntries) {
    installedByChannelId.set(
      entry.id,
      isCatalogChannelInstalled({
        cfg,
        entry,
        ...(workspaceDir ? { workspaceDir } : {}),
      }),
    );
  }
  // A plugin loaded into the runtime registry is, by definition, installed.
  // Catalog-tracked channels may still be flagged as not installed when the
  // plugin object only came in via setup fallback metadata; in that case the
  // explicit catalog check above wins.
  const isInstalled = (channelId: string): boolean => installedByChannelId.get(channelId) ?? true;

  type AccountLineSource = {
    plugin: ChannelPlugin;
    snapshot: ChannelAccountSnapshot;
    installed: boolean;
  };
  const accountLines: AccountLineSource[] = [];
  const renderedChannelIds = new Set<string>();

  for (const plugin of plugins) {
    const accountIds = plugin.config.listAccountIds(cfg);
    if (accountIds && accountIds.length > 0) {
      renderedChannelIds.add(plugin.id);
      const runtimeAccounts = runtimeAccountsByChannel.get(plugin.id) ?? [];
      const rows = await resolveChannelAccountStatusRows({
        localAccountIds: accountIds,
        runtimeAccounts,
        resolveLocalSnapshot: (accountId) =>
          buildChannelAccountSnapshot({ plugin, cfg, accountId }),
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
    const snapshot = await buildChannelAccountSnapshot({
      plugin,
      cfg,
      accountId: "default",
    });
    const runtimeSnapshot = runtimeAccountsByChannel
      .get(plugin.id)
      ?.find((account) => account.accountId === "default");
    renderedChannelIds.add(plugin.id);
    accountLines.push({
      plugin,
      snapshot: runtimeSnapshot ?? snapshot,
      installed: isInstalled(plugin.id),
    });
  }

  // --all also surfaces catalog entries that are not already represented
  // by a plugin row above. Two shapes land here:
  //   1. Catalog plugin package is not yet installed on disk — rendered as
  //      `not installed, not configured, disabled` so the channel still
  //      appears in the listing as installable.
  //   2. Catalog plugin package IS installed but the user has no config
  //      entry for the channel, AND the read-only loader did not surface
  //      a plugin object for it (because it only activates based on
  //      configured channels). These would otherwise silently disappear
  //      from the listing — render them as `installed, not configured,
  //      disabled` so operators can tell the plugin is ready to configure.
  const catalogOnlyLines: ChannelPluginCatalogEntry[] = showAll
    ? catalogEntries.filter((entry) => !renderedChannelIds.has(entry.id))
    : [];

  if (opts.json) {
    type JsonChannelEntry = {
      accounts: string[];
      installed: boolean;
      origin: "configured" | "available" | "installable";
    };
    const chat: Record<string, JsonChannelEntry> = {};
    for (const plugin of plugins) {
      const accountIds = plugin.config.listAccountIds(cfg);
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
    if (showAll) {
      for (const entry of catalogOnlyLines) {
        const installed = isInstalled(entry.id);
        chat[entry.id] = {
          accounts: [],
          installed,
          origin: installed ? "available" : "installable",
        };
      }
    }
    writeRuntimeJson(runtime, { chat });
    return;
  }

  const lines: string[] = [];
  lines.push(theme.heading("Chat channels:"));
  if (accountLines.length === 0 && catalogOnlyLines.length === 0) {
    lines.push(
      theme.muted(
        showAll
          ? "- no chat channels found"
          : "- no configured chat channels (run `openclaw channels list --all` to see installable channels)",
      ),
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
    for (const entry of catalogOnlyLines) {
      lines.push(
        formatCatalogOnlyLine({
          entry,
          installed: isInstalled(entry.id),
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
