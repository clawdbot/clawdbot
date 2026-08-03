// Discord plugin module implements status behavior.
import { channelReadyPatch } from "openclaw/plugin-sdk/gateway-runtime";

type DiscordMonitorStatusPatch = {
  connected?: boolean;
  lastEventAt?: number | null;
  lastTransportActivityAt?: number | null;
  lastConnectedAt?: number | null;
  lastDisconnect?:
    | string
    | {
        at: number;
        status?: number;
        error?: string;
        loggedOut?: boolean;
      }
    | null;
  lastInboundAt?: number | null;
  lastError?: string | null;
  lifecycle?: "ready" | "recovering" | "blocked";
  terminalDisconnect?: boolean;
  busy?: boolean;
  activeRuns?: number;
  lastRunActivityAt?: number | null;
};

export type DiscordMonitorStatusSink = (patch: DiscordMonitorStatusPatch) => void;

/** READY proves a prior terminal failure was repaired, so the account is restartable again. */
export function createDiscordReadyStatusPatch(at: number = Date.now()) {
  return channelReadyPatch({
    lastConnectedAt: at,
    lastEventAt: at,
    lastDisconnect: null,
  });
}
