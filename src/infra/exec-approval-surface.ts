import {
  getChannelPlugin,
  listChannelPlugins,
  resolveChannelApprovalCapability,
} from "../channels/plugins/index.js";
import { getRuntimeConfig, type OpenClawConfig } from "../config/config.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel.js";

export type ExecApprovalInitiatingSurfaceState =
  | { kind: "enabled"; channel: string | undefined; channelLabel: string; accountId?: string }
  | { kind: "disabled"; channel: string; channelLabel: string; accountId?: string }
  | { kind: "unsupported"; channel: string; channelLabel: string; accountId?: string };

function labelForChannel(channel?: string): string {
  if (channel === "tui") {
    return "terminal UI";
  }
  if (channel === INTERNAL_MESSAGE_CHANNEL) {
    return "Web UI";
  }
  return (
    getChannelPlugin(channel ?? "")?.meta.label ??
    (channel ? channel[0]?.toUpperCase() + channel.slice(1) : "this platform")
  );
}

function hasNativeExecApprovalCapability(channel?: string): boolean {
  const capability = resolveChannelApprovalCapability(getChannelPlugin(channel ?? ""));
  if (!capability?.native) {
    return false;
  }
  return Boolean(capability.getExecInitiatingSurfaceState || capability.getActionAvailabilityState);
}

export function resolveExecApprovalInitiatingSurfaceState(params: {
  channel?: string | null;
  accountId?: string | null;
  cfg?: OpenClawConfig;
}): ExecApprovalInitiatingSurfaceState {
  const channel = normalizeMessageChannel(params.channel);
  const channelLabel = labelForChannel(channel);
  const accountId = normalizeOptionalString(params.accountId);
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL || channel === "tui") {
    return { kind: "enabled", channel, channelLabel, accountId };
  }

  const cfg = params.cfg ?? getRuntimeConfig();
  const capability = resolveChannelApprovalCapability(getChannelPlugin(channel));
  const state =
    capability?.getExecInitiatingSurfaceState?.({
      cfg,
      accountId: params.accountId,
      action: "approve",
    }) ??
    capability?.getActionAvailabilityState?.({
      cfg,
      accountId: params.accountId,
      action: "approve",
      approvalKind: "exec",
    });
  if (state) {
    return { ...state, channel, channelLabel, accountId };
  }
  if (isDeliverableMessageChannel(channel)) {
    return { kind: "enabled", channel, channelLabel, accountId };
  }
  return { kind: "unsupported", channel, channelLabel, accountId };
}

export function supportsNativeExecApprovalClient(channel?: string | null): boolean {
  const normalized = normalizeMessageChannel(channel);
  if (!normalized || normalized === INTERNAL_MESSAGE_CHANNEL || normalized === "tui") {
    return true;
  }
  return hasNativeExecApprovalCapability(normalized);
}

export function listNativeExecApprovalClientLabels(params?: {
  excludeChannel?: string | null;
}): string[] {
  const excludeChannel = normalizeMessageChannel(params?.excludeChannel);
  return listChannelPlugins()
    .filter((plugin) => plugin.id !== excludeChannel)
    .filter((plugin) => hasNativeExecApprovalCapability(plugin.id))
    .map((plugin) => normalizeOptionalString(plugin.meta.label))
    .filter((label): label is string => Boolean(label))
    .toSorted((a, b) => a.localeCompare(b));
}

export function describeNativeExecApprovalClientSetup(params: {
  channel?: string | null;
  channelLabel?: string | null;
  accountId?: string | null;
}): string | null {
  const channel = normalizeMessageChannel(params.channel);
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL || channel === "tui") {
    return null;
  }
  const channelLabel = normalizeOptionalString(params.channelLabel) ?? labelForChannel(channel);
  const accountId = normalizeOptionalString(params.accountId);
  return (
    resolveChannelApprovalCapability(getChannelPlugin(channel))?.describeExecApprovalSetup?.({
      channel,
      channelLabel,
      accountId,
    }) ?? null
  );
}
