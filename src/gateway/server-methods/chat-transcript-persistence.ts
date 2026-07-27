// Transcript persistence and source-reply rewrites shared by chat send and abort.
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import {
  findTranscriptEvent,
  patchSessionEntry,
  publishTranscriptUpdate,
  withTranscriptWriteLock,
  type SessionTranscriptWriteScope,
  type TranscriptEvent,
} from "../../config/sessions/session-accessor.js";
import { resolveMirroredTranscriptText } from "../../config/sessions/transcript-mirror.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AssistantDisplayContentBlock } from "./chat-assistant-content.js";
import {
  appendInjectedAssistantMessageToTranscript,
  type GatewayInjectedTtsSupplementMarker,
} from "./chat-transcript-inject.js";

type TranscriptAppendResult = {
  ok: boolean;
  messageId?: string;
  message?: Record<string, unknown>;
  error?: string;
};

type AssistantTranscriptScopeParams = {
  sessionId: string;
  storePath: string | undefined;
  sessionKey: string;
  agentId?: string;
};

export type SourceReplyTranscriptMirrorMetadata = NonNullable<
  ReturnType<typeof getReplyPayloadMetadata>
>["sourceReplyTranscriptMirror"];

export type SourceReplyContentState = {
  broadcastContent: AssistantDisplayContentBlock[];
  persistedContent: AssistantDisplayContentBlock[];
  hasManagedOutgoingContent: boolean;
  backedManagedOutgoingContent: boolean;
};

export function assistantTranscriptScope(
  params: AssistantTranscriptScopeParams,
): SessionTranscriptWriteScope | null {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey || !params.sessionId.trim()) {
    return null;
  }
  return {
    sessionKey,
    sessionId: params.sessionId,
    ...(params.storePath ? { storePath: params.storePath } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
  };
}

function transcriptEventRecord(event: TranscriptEvent): Record<string, unknown> | undefined {
  return event && typeof event === "object" && !Array.isArray(event)
    ? (event as Record<string, unknown>)
    : undefined;
}

function transcriptEventId(event: TranscriptEvent): string | undefined {
  const id = transcriptEventRecord(event)?.id;
  return typeof id === "string" && id.trim().length > 0 ? id : undefined;
}

function transcriptEventMessage(event: TranscriptEvent): Record<string, unknown> | undefined {
  const message = transcriptEventRecord(event)?.message;
  return message && typeof message === "object" && !Array.isArray(message)
    ? (message as Record<string, unknown>)
    : undefined;
}

function findAssistantTranscriptMessageByIdempotencyKeyInEvents(
  events: readonly TranscriptEvent[],
  idempotencyKey: string,
): { messageId: string; message: Record<string, unknown> } | null {
  const trimmedIdempotencyKey = idempotencyKey.trim();
  if (!trimmedIdempotencyKey) {
    return null;
  }
  const target = events.toReversed().find((event) => {
    const message = transcriptEventMessage(event);
    return message?.role === "assistant" && message.idempotencyKey === trimmedIdempotencyKey;
  });
  const message = target ? transcriptEventMessage(target) : undefined;
  const messageId = target ? transcriptEventId(target) : undefined;
  if (!messageId || !message) {
    return null;
  }
  return { messageId, message };
}

function findSourceReplyTranscriptMirrorByIdempotencyKeyInEvents(
  events: readonly TranscriptEvent[],
  idempotencyKey: string,
): { messageId: string; message: Record<string, unknown> } | null {
  const found = findAssistantTranscriptMessageByIdempotencyKeyInEvents(events, idempotencyKey);
  if (found?.message.provider !== "openclaw" || found.message.model !== "delivery-mirror") {
    return null;
  }
  return found;
}

function extractAssistantTranscriptText(message: Record<string, unknown>): string | undefined {
  const content = message.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .map((block) =>
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
        ? ((block as { text: string }).text.trim() ?? "")
        : "",
    )
    .filter(Boolean)
    .join("\n")
    .trim();
  return text || undefined;
}

