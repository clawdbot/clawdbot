import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  findTranscriptEvent,
  readTranscriptEventMessage,
} from "../config/sessions/session-accessor.sqlite-read.js";
import { getOwnedSessionTranscriptWriterFence } from "../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getAgentScopedMediaLocalRootsForSources } from "../media/local-roots.js";
import { createKeyedFifoLeaseRegistry } from "../shared/keyed-fifo-lease.js";
import { isOpenClawDeliveryMirrorAssistantMessage } from "../shared/transcript-only-openclaw-assistant.js";
import {
  attachManagedOutgoingMediaToMessage,
  createManagedOutgoingMediaBlocks,
} from "./managed-image-attachments.js";
import { prepareGatewayInjectedAssistantContent } from "./server-methods/chat-transcript-inject.js";

const internalSourceReplyPersistenceLeases = createKeyedFifoLeaseRegistry(
  Symbol.for("openclaw.internalSourceReplyPersistenceLeases"),
);

function collectSourceReplyMediaUrls(payload: ReplyPayload): string[] {
  return Array.from(
    new Set([...(payload.mediaUrl ? [payload.mediaUrl] : []), ...(payload.mediaUrls ?? [])]),
  ).filter((value) => value.trim().length > 0);
}

async function hasPersistedInternalSourceReply(params: {
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
  const found = await findTranscriptEvent(
    {
      agentId: params.agentId,
      sessionId: params.expectedSessionId,
      sessionKey: params.sessionKey,
      storePath,
    },
    (event) => {
      const message = readTranscriptEventMessage(event);
      return (
        message?.idempotencyKey === params.idempotencyKey &&
        isOpenClawDeliveryMirrorAssistantMessage(message)
      );
    },
  );
  return found !== undefined;
}

function resolveInternalSourceReplyPersistenceLeaseKey(params: {
  sessionKey: string;
  expectedSessionId?: string;
  agentId?: string;
  idempotencyKey?: string;
}): string | undefined {
  if (!params.idempotencyKey) {
    return undefined;
  }
  return JSON.stringify([
    params.agentId ?? "",
    params.sessionKey,
    params.expectedSessionId ?? "",
    params.idempotencyKey,
  ]);
}

/** Persist the private WebChat source reply before its successful tool result becomes visible. */
export async function persistInternalSourceReply(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  expectedSessionId?: string;
  agentId?: string;
  payload: ReplyPayload;
  idempotencyKey?: string;
  sourceReplyFinal?: boolean;
  toolCallId?: string;
  sourceTurnId?: string;
}): Promise<void> {
  const leaseKey = resolveInternalSourceReplyPersistenceLeaseKey(params);
  const lease = leaseKey ? internalSourceReplyPersistenceLeases.reserve([leaseKey]) : undefined;
  await lease?.wait();
  try {
    if (await hasPersistedInternalSourceReply(params)) {
      return;
    }
    const mediaUrls = collectSourceReplyMediaUrls(params.payload);
    const mediaBlocks = await createManagedOutgoingMediaBlocks({
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      mediaUrls,
      localRoots: getAgentScopedMediaLocalRootsForSources({
        cfg: params.cfg,
        agentId: params.agentId,
        mediaSources: mediaUrls,
      }),
    });
    const content: Array<Record<string, unknown>> = [
      ...(params.payload.text ? [{ type: "text", text: params.payload.text }] : []),
      ...mediaBlocks,
    ];
    const writerFence = getOwnedSessionTranscriptWriterFence();
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
    });
    if (!appended.ok) {
      throw new Error(`Internal source reply persistence failed: ${appended.reason}`);
    }
    if (
      mediaBlocks.length > 0 &&
      !attachManagedOutgoingMediaToMessage({
        messageId: appended.messageId,
        blocks: mediaBlocks,
      })
    ) {
      throw new Error("Internal source reply media ownership could not be persisted");
    }
  } finally {
    lease?.release();
  }
}
