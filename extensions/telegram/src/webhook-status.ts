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
        lastError: null,
      });
    },
    noteWebhookUpdateReceived(at = Date.now()) {
      setStatus?.({
        ...createConnectedChannelStatusPatch(at),
        mode: "webhook",
        lastError: null,
      });
    },
    noteWebhookRegistrationFailure(error: string) {
      setStatus?.({
        mode: "webhook",
        connected: false,
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
