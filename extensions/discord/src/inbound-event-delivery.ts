// Discord plugin module implements inbound event delivery behavior.
import { createInboundEventDeliveryCorrelation } from "openclaw/plugin-sdk/inbound-event-delivery";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import {
  asOptionalRecord as readRecord,
  normalizeOptionalString as readString,
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
  const channelData = readRecord(payload.channelData) ?? {};
  const discordData = readRecord(channelData.discord) ?? {};
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
  const channelData = readRecord(params.payload.channelData);
  const discordData = readRecord(channelData?.discord);
  const metadata = readRecord(discordData?.[DISCORD_INBOUND_EVENT_DELIVERY_KEY]);
  if (!metadata) {
    return;
  }
  discordInboundEventDelivery.notify({
    sessionKey: readString(metadata.sessionKey),
    inboundEventKind: readString(metadata.inboundEventKind),
    to: params.to,
    accountId: params.accountId,
  });
}
