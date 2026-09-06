import { createHash } from "node:crypto";
import type { ConversationRecord } from "./conversation-registry.js";
import {
  parseConversationRouteContext,
  type ConversationRouteContext,
} from "./conversation-route-context.js";

type ConversationRouteFingerprintInput = Pick<
  ConversationRecord,
  | "accountId"
  | "channel"
  | "kind"
  | "nativeDirectUserId"
  | "parentConversationRef"
  | "peerId"
  | "target"
  | "threadId"
> & {
  nativeChannelId?: string;
  routeContext?: ConversationRouteContext;
  routeContextObserved?: true;
};

/** Binds queued authority to the exact route facts admitted by the Gateway. */
export function resolveConversationRouteFingerprint(
  route: ConversationRouteFingerprintInput,
): string {
  const context = route.routeContext
    ? parseConversationRouteContext(route.routeContext)
    : undefined;
  return createHash("sha256")
    .update(
      JSON.stringify([
        route.channel,
        route.accountId,
        route.kind,
        route.peerId,
        route.target,
        route.parentConversationRef ?? null,
        route.threadId ?? null,
        route.nativeChannelId ?? null,
        route.nativeDirectUserId ?? null,
        route.routeContextObserved === true,
        context ?? null,
      ]),
    )
    .digest("hex");
}
