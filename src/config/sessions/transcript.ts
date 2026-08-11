// Session transcript facade resolves transcript files, appends mirror messages, and reads tails.
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import type { SessionManager } from "../../agents/sessions/session-manager.js";
import { redactTranscriptMessage } from "../../agents/transcript-redact.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  scopeLegacySessionKeyToAgent,
} from "../../routing/session-key.js";
import {
  extractAssistantPhaseText,
  extractFirstTextBlock,
} from "../../shared/chat-message-content.js";
import {
  OPENCLAW_DELIVERY_MIRROR_MODEL,
  OPENCLAW_TRANSCRIPT_ARTIFACT_API,
  OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
  isTranscriptOnlyOpenClawAssistantModel,
} from "../../shared/transcript-only-openclaw-assistant.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  parseSqliteSessionFileMarker,
  type SqliteSessionFileMarker,
} from "./legacy-sqlite-marker.js";
import { resolveDefaultSessionStorePath, resolveStorePath } from "./paths.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  isSessionTranscriptProjectionUnavailableError,
  persistSessionTranscriptTurn,
  readActiveTranscriptEntryAnchor,
  readLatestTranscriptAssistantText,
  readSessionTranscriptMessageEventPage,
  resolveSessionEntrySelection,
  updateSessionEntry,
  type SessionTranscriptTurnWriteContext,
  type SessionTranscriptTurnExpectedState,
  type TranscriptEntryAnchor,
} from "./session-accessor.js";
import type { SessionTranscriptTurnLifecyclePatch } from "./session-transcript-turn-lifecycle.types.js";
import {
  applyBeforeMessageWriteToAssistant,
  type AssistantBeforeMessageWrite,
} from "./transcript-assistant-message.js";
import { resolveMirroredTranscriptText } from "./transcript-mirror.js";
import {
  isWithinTranscriptWindow,
  normalizeRecentTranscriptLimit,
  normalizeTranscriptTimestamp,
  readPreferredUpstreamUserText,
} from "./transcript-recent-window.js";
import { streamSessionTranscriptLinesReverse } from "./transcript-stream.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

type SessionTranscriptAppendTarget = {
  agentId?: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
};

export type SessionTranscriptAppendResult =
  | {
      ok: true;
      target: SessionTranscriptAppendTarget;
      messageId: string;
      anchor?: TranscriptEntryAnchor;
    }
  | {
      ok: false;
      reason: string;
      code?: "blocked" | "session-rebound";
    };

export type SessionTranscriptUpdateMode = "inline" | "file-only" | "none";
export type SessionTranscriptDeliveryMirror =
  | {
      kind: "channel-final";
      sourceMessageId?: string;
    }
  | {
      kind: "channel-final-suppressed";
      reason: "stale-foreground";
      sourceMessageId?: string;
    };

type InternalSessionTranscriptDeliveryMirror =
  | SessionTranscriptDeliveryMirror
  | {
      kind: "message-tool-source-reply";
      final: boolean;
      sourceTurnId?: string;
      toolCallId?: string;
    };

export type SessionTranscriptAssistantMessage = Parameters<SessionManager["appendMessage"]>[0] & {
  role: "assistant";
};

type AssistantTranscriptText = {
  id?: string;
  text: string;
  timestamp?: number;
};

export type SessionRecentConversationText = {
  id?: string;
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
  sourceChannel?: string;
};

type ReadRecentSessionConversationTextOptions = {
  beforeTimestampMs?: number;
  limit?: number;
  minTimestampMs?: number;
  role?: "user" | "assistant";
  preferUpstreamUserText?: boolean;
};

type ReadRecentSessionConversationTextParams = ReadRecentSessionConversationTextOptions & {
  agentId: string;
  sessionKey: string;
  storePath?: string;
};

class SessionTranscriptAgentScopeMismatchError extends Error {
  readonly code = "SESSION_TRANSCRIPT_AGENT_SCOPE_MISMATCH";

  constructor(
    readonly agentId: string,
    readonly sessionKeyAgentId: string,
  ) {
    super(
      `Session transcript agent scope mismatch: explicit agent "${agentId}" does not match session key agent "${sessionKeyAgentId}".`,
    );
    this.name = "SessionTranscriptAgentScopeMismatchError";
  }
}

