import { readSessionTranscriptActivePathEntryRelation } from "../../config/sessions/session-accessor.js";
import type { loadSessionEntry } from "../session-utils.js";
import { ACTIVE_LEAF_CHANGED_ERROR_REASON } from "./chat-send-pre-admission.js";

export function assertExpectedLeafActive(
  session: Pick<ReturnType<typeof loadSessionEntry>, "canonicalKey" | "entry" | "storePath">,
  agentId: string,
  expectedLeafEntryId: string | null,
  requestedSessionId: string | undefined,
) {
  const activePathRelation = session.entry?.sessionId
    ? readSessionTranscriptActivePathEntryRelation(
        {
          agentId,
          sessionId: session.entry.sessionId,
          sessionKey: session.canonicalKey,
          sessionEntry: session.entry,
          storePath: session.storePath,
        },
        expectedLeafEntryId,
      )
    : expectedLeafEntryId === null
      ? "exact"
      : "off-path";
  // Branch switches preserve entry ids while rotating session ids. A supplied session id
  // fences exact and ancestor matches; omission remains legacy exact-only compatibility.
  const matchesRequestedSession =
    requestedSessionId === undefined || requestedSessionId === session.entry?.sessionId;
  const matchesActivePath =
    activePathRelation === "exact" ||
    (activePathRelation === "ancestor" && requestedSessionId !== undefined);
  if (!matchesRequestedSession || !matchesActivePath) {
    throw new Error(ACTIVE_LEAF_CHANGED_ERROR_REASON);
  }
}
