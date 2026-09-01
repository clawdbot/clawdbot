import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadExactSessionEntry,
  persistSessionTranscriptTurn,
  readActiveTranscriptEntryAnchor,
  resolveSessionEntrySelection,
  type TranscriptMessageAppendResult,
} from "../config/sessions/session-accessor.js";
import {
  findTranscriptEvent,
  readTranscriptEventId,
  readTranscriptEventMessage,
} from "../config/sessions/session-accessor.sqlite-read.js";
import { sessionMatchesExpectedTranscriptTurn } from "../config/sessions/session-transcript-turn-state.js";
import { getOwnedSessionTranscriptWriterFence } from "../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getAgentScopedMediaLocalRootsForSources } from "../media/local-roots.js";
import { createKeyedFifoLeaseRegistry } from "../shared/keyed-fifo-lease.js";
import { isOpenClawDeliveryMirrorAssistantMessage } from "../shared/transcript-only-openclaw-assistant.js";
import {
  attachManagedOutgoingMediaToMessage,
  createManagedOutgoingMediaBlocks,
  prepareOutgoingMediaFromReplyPayload,
  removeManagedOutgoingMediaBlocks,
} from "./managed-image-attachments.js";
import { prepareGatewayInjectedAssistantContent } from "./server-methods/chat-transcript-inject.js";

const internalSourceReplyPersistenceLeases = createKeyedFifoLeaseRegistry(
  Symbol.for("openclaw.internalSourceReplyPersistenceLeases"),
);

async function completePersistedInternalSourceReply(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  expectedSessionId?: string;
  agentId?: string;
  idempotencyKey?: string;
}): Promise<boolean> {
  if (!params.expectedSessionId || !params.idempotencyKey) {
    return false;
  }
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const scope = {
    agentId: params.agentId,
    sessionId: params.expectedSessionId,
    sessionKey: params.sessionKey,
    storePath,
  };
  scope.sessionKey = resolveSessionEntrySelection(scope).normalizedKey;
  const expected = {
    expectedSessionId: params.expectedSessionId,
    ...getOwnedSessionTranscriptWriterFence({ sessionKey: scope.sessionKey }),
  };
  const found = await findTranscriptEvent(scope, (event) => {
    const message = readTranscriptEventMessage(event);
    return (
      message?.idempotencyKey === params.idempotencyKey &&
      isOpenClawDeliveryMirrorAssistantMessage(message)
    );
  });
  if (!found) {
    return false;
  }
  const messageId = readTranscriptEventId(found.event);
  const message = readTranscriptEventMessage(found.event);
  if (!messageId || !message) {
    throw new Error("Internal source reply transcript identity is unavailable");
  }
  const assertCurrentReplay = (entryId: string) => {
    if (
      !sessionMatchesExpectedTranscriptTurn(loadExactSessionEntry(scope), expected) ||
      !readActiveTranscriptEntryAnchor({ ...scope, entryId })
    ) {
      throw new Error("Internal source reply no longer owns the active transcript");
    }
  };
  // Replay also refreshes history when an earlier owned drain suppressed publication.
  // Preserve the original bytes and run provenance; never restage a retry.
  const replay = await persistSessionTranscriptTurn(scope, {
    config: params.cfg,
    ...expected,
    messages: [
      {
        eventId: messageId,
        message,
        idempotencyLookup: "scan",
        shouldAppendInTransaction: () => {
          // A removed or abandoned original must never become a new append on retry.
          assertCurrentReplay(messageId);
          return true;
        },
      },
    ],
    touchSessionEntry: false,
    updateMode: "file-only",
    publishWhen: "always",
    onMessageCommitted: (result) => {
      // The queue await can outlive admission or the active branch; promotion must use current ownership.
      assertCurrentReplay(result.messageId);
      attachSourceReplyMedia(result);
    },
  });
  if (replay.rejectedReason || replay.messages.length === 0) {
    throw new Error("Internal source reply no longer owns the active transcript");
  }
  return true;
}

function attachSourceReplyMedia(result: TranscriptMessageAppendResult<unknown>): void {
  // This producer writes only text and managed-media blocks.
  const message = result.message;
  const blocks =
    isRecord(message) && Array.isArray(message.content)
      ? message.content.filter(isRecord).filter((block) => block.type !== "text")
      : [];
  if (
    blocks.length > 0 &&
    !attachManagedOutgoingMediaToMessage({ messageId: result.messageId, blocks })
  ) {
    throw new Error("Internal source reply media ownership could not be persisted");
  }
}

/** Persist the private WebChat source reply before its successful tool result becomes visible. */
export async function persistInternalSourceReply(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  expectedSessionId?: string;
  agentId?: string;
  payload: ReplyPayload;
  idempotencyKey?: string;
  runId?: string;
  sourceReplyFinal?: boolean;
  toolCallId?: string;
  sourceTurnId?: string;
}): Promise<void> {
  const leaseKey = params.idempotencyKey
    ? JSON.stringify([
        params.agentId ?? "",
        params.sessionKey,
        params.expectedSessionId ?? "",
        params.idempotencyKey,
      ])
    : undefined;
  const lease = leaseKey ? internalSourceReplyPersistenceLeases.reserve([leaseKey]) : undefined;
  await lease?.wait();
  try {
    if (await completePersistedInternalSourceReply(params)) {
      return;
    }
    const media = prepareOutgoingMediaFromReplyPayload(params.payload);
    // Prepared media is transient until commit so maintenance cannot reap it as missing history.
    const mediaBlocks = await createManagedOutgoingMediaBlocks({
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      items: media,
      localRoots: getAgentScopedMediaLocalRootsForSources({
        cfg: params.cfg,
        agentId: params.agentId,
        mediaSources: media.map((item) => item.url),
      }),
    });
    let committed = false;
    try {
      const content: Array<Record<string, unknown>> = [
        ...(params.payload.text ? [{ type: "text", text: params.payload.text }] : []),
        ...mediaBlocks,
      ];
      const writerFence = getOwnedSessionTranscriptWriterFence({
        sessionKey: params.sessionKey,
      });
      const appended = await appendAssistantMessageToSessionTranscript({
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        ...(params.expectedSessionId ? { expectedSessionId: params.expectedSessionId } : {}),
        ...(writerFence?.expectedLifecycleRevision !== undefined
          ? { expectedLifecycleRevision: writerFence.expectedLifecycleRevision }
          : {}),
        ...(writerFence ? { expectedWriterRunId: writerFence.expectedWriterRunId } : {}),
        content: prepareGatewayInjectedAssistantContent(content),
        idempotencyKey: params.idempotencyKey,
        runId: params.runId,
        ...(params.sourceReplyFinal !== undefined
          ? {
              deliveryMirror: {
                kind: "message-tool-source-reply" as const,
                final: params.sourceReplyFinal,
                ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
                ...(params.sourceTurnId ? { sourceTurnId: params.sourceTurnId } : {}),
              },
            }
          : {}),
        config: params.cfg,
        onMessageCommitted: (result) => {
          // Publication can fail after commit; cleanup must never delete owned media.
          committed = result.appended;
          attachSourceReplyMedia(result);
        },
      });
      if (!appended.ok) {
        throw new Error(`Internal source reply persistence failed: ${appended.reason}`);
      }
    } finally {
      if (!committed) {
        await removeManagedOutgoingMediaBlocks({ blocks: mediaBlocks, messageId: null });
      }
    }
  } finally {
    lease?.release();
  }
}
