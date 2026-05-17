import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";

export type DiscordInboundEventDeliveryEnd = () => void;

type ActiveEvent = {
  outboundTo: string;
  outboundAccountId?: string;
  markInboundEventDelivered: () => void;
};

const DISCORD_INBOUND_EVENT_DELIVERY_KEY = "__openclawInboundEventDelivery";
const registry = new Map<string, ActiveEvent>();

function normalizeDiscordDeliveryTarget(value: string): string {
  return value
    .trim()
    .replace(/^discord:/iu, "")
    .replace(/^channel:/iu, "")
    .toLowerCase();
}

function resolveDiscordInboundEventDeliveryCorrelationKey(
  sessionKey: string | undefined,
  inboundEventKind?: string,
): string | undefined {
  const key = sessionKey?.trim();
  if (!key) {
    return undefined;
  }
  return inboundEventKind === "room_event" ? `${key}:room_event` : key;
}

export function beginDiscordInboundEventDeliveryCorrelation(
  sessionKey: string | undefined,
  event: ActiveEvent,
  options?: { inboundEventKind?: string },
): DiscordInboundEventDeliveryEnd {
  const key = resolveDiscordInboundEventDeliveryCorrelationKey(
    sessionKey,
    options?.inboundEventKind,
  );
  if (!key) {
    return () => {};
  }
  registry.set(key, event);
  return () => {
    if (registry.get(key) === event) {
      registry.delete(key);
    }
  };
}

export function notifyDiscordInboundEventOutboundSuccess(params: {
  sessionKey: string | undefined;
  to: string;
  accountId?: string | null;
  inboundEventKind?: string;
}): void {
  const key = resolveDiscordInboundEventDeliveryCorrelationKey(
    params.sessionKey,
    params.inboundEventKind,
  );
  if (!key) {
    return;
  }
  const event = registry.get(key);
  if (
    !event ||
    normalizeDiscordDeliveryTarget(event.outboundTo) !== normalizeDiscordDeliveryTarget(params.to)
  ) {
    return;
  }
  if (event.outboundAccountId && params.accountId && params.accountId !== event.outboundAccountId) {
    return;
  }
  registry.delete(key);
  event.markInboundEventDelivered();
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

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
  notifyDiscordInboundEventOutboundSuccess({
    sessionKey: readString(metadata.sessionKey),
    inboundEventKind: readString(metadata.inboundEventKind),
    to: params.to,
    accountId: params.accountId,
  });
}
