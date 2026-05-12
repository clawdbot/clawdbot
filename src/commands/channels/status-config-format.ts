import {
  hasConfiguredUnavailableCredentialStatus,
  hasResolvedCredentialValue,
} from "../../channels/account-snapshot-fields.js";
import { normalizeChannelId } from "../../channels/plugins/index.js";
import { listReadOnlyChannelPluginsForConfig } from "../../channels/plugins/read-only.js";
import {
  buildChannelAccountSnapshot,
  buildReadOnlySourceChannelAccountSnapshot,
} from "../../channels/plugins/status.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { listExplicitConfiguredChannelIdsForConfig } from "../../plugins/channel-plugin-ids.js";
import {
  type OfficialExternalPluginRepairHint,
  resolveMissingOfficialExternalChannelPluginRepairHint,
} from "../../plugins/official-external-plugin-repair-hints.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import {
  appendBaseUrlBit,
  appendEnabledConfiguredLinkedBits,
  appendModeBit,
  appendTokenSourceBits,
  buildChannelAccountLine,
  type ChatChannel,
} from "./shared.js";

type ChannelStatusPluginLabel = {
  id: ChatChannel;
  meta: { label?: string };
};

export async function formatConfigChannelsStatusLines(
  cfg: OpenClawConfig,
  meta: { path?: string; mode?: "local" | "remote" },
  opts?: { sourceConfig?: OpenClawConfig; channel?: string },
): Promise<string[]> {
  const lines: string[] = [];
  lines.push(theme.warn("Gateway not reachable; showing config-only status."));
  if (meta.path) {
    lines.push(`Config: ${meta.path}`);
  }
  if (meta.mode) {
    lines.push(`Mode: ${meta.mode}`);
  }
  if (meta.path || meta.mode) {
    lines.push("");
  }

  const accountLines = (
    plugin: ChannelStatusPluginLabel,
    accounts: Array<Record<string, unknown>>,
  ) =>
    accounts.map((account) => {
      const bits: string[] = [];
      appendEnabledConfiguredLinkedBits(bits, account);
      appendModeBit(bits, account);
      appendTokenSourceBits(bits, account);
      appendBaseUrlBit(bits, account);
      return buildChannelAccountLine(plugin.id, account, bits, {
        channelLabel: plugin.meta.label ?? plugin.id,
      });
    });

  const sourceConfig = opts?.sourceConfig ?? cfg;
  const requestedChannel = opts?.channel ? normalizeChannelId(opts.channel) : null;
  const plugins = listReadOnlyChannelPluginsForConfig(cfg, {
    activationSourceConfig: sourceConfig,
    includeSetupFallbackPlugins: true,
  }).filter((plugin) => !requestedChannel || plugin.id === requestedChannel);
  const visibleChannelIds = new Set<string>();
  for (const plugin of plugins) {
    visibleChannelIds.add(plugin.id);
    const accountIds = plugin.config.listAccountIds(cfg);
    if (!accountIds.length) {
      continue;
    }
    const snapshots: ChannelAccountSnapshot[] = [];
    for (const accountId of accountIds) {
      const sourceSnapshot = await buildReadOnlySourceChannelAccountSnapshot({
        plugin,
        cfg: sourceConfig,
        accountId,
      });
      const resolvedSnapshot = await buildChannelAccountSnapshot({
        plugin,
        cfg,
        accountId,
      });
      snapshots.push(
        sourceSnapshot &&
          hasConfiguredUnavailableCredentialStatus(sourceSnapshot) &&
          (!hasResolvedCredentialValue(resolvedSnapshot) ||
            (sourceSnapshot.configured === true && resolvedSnapshot.configured === false))
          ? sourceSnapshot
          : resolvedSnapshot,
      );
    }
    if (snapshots.length > 0) {
      lines.push(...accountLines(plugin, snapshots));
    }
  }

  const missingHints: OfficialExternalPluginRepairHint[] = [];
  const missingChannelIds = [
    ...new Set([
      ...listExplicitConfiguredChannelIdsForConfig(sourceConfig),
      ...listExplicitConfiguredChannelIdsForConfig(cfg),
    ]),
  ];
  for (const channelId of missingChannelIds) {
    if (requestedChannel && channelId !== requestedChannel) {
      continue;
    }
    if (visibleChannelIds.has(channelId)) {
      continue;
    }
    const hint = resolveMissingOfficialExternalChannelPluginRepairHint({
      config: cfg,
      activationSourceConfig: sourceConfig,
      channelId,
    });
    if (!hint?.channelId || visibleChannelIds.has(hint.channelId)) {
      continue;
    }
    missingHints.push(hint);
    visibleChannelIds.add(hint.channelId);
  }
  if (missingHints.length > 0) {
    lines.push("");
    lines.push(theme.warn("Missing official external plugins:"));
    for (const hint of missingHints) {
      lines.push(`- ${hint.label}: ${hint.repairHint}`);
    }
  }

  lines.push("");
  lines.push(
    `Tip: ${formatDocsLink("/cli#status", "status --deep")} adds gateway health probes to status output (requires a reachable gateway).`,
  );
  return lines;
}
