// Telegram plugin module implements polling status behavior.
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import {
  createConnectedChannelStatusPatch,
  createTransportActivityStatusPatch,
} from "openclaw/plugin-sdk/gateway-runtime";

type TelegramPollingStatusSink = (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;

export function createTelegramPollingStatusPublisher(setStatus?: TelegramPollingStatusSink) {
  return {
    notePollingStart() {
      setStatus?.({
        mode: "polling",
        connected: false,
        lastConnectedAt: null,
        lastEventAt: null,
        lastTransportActivityAt: null,
      });
    },
    notePollSuccess(at = Date.now()) {
      setStatus?.({
        ...createConnectedChannelStatusPatch(at),
        // A successful getUpdates call proves the Telegram HTTP long-poll is alive
        // even when the response has no user-visible updates.
        ...createTransportActivityStatusPatch(at),
        mode: "polling",
        lifecycle: "ready",
        // Runtime patches merge, so a repaired token must clear the prior terminal auth fact.
        terminalDisconnect: undefined,
        lastError: null,
      });
    },
    notePollingRecovery() {
      setStatus?.({ lifecycle: "recovering" });
    },
    notePollingError(error: string, lifecycle?: "recovering" | "blocked") {
      setStatus?.({
        mode: "polling",
        connected: false,
        ...(lifecycle ? { lifecycle } : {}),
        ...(lifecycle === "blocked" ? { terminalDisconnect: true } : {}),
        lastError: error,
      });
    },
    notePollingStop() {
      setStatus?.({
        mode: "polling",
        connected: false,
      });
    },
  };
}
