// Session transcript facade resolves transcript files, appends mirror messages, and reads tails.
import path from "node:path";
import type { AgentMessage } from "../../agents/runtime/index.js";
import type { SessionManager } from "../../agents/sessions/session-manager.js";
import { redactTranscriptMessage } from "../../agents/transcript-redact.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { parseAgentSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  extractAssistantVisibleText,
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
  resolveDefaultSessionStorePath,
  resolveSessionFilePath,
  resolveStorePath,
} from "./paths.js";
import {
  listSessionEntries,
  loadSessionEntry,
  loadTranscriptEvents,
  persistSessionTranscriptTurn,
  readLatestTranscriptAssistantText,
  updateSessionEntry,
  type SessionTranscriptTurnWriteContext,
  type SessionTranscriptTurnExpectedState,
} from "./session-accessor.js";
import type { SessionTranscriptTurnLifecyclePatch } from "./session-transcript-turn-lifecycle.types.js";
import { parseSqliteSessionFileMarker, type SqliteSessionFileMarker } from "./sqlite-marker.js";
import { resolveSessionStoreEntry } from "./store.js";
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
import type { SessionEntry } from "./types.js";

export type SessionTranscriptAppendResult =
  | { ok: true; sessionFile: string; messageId: string }
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
  agentId?: string;
  sessionKey: string;
  storePath?: string;
};

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
  const text = extractAssistantVisibleText(message)?.trim();
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
  sessionFile?: string;
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
      ? extractAssistantVisibleText(message)
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
  return (await readRecentUserAssistantTextFromSqliteTranscriptWithPresence(scope, options)).recent;
}

async function readRecentUserAssistantTextFromSqliteTranscriptWithPresence(
  scope: SqliteSessionFileMarker,
  options: ReadRecentSessionConversationTextOptions = {},
): Promise<{ recent: SessionRecentConversationText[]; hasEvents: boolean }> {
  const events = await loadTranscriptEvents({
    agentId: scope.agentId,
    sessionId: scope.sessionId,
    storePath: scope.storePath,
  });
  const limit = normalizeRecentTranscriptLimit(options.limit);
  const recent: SessionRecentConversationText[] = [];
  for (const event of events.toReversed()) {
    const entry = parseRecentConversationText(JSON.stringify(event), options);
    if (!entry) {
      continue;
    }
    if (!isWithinTranscriptWindow(entry.timestamp, options)) {
      continue;
    }
    recent.push(entry);
    if (recent.length >= limit) {
      break;
    }
  }
  return { recent: recent.toReversed(), hasEvents: events.length > 0 };
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
  const agentId = params.agentId ?? resolveAgentIdFromSessionKey(sessionKey) ?? "main";
  const storePath = params.storePath ?? resolveDefaultSessionStorePath(agentId);
  const entry = loadSessionEntry({ agentId, sessionKey, storePath });
  if (!entry?.sessionId) {
    return {};
  }
  return {
    sessionFile: resolveSessionFilePath(entry.sessionId, entry, {
      sessionsDir: path.dirname(storePath),
      agentId,
    }),
    sqliteScope: {
      agentId,
      sessionId: entry.sessionId,
      storePath,
    },
  };
}

async function readRecentUserAssistantTextFromSessionTranscript(
  sessionFile: string | undefined,
  options: ReadRecentSessionConversationTextOptions = {},
): Promise<SessionRecentConversationText[]> {
  const sqliteMarker = parseSqliteSessionFileMarker(sessionFile);
  if (sqliteMarker) {
    return await readRecentUserAssistantTextFromSqliteTranscript(sqliteMarker, options);
  }
  if (!sessionFile?.trim()) {
    return [];
  }
  const limit = normalizeRecentTranscriptLimit(options.limit);
  const recent: SessionRecentConversationText[] = [];
  for await (const line of streamSessionTranscriptLinesReverse(sessionFile)) {
    try {
      const entry = parseRecentConversationText(line, options);
      if (!entry) {
        continue;
      }
      if (!isWithinTranscriptWindow(entry.timestamp, options)) {
        continue;
      }
      recent.push(entry);
      if (recent.length >= limit) {
        break;
      }
    } catch {
      continue;
    }
  }
  return recent.toReversed();
}

export async function readRecentUserAssistantTextForSession(
  params: ReadRecentSessionConversationTextParams,
): Promise<SessionRecentConversationText[]> {
  const target = resolveSessionConversationTranscriptTarget(params);
  if (target.sqliteScope) {
    const sqliteRecent = await readRecentUserAssistantTextFromSqliteTranscriptWithPresence(
      target.sqliteScope,
      params,
    );
    return sqliteRecent.recent;
  }
  return await readRecentUserAssistantTextFromSessionTranscript(target.sessionFile, params);
}

