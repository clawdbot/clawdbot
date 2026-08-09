import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";

export type MSTeamsStatusSink = (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;

export function publishMSTeamsBlocked(
  statusSink: MSTeamsStatusSink | undefined,
  lastError: string,
) {
  statusSink?.({
    running: true,
    lifecycle: "blocked",
    terminalDisconnect: true,
    lastError,
  });
}

export function publishMSTeamsReady(statusSink: MSTeamsStatusSink | undefined, now = Date.now()) {
  statusSink?.({
    running: true,
    connected: true,
    lifecycle: "ready",
    lastConnectedAt: now,
    lastError: null,
    terminalDisconnect: undefined,
  });
}

export function publishMSTeamsRecovering(
  statusSink: MSTeamsStatusSink | undefined,
  lastError: string,
) {
  statusSink?.({ connected: false, lifecycle: "recovering", lastError });
}

export function publishMSTeamsStopped(statusSink: MSTeamsStatusSink | undefined) {
  statusSink?.({ running: false, connected: false, lifecycle: "stopped" });
}