export type LatestAssistantTranscriptText = AssistantTranscriptText;
type TailAssistantTranscriptText = AssistantTranscriptText;

export { resolveSessionTranscriptFile } from "./transcript-file-resolve.js";

function parseAssistantTranscriptText(
  line: string,
  options?: { excludeTranscriptOnlyOpenClawAssistant?: boolean },
): AssistantTranscriptText | undefined {
  const parsed = JSON.parse(line) as {
    id?: unknown;
    message?: unknown;
  };
  const message = parsed.message as
    | { role?: unknown; timestamp?: unknown; provider?: unknown; model?: unknown }
    | undefined;
  if (!message || message.role !== "assistant") {
    return undefined;
  }
  if (
    options?.excludeTranscriptOnlyOpenClawAssistant &&
    isTranscriptOnlyOpenClawAssistantMessage(message)
  ) {
    return undefined;
  }
  const text = extractAssistantPhaseText(message)?.trim();
  if (!text) {
    return undefined;
  }
  return {
    ...(typeof parsed.id === "string" && parsed.id ? { id: parsed.id } : {}),
    text,
    ...(typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
      ? { timestamp: message.timestamp }
      : {}),
  };
}

function isTranscriptOnlyOpenClawAssistantMessage(message: {
  provider?: unknown;
  model?: unknown;
}): boolean {
  return isTranscriptOnlyOpenClawAssistantModel(message.provider, message.model);
}

type SessionConversationTranscriptTarget = {
  sqliteScope?: SqliteSessionFileMarker;
};

function parseRecentConversationText(
  line: string,
  options: ReadRecentSessionConversationTextOptions = {},
): SessionRecentConversationText | undefined {
  const parsed = JSON.parse(line) as {
    id?: unknown;
    message?: unknown;
  };
  const message = parsed.message as
    | {
        role?: unknown;
        timestamp?: unknown;
        provenance?: unknown;
        provider?: unknown;
        model?: unknown;
        __openclaw?: unknown;
      }
    | undefined;
  if (
    !message ||
    (message.role !== "user" && message.role !== "assistant") ||
    (options.role && message.role !== options.role)
  ) {
    return undefined;
  }
  if (message.role === "assistant" && isTranscriptOnlyOpenClawAssistantMessage(message)) {
    return undefined;
  }
  const upstreamUserText =
    options.preferUpstreamUserText && message.role === "user"
      ? readPreferredUpstreamUserText(message)
      : undefined;
  if (upstreamUserText === null) {
    return undefined;
  }
  const text =
    message.role === "assistant"
      ? extractAssistantPhaseText(message)
      : (upstreamUserText ?? extractFirstTextBlock(message)?.trim());
  if (!text) {
    return undefined;
  }
  const provenance =
    message.provenance && typeof message.provenance === "object"
      ? (message.provenance as { sourceChannel?: unknown })
      : undefined;
  return {
    ...(typeof parsed.id === "string" && parsed.id ? { id: parsed.id } : {}),
    role: message.role,
    text,
    ...(normalizeTranscriptTimestamp(message.timestamp) !== undefined
      ? { timestamp: normalizeTranscriptTimestamp(message.timestamp) }
      : {}),
    ...(typeof provenance?.sourceChannel === "string" && provenance.sourceChannel.trim()
      ? { sourceChannel: provenance.sourceChannel.trim() }
      : {}),
  };
}

async function readRecentUserAssistantTextFromSqliteTranscript(
  scope: SqliteSessionFileMarker,
  options: ReadRecentSessionConversationTextOptions = {},
): Promise<SessionRecentConversationText[]> {
  const limit = normalizeRecentTranscriptLimit(options.limit);
  const pageSize = 250;
  try {
    const readScope = {
      agentId: scope.agentId,
      sessionId: scope.sessionId,
      storePath: scope.storePath,
    };
    const recent: SessionRecentConversationText[] = [];
    for (let offset = 0; recent.length < limit; offset += pageSize) {
      const page = readSessionTranscriptMessageEventPage(readScope, {
        maxMessages: pageSize,
        offset,
      });
      if (page.events.length === 0) {
        break;
      }
      for (const event of page.events.toReversed()) {
        const entry = parseRecentConversationText(JSON.stringify(event.event), options);
        if (entry && isWithinTranscriptWindow(entry.timestamp, options)) {
          recent.push(entry);
          if (recent.length >= limit) {
            break;
          }
        }
      }
    }
    return recent.toReversed();
  } catch (error) {
    if (isSessionTranscriptProjectionUnavailableError(error)) {
      return [];
    }
    throw error;
  }
}

