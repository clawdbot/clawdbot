export const SESSION_HISTORY_SESSION_ID_PARAM = "__openclawHistorySessionId";
export const SESSION_HISTORY_MESSAGE_ID_PARAM = "__openclawHistoryMessageId";

export type SessionHistoryAnchor = {
  sessionId: string;
  messageId: string;
};

export function withSessionHistoryAnchor<T extends { search?: string }>(
  options: T,
  anchor: SessionHistoryAnchor,
): T & { search: string } {
  const params = new URLSearchParams(options.search ?? "");
  params.set(SESSION_HISTORY_SESSION_ID_PARAM, anchor.sessionId);
  params.set(SESSION_HISTORY_MESSAGE_ID_PARAM, anchor.messageId);
  return { ...options, search: `?${params.toString()}` };
}