function findSourceReplyTranscriptMirrorByMetadataInEvents(params: {
  events: readonly TranscriptEvent[];
  idempotencyKey: string;
  metadata: SourceReplyTranscriptMirrorMetadata;
}): { messageId: string; message: Record<string, unknown> } | null {
  const byIdempotencyKey = findSourceReplyTranscriptMirrorByIdempotencyKeyInEvents(
    params.events,
    params.idempotencyKey,
  );
  if (byIdempotencyKey) {
    return byIdempotencyKey;
  }
  const expectedText = resolveMirroredTranscriptText({
    text: params.metadata?.text,
    mediaUrls: params.metadata?.mediaUrls,
  });
  if (!expectedText) {
    return null;
  }
  const target = params.events.toReversed().find((event) => {
    const message = transcriptEventMessage(event);
    return (
      typeof transcriptEventId(event) === "string" &&
      message?.role === "assistant" &&
      message.provider === "openclaw" &&
      message.model === "delivery-mirror" &&
      extractAssistantTranscriptText(message) === expectedText
    );
  });
  const message = target ? transcriptEventMessage(target) : undefined;
  const messageId = target ? transcriptEventId(target) : undefined;
  if (!messageId || !message) {
    return null;
  }
  return { messageId, message };
}

async function transcriptExists(scope: SessionTranscriptWriteScope): Promise<boolean> {
  const sessionId = scope.sessionId;
  if (!sessionId) {
    return false;
  }
  // Existence probe: the newest-first matcher returns on the first record, so
  // this reads one transcript line instead of materializing the whole file.
  const found = await findTranscriptEvent({ ...scope, sessionId }, () => true).catch(
    () => undefined,
  );
  return found !== undefined;
}

export async function appendAssistantTranscriptMessage(params: {
  sessionKey: string;
  message: string;
  label?: string;
  content?: Array<Record<string, unknown>>;
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
  createIfMissing?: boolean;
  idempotencyKey?: string;
  abortMeta?: {
    aborted: true;
    origin: "rpc" | "stop-command";
    runId: string;
  };
  ttsSupplement?: GatewayInjectedTtsSupplementMarker;
  cfg?: OpenClawConfig;
}): Promise<TranscriptAppendResult> {
  const scope = assistantTranscriptScope(params);
  if (!scope) {
    return { ok: false, error: "transcript identity not resolved" };
  }
  if (!params.createIfMissing && !(await transcriptExists(scope))) {
    return { ok: false, error: "transcript not found" };
  }

  const appended = await appendInjectedAssistantMessageToTranscript({
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    storePath: params.storePath,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    message: params.message,
    label: params.label,
    content: params.content,
    idempotencyKey: params.idempotencyKey,
    abortMeta: params.abortMeta,
    ttsSupplement: params.ttsSupplement,
    config: params.cfg,
  });
  return appended;
}

async function touchAssistantTranscriptSessionEntry(
  scope: SessionTranscriptWriteScope,
): Promise<void> {
  if (!scope.storePath || !scope.sessionKey || !scope.sessionId) {
    return;
  }
  const transcriptMarkerUpdatedAt = Date.now();
  await patchSessionEntry(
    {
      storePath: scope.storePath,
      sessionKey: scope.sessionKey,
      ...(scope.agentId ? { agentId: scope.agentId } : {}),
    },
    (current) =>
      current.sessionId === scope.sessionId ? { updatedAt: transcriptMarkerUpdatedAt } : null,
    {
      skipMaintenance: true,
    },
  );
}

export async function rewriteSourceReplyTranscriptMirrors(params: {
  candidates: readonly {
    idempotencyKey: string;
    metadata: SourceReplyTranscriptMirrorMetadata;
  }[];
  requests: readonly {
    idempotencyKey: string;
    metadata: SourceReplyTranscriptMirrorMetadata;
    state: SourceReplyContentState;
  }[];
  scope: SessionTranscriptWriteScope;
}): Promise<
  Array<{
    messageId: string;
    request: {
      idempotencyKey: string;
      metadata: SourceReplyTranscriptMirrorMetadata;
      state: SourceReplyContentState;
    };
  }>
