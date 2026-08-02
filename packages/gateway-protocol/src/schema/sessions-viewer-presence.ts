import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { ChatSendSessionKeyString } from "./primitives.js";

/** Maximum sessions one connection may declare as concurrently visible. */
export const SESSION_VIEWER_PRESENCE_MAX_KEYS = 32;

/** Replaces the sessions this connection is currently rendering. */
export const SessionsViewerPresenceSetParamsSchema = closedObject({
  sessionKeys: Type.Array(ChatSendSessionKeyString, {
    maxItems: SESSION_VIEWER_PRESENCE_MAX_KEYS,
  }),
});

/** Canonical session keys retained for this connection's viewer presence. */
export const SessionsViewerPresenceSetResultSchema = closedObject({
  sessionKeys: Type.Array(ChatSendSessionKeyString, {
    maxItems: SESSION_VIEWER_PRESENCE_MAX_KEYS,
  }),
});

export type SessionsViewerPresenceSetParams = Static<typeof SessionsViewerPresenceSetParamsSchema>;
export type SessionsViewerPresenceSetResult = Static<typeof SessionsViewerPresenceSetResultSchema>;
