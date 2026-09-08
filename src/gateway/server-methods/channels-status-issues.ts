import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelId, ChannelStatusIssue } from "../../channels/plugins/types.public.js";
import { collectChannelStatusIssues } from "../../infra/channels-status-issues.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestContext } from "./types.js";

export function resolveDeferredChannelReloadIssue(
  context: GatewayRequestContext,
  channel: ChannelId,
  accountId: string,
): ChannelStatusIssue | undefined {
  const deferred = context.getDeferredChannelReloads?.().find((entry) => entry.channel === channel);
  if (!deferred) {
    return undefined;
  }
  return {
    channel,
    accountId,
    kind: "config",
    message: deferred.publicationPending
      ? "Channel configuration reload is deferred while active work finishes. The previous configuration is still in use."
      : "Channel reload is deferred while active work finishes.",
    fix: "Wait for active work to finish, then refresh channel status. Stopping and starting the channel does not apply unpublished configuration.",
  };
}

export function collectGatewayChannelStatusIssues(params: {
  payload: Record<string, unknown>;
  plugins: readonly ChannelPlugin[];
  defaultAccountIds: Record<string, unknown>;
  context: GatewayRequestContext;
  warnings: string[];
}): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];
  for (const plugin of params.plugins) {
    try {
      issues.push(...collectChannelStatusIssues(params.payload, [plugin]));
    } catch (error) {
      params.warnings.push(`${plugin.id} status diagnostics failed: ${formatForLog(error)}`);
    }
    const defaultAccountId = params.defaultAccountIds[plugin.id];
    const deferredIssue = resolveDeferredChannelReloadIssue(
      params.context,
      plugin.id,
      typeof defaultAccountId === "string" ? defaultAccountId : DEFAULT_ACCOUNT_ID,
    );
    if (deferredIssue) {
      issues.push(deferredIssue);
    }
  }
  return issues.slice(0, 50);
}