export async function readLatestAssistantTextFromSessionTranscript(
  sessionFile: string | undefined,
): Promise<LatestAssistantTranscriptText | undefined> {
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
  sessionFile: string | undefined,
  options?: { excludeTranscriptOnlyOpenClawAssistant?: boolean },
): Promise<TailAssistantTranscriptText | undefined> {
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
  const storeAgentId = transcriptAgentId ?? resolveAgentIdFromSessionKey(sessionKey);
  const storePath =
    params.storePath ?? resolveStorePath(params.config?.session?.store, { agentId: storeAgentId });
  const store = Object.fromEntries(
    listSessionEntries({ agentId: transcriptAgentId, storePath }).map(
      ({ sessionKey: entryKey, entry }) => [entryKey, entry],
    ),
  );
  const resolved = resolveSessionStoreEntry({ store, sessionKey });
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
  if (!entry?.sessionId) {
    return { ok: false, reason: `unknown sessionKey: ${sessionKey}` };
  }

  const appendToSessionFile = async (
    currentEntry: NonNullable<typeof entry>,
    sessionFile?: string,
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
    let latestEquivalentAssistantId: string | undefined;
    // Identified delivery mirrors, including suppressed finals, dedupe only by
    // key so same-text markers from different source ids remain separate rows.
    const turn = await persistSessionTranscriptTurn(
      {
        sessionId: currentEntry.sessionId,
        sessionKey: resolved.normalizedKey,
        storePath,
        ...(sessionFile ? { sessionFile } : {}),
        ...(transcriptAgentId ? { agentId: transcriptAgentId } : {}),
      },
      {
        cwd: currentEntry.spawnedCwd,
        ...(params.expectedSessionId ? { expectedSessionId: params.expectedSessionId } : {}),
        ...(params.expectedLifecycleRevision !== undefined
          ? { expectedLifecycleRevision: params.expectedLifecycleRevision }
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
            shouldAppend: async (target) => {
              latestEquivalentAssistantId =
                isRedundantDeliveryMirror(params.message) && !identifiedDeliveryMirror
                  ? await findLatestEquivalentAssistantMessageId(
                      target,
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
      return { ok: true, sessionFile: turn.sessionFile, messageId: latestEquivalentAssistantId };
    }
    const appendedResult = turn.messages[0];
    if (!appendedResult) {
      return {
        ok: false,
        code: "blocked",
        reason: "blocked by before_message_write",
      };
    }
    const { messageId } = appendedResult;
    if (!params.expectedSessionId) {
      try {
        if (parseSqliteSessionFileMarker(turn.sessionFile)) {
          await touchSqliteAssistantAppendSessionEntry({
            agentId: transcriptAgentId,
            currentEntry,
            sessionFile: turn.sessionFile,
            sessionKey: resolved.normalizedKey,
            storePath,
          });
        } else {
          return { ok: false, reason: `unexpected transcript target: ${turn.sessionFile}` };
        }
      } catch (err) {
        return {
          ok: false,
          reason: formatErrorMessage(err),
        };
      }
    }
    return { ok: true, sessionFile: turn.sessionFile, messageId };
  };

  let result: SessionTranscriptAppendResult;
  if (params.expectedSessionId) {
    result = await appendToSessionFile(entry);
  } else {
    result = await appendToSessionFile(entry);
  }
  return result;
}

async function touchSqliteAssistantAppendSessionEntry(params: {
  agentId?: string;
  currentEntry: SessionEntry;
  sessionFile: string;
  sessionKey: string;
  storePath: string;
}): Promise<void> {
  const now = Date.now();
  const buildPatch = (entry: SessionEntry | undefined): Partial<SessionEntry> => ({
    updatedAt: Math.max(entry?.updatedAt ?? 0, now),
    sessionStartedAt: entry?.sessionStartedAt ?? params.currentEntry.sessionStartedAt ?? now,
    sessionFile: params.sessionFile,
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

  for await (const line of streamSessionTranscriptLinesReverse(target.sessionFile)) {
    try {
      const parsed = JSON.parse(line) as {
        id?: unknown;
        message?: SessionTranscriptAssistantMessage;
      };
      const candidate = parsed.message;
      if (!candidate) {
        continue;
      }
      if (candidate.role !== "assistant") {
        return undefined;
      }
      // Only the tail message can be a duplicate mirror replay.
      const candidateText = extractAssistantMessageText(
        redactTranscriptMessage(
          candidate as AgentMessage,
          config,
        ) as unknown as SessionTranscriptAssistantMessage,
      );
      if (candidateText !== expectedText) {
        return undefined;
      }
      if (typeof parsed.id === "string" && parsed.id) {
        return parsed.id;
      }
      return undefined;
    } catch {
      continue;
    }
  }

  return undefined;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