> {
  if (params.requests.length === 0 || params.candidates.length === 0) {
    return [];
  }

  return await withTranscriptWriteLock(params.scope, async (transcript) => {
    const events = await transcript.readEvents();
    const allowedSourceReplyMirrorIds = new Set<string>();
    for (const candidate of params.candidates) {
      const target = findSourceReplyTranscriptMirrorByMetadataInEvents({
        events,
        idempotencyKey: candidate.idempotencyKey,
        metadata: candidate.metadata,
      });
      if (target) {
        allowedSourceReplyMirrorIds.add(target.messageId);
      }
    }

    const rewriteTargets: Array<{
      request: (typeof params.requests)[number];
      messageId: string;
      message: Record<string, unknown>;
    }> = [];
    for (const request of params.requests) {
      const target = findSourceReplyTranscriptMirrorByMetadataInEvents({
        events,
        idempotencyKey: request.idempotencyKey,
        metadata: request.metadata,
      });
      if (target) {
        rewriteTargets.push({ request, ...target });
      }
    }
    if (rewriteTargets.length === 0) {
      return [];
    }

    const rewriteTargetIds = new Set(rewriteTargets.map((target) => target.messageId));
    const firstRewriteEntryIndex = events.findIndex((event) => {
      const id = transcriptEventId(event);
      return id ? rewriteTargetIds.has(id) : false;
    });
    const canRewriteSourceReplyMirrors =
      firstRewriteEntryIndex >= 0 &&
      events.slice(firstRewriteEntryIndex).every((event) => {
        const id = transcriptEventId(event);
        return !id || allowedSourceReplyMirrorIds.has(id);
      });
    if (!canRewriteSourceReplyMirrors) {
      return [];
    }

    const replacementsById = new Map(rewriteTargets.map((target) => [target.messageId, target]));
    const rewrittenEvents = events.map((event) => {
      const id = transcriptEventId(event);
      const replacement = id ? replacementsById.get(id) : undefined;
      if (!replacement) {
        return event;
      }
      return Object.assign({}, event as Record<string, unknown>, {
        message: {
          ...replacement.message,
          idempotencyKey: replacement.request.idempotencyKey,
          content: replacement.request.state.persistedContent,
        },
      });
    });
    await transcript.replaceEvents(rewrittenEvents);
    return rewriteTargets.map((target) => ({
      messageId: target.messageId,
      request: target.request,
    }));
  });
}

export async function rewriteAssistantTranscriptMessageByIdempotencyKey(params: {
  content: AssistantDisplayContentBlock[];
  idempotencyKey: string;
  scope: SessionTranscriptWriteScope;
}): Promise<{ messageId: string } | null> {
  const idempotencyKey = params.idempotencyKey.trim();
  if (!idempotencyKey || params.content.length === 0) {
    return null;
  }
  return await withTranscriptWriteLock(params.scope, async (transcript) => {
    const events = await transcript.readEvents();
    const target = findAssistantTranscriptMessageByIdempotencyKeyInEvents(events, idempotencyKey);
    if (!target) {
      return null;
    }
    const rewrittenEvents = events.map((event) =>
      transcriptEventId(event) === target.messageId
        ? Object.assign({}, event as Record<string, unknown>, {
            message: {
              ...target.message,
              content: params.content,
            },
          })
        : event,
    );
    await transcript.replaceEvents(rewrittenEvents);
    return { messageId: target.messageId };
  });
}

export async function publishAssistantTranscriptRewrite(params: {
  scope: SessionTranscriptWriteScope;
  rewritten: readonly { messageId: string }[];
}): Promise<void> {
  if (params.rewritten.length === 0) {
    return;
  }
  await touchAssistantTranscriptSessionEntry(params.scope);
  await publishTranscriptUpdate(params.scope, {
    messageId: params.rewritten.at(-1)?.messageId,
  });
}
