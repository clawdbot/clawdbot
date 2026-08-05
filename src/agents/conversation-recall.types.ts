export type ConversationRecallContext = {
  /** Private conversation that requested this bounded recall pass. */
  anchorSessionKey: string;
  /** Only same-agent private transcript hits may pass. */
  scope: "same-agent-private";
  /** Product-only recall searches sessions; advanced recall keeps configured corpora. */
  corpus: "sessions" | "configured";
};
