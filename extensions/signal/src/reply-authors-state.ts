// Signal plugin module owns native-reply quote author state.
type SignalReplyContextRecordBase = {
  accountId: string;
  conversationKey: string;
  replyToId: string;
  sourceTimestamp: number;
  registeredAt: number;
};

export type SignalReplyContextRecord = SignalReplyContextRecordBase &
  ({ kind: "resolved"; author: string; body?: string } | { kind: "ambiguous" });

export const signalReplyAuthorState = {
  memoryReplyContexts: new Map<
    string,
    SignalReplyContextRecord & {
      expiresAt: number;
    }
  >(),
  persistentStoreDisabled: false,
};
