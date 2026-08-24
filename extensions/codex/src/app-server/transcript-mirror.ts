import { createHash } from "node:crypto";
import {
  embeddedAgentLog,
  formatErrorMessage,
  projectAgentHarnessTranscriptMessageForDisplay,
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
  readUpstreamUserText,
} from "./upstream-prompt-provenance.js";
import {
  buildResolvedCodexUserPromptMessage,
  buildCodexUserPromptMessage,
} from "./user-prompt-message.js";

export { buildCodexUserPromptMessage };
export { projectBoundedCodexThreadHistory };

type MirroredAgentMessage = Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" }>;
type MirroredUserMessage = Extract<AgentMessage, { role: "user" }>;
type MirroredUserMessageReceipt = {
  anchor: TranscriptEntryAnchor;
  message: MirroredUserMessage;
};
type CodexAppServerTranscriptMirrorResult = {
  assistantMirrorIdentitiesOwned: string[];
  anchorsByMirrorIdentity: Map<string, TranscriptEntryAnchor>;
  messagesPresent: MirroredAgentMessage[];
  userMessagesPresent: MirroredUserMessage[];
  userMessageReceipts: MirroredUserMessageReceipt[];
};

function isMirroredAgentMessage(message: AgentMessage): message is MirroredAgentMessage {
  return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

/** Imports a bounded, user-visible Codex history tail into a new OpenClaw transcript. */
export async function importCodexThreadHistoryToTranscript(params: {
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
  const projection = projectBoundedCodexThreadHistory({
    thread: params.thread,
    throughTurnId: params.throughTurnId,
    importedAt: Date.now(),
    ...(params.modelProvider ? { modelProvider: params.modelProvider } : {}),
  });
  if (projection.transcriptMessages.length > 0) {
    await mirror({
      storePath: params.storePath,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(params.config ? { config: params.config } : {}),
      messages: projection.transcriptMessages,
      idempotencyScope: `codex-app-server:${params.thread.id}:history`,
    });
  }
  return {
    importedMessages: projection.importedMessages,
    omittedMessages: projection.omittedMessages,
  };
}

async function mirrorBestEffort(params: {
  params: EmbeddedRunAttemptParams;
  agentId?: string;
  notifyUserMessagePersisted: (
    message: Extract<AgentMessage, { role: "user" }>,
    anchor: TranscriptEntryAnchor,
  ) => void;
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
    const mirrorResult = await mirror({
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
      config: params.params.config,
    });
    for (const receipt of mirrorResult.userMessageReceipts) {
      try {
        params.notifyUserMessagePersisted(receipt.message, receipt.anchor);
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

async function resolveFinalCodexMirrorMessages(params: {
  params: EmbeddedRunAttemptParams;
  messagesSnapshot: AgentMessage[];
  turnId: string;
}): Promise<AgentMessage[]> {
  if (
    params.params.suppressNextUserMessagePersistence ||
    !params.params.userTurnTranscriptRecorder
  ) {
    return params.messagesSnapshot;
  }
  const promptSnapshot = params.messagesSnapshot.find((message) => message.role === "user");
  const resolvedBase = attachCodexMirrorIdentity(
    await buildResolvedCodexUserPromptMessage(params.params),
    `${params.turnId}:prompt`,
  );
  const upstreamUserText = readUpstreamUserText(promptSnapshot);
  const resolvedPrompt = upstreamUserText
    ? attachUpstreamUserText(resolvedBase, upstreamUserText)
    : resolvedBase;
  const firstUserIndex = params.messagesSnapshot.findIndex((message) => message.role === "user");
  if (firstUserIndex === -1) {
    return [resolvedPrompt, ...params.messagesSnapshot];
  }
  const messages = params.messagesSnapshot.slice();
  messages[firstUserIndex] = resolvedPrompt;
  return messages;
}

export function createCodexAppServerUserMessagePersistenceNotifier(
  runParams: EmbeddedRunAttemptParams,
): (message: Extract<AgentMessage, { role: "user" }>, anchor: TranscriptEntryAnchor) => void {
  let notified = false;
  return (message, anchor) => {
    if (notified) {
      return;
    }
    notified = true;
    runParams.userTurnTranscriptRecorder?.markRuntimePersisted(message, anchor);
    try {
      runParams.onUserMessagePersisted?.(message);
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
  notifyUserMessagePersisted: (
    message: Extract<AgentMessage, { role: "user" }>,
    anchor: TranscriptEntryAnchor,
  ) => void;
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
      const mirrorResult = await mirror({
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
        params.notifyUserMessagePersisted(receipt.message, receipt.anchor);
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
  const explicit = readMirrorIdentity(message);
  if (explicit) {
    return explicit;
  }
  return `${message.role}:${fingerprintMirrorMessageContent(message)}`;
}

async function mirror(params: {
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
  config?: SessionTranscriptWriteLockParams["config"];
  skipBeforeMessageWriteHooks?: boolean;
}): Promise<CodexAppServerTranscriptMirrorResult> {
  const messages = params.messages.filter(isMirroredAgentMessage);
  if (messages.length === 0) {
    return {
      assistantMirrorIdentitiesOwned: [],
      anchorsByMirrorIdentity: new Map(),
      messagesPresent: [],
      userMessageReceipts: [],
      userMessagesPresent: [],
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
  const mirrorBatch = await withCodexSessionTranscriptMirrorWriteLock(
    { ...transcriptTarget, config: params.config },
    async (transcript) => {
      const nextAppendedUpdates: Array<{
        messageId: string;
        message: AgentMessage;
        messageSeq?: number;
      }> = [];
      const nextAssistantMirrorIdentitiesOwned = new Set<string>();
      const nextAnchorsByMirrorIdentity = new Map<string, TranscriptEntryAnchor>();
      const nextMessagesPresent: MirroredAgentMessage[] = [];
      const nextUserMessageReceipts: MirroredUserMessageReceipt[] = [];
      const nextUserMessagesPresent: MirroredUserMessage[] = [];
      const mirrorFacts = await transcript.readMessageFacts({
        idempotencyKeys: candidateIdempotencyKeys,
      });
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
            if (persistedMessage.role === "user") {
              nextUserMessagesPresent.push(persistedMessage);
              if (persistedAnchor) {
                nextUserMessageReceipts.push({
                  anchor: persistedAnchor,
                  message: persistedMessage,
                });
              }
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
        const nextMessage = params.skipBeforeMessageWriteHooks
          ? transcriptMessage
          : runAgentHarnessBeforeMessageWriteHook({
              message: transcriptMessage,
              agentId: params.agentId,
              sessionKey: params.sessionKey,
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
        let messageToAppend = (
          idempotencyKey
            ? {
                ...attachCodexMirrorAttestation(nextMessage, sourceFingerprint),
                idempotencyKey,
              }
            : attachCodexMirrorAttestation(nextMessage, sourceFingerprint)
        ) as AgentMessage;
        if (mirrorIdentity) {
          // Hooks may replace the whole message. Restore the provider-owned
          // identity so retries cannot turn a stale idempotency hit into evidence.
          messageToAppend = attachCodexMirrorIdentity(messageToAppend, mirrorIdentity);
        }
        if (ownsRun && params.runId) {
          messageToAppend = attachCodexMirrorRunId(messageToAppend, params.runId, ownsTerminal);
        }
        messageToAppend = projectAgentHarnessTranscriptMessageForDisplay({
          hidden: (message as { display?: boolean }).display === false,
          message: messageToAppend,
        });
        const { messageSeq, result: appended } = await transcript.appendMessageWithMessageSequence({
          message: messageToAppend,
          // Preliminary facts avoid hooks and payload work on normal retries.
          // SQLite repeats this lookup under BEGIN IMMEDIATE for cross-process safety.
          idempotencyLookup: "scan",
          cwd: params.cwd,
        });
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
          nextUserMessagesPresent.push(appendedMessage);
          nextUserMessageReceipts.push({
            anchor: appended.anchor,
            message: appendedMessage,
          });
        }
        if (appended.appended) {
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
        assistantMirrorIdentitiesOwned: [...nextAssistantMirrorIdentitiesOwned],
        anchorsByMirrorIdentity: nextAnchorsByMirrorIdentity,
        messagesPresent: nextMessagesPresent,
        userMessageReceipts: nextUserMessageReceipts,
        userMessagesPresent: nextUserMessagesPresent,
      };
    },
  );
  const {
    appendedUpdates,
    assistantMirrorIdentitiesOwned,
    anchorsByMirrorIdentity,
    messagesPresent,
    userMessageReceipts,
    userMessagesPresent,
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
    assistantMirrorIdentitiesOwned,
    anchorsByMirrorIdentity,
    messagesPresent,
    userMessageReceipts,
    userMessagesPresent,
  };
}

export const codexTranscriptMirrorRuntime = { mirror, mirrorBestEffort };

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
