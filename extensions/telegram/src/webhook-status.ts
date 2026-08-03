// Telegram plugin module implements webhook status behavior.
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { createConnectedChannelStatusPatch } from "openclaw/plugin-sdk/gateway-runtime";

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
      setStatus?.({
        ...createConnectedChannelStatusPatch(at),
        mode: "webhook",
        lifecycle: "ready",
        terminalDisconnect: undefined,
        lastError: null,
      });
    },
    noteWebhookUpdateReceived(at = Date.now()) {
      setStatus?.({
        ...createConnectedChannelStatusPatch(at),
        mode: "webhook",
        lifecycle: "ready",
        // Runtime patches merge, so a repaired token must clear the prior terminal auth fact.
        terminalDisconnect: undefined,
        lastError: null,
      });
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