function resolveSessionConversationTranscriptTarget(params: {
  agentId?: string;
  sessionKey: string;
  storePath?: string;
}): SessionConversationTranscriptTarget {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return {};
  }
  const explicitAgentId = params.agentId?.trim() ? normalizeAgentId(params.agentId) : undefined;
  const sessionKeyAgentId = parseAgentSessionKey(sessionKey)?.agentId;
  if (
    explicitAgentId &&
    sessionKeyAgentId &&
    explicitAgentId !== normalizeAgentId(sessionKeyAgentId)
  ) {
    throw new SessionTranscriptAgentScopeMismatchError(explicitAgentId, sessionKeyAgentId);
  }
  const agentId = explicitAgentId ?? resolveAgentIdFromSessionKey(sessionKey);
  const scopedSessionKey = scopeLegacySessionKeyToAgent({ agentId, sessionKey }) ?? sessionKey;
  const storePath = params.storePath ?? resolveDefaultSessionStorePath(agentId);
  const entry = loadSessionEntryReadOnly({ agentId, sessionKey: scopedSessionKey, storePath });
  if (!entry?.sessionId) {
    return {};
  }
  return {
    sqliteScope: {
      agentId,
      sessionId: entry.sessionId,
      storePath,
    },
  };
}

export async function readRecentUserAssistantTextForSession(
  params: ReadRecentSessionConversationTextParams,
): Promise<SessionRecentConversationText[]> {
  const target = resolveSessionConversationTranscriptTarget(params);
  if (target.sqliteScope) {
    return await readRecentUserAssistantTextFromSqliteTranscript(target.sqliteScope, params);
  }
  return [];
}

