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
    const health = evaluateChannelHealth(account, {
      channelId: channel,
      now,
      channelConnectGraceMs: DEFAULT_CHANNEL_CONNECT_GRACE_MS,
      staleEventThresholdMs: DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
    });
    if (health.healthy) {
      continue;
    }
    if (health.reason === "disconnected") {
      issues.push({
        channel,
        accountId,
        kind: "runtime",
        message: "Channel reports running, but the runtime is disconnected.",
        fix: "restart the channel or gateway",
      });
      continue;
    }
    if (health.reason === "stale-socket") {
      issues.push({
        channel,
        accountId,
        kind: "runtime",
        message:
          "Channel reports connected, but transport activity is stale; inbound delivery may be broken.",
        fix: "restart the channel or gateway",
      });
      continue;
    }
    if (health.reason === "stuck") {
      issues.push({
        channel,
        accountId,
        kind: "runtime",
        message: "Channel runtime appears stuck with stale run activity.",
        fix: "restart the channel or gateway",
      });
    }
  }
  return issues;
}

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
