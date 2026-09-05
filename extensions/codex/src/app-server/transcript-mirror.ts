import { createHash } from "node:crypto";
import {
  deliverAgentHarnessUserInputPrompt,
  embeddedAgentLog,
  formatErrorMessage,
  projectAgentHarnessTranscriptMessageForDisplay,
  restorePreparedUserTurnOperationalMetaForRuntime,
  runAgentHarnessBeforeMessageWriteHook,
  type AgentMessage,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { withCodexSessionTranscriptMirrorWriteLock } from "openclaw/plugin-sdk/codex-session-transcript-runtime";
import {
  publishSessionTranscriptUpdateByIdentity,
  type TranscriptEntryAnchor,
  type SessionTranscriptTargetParams,
  type SessionTranscriptWriteLockParams,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import type { CodexAsyncAssistantMessage } from "./event-projector-assistant-message.js";
import type { CodexAsyncDeliverySettlement } from "./event-projector-options.js";
import type { CodexThread } from "./protocol.js";
import {
  projectBoundedCodexThreadHistory,
  type CodexThreadHistoryImportResult,
} from "./transcript-history-projection.js";
import {
  attachCodexMirrorAttestation,
  attachCodexMirrorRunId,
  fingerprintCodexMirrorSourceMessage,
  readCodexMirrorSourceFingerprint,
} from "./transcript-mirror-attestation.js";
import {
  attachCodexMirrorIdentity,
  attachUpstreamUserText,
  readMirrorIdentity,
} from "./upstream-prompt-provenance.js";
import {
  buildResolvedCodexUserPromptMessage,
  buildCodexUserPromptMessage,
  resolveFinalCodexMirrorMessages,
} from "./user-prompt-message.js";

export { buildCodexUserPromptMessage };
export { projectBoundedCodexThreadHistory };

type MirroredAgentMessage = Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" }> &
  Partial<Pick<CodexAsyncAssistantMessage, "openclawAsyncDelivery">>;
type MirroredUserMessage = Extract<AgentMessage, { role: "user" }>;
type MirroredUserMessageReceipt = {
  anchor: TranscriptEntryAnchor;
  appended: boolean;
  message: MirroredUserMessage;
};
type UserMessagePersistenceNotifier = (receipt: MirroredUserMessageReceipt) => void;
type CodexAppServerTranscriptMirrorResult = {
  assistantMirrorIdentitiesAppended: string[];
  assistantMirrorIdentitiesOwned: string[];
  anchorsByMirrorIdentity: Map<string, TranscriptEntryAnchor>;
  messagesPresent: MirroredAgentMessage[];
  userMessageReceipts: MirroredUserMessageReceipt[];
};

function isMirroredAgentMessage(message: AgentMessage): message is MirroredAgentMessage {
  return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

function readMirroredAssistantText(message: MirroredAgentMessage | undefined): string | undefined {
  if (message?.role !== "assistant") {
    return undefined;
  }
  const text = message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
  return text || undefined;
}

/** Imports a bounded, user-visible Codex history tail into a new OpenClaw transcript. */
export async function importCodexThreadHistoryToTranscript(params: {
  assertCurrent?: () => void;
  thread: CodexThread;
  throughTurnId: string | null;
  storePath: string;
  sessionId: string;
  sessionKey: string;
  agentId?: string;
  cwd?: string;
  modelProvider?: string | null;
  config?: SessionTranscriptWriteLockParams["config"];
}): Promise<CodexThreadHistoryImportResult> {
  const { transcriptMessages, importedMessages, omittedMessages } =
    projectBoundedCodexThreadHistory({
      thread: params.thread,
      throughTurnId: params.throughTurnId,
      importedAt: Date.now(),
      ...(params.modelProvider ? { modelProvider: params.modelProvider } : {}),
    });
  if (transcriptMessages.length > 0) {
    await mirror({
      assertCurrent: params.assertCurrent,
      storePath: params.storePath,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(params.config ? { config: params.config } : {}),
      messages: transcriptMessages,
      idempotencyScope: `codex-app-server:${params.thread.id}:history`,
    });
  }
  return { importedMessages, omittedMessages };
}

async function mirrorBestEffort(params: {
  assertWriteCurrent?: () => void;
  params: EmbeddedRunAttemptParams;
  agentId?: string;
  notifyUserMessagePersisted: UserMessagePersistenceNotifier;
  result: EmbeddedRunAttemptResult;
  sessionKey?: string;
  cwd: string;
  threadId: string;
  turnId: string;
}): Promise<{
  assistantTranscriptOwned: boolean;
  assistantTranscriptIdempotencyKey?: string;
  terminalAnchor?: TranscriptEntryAnchor;
  mirroredMessages: MirroredAgentMessage[];
}> {
  if (!params.params.sessionTarget) {
    return { assistantTranscriptOwned: false, mirroredMessages: [] };
  }
  try {
    const messages = await resolveFinalCodexMirrorMessages({
      params: params.params,
      messagesSnapshot: params.result.messagesSnapshot,
      turnId: params.turnId,
    });
    params.assertWriteCurrent?.();
    const mirrorResult = await mirror({
      assertWriteCurrent: params.assertWriteCurrent,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionId: params.params.sessionId,
      storePath: params.params.sessionTarget?.storePath,
      cwd: params.cwd,
      messages,
      // Scope is thread-stable. Each entry in `messagesSnapshot` is tagged
      // with a per-turn `attachCodexMirrorIdentity` value carrying its own
      // turnId, so distinct turns produce distinct dedupe keys via the
      // identity (not via the scope). Dropping `turnId` from the scope here is
      // what lets a re-emitted prior-turn entry collide with its existing key.
      idempotencyScope: `codex-app-server:${params.threadId}`,
      runId: params.params.runId,
      runMirrorIdentityPrefix: `${params.turnId}:`,
      terminalAssistantOwner: {
        mirrorIdentity: `${params.turnId}:assistant`,
        runId: params.params.runId,
      },
      prepareAssistantTranscriptMessage: params.params.prepareAssistantTranscriptMessage,
      config: params.params.config,
    });
    for (const receipt of mirrorResult.userMessageReceipts) {
      try {
        params.notifyUserMessagePersisted(receipt);
      } catch (error) {
        embeddedAgentLog.warn("failed to notify codex app-server user-message persistence", {
          error: formatErrorMessage(error),
        });
      }
    }
    const expectedFingerprints = new Map(
      messages.flatMap((message) => {
        if (!isMirroredAgentMessage(message)) {
          return [];
        }
        const identity = readMirrorIdentity(message);
        return identity ? [[identity, fingerprintCodexMirrorSourceMessage(message)] as const] : [];
      }),
    );
    const mirroredMessages = mirrorResult.messagesPresent.filter((message) => {
      const identity = readMirrorIdentity(message);
      return (
        identity !== undefined &&
        readCodexMirrorSourceFingerprint(message) === expectedFingerprints.get(identity)
      );
    });
    const assistantMirrorIdentity = `${params.turnId}:assistant`;
    const assistantTranscriptMessage = mirroredMessages.find(
      (message) => readMirrorIdentity(message) === assistantMirrorIdentity,
    );
    const assistantTranscriptOwned = Boolean(
      assistantTranscriptMessage &&
      mirrorResult.assistantMirrorIdentitiesOwned.includes(assistantMirrorIdentity),
    );
    const assistantTranscriptIdempotencyKey = normalizeOptionalString(
      (assistantTranscriptMessage as { idempotencyKey?: unknown } | undefined)?.idempotencyKey,
    );
    const terminalMessage = mirroredMessages.at(-1);
    const terminalMirrorIdentity = terminalMessage
      ? readMirrorIdentity(terminalMessage)
      : undefined;
    const terminalAnchor =
      (terminalMirrorIdentity
        ? mirrorResult.anchorsByMirrorIdentity.get(terminalMirrorIdentity)
        : undefined) ?? params.params.userTurnTranscriptRecorder?.getAdmissionReceipt();
    return {
      assistantTranscriptOwned,
      ...(assistantTranscriptIdempotencyKey ? { assistantTranscriptIdempotencyKey } : {}),
      ...(terminalAnchor ? { terminalAnchor } : {}),
      mirroredMessages,
    };
  } catch (error) {
    embeddedAgentLog.warn("failed to mirror codex app-server transcript", {
      error: formatErrorMessage(error),
      runId: params.params.runId,
      sessionId: params.params.sessionId,
    });
    return { assistantTranscriptOwned: false, mirroredMessages: [] };
  }
}

export function createCodexAppServerUserMessagePersistenceNotifier(
  runParams: EmbeddedRunAttemptParams,
): UserMessagePersistenceNotifier {
  let notified = false;
  return (receipt) => {
    if (notified) {
      return;
    }
    notified = true;
    runParams.userTurnTranscriptRecorder?.markRuntimePersisted(
      receipt.message,
      receipt.anchor,
      receipt,
    );
    try {
      runParams.onUserMessagePersisted?.(receipt.message);
    } catch (error) {
      embeddedAgentLog.warn("codex app-server user persistence notification failed", {
        error: formatErrorMessage(error),
      });
    }
  };
}

export async function mirrorPromptAtTurnStartBestEffort(params: {
  params: EmbeddedRunAttemptParams;
  agentId?: string;
  notifyUserMessagePersisted: UserMessagePersistenceNotifier;
  sessionKey?: string;
  cwd: string;
  threadId: string;
  turnId: string;
  upstreamUserText: string;
}): Promise<void> {
  if (params.params.suppressNextUserMessagePersistence || !params.params.sessionTarget) {
    return;
  }
  try {
    const mirrorPromise = (async () => {
      const userPromptMessage = projectAgentHarnessTranscriptMessageForDisplay({
        hidden: params.params.trigger === "memory",
        message: attachUpstreamUserText(
          attachCodexMirrorIdentity(
            await buildResolvedCodexUserPromptMessage(params.params),
            `${params.turnId}:prompt`,
          ),
          params.upstreamUserText,
        ),
      });
      const recorder = params.params.userTurnTranscriptRecorder;
      // Hidden admissions intentionally have no annotation authority. Use the host's
      // persisted row, since hooks can change visibility after prompt preparation.
      if (recorder?.getAdmissionReceipt() && recorder.getPersistedMessage?.()?.display !== false) {
        const annotate = params.params.hostCapabilities.annotateCurrentUserTurn;
        if (!annotate || userPromptMessage.role !== "user") {
          throw new Error("current host admission is unavailable for native prompt annotation");
        }
        // Native turn acceptance supplies the identity. Annotate before taking the mirror lock:
        // the anchored writer owns that same queue and must never be nested under it.
        await annotate({
          mirrorIdentity: `${params.turnId}:prompt`,
          upstreamUserText: params.upstreamUserText,
          mirrorOrigin: "codex-app-server",
          mirrorSourceFingerprint: fingerprintCodexMirrorSourceMessage(userPromptMessage),
        });
      }
      const mirrorResult = await mirror({
        assertCurrent: params.params.hostCapabilities.assertActive,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        sessionId: params.params.sessionId,
        storePath: params.params.sessionTarget?.storePath,
        cwd: params.cwd,
        messages: [userPromptMessage],
        idempotencyScope: `codex-app-server:${params.threadId}`,
        runId: params.params.runId,
        runMirrorIdentityPrefix: `${params.turnId}:`,
        config: params.params.config,
      });
      for (const receipt of mirrorResult.userMessageReceipts) {
        params.notifyUserMessagePersisted(receipt);
      }
    })();
    params.params.userTurnTranscriptRecorder?.markRuntimePersistencePending(mirrorPromise);
    await mirrorPromise;
  } catch (error) {
    embeddedAgentLog.warn("failed to mirror codex app-server prompt at turn start", {
      error: formatErrorMessage(error),
      runId: params.params.runId,
      sessionId: params.params.sessionId,
    });
  }
}

// Fallback content fingerprint for callers that did not tag the message
// with a stable mirror identity. Only role and content participate; volatile
// metadata (timestamps, usage, etc.) is intentionally excluded so the
// fingerprint survives snapshot reordering inside a fixed scope. Distinct
// same-content turns are still distinguished by the caller's idempotency
// scope when callers route through this fallback.
function fingerprintMirrorMessageContent(message: MirroredAgentMessage): string {
  const payload = JSON.stringify({ role: message.role, content: message.content });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function buildMirrorDedupeIdentity(message: MirroredAgentMessage): string {
  return (
    readMirrorIdentity(message) || `${message.role}:${fingerprintMirrorMessageContent(message)}`
  );
}

async function mirror(params: {
  assertCurrent?: () => void;
  assertWriteCurrent?: () => void;
  sessionId: string;
  cwd?: string;
  sessionKey?: string;
  agentId?: string;
  storePath?: string;
  messages: AgentMessage[];
  idempotencyScope?: string;
  runId?: string;
  runMirrorIdentityPrefix?: string;
  terminalAssistantOwner?: { mirrorIdentity: string; runId: string };
  prepareAssistantTranscriptMessage?: EmbeddedRunAttemptParams["prepareAssistantTranscriptMessage"];
  config?: SessionTranscriptWriteLockParams["config"];
  skipBeforeMessageWriteHooks?: boolean;
}): Promise<CodexAppServerTranscriptMirrorResult> {
  const messages = params.messages.filter(isMirroredAgentMessage);
  if (messages.length === 0) {
    return {
      assistantMirrorIdentitiesAppended: [],
      assistantMirrorIdentitiesOwned: [],
      anchorsByMirrorIdentity: new Map(),
      messagesPresent: [],
      userMessageReceipts: [],
    };
  }

  const candidates = messages.map((message) => {
    const dedupeIdentity = buildMirrorDedupeIdentity(message);
    const sourceFingerprint = fingerprintCodexMirrorSourceMessage(message);
    const sourceUserIdempotencyKey =
      message.role === "user"
        ? normalizeOptionalString("idempotencyKey" in message ? message.idempotencyKey : undefined)
        : undefined;
    // Gateway-owned user keys keep optimistic client rows stable. Other rows use
    // the provider mirror identity so retries find the exact logical message.
    const idempotencyKey =
      sourceUserIdempotencyKey ??
      (params.idempotencyScope ? `${params.idempotencyScope}:${dedupeIdentity}` : undefined);
    return { dedupeIdentity, idempotencyKey, message, sourceFingerprint };
  });
  const candidateIdempotencyKeys = candidates.flatMap(({ idempotencyKey }) =>
    idempotencyKey ? [idempotencyKey] : [],
  );
  const transcriptTarget = resolveCodexMirrorTranscriptTarget(params);
  // A queued terminal must still match its prepared outcome before committing.
  // Publication may trigger Stop afterward; that cannot erase a committed receipt.
  const assertWritable = () => {
    params.assertCurrent?.();
    params.assertWriteCurrent?.();
  };
  assertWritable();
  const mirrorBatch = await withCodexSessionTranscriptMirrorWriteLock(
    { ...transcriptTarget, config: params.config },
    async (transcript) => {
      assertWritable();
      const nextAppendedUpdates: Array<{
        messageId: string;
        message: AgentMessage;
        messageSeq?: number;
      }> = [];
      const nextAssistantMirrorIdentitiesAppended = new Set<string>();
      const nextAssistantMirrorIdentitiesOwned = new Set<string>();
      const nextAnchorsByMirrorIdentity = new Map<string, TranscriptEntryAnchor>();
      const nextMessagesPresent: MirroredAgentMessage[] = [];
      const nextUserMessageReceipts: MirroredUserMessageReceipt[] = [];
      const mirrorFacts = await transcript.readMessageFacts({
        idempotencyKeys: candidateIdempotencyKeys,
      });
      assertWritable();
      for (const { dedupeIdentity, idempotencyKey, message, sourceFingerprint } of candidates) {
        const mirrorIdentity = readMirrorIdentity(message);
        const ownsRun = Boolean(
          params.runId &&
          (!params.runMirrorIdentityPrefix ||
            mirrorIdentity?.startsWith(params.runMirrorIdentityPrefix)),
        );
        const terminalOwner = params.terminalAssistantOwner;
        const ownsTerminal = Boolean(
          ownsRun && terminalOwner && mirrorIdentity === terminalOwner.mirrorIdentity,
        );
        const ownedMessage =
          ownsRun && params.runId
            ? attachCodexMirrorRunId(message, params.runId, ownsTerminal)
            : message;
        const transcriptMessage = {
          ...attachCodexMirrorAttestation(ownedMessage, sourceFingerprint),
          ...(idempotencyKey ? { idempotencyKey } : {}),
        } as AgentMessage;
        if (idempotencyKey && mirrorFacts.existingIdempotencyKeys.has(idempotencyKey)) {
          const persistedMessage = mirrorFacts.messagesByIdempotencyKey.get(idempotencyKey);
          const persistedAnchor = mirrorFacts.anchorsByIdempotencyKey.get(idempotencyKey);
          if (persistedMessage && isMirroredAgentMessage(persistedMessage)) {
            nextMessagesPresent.push(persistedMessage);
            if (persistedMessage.role === "user" && persistedAnchor) {
              nextUserMessageReceipts.push({
                anchor: persistedAnchor,
                appended: false,
                message: persistedMessage,
              });
            }
          }
          if (persistedAnchor) {
            nextAnchorsByMirrorIdentity.set(dedupeIdentity, persistedAnchor);
          }
          if (message.role === "assistant") {
            nextAssistantMirrorIdentitiesOwned.add(dedupeIdentity);
          }
          continue;
        }
        assertWritable();
        const preparedUserMessage =
          transcriptMessage.role === "user"
            ? {
                ...transcriptMessage,
                __openclaw: { ...Reflect.get(transcriptMessage, "__openclaw") },
              }
            : undefined;
        if (preparedUserMessage?.["__openclaw"].humanMentions !== undefined) {
          // Hooks cannot move a selection by mutating the original text or spans in place.
          preparedUserMessage.content = structuredClone(preparedUserMessage.content);
          preparedUserMessage["__openclaw"].humanMentions = structuredClone(
            preparedUserMessage["__openclaw"].humanMentions,
          );
        }
        const nextMessage = runAgentHarnessBeforeMessageWriteHook({
          message: transcriptMessage,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          skipBeforeMessageWriteHooks: params.skipBeforeMessageWriteHooks,
          // Only this turn's terminal row belongs to the outer attachment dispatcher.
          prepareAssistantTranscriptMessage: ownsTerminal
            ? params.prepareAssistantTranscriptMessage
            : undefined,
        });
        if (!nextMessage) {
          if (message.role === "assistant") {
            // A transcript hook deliberately blocked this logical assistant row.
            // Treat that as an authoritative persistence decision so delivery
            // does not bypass the hook with a fallback mirror.
            nextAssistantMirrorIdentitiesOwned.add(dedupeIdentity);
          }
          continue;
        }
        const restoredMessage = restorePreparedUserTurnOperationalMetaForRuntime({
          runtimeMessage: nextMessage,
          preparedMessage: preparedUserMessage,
        });
        let messageToAppend = (
          idempotencyKey
            ? {
                ...attachCodexMirrorAttestation(restoredMessage, sourceFingerprint),
                idempotencyKey,
              }
            : attachCodexMirrorAttestation(restoredMessage, sourceFingerprint)
        ) as AgentMessage;
        if (mirrorIdentity) {
          // Hooks may replace the whole message. Restore the provider-owned
          // identity so retries cannot turn a stale idempotency hit into evidence.
          messageToAppend = attachCodexMirrorIdentity(messageToAppend, mirrorIdentity);
        }
        if (ownsRun && params.runId) {
          messageToAppend = attachCodexMirrorRunId(messageToAppend, params.runId, ownsTerminal);
        }
        if (message.role === "assistant" && message.openclawAsyncDelivery) {
          // Async delivery ownership is provider-authored. Whole-message hooks may
          // rewrite content, but must not turn the durable row into a terminal answer.
          messageToAppend = Object.assign(messageToAppend, {
            openclawAsyncDelivery: { itemId: message.openclawAsyncDelivery.itemId },
          });
        }
        messageToAppend = projectAgentHarnessTranscriptMessageForDisplay({
          hidden: (message as { display?: boolean }).display === false,
          message: messageToAppend,
        });
        assertWritable();
        const { messageSeq, result: appended } = await transcript.appendMessageWithMessageSequence({
          message: messageToAppend,
          ...(params.assertCurrent || params.assertWriteCurrent
            ? {
                prepareMessageAfterIdempotencyCheck: (preparedMessage: typeof messageToAppend) => {
                  assertWritable();
                  return preparedMessage;
                },
              }
            : {}),
          // Preliminary facts avoid hooks and payload work on normal retries.
          // SQLite repeats this lookup under BEGIN IMMEDIATE for cross-process safety.
          idempotencyLookup: "scan",
          cwd: params.cwd,
        });
        params.assertCurrent?.();
        if (!appended) {
          continue;
        }
        const { messageId, message: appendedMessage } = appended;
        if (isMirroredAgentMessage(appendedMessage)) {
          nextMessagesPresent.push(appendedMessage);
          if (idempotencyKey) {
            mirrorFacts.messagesByIdempotencyKey.set(idempotencyKey, appendedMessage);
          }
        }
        if (message.role === "assistant") {
          nextAssistantMirrorIdentitiesOwned.add(dedupeIdentity);
        }
        if (appended.anchor) {
          nextAnchorsByMirrorIdentity.set(dedupeIdentity, appended.anchor);
        }
        if (appendedMessage.role === "user" && appended.anchor) {
          nextUserMessageReceipts.push({
            anchor: appended.anchor,
            appended: appended.appended,
            message: appendedMessage,
          });
        }
        if (appended.appended) {
          if (message.role === "assistant") {
            nextAssistantMirrorIdentitiesAppended.add(dedupeIdentity);
          }
          nextAppendedUpdates.push({
            messageId,
            message: appendedMessage,
            ...(messageSeq !== undefined ? { messageSeq } : {}),
          });
        }
        if (idempotencyKey) {
          mirrorFacts.existingIdempotencyKeys.add(idempotencyKey);
          if (appended.anchor) {
            mirrorFacts.anchorsByIdempotencyKey.set(idempotencyKey, appended.anchor);
          }
        }
      }
      return {
        appendedUpdates: nextAppendedUpdates,
        assistantMirrorIdentitiesAppended: [...nextAssistantMirrorIdentitiesAppended],
        assistantMirrorIdentitiesOwned: [...nextAssistantMirrorIdentitiesOwned],
        anchorsByMirrorIdentity: nextAnchorsByMirrorIdentity,
        messagesPresent: nextMessagesPresent,
        userMessageReceipts: nextUserMessageReceipts,
      };
    },
  );
  params.assertCurrent?.();
  const {
    appendedUpdates,
    assistantMirrorIdentitiesAppended,
    assistantMirrorIdentitiesOwned,
    anchorsByMirrorIdentity,
    messagesPresent,
    userMessageReceipts,
  } = mirrorBatch;

  for (const update of appendedUpdates) {
    try {
      // Commentary and tool rows share the Codex turn but cannot claim terminal run ownership.
      const terminalOwner = params.terminalAssistantOwner;
      const terminalRunId =
        update.message.role === "assistant" &&
        terminalOwner &&
        readMirrorIdentity(update.message) === terminalOwner.mirrorIdentity
          ? terminalOwner.runId
          : undefined;
      await publishSessionTranscriptUpdateByIdentity({
        ...transcriptTarget,
        update: {
          ...(params.agentId ? { agentId: params.agentId } : {}),
          message: update.message,
          messageId: update.messageId,
          ...(update.messageSeq !== undefined ? { messageSeq: update.messageSeq } : {}),
          ...(terminalRunId ? { runId: terminalRunId } : {}),
          sessionKey: transcriptTarget.sessionKey,
        },
      });
    } catch (error) {
      // The transcript append is already committed. A transient live-update
      // failure must not make dispatch append a second assistant message.
      embeddedAgentLog.warn("failed to publish codex app-server transcript update", {
        error: formatErrorMessage(error),
      });
    }
  }

  return {
    assistantMirrorIdentitiesAppended,
    assistantMirrorIdentitiesOwned,
    anchorsByMirrorIdentity,
    messagesPresent,
    userMessageReceipts,
  };
}

async function deliverAsyncMessageBestEffort(params: {
  cwd: string;
  params: EmbeddedRunAttemptParams;
  itemId: string;
  message: AgentMessage;
  text: string;
  threadId: string;
  turnId: string;
}): Promise<CodexAsyncDeliverySettlement> {
  const mirrorIdentity = `${params.turnId}:async:${params.itemId}`;
  const deliveryIntentId = `block-reply:v1:codex-app-server:${[
    params.threadId,
    params.turnId,
    params.itemId,
  ]
    .map(encodeURIComponent)
    .join(":")}`;
  const target = params.params.sessionTarget;
  if (!target) {
    if (!params.params.onBlockReply) {
      return "retry";
    }
    try {
      await deliverAsyncBlockReply(params.params.onBlockReply, params.text, deliveryIntentId);
      return "settled";
    } catch (error) {
      embeddedAgentLog.warn("failed to deliver codex async agent message", {
        error: formatErrorMessage(error),
        itemId: params.itemId,
        runId: params.params.runId,
        threadId: params.threadId,
        turnId: params.turnId,
      });
      return "retry";
    }
  }

  let result: CodexAppServerTranscriptMirrorResult;
  try {
    result = await mirror({
      agentId: target.agentId ?? params.params.agentId,
      sessionId: target.sessionId ?? params.params.sessionId,
      sessionKey: target.sessionKey ?? params.params.sessionKey,
      storePath: target.storePath,
      cwd: params.cwd,
      config: params.params.config,
      messages: [attachCodexMirrorIdentity(params.message, mirrorIdentity)],
      idempotencyScope: `codex-app-server:${params.threadId}`,
    });
  } catch (error) {
    embeddedAgentLog.warn("failed to persist codex async agent message", {
      error: formatErrorMessage(error),
      itemId: params.itemId,
      runId: params.params.runId,
      threadId: params.threadId,
      turnId: params.turnId,
    });
    return "retry";
  }

  if (!result.assistantMirrorIdentitiesOwned.includes(mirrorIdentity)) {
    return "retry";
  }
  const persistedText = readMirroredAssistantText(
    result.messagesPresent.find((message) => readMirrorIdentity(message) === mirrorIdentity),
  );
  if (params.params.onBlockReply && persistedText !== undefined) {
    try {
      await deliverAsyncBlockReply(params.params.onBlockReply, persistedText, deliveryIntentId);
    } catch (error) {
      embeddedAgentLog.warn("failed to deliver persisted codex async agent message", {
        error: formatErrorMessage(error),
        itemId: params.itemId,
        runId: params.params.runId,
        threadId: params.threadId,
        turnId: params.turnId,
      });
      return "retry";
    }
  }
  return "settled";
}

export const codexTranscriptMirrorRuntime = {
  deliverAsyncMessageBestEffort,
  mirror,
  mirrorBestEffort,
};

async function deliverAsyncBlockReply(
  onBlockReply: NonNullable<EmbeddedRunAttemptParams["onBlockReply"]>,
  text: string,
  deliveryIntentId: string,
): Promise<void> {
  // Harness-owned prompts already carry the host's canonical source-delivery
  // authorization; an empty question list keeps the upstream message exact.
  await deliverAgentHarnessUserInputPrompt(
    { onBlockReply: (payload) => onBlockReply(payload, { deliveryIntentId }) },
    [],
    { intro: text },
  );
}

function resolveCodexMirrorTranscriptTarget(params: {
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
}): SessionTranscriptTargetParams {
  const sessionKey = params.sessionKey?.trim();
  const storePath = params.storePath?.trim();
  if (!sessionKey || !storePath) {
    throw new Error("Codex transcript mirror requires a runtime session identity");
  }
  return {
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: params.sessionId,
    sessionKey,
    storePath,
  };
}
