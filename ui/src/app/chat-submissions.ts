import type {
  SessionMessageIdentity,
  SessionProjectionScope,
} from "@openclaw/gateway-client/browser";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
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
    shouldDisplay: (submission: RetainedChatSubmission, receipt: SessionMessageIdentity | null) => {
      // A local copy suppresses display; only a durable receipt retires ownership.
      if (receipt && (receipt.id !== null || receipt.sequence !== null)) {
        submission.pending = false;
      }
      return submission.pending && !receipt;
    },
    forSession: (
      host: { sessionKey: string; client?: object | null },
      scope: SessionProjectionScope,
      key: string,
    ) => {
      const sessionKey = scope.sessionKey ?? host.sessionKey;
      const handoff = readInitial(sessionKey, host.client ?? null);
      const entries = delivered.get(host.client ?? host);
      // The pane prepares one delivery key for the whole synchronous receipt batch.
      const retire = (runId: string) => {
        const entry = entries?.get(key + runId);
        if (
          entry?.kind === "delivered" &&
          (!entry.sessionId || !scope.sessionId || entry.sessionId === scope.sessionId)
        ) {
          entry.pending = false;
        }
      };
      return {
        initial: handoff,
        accept: (runIds: ReadonlySet<string>) => {
          runIds.forEach(retire);
          if (handoff && runIds.has(handoff.pendingRunId)) {
            handoff.pending = false;
          }
        },
        receive: (
          message: unknown,
          identity: SessionMessageIdentity | null,
          persisted = false,
          acceptedRunId?: string,
        ) => {
          const runId = acceptedRunId ?? identity?.idempotencyKey?.replace(/:user$/u, "");
          if (identity?.role !== "user" || !runId) {
            return message;
          }
          const receipt = persisted || identity.id !== null || identity.sequence !== null;
          if (receipt) {
            retire(runId);
          }
          if (!handoff || identity.isImported || runId !== handoff.pendingRunId) {
            return message;
          }
          // Cached bytes for this retained submission are not a receipt. Omit
          // that snapshot copy; the pane admits the recorded local owner through
          // sendPending, preserving provenance even with sender/reply metadata.
          if (!receipt && !acceptedRunId) {
            return undefined;
          }
          handoff.pending = false;
          const authoritative = asNullableRecord(message) ?? {};
          // Initial inline bytes replace managed media, never duplicate it. The
          // received object and its authoritative sender attribution stay intact.
          const { media: _media, ...metadata } =
            asNullableRecord(authoritative["__openclaw"]) ?? {};
          return {
            ...handoff.message,
            ...authoritative,
            content: handoff.message.content,
            __openclaw: metadata,
          };
        },
      };
    },
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
