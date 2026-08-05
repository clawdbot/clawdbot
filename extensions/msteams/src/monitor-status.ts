import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import {
  channelBlockedPatch,
  channelReadyPatch,
  channelStoppedPatch,
} from "openclaw/plugin-sdk/gateway-runtime";

export type MSTeamsStatusSink = (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;

export function publishMSTeamsBlocked(
  statusSink: MSTeamsStatusSink | undefined,
  lastError: string,
) {
  statusSink?.(channelBlockedPatch(lastError, { running: true }));
}

export function publishMSTeamsReady(statusSink: MSTeamsStatusSink | undefined, now = Date.now()) {
  statusSink?.(channelReadyPatch({ lastConnectedAt: now }));
}

export function publishMSTeamsRecovering(
  statusSink: MSTeamsStatusSink | undefined,
  lastError: string,
) {
  statusSink?.({ connected: false, lifecycle: "recovering", lastError });
}

export function publishMSTeamsStopped(statusSink: MSTeamsStatusSink | undefined) {
  statusSink?.(channelStoppedPatch());
}
