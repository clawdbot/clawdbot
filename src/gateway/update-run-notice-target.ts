import { parseSessionThreadInfo } from "../config/sessions/thread-info.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SessionDeliveryRoute } from "../infra/session-delivery-queue-storage.js";
import {
  type DeliveryContext,
  deliveryContextFromSession,
  hasDeliveryTargetFields,
  mergeDeliveryContext,
  sessionDeliveryOrigin,
} from "../utils/delivery-context.shared.js";
import { isInternalMessageChannel } from "../utils/message-channel.js";
import { resolveGatewayLifecycleNoticeRoute } from "./server-restart-sentinel-notice.js";
import { loadSessionEntry } from "./session-utils.js";

type NoticeSession = ReturnType<typeof loadSessionEntry>;
type NoticeTarget =
  | { kind: "route"; route: SessionDeliveryRoute }
  | { kind: "internal"; session: NoticeSession & { entry: SessionEntry } }
  | { kind: "none" };

/** Resolve the origin once; internal sessions intentionally have no external delivery context. */
export function resolveUpdateRunNoticeTarget(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  explicitDeliveryContext?: DeliveryContext;
  threadId?: string;
  session?: NoticeSession;
}): NoticeTarget {
  const session =
    params.session ?? (params.sessionKey ? loadSessionEntry(params.sessionKey) : undefined);
  const routingKey = params.sessionKey ?? session?.canonicalKey;
  const { baseSessionKey, threadId } = parseSessionThreadInfo(routingKey);
  let context = deliveryContextFromSession(session?.entry);
  let chatType = sessionDeliveryOrigin(session?.entry)?.chatType ?? "direct";
  if (!hasDeliveryTargetFields(context) && baseSessionKey && baseSessionKey !== routingKey) {
    const { entry } = loadSessionEntry(baseSessionKey);
    chatType =
      sessionDeliveryOrigin(session?.entry)?.chatType ??
      sessionDeliveryOrigin(entry)?.chatType ??
      "direct";
    context = mergeDeliveryContext(context, deliveryContextFromSession(entry));
  }
  const origin = mergeDeliveryContext(params.explicitDeliveryContext, context);
  if (
    isInternalMessageChannel(origin?.channel) ||
    (!origin?.channel && session?.entry?.delivery?.kind !== "external")
  ) {
    return session?.entry
      ? { kind: "internal", session: { ...session, entry: session.entry } }
      : { kind: "none" };
  }
  const route = resolveGatewayLifecycleNoticeRoute({
    cfg: params.cfg,
    deliveryContext: origin,
    // Ambient recovery keeps the persisted system route thread; origin keys can supply hints.
    threadId: params.threadId ?? (params.sessionKey ? threadId : undefined),
  });
  return route ? { kind: "route", route: { ...route, chatType } } : { kind: "none" };
}
