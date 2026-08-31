// Restart request parsing keeps restart sentinel payloads limited to resumable
// session, delivery, thread, and delay fields.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewayRestartIntent } from "../../infra/restart-intent.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";

type RestartDeliveryContext = {
  channel?: string;
  to?: string;
  accountId?: string;
};

function parseRestartDeliveryContext(params: unknown): {
  deliveryContext: RestartDeliveryContext | undefined;
  threadId: string | undefined;
} {
  const raw = (params as { deliveryContext?: unknown }).deliveryContext;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { deliveryContext: undefined, threadId: undefined };
  }
  const context = raw as {
    channel?: unknown;
    to?: unknown;
    accountId?: unknown;
    threadId?: unknown;
  };
  const deliveryContext: RestartDeliveryContext = {
    channel: normalizeOptionalString(context.channel),
    to: normalizeOptionalString(context.to),
    accountId: normalizeOptionalString(context.accountId),
  };
  const normalizedContext =
    deliveryContext.channel || deliveryContext.to || deliveryContext.accountId
      ? deliveryContext
      : undefined;
  const threadId = stringifyRouteThreadId(context.threadId);
  return { deliveryContext: normalizedContext, threadId };
}

// Restart sentinels can resume a channel turn after the gateway comes back.
// Keep only routable delivery fields plus a normalized thread id so malformed
// UI/tool payloads do not leak arbitrary data into the sentinel file.
export function parseRestartRequestParams(params: unknown): {
  sessionKey: string | undefined;
  deliveryContext: RestartDeliveryContext | undefined;
  threadId: string | undefined;
  note: string | undefined;
  continuationMessage: string | undefined;
  restartDelayMs: number | undefined;
} {
  const sessionKey = normalizeOptionalString((params as { sessionKey?: unknown }).sessionKey);
  const { deliveryContext, threadId } = parseRestartDeliveryContext(params);
  const note = normalizeOptionalString((params as { note?: unknown }).note);
  const continuationMessage = normalizeOptionalString(
    (params as { continuationMessage?: unknown }).continuationMessage,
  );
  const restartDelayMsRaw = (params as { restartDelayMs?: unknown }).restartDelayMs;
  const restartDelayMs =
    typeof restartDelayMsRaw === "number" && Number.isFinite(restartDelayMsRaw)
      ? Math.max(0, Math.floor(restartDelayMsRaw))
      : undefined;
  return { sessionKey, deliveryContext, threadId, note, continuationMessage, restartDelayMs };
}

type TargetedGatewayRestart = {
  pid: number;
  ownerId: string;
  port: number;
};

export function parseTargetedGatewayRestart(
  value: unknown,
): TargetedGatewayRestart | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const target = value as { pid?: unknown; ownerId?: unknown; port?: unknown };
  if (
    typeof target.pid !== "number" ||
    !Number.isSafeInteger(target.pid) ||
    target.pid <= 0 ||
    typeof target.ownerId !== "string" ||
    !target.ownerId.trim() ||
    typeof target.port !== "number" ||
    !Number.isInteger(target.port) ||
    target.port <= 0 ||
    target.port > 65_535
  ) {
    return null;
  }
  return {
    pid: target.pid,
    ownerId: target.ownerId.trim(),
    port: target.port,
  };
}

export function parseTargetedGatewayRestartIntent(
  value: unknown,
  reason: string | undefined,
): GatewayRestartIntent | null {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
    return null;
  }
  const raw = (value ?? {}) as { force?: unknown; waitMs?: unknown };
  const force = raw.force === true;
  const waitMs =
    typeof raw.waitMs === "number" &&
    Number.isSafeInteger(raw.waitMs) &&
    raw.waitMs >= 0 &&
    raw.waitMs <= MAX_TIMER_TIMEOUT_MS
      ? raw.waitMs
      : undefined;
  if (
    (raw.force !== undefined && typeof raw.force !== "boolean") ||
    (raw.waitMs !== undefined && waitMs === undefined) ||
    (force && waitMs !== undefined)
  ) {
    return null;
  }
  return {
    ...(reason ? { reason } : {}),
    ...(force ? { force: true } : {}),
    ...(waitMs !== undefined ? { waitMs } : {}),
  };
}

/**
 * Only the predecessor-bound restart may cross a prepared suspension lease.
 * The live lock target is sufficient: restart drain becomes the stronger owner
 * and explicitly retires the reversible suspension token after delivery.
 */
export function isTargetedNonSafeGatewayRestartRequest(params: unknown): boolean {
  if (!isRecord(params) || (params.safe !== undefined && params.safe !== false)) {
    return false;
  }
  const target = parseTargetedGatewayRestart(params.target);
  return (
    target !== undefined &&
    target !== null &&
    parseTargetedGatewayRestartIntent(params.restartIntent, undefined) !== null
  );
}
