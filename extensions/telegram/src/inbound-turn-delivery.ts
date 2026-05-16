import { stripTelegramInternalPrefixes } from "./targets.js";

export type TelegramInboundTurnDeliveryEnd = () => void;
export type TelegramInboundTurnDeliveryKind = "user_request" | "room_event";

type ActiveTurn = {
  outboundTo: string;
  outboundAccountId?: string;
  markInboundTurnDelivered: () => void;
};

const registry = new Map<string, ActiveTurn>();

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

export function resolveTelegramInboundTurnDeliveryCorrelationKey(
  sessionKey: string | undefined,
  inboundTurnKind?: string,
): string | undefined {
  const key = sessionKey?.trim();
  if (!key) {
    return undefined;
  }
  return inboundTurnKind === "room_event" ? `${key}:room_event` : key;
}

export function beginTelegramInboundTurnDeliveryCorrelation(
  sessionKey: string | undefined,
  turn: ActiveTurn,
  options?: { inboundTurnKind?: string },
): TelegramInboundTurnDeliveryEnd {
  const key = resolveTelegramInboundTurnDeliveryCorrelationKey(
    sessionKey,
    options?.inboundTurnKind,
  );
  if (!key) {
    return () => {};
  }
  registry.set(key, turn);
  return () => {
    if (registry.get(key) === turn) {
      registry.delete(key);
    }
  };
}

export function notifyTelegramInboundTurnOutboundSuccess(params: {
  sessionKey: string | undefined;
  to: string;
  accountId?: string | null;
  inboundTurnKind?: string;
}): void {
  const key = resolveTelegramInboundTurnDeliveryCorrelationKey(
    params.sessionKey,
    params.inboundTurnKind,
  );
  if (!key) {
    return;
  }
  const turn = registry.get(key);
  if (!turn || !telegramDeliveryTargetsMatch(turn.outboundTo, params.to)) {
    return;
  }
  if (turn.outboundAccountId && params.accountId && params.accountId !== turn.outboundAccountId) {
    return;
  }
  turn.markInboundTurnDelivered();
}
