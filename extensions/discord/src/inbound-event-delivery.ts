// Discord plugin module implements inbound event delivery behavior.
import { createInboundEventDeliveryCorrelation } from "openclaw/plugin-sdk/inbound-event-delivery";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const DISCORD_INBOUND_EVENT_DELIVERY_KEY = "__openclawInboundEventDelivery";

function normalizeDiscordDeliveryTarget(value: string): string {
  return value
    .trim()
    .replace(/^discord:/iu, "")
    .replace(/^channel:/iu, "")
    .toLowerCase();
}

export const discordInboundEventDelivery = createInboundEventDeliveryCorrelation({
  targetsMatch: (expected, actual) =>
    normalizeDiscordDeliveryTarget(expected) === normalizeDiscordDeliveryTarget(actual),
});

export function withDiscordInboundEventDeliveryMetadata(
  payload: ReplyPayload,
  params: {
    sessionKey?: string | null;
    inboundEventKind?: string;
  },
): ReplyPayload {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey || params.inboundEventKind !== "room_event") {
    return payload;
  }
  const channelData = asOptionalRecord(payload.channelData) ?? {};
  const discordData = asOptionalRecord(channelData.discord) ?? {};
  return {
    ...payload,
    channelData: {
      ...channelData,
      discord: {
        ...discordData,
        [DISCORD_INBOUND_EVENT_DELIVERY_KEY]: {
          sessionKey,
          inboundEventKind: params.inboundEventKind,
        },
      },
    },
  };
}

export function notifyDiscordInboundEventOutboundPayloadSuccess(params: {
  payload: ReplyPayload;
  to: string;
  accountId?: string | null;
}): void {
  const channelData = asOptionalRecord(params.payload.channelData);
  const discordData = asOptionalRecord(channelData?.discord);
  const metadata = asOptionalRecord(discordData?.[DISCORD_INBOUND_EVENT_DELIVERY_KEY]);
  if (!metadata) {
    return;
  }
  discordInboundEventDelivery.notify({
    sessionKey: normalizeOptionalString(metadata.sessionKey),
    inboundEventKind: normalizeOptionalString(metadata.inboundEventKind),
    to: params.to,
    accountId: params.accountId,
  });
}
