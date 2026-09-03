// Telegram plugin module implements webhook status behavior.
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { channelReadyPatch } from "openclaw/plugin-sdk/gateway-runtime";

type TelegramWebhookStatusSink = (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;

export function createTelegramWebhookStatusPublisher(setStatus?: TelegramWebhookStatusSink) {
  return {
    noteWebhookStart() {
      setStatus?.({
        mode: "webhook",
        connected: false,
        lastConnectedAt: null,
        lastEventAt: null,
        lastTransportActivityAt: null,
      });
    },
    noteWebhookAdvertised(at = Date.now()) {
      setStatus?.(
        channelReadyPatch({
          lastConnectedAt: at,
          lastEventAt: at,
          mode: "webhook",
        }),
      );
    },
    noteWebhookUpdateReceived(at = Date.now()) {
      setStatus?.(
        channelReadyPatch({
          lastConnectedAt: at,
          lastEventAt: at,
          mode: "webhook",
        }),
      );
    },
    noteWebhookRecovery() {
      setStatus?.({ lifecycle: "recovering" });
    },
    noteWebhookRegistrationFailure(error: string, lifecycle?: "recovering" | "blocked") {
      setStatus?.({
        mode: "webhook",
        connected: false,
        ...(lifecycle ? { lifecycle } : {}),
        ...(lifecycle === "blocked" ? { terminalDisconnect: true } : {}),
        lastError: error,
      });
    },
    noteWebhookStop() {
      setStatus?.({
        mode: "webhook",
        connected: false,
      });
    },
  };
}
