export const processedCardActions = new Map<
  string,
  { status: "inflight" | "completed"; expiresAt: number }
>();

export const resolvedCardActionChatTypes = new Map<
  string,
  { value: "p2p" | "group"; expiresAt: number }
>();