export async function readLatestAssistantTextFromSessionTranscript(
  target:
    | string
    | {
        agentId?: string;
        sessionId: string;
        sessionKey?: string;
        storePath?: string;
      }
    | undefined,
): Promise<LatestAssistantTranscriptText | undefined> {
  if (target && typeof target === "object") {
    return readLatestTranscriptAssistantText(target);
  }
  const sessionFile = target;
  const sqliteMarker = parseSqliteSessionFileMarker(sessionFile);
  if (sqliteMarker) {
    return readLatestTranscriptAssistantText({
      agentId: sqliteMarker.agentId,
      sessionId: sqliteMarker.sessionId,
      storePath: sqliteMarker.storePath,
    });
  }
  if (!sessionFile?.trim()) {
    return undefined;
  }

  for await (const line of streamSessionTranscriptLinesReverse(sessionFile)) {
    try {
      const assistantText = parseAssistantTranscriptText(line, {
        excludeTranscriptOnlyOpenClawAssistant: true,
      });
      if (assistantText) {
        return assistantText;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function readTailAssistantTextFromSessionTranscript(
  sessionFile:
    | string
    | undefined
    | { agentId?: string; sessionId?: string; sessionKey?: string; storePath?: string },
  options?: { excludeTranscriptOnlyOpenClawAssistant?: boolean },
): Promise<TailAssistantTranscriptText | undefined> {
  if (typeof sessionFile === "object") {
    if (!sessionFile.sessionId || (!sessionFile.agentId && !sessionFile.sessionKey)) {
      return undefined;
    }
    const events = await loadTranscriptEvents({
      ...(sessionFile.agentId ? { agentId: sessionFile.agentId } : {}),
      sessionId: sessionFile.sessionId,
      ...(sessionFile.sessionKey ? { sessionKey: sessionFile.sessionKey } : {}),
      ...(sessionFile.storePath ? { storePath: sessionFile.storePath } : {}),
    });
    for (const event of events.toReversed()) {
      const parsed = event as { message?: { model?: unknown; provider?: unknown; role?: unknown } };
      if (!parsed.message || typeof parsed.message !== "object") {
        continue;
      }
      if (parsed.message.role !== "assistant") {
        return undefined;
      }
      const assistantText = parseAssistantTranscriptText(JSON.stringify(event), {
        excludeTranscriptOnlyOpenClawAssistant:
          options?.excludeTranscriptOnlyOpenClawAssistant === true,
      });
      if (assistantText) {
        return assistantText;
      }
      if (
        options?.excludeTranscriptOnlyOpenClawAssistant !== true ||
        !isTranscriptOnlyOpenClawAssistantMessage(parsed.message)
      ) {
        return undefined;
      }
    }
    return undefined;
  }
  const sqliteMarker = parseSqliteSessionFileMarker(sessionFile);
  if (sqliteMarker) {
    const events = await loadTranscriptEvents({
      agentId: sqliteMarker.agentId,
      sessionId: sqliteMarker.sessionId,
      storePath: sqliteMarker.storePath,
    });
    for (const event of events.toReversed()) {
      const parsed = event as { message?: { model?: unknown; provider?: unknown; role?: unknown } };
      if (!parsed.message || typeof parsed.message !== "object") {
        continue;
      }
      if (parsed.message.role !== "assistant") {
        return undefined;
      }
      const assistantText = parseAssistantTranscriptText(JSON.stringify(event), {
        excludeTranscriptOnlyOpenClawAssistant:
          options?.excludeTranscriptOnlyOpenClawAssistant === true,
      });
      if (assistantText) {
        return assistantText;
      }
      if (
        options?.excludeTranscriptOnlyOpenClawAssistant !== true ||
        !isTranscriptOnlyOpenClawAssistantMessage(parsed.message)
      ) {
        return undefined;
      }
    }
    return undefined;
  }
  if (!sessionFile?.trim()) {
    return undefined;
  }

  for await (const line of streamSessionTranscriptLinesReverse(sessionFile)) {
    try {
      const parsed = JSON.parse(line) as { message?: unknown };
      // Skip non-message entries (e.g. `openclaw.cache-ttl` custom events) so
      // a metadata line emitted after the canonical assistant turn doesn't
      // make the tail reader fall through to "no assistant tail" and cause
      // persistTextTurnTranscript to append a duplicate. Stop at any real
      // message entry — a user turn means a new turn has started and a
      // matching reply is a legitimate repeat, not a gap-fill duplicate.
      if (!parsed.message || typeof parsed.message !== "object") {
        continue;
      }
      const assistantText = parseAssistantTranscriptText(line, options);
      if (assistantText) {
        return assistantText;
      }
      if (
        options?.excludeTranscriptOnlyOpenClawAssistant === true &&
        isTranscriptOnlyOpenClawAssistantMessage(parsed.message)
      ) {
        continue;
      }
      return undefined;
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function appendAssistantMessageToSessionTranscript(params: {
  agentId?: string;
  sessionKey: string;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
  expectedWriterRunId?: string;
  expectedSessionState?: SessionTranscriptTurnExpectedState;
  sessionLifecyclePatch?: SessionTranscriptTurnLifecyclePatch;
  text?: string;
  mediaUrls?: string[];
  idempotencyKey?: string;
  deliveryMirror?: InternalSessionTranscriptDeliveryMirror;
  /** Optional override for store path (mostly for tests). */
  storePath?: string;
  updateMode?: SessionTranscriptUpdateMode;
  config?: OpenClawConfig;
  beforeMessageWrite?: AssistantBeforeMessageWrite;
}): Promise<SessionTranscriptAppendResult> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return { ok: false, reason: "missing sessionKey" };
  }

  const mirrorText = resolveMirroredTranscriptText({
    text: params.text,
    mediaUrls: params.mediaUrls,
  });
  if (!mirrorText) {
    return { ok: false, reason: "empty text" };
  }

  return appendExactAssistantMessageToSessionTranscript({
    agentId: params.agentId,
    sessionKey,
    ...(params.expectedSessionId ? { expectedSessionId: params.expectedSessionId } : {}),
    ...(params.expectedLifecycleRevision
      ? { expectedLifecycleRevision: params.expectedLifecycleRevision }
      : {}),
    ...(params.expectedWriterRunId ? { expectedWriterRunId: params.expectedWriterRunId } : {}),
    ...(params.expectedSessionState ? { expectedSessionState: params.expectedSessionState } : {}),
    ...(params.sessionLifecyclePatch
      ? { sessionLifecyclePatch: params.sessionLifecyclePatch }
      : {}),
    storePath: params.storePath,
    idempotencyKey: params.idempotencyKey,
    updateMode: params.updateMode,
    config: params.config,
    ...(params.beforeMessageWrite ? { beforeMessageWrite: params.beforeMessageWrite } : {}),
    message: {
      role: "assistant" as const,
      content: [{ type: "text", text: mirrorText }],
      api: OPENCLAW_TRANSCRIPT_ARTIFACT_API,
      provider: OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
      model: OPENCLAW_DELIVERY_MIRROR_MODEL,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop" as const,
      timestamp: Date.now(),
      ...(params.deliveryMirror ? { openclawDeliveryMirror: params.deliveryMirror } : {}),
    } as SessionTranscriptAssistantMessage,
  });
}

export async function appendExactAssistantMessageToSessionTranscript(params: {
  agentId?: string;
  sessionKey: string;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
  expectedWriterRunId?: string;
  expectedSessionState?: SessionTranscriptTurnExpectedState;
  sessionLifecyclePatch?: SessionTranscriptTurnLifecyclePatch;
  message: SessionTranscriptAssistantMessage;
  idempotencyKey?: string;
  storePath?: string;
  updateMode?: SessionTranscriptUpdateMode;
  config?: OpenClawConfig;
  beforeMessageWrite?: AssistantBeforeMessageWrite;
}): Promise<SessionTranscriptAppendResult> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return { ok: false, reason: "missing sessionKey" };
  }
  if (params.message.role !== "assistant") {
    return { ok: false, reason: "message role must be assistant" };
  }

  const explicitAgentId = params.agentId?.trim() || undefined;
  const sessionAgentId = parseAgentSessionKey(sessionKey)?.agentId;
  const transcriptAgentId = explicitAgentId ?? sessionAgentId;
  const configuredDefaultAgentId =
    !transcriptAgentId && params.config ? resolveDefaultAgentId(params.config) : undefined;
  const storeAgentId =
    transcriptAgentId ?? resolveAgentIdFromSessionKey(sessionKey, configuredDefaultAgentId);
  const storePath =
    params.storePath ?? resolveStorePath(params.config?.session?.store, { agentId: storeAgentId });
  const resolved = resolveSessionEntrySelection({
    ...(transcriptAgentId ? { agentId: transcriptAgentId } : {}),
    sessionKey,
    storePath,
  });
  const entry = resolved.existing;
  if (params.expectedSessionId && entry?.sessionId !== params.expectedSessionId) {
    return {
      ok: false,
      code: "session-rebound",
      reason: `session rebound for sessionKey: ${sessionKey}`,
    };
  }
  if (
    params.expectedLifecycleRevision !== undefined &&
    entry?.lifecycleRevision !== params.expectedLifecycleRevision
  ) {
    return {
      ok: false,
      code: "session-rebound",
      reason: `session rebound for sessionKey: ${sessionKey}`,
    };
  }
  if (
    params.expectedWriterRunId !== undefined &&
    (entry as SessionEntry | undefined)?.activeWriterRunId !== params.expectedWriterRunId
  ) {
    return {
      ok: false,
      code: "session-rebound",
      reason: `session rebound for sessionKey: ${sessionKey}`,
    };
  }
  if (!entry?.sessionId) {
    return { ok: false, reason: `unknown sessionKey: ${sessionKey}` };
  }

  const appendToSession = async (
    currentEntry: NonNullable<typeof entry>,
  ): Promise<SessionTranscriptAppendResult> => {
    const explicitIdempotencyKey =
      params.idempotencyKey ??
      ((params.message as { idempotencyKey?: unknown }).idempotencyKey as string | undefined);
    const message = {
      ...params.message,
      ...(explicitIdempotencyKey ? { idempotencyKey: explicitIdempotencyKey } : {}),
    } as Parameters<SessionManager["appendMessage"]>[0];
    const preparedUnkeyedMessage =
      !explicitIdempotencyKey && params.beforeMessageWrite
        ? applyBeforeMessageWriteToAssistant({
            message,
            beforeMessageWrite: params.beforeMessageWrite,
            agentId: transcriptAgentId,
            sessionKey: resolved.normalizedKey,
          })
        : message;
    if (!preparedUnkeyedMessage) {
      return {
        ok: false,
        code: "blocked",
        reason: "blocked by before_message_write",
      };
    }
    const identifiedDeliveryMirror =
      Boolean(explicitIdempotencyKey) && isIdentifiedDeliveryMirror(params.message);
    const target: SessionTranscriptAppendTarget = {
      ...(transcriptAgentId ? { agentId: transcriptAgentId } : {}),
      sessionId: currentEntry.sessionId,
      sessionKey: resolved.normalizedKey,
      storePath,
    };
    let latestEquivalentAssistantId: string | undefined;
    // Identified delivery mirrors, including suppressed finals, dedupe only by
    // key so same-text markers from different source ids remain separate rows.
    const turn = await persistSessionTranscriptTurn(
      {
        sessionId: currentEntry.sessionId,
        sessionKey: resolved.normalizedKey,
        storePath,
        ...(transcriptAgentId ? { agentId: transcriptAgentId } : {}),
      },
      {
        cwd: currentEntry.spawnedCwd,
        ...(params.expectedSessionId ? { expectedSessionId: params.expectedSessionId } : {}),
        ...(params.expectedLifecycleRevision !== undefined
          ? { expectedLifecycleRevision: params.expectedLifecycleRevision }
          : {}),
        ...(params.expectedWriterRunId !== undefined
          ? { expectedWriterRunId: params.expectedWriterRunId }
          : {}),
        ...(params.expectedSessionState
          ? { expectedSessionState: params.expectedSessionState }
          : {}),
        ...(params.sessionLifecyclePatch
          ? { sessionLifecyclePatch: params.sessionLifecyclePatch }
          : {}),
        ...(params.config ? { config: params.config } : {}),
        updateMode: params.updateMode ?? "inline",
        touchSessionEntry: true,
        messages: [
          {
            message: preparedUnkeyedMessage,
            ...(explicitIdempotencyKey ? { idempotencyLookup: "scan" } : {}),
            ...(explicitIdempotencyKey && params.beforeMessageWrite
              ? {
                  prepareMessageAfterIdempotencyCheck: (candidate: unknown) =>
                    applyBeforeMessageWriteToAssistant({
                      message: candidate as Parameters<SessionManager["appendMessage"]>[0],
                      beforeMessageWrite: params.beforeMessageWrite,
                      explicitIdempotencyKey,
                      agentId: transcriptAgentId,
                      sessionKey: resolved.normalizedKey,
                    }),
                }
              : {}),
            shouldAppend: async (appendTarget) => {
              latestEquivalentAssistantId =
                isRedundantDeliveryMirror(params.message) && !identifiedDeliveryMirror
                  ? await findLatestEquivalentAssistantMessageId(
                      appendTarget,
                      preparedUnkeyedMessage as SessionTranscriptAssistantMessage,
                      params.config,
                    )
                  : undefined;
              return !latestEquivalentAssistantId;
            },
          },
        ],
      },
    );
    if (turn.rejectedReason === "session-rebound") {
      return {
        ok: false,
        code: "session-rebound",
        reason: `session rebound for sessionKey: ${sessionKey}`,
      };
    }
    if (latestEquivalentAssistantId) {
      const anchor = readActiveTranscriptEntryAnchor({
        ...target,
        entryId: latestEquivalentAssistantId,
      });
      return {
        ok: true,
        target,
        messageId: latestEquivalentAssistantId,
        ...(anchor ? { anchor } : {}),
      };
    }
    const appendedResult = turn.messages[0];
    if (!appendedResult) {
      return {
        ok: false,
        code: "blocked",
        reason: "blocked by before_message_write",
      };
    }
    const { anchor, messageId } = appendedResult;
    if (!params.expectedSessionId) {
      try {
        await touchSqliteAssistantAppendSessionEntry({
          agentId: transcriptAgentId,
          currentEntry,
          sessionKey: resolved.normalizedKey,
          storePath,
        });
      } catch (err) {
        return {
          ok: false,
          reason: formatErrorMessage(err),
        };
      }
    }
    return { ok: true, target, messageId, ...(anchor ? { anchor } : {}) };
  };
  return await appendToSession(entry);
}

async function touchSqliteAssistantAppendSessionEntry(params: {
  agentId?: string;
  currentEntry: SessionEntry;
  sessionKey: string;
  storePath: string;
}): Promise<void> {
  const now = Date.now();
  const buildPatch = (entry: SessionEntry | undefined): Partial<SessionEntry> => ({
    updatedAt: Math.max(entry?.updatedAt ?? 0, now),
    sessionStartedAt: entry?.sessionStartedAt ?? params.currentEntry.sessionStartedAt ?? now,
  });
  await updateSessionEntry(
    {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    (entry) => {
      if (entry.sessionId !== params.currentEntry.sessionId) {
        return null;
      }
      return buildPatch(entry);
    },
  );
}

function isRedundantDeliveryMirror(message: SessionTranscriptAssistantMessage): boolean {
  return (
    message.provider === OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER &&
    message.model === OPENCLAW_DELIVERY_MIRROR_MODEL
  );
}

async function readLatestVisibleTranscriptMessage(scope: {
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  storePath: string;
}): Promise<{ id?: string; message: unknown } | undefined> {
  const events = await loadTranscriptEvents(scope).catch(() => []);
  const tree = scanSessionTranscriptTree(events);
  const visiblePath = selectSessionTranscriptTreePathNodes(tree, tree.leafId);
  const visibleEvents =
    visiblePath.length > 0
      ? visiblePath.map((node) => node.entry)
      : tree.hasLeafControl
        ? []
        : events;
  for (const event of visibleEvents.toReversed()) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      continue;
    }
    const record = event as { id?: unknown; message?: unknown };
    if (record.message === undefined) {
      continue;
    }
    return {
      ...(typeof record.id === "string" ? { id: record.id } : {}),
      message: record.message,
    };
  }
  return undefined;
}

function isIdentifiedDeliveryMirror(message: SessionTranscriptAssistantMessage): boolean {
  const marker = (message as { openclawDeliveryMirror?: InternalSessionTranscriptDeliveryMirror })
    .openclawDeliveryMirror;
  return (
    isRedundantDeliveryMirror(message) &&
    (marker?.kind === "channel-final" ||
      marker?.kind === "channel-final-suppressed" ||
      marker?.kind === "message-tool-source-reply")
  );
}

function extractAssistantMessageText(message: SessionTranscriptAssistantMessage): string | null {
  if (!Array.isArray(message.content)) {
    return null;
  }

  const parts = message.content
    .filter(
      (
        part,
      ): part is {
        type: "text";
        text: string;
      } => part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0,
    )
    .map((part) => part.text.trim());

  return parts.length > 0 ? parts.join("\n").trim() : null;
}

async function findLatestEquivalentAssistantMessageId(
  target: SessionTranscriptTurnWriteContext,
  message: SessionTranscriptAssistantMessage,
  config?: OpenClawConfig,
): Promise<string | undefined> {
  const expectedText = extractAssistantMessageText(
    redactTranscriptMessage(message, config) as unknown as SessionTranscriptAssistantMessage,
  );
  if (!expectedText) {
    return undefined;
  }

  if (target.storePath && target.sessionId) {
    const latest = await readLatestVisibleTranscriptMessage({
      ...(target.agentId ? { agentId: target.agentId } : {}),
      sessionId: target.sessionId,
      ...(target.sessionKey ? { sessionKey: target.sessionKey } : {}),
      storePath: target.storePath,
    });
    const latestMessage = latest?.message as { role?: unknown } | undefined;
    if (latestMessage?.role !== "assistant") {
      return undefined;
    }
    const candidateText = latest
      ? extractAssistantMessageText(
          redactTranscriptMessage(
            latest.message as AgentMessage,
            config,
          ) as unknown as SessionTranscriptAssistantMessage,
        )
      : undefined;
    return candidateText === expectedText ? latest?.id : undefined;
  }

  return undefined;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
