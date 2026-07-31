// Collects channel account status issues for diagnostics.
import { listChannelPlugins } from "../channels/plugins/index.js";
import type {
  ChannelAccountSnapshot,
  ChannelId,
  ChannelStatusIssue,
} from "../channels/plugins/types.public.js";
import {
  DEFAULT_CHANNEL_CONNECT_GRACE_MS,
  DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
  evaluateChannelHealth,
} from "../gateway/channel-health-policy.js";

function resolveIssueAccountId(account: ChannelAccountSnapshot): string {
  return typeof account.accountId === "string" && account.accountId.trim()
    ? account.accountId
    : "default";
}

function collectGenericRuntimeStatusIssues(
  channel: ChannelId,
  accounts: ChannelAccountSnapshot[],
): ChannelStatusIssue[] {
  const now = Date.now();
  const issues: ChannelStatusIssue[] = [];
  for (const account of accounts) {
    if (account.enabled === false || account.configured === false) {
      continue;
    }
    const accountId = resolveIssueAccountId(account);
    // Dead ingress outranks the restart-pending short-circuit: a pending restart
    // cannot fix a channel whose inbound admission is unavailable, and hiding it
    // behind "status may be stale" is how silent inbound loss stays invisible.
    if (account.ingressUnavailable === true) {
      issues.push({
        channel,
        accountId,
        kind: "runtime",
        message:
          "Channel cannot admit inbound events; its durable ingress queue is unavailable. Outbound may still work.",
        fix: "check openclaw logs for the ingress failure, then rerun openclaw doctor",
      });
      continue;
    }
    if (account.restartPending === true) {
      issues.push({
        channel,
        accountId,
        kind: "runtime",
        message: "Channel restart is pending; runtime status may be stale.",
        fix: "wait for restart to complete, then rerun channels status",
      });
      continue;
    }
    // Generic health issues are derived before plugin-specific checks so every
    // channel gets the same stale/disconnected runtime warnings.
    const health = evaluateChannelHealth(account, {
      channelId: channel,
      now,
      channelConnectGraceMs: DEFAULT_CHANNEL_CONNECT_GRACE_MS,
      staleEventThresholdMs: DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
    });
    if (health.healthy) {
      continue;
    }
    let message: string;
    switch (health.reason) {
      case "not-running":
        // Older status snapshots can omit running; absence is not a stopped runtime.
        if (account.running !== false) {
          continue;
        }
        message = "Channel is enabled and configured, but its runtime is not running.";
        break;
      case "disconnected":
        message = "Channel reports running, but the runtime is disconnected.";
        break;
      case "stale-socket":
        message =
          "Channel reports connected, but transport activity is stale; inbound delivery may be broken.";
        break;
      case "stuck":
        message = "Channel runtime appears stuck with stale run activity.";
        break;
      default:
        continue;
    }
    issues.push({
      channel,
      accountId,
      kind: "runtime",
      message,
      fix: "restart the channel or gateway",
    });
  }
  return issues;
}

/** Collects generic and plugin-specific issues from a channels status payload. */
export function collectChannelStatusIssues(payload: Record<string, unknown>): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];
  const accountsByChannel = payload.channelAccounts as Record<string, unknown> | undefined;
  for (const plugin of listChannelPlugins()) {
    const raw = accountsByChannel?.[plugin.id];
    if (!Array.isArray(raw)) {
      continue;
    }
    const accounts = raw as ChannelAccountSnapshot[];
    issues.push(...collectGenericRuntimeStatusIssues(plugin.id, accounts));
    const collect = plugin.status?.collectStatusIssues;
    if (collect) {
      issues.push(...collect(accounts));
    }
  }
  return issues;
}
