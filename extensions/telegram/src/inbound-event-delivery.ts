import { stripTelegramInternalPrefixes } from "./targets.js";

export type TelegramInboundEventDeliveryEnd = () => void;
export type TelegramInboundEventDeliveryKind = "user_request" | "room_event";

type ActiveInboundEvent = {
  outboundTo: string;
  outboundAccountId?: string;
  markInboundEventDelivered: () => void;
};

const registry = new Map<string, ActiveInboundEvent>();

function normalizeTelegramDeliveryTarget(value: string): string {
  return stripTelegramInternalPrefixes(value).toLowerCase();
}

function stripTelegramTopicTarget(value: string): string {
  return value.replace(/:topic:\d+$/u, "");
}

function hasTelegramTopicTarget(value: string): boolean {
  return /:topic:\d+$/u.test(value);
}

function telegramDeliveryTargetsMatch(expected: string, actual: string): boolean {
  const expectedTarget = normalizeTelegramDeliveryTarget(expected);
  const actualTarget = normalizeTelegramDeliveryTarget(actual);
  if (expectedTarget === actualTarget) {
    return true;
  }
  if (hasTelegramTopicTarget(expectedTarget)) {
    return false;
  }
  const expectedBase = stripTelegramTopicTarget(expectedTarget);
  const actualBase = stripTelegramTopicTarget(actualTarget);
  return (
    expectedBase === actualBase && (expectedTarget === expectedBase || actualTarget === actualBase)
  );
}

export function resolveTelegramInboundEventDeliveryCorrelationKey(
  sessionKey: string | undefined,
  inboundEventKind?: string,
): string | undefined {
  const key = sessionKey?.trim();
  if (!key) {
    return undefined;
  }
  return inboundEventKind === "room_event" ? `${key}:room_event` : key;
}

export function beginTelegramInboundEventDeliveryCorrelation(
  sessionKey: string | undefined,
  event: ActiveInboundEvent,
  options?: { inboundEventKind?: string },
): TelegramInboundEventDeliveryEnd {
  const key = resolveTelegramInboundEventDeliveryCorrelationKey(
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

export function notifyTelegramInboundEventOutboundSuccess(params: {
  sessionKey: string | undefined;
  to: string;
  accountId?: string | null;
  inboundEventKind?: string;
}): void {
  const key = resolveTelegramInboundEventDeliveryCorrelationKey(
    params.sessionKey,
    params.inboundEventKind,
  );
  if (!key) {
    return;
  }
  const event = registry.get(key);
  if (!event || !telegramDeliveryTargetsMatch(event.outboundTo, params.to)) {
    return;
  }
  if (event.outboundAccountId && params.accountId && params.accountId !== event.outboundAccountId) {
    return;
  }
  event.markInboundEventDelivered();
}
