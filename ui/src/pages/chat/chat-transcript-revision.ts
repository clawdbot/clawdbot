import type { ChatTranscriptRevision } from "../../lib/chat/chat-types.ts";

// Keep rendered-revision reads independent of history and transport owners;
// lifecycle code needs the snapshot without creating an owner import cycle.
function resolveDisplayedLeafEntryId(state: {
  chatDisplayedLeafEntryId?: string | null;
}): string | null | undefined {
  if (state.chatDisplayedLeafEntryId === null) {
    return null;
  }
  const leafEntryId = state.chatDisplayedLeafEntryId?.trim();
  return leafEntryId || undefined;
}

export function resolveDisplayedTranscriptRevision(state: {
  chatDisplayedLeafEntryId?: string | null;
  currentSessionId?: string | null;
}): ChatTranscriptRevision | undefined {
  const expectedLeafEntryId = resolveDisplayedLeafEntryId(state);
  if (expectedLeafEntryId === undefined) {
    return undefined;
  }
  const sessionId = state.currentSessionId?.trim() || undefined;
  return {
    expectedLeafEntryId,
    ...(sessionId ? { sessionId } : {}),
  };
}
