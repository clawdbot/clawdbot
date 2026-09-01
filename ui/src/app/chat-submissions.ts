import { areUiSessionKeysEquivalent } from "../lib/sessions/session-key.ts";
import type { buildLocalUserMessage } from "../pages/chat/user-message-content.ts";

type RetainedMessage = NonNullable<ReturnType<typeof buildLocalUserMessage>>;

type Submission = {
  message: RetainedMessage;
  pendingRunId: string;
  sessionKey: string;
  /** Logical client, not the hello object that rotates on reconnect. */
  owner: object;
} & (
  | { kind: "initial" }
  | { kind: "delivered"; deliveryKey: string; agentId?: string; sessionId?: string }
);
export type RetainedChatSubmission = Submission & { pending: boolean };

export type ApplicationChatSubmissions = ReturnType<typeof createChatSubmissions>;
/** App-owned display bytes only. Outbox payloads, attempts, and retries stay with the outbox. */
export function createChatSubmissions() {
  const initial = new Map<string, RetainedChatSubmission>();
  let delivered = new WeakMap<object, Map<string, RetainedChatSubmission>>();
  const initialKey = (sessionKey: string) =>
    [...initial.keys()].find((key) => areUiSessionKeysEquivalent(key, sessionKey));
  const readInitial = (sessionKey: string, owner: object | null) => {
    const entry = initial.get(initialKey(sessionKey) ?? "");
    return entry?.owner === owner ? entry : null;
  };
  const retain = (submission: Submission | null): RetainedChatSubmission | undefined => {
    if (!submission) {
      return undefined;
    }
    const entries =
      submission.kind === "initial"
        ? initial
        : (delivered.get(submission.owner) ?? new Map<string, RetainedChatSubmission>());
    const key =
      submission.kind === "initial"
        ? (initialKey(submission.sessionKey) ?? submission.sessionKey)
        : submission.deliveryKey;
    if (submission.kind === "delivered") {
      delivered.set(submission.owner, entries);
    }
    const retained = { ...submission, pending: true };
    entries.delete(key);
    entries.set(key, retained);
    // Preserve the initial app limit and delivered per-client lifetime/limit.
    const limit = submission.kind === "initial" ? 32 : 64;
    if (entries.size > limit) {
      entries.delete(entries.keys().next().value!);
    }
    return retained;
  };
  return {
    retain,
    readInitial,
    readDelivered: (key: string, owner: object) => delivered.get(owner)?.get(key),
    clearInitial: (sessionKey: string) => {
      const key = initialKey(sessionKey);
      if (key) {
        initial.delete(key);
      }
    },
    clear: () => {
      initial.clear();
      delivered = new WeakMap();
    },
  };
}
