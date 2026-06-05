// Resolves the first channel that can report linked/unlinked auth state for status summaries.
// Channel-specific linking logic stays inside plugin status hooks.

import { listReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveDefaultChannelAccountContext } from "./channel-account-context.js";

export type LinkChannelContext = {
  linked: boolean;
  authAgeMs: number | null;
  account?: unknown;
  accountId?: string;
  plugin: ChannelPlugin;
};

/** Returns link status for the first configured read-only channel that exposes linked state. */
export async function resolveLinkChannelContext(
  cfg: OpenClawConfig,
  options: { sourceConfig?: OpenClawConfig } = {},
): Promise<LinkChannelContext | null> {
  const sourceConfig = options.sourceConfig ?? cfg;
  for (const plugin of listReadOnlyChannelPluginsForConfig(cfg, {
    activationSourceConfig: sourceConfig,
    includeSetupFallbackPlugins: false,
  })) {
    const { defaultAccountId, account, enabled, configured } =
      await resolveDefaultChannelAccountContext(plugin, cfg, {
        mode: "read_only",
        commandName: "status",
      });
    const snapshot = plugin.config.describeAccount
      ? plugin.config.describeAccount(account, cfg)
      : ({
          // Fallback snapshot keeps older/simple plugins visible in status.
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
    const summaryRecord = summary;
    const linked =
      summaryRecord && typeof summaryRecord.linked === "boolean" ? summaryRecord.linked : null;
    if (linked === null) {
      // Keep scanning until a plugin reports an explicit linked/unlinked value.
      continue;
    }
    const authAgeMs =
      summaryRecord && typeof summaryRecord.authAgeMs === "number" ? summaryRecord.authAgeMs : null;
    return { linked, authAgeMs, account, accountId: defaultAccountId, plugin };
  }
  return null;
}
