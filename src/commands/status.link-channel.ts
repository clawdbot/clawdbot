import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { listChannelPlugins } from "../channels/plugins/index.js";
import type { ChannelAccountSnapshot, ChannelPlugin } from "../channels/plugins/types.js";
import type { MoltbotConfig } from "../config/config.js";

export type LinkChannelContext = {
  linked: boolean;
  authAgeMs: number | null;
  account?: unknown;
  accountId?: string;
  plugin: ChannelPlugin;
};

export async function resolveLinkChannelContext(
  cfg: MoltbotConfig,
): Promise<LinkChannelContext | null> {
  for (const plugin of listChannelPlugins()) {
    const accountIds = plugin.config.listAccountIds(cfg);
    const defaultAccountId = resolveChannelDefaultAccountId({
      plugin,
      cfg,
      accountIds,
    });
    const account = plugin.config.resolveAccount(cfg, defaultAccountId);
    const enabled = plugin.config.isEnabled ? plugin.config.isEnabled(account, cfg) : true;
    const configured = plugin.config.isConfigured
      ? await plugin.config.isConfigured(account, cfg)
      : true;
    const snapshot = plugin.config.describeAccount
      ? plugin.config.describeAccount(account, cfg)
      : ({
          accountId: defaultAccountId,
          enabled,
          configured,
        } as ChannelAccountSnapshot);
    const summary = plugin.status?.buildChannelSummary
      ? await plugin.status.buildChannelSummary({
          account,
          cfg,
          defaultAccountId,
          snapshot,
        })
      : undefined;
    const summaryRecord = summary as Record<string, unknown> | undefined;
    const linked =
      summaryRecord && typeof summaryRecord.linked === "boolean" ? summaryRecord.linked : null;
    if (linked === null) continue;
    const authAgeMs =
      summaryRecord && typeof summaryRecord.authAgeMs === "number" ? summaryRecord.authAgeMs : null;
    return { linked, authAgeMs, account, accountId: defaultAccountId, plugin };
  }
  return null;
}
