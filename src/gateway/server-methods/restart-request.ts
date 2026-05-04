import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

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
