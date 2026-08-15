// Signal plugin module owns native-reply quote author state.
import type { MediaPlaceholderTextFact } from "openclaw/plugin-sdk/channel-inbound";
type SignalReplyContextRecordBase = {
  accountId: string;
  conversationKey: string;
  replyToId: string;
  sourceTimestamp: number;
  registeredAt: number;
};

export type SignalReplyContextRecord = SignalReplyContextRecordBase &
  (
    | { kind: "resolved"; author: string; body?: string; media?: MediaPlaceholderTextFact[] }
    | { kind: "ambiguous" }
  );

export const signalReplyAuthorState = {
  memoryReplyContexts: new Map<
    string,
    SignalReplyContextRecord & {
      expiresAt: number;
    }
  >(),
  persistentStoreDisabled: false,
};
