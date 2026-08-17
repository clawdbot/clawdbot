import { randomUUID } from "node:crypto";
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { extractAssistantPhaseText } from "../../shared/chat-message-content.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import {
  collectSessionEntryLookupKeys,
  readSessionEntryRow,
  readSessionIdentitySnapshot,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { emitCommittedSessionIdentityDiff } from "./session-accessor.sqlite-identity.js";
import { loadTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import {
  getSessionKysely,
  normalizeSqliteSessionKey,
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedSqliteScope,
} from "./session-accessor.sqlite-scope.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import type {
  SessionBranchListParams,
  SessionBranchListResult,
  SessionBranchSummary,
  SessionBranchSwitchMutationParams,
  SessionBranchSwitchMutationResult,
  SessionMessageCutMutationParams,
  SessionMessageCutMutationResult,
} from "./session-accessor.types.js";
import { buildSessionCreationStamp } from "./session-entry-provenance.js";
import { inheritSessionSelection } from "./session-entry-selection.js";
import { reconcileSessionTranscriptIndexInTransaction } from "./session-transcript-index.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";
import {
  isSessionTranscriptLeafControl,
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
  type SessionTranscriptTree,
} from "./transcript-tree.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

type MessageCut = {
  status: "cut";
  editorText?: string;
  editorAttachments?: Array<{ mimeType: string; data: string }>;
  editorMediaRefs?: Array<{ path: string; contentType: string }>;
  parentId: string | null;
  prefix: TranscriptEvent[];
};

type SessionTranscriptMutationResult =
  | SessionMessageCutMutationResult
  | SessionBranchSwitchMutationResult
  | { status: "conflict" };

type SessionTranscriptMutationMode = "fork" | "rewind" | "switch";
type SessionEntryExpectedState = Pick<SessionEntry, "lifecycleRevision" | "sessionId">;

const BRANCH_HEADLINE_MAX_CHARS = 120;
const SESSION_BRANCH_CACHE_MAX_ENTRIES = 32;

type SessionBranchCacheEntry = {
  branches: SessionBranchSummary[];
  generation: string | null;
  maxSeq: number | null;
};

// Branch listing must not scale with transcript size on every request. Appends advance max(seq),
// while every in-place or replacement path rotates generation; cap the validated LRU at 32 sessions.
const sessionBranchCache = new Map<string, SessionBranchCacheEntry>();

function sessionBranchCacheKey(databasePath: string, sessionId: string): string {
  return `${databasePath}\0${sessionId}`;
}

function cloneSessionBranchSummaries(branches: readonly SessionBranchSummary[]) {
  return branches.map((branch) => ({ ...branch }));
}

function readSessionBranchWatermark(
  database: OpenClawAgentDatabase,
  sessionId: string,
): Pick<SessionBranchCacheEntry, "generation" | "maxSeq"> {
  const db = getSessionKysely(database.db);
  const maxSeq = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select((eb) => eb.fn.max<number>("seq").as("max_seq"))
      .where("session_id", "=", sessionId),
  )?.max_seq;
  const generation = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_rewrite_watermarks")
      .select("generation")
      .where("session_id", "=", sessionId),
  )?.generation;
  return { generation: generation ?? null, maxSeq: maxSeq ?? null };
}

function loadSessionBranchSummaries(
  database: OpenClawAgentDatabase,
  sessionId: string,
): SessionBranchSummary[] {
  const cacheKey = sessionBranchCacheKey(database.path, sessionId);
  const watermark = readSessionBranchWatermark(database, sessionId);
  const cached = sessionBranchCache.get(cacheKey);
  if (cached?.generation === watermark.generation && cached.maxSeq === watermark.maxSeq) {
    sessionBranchCache.delete(cacheKey);
    sessionBranchCache.set(cacheKey, cached);
    return cloneSessionBranchSummaries(cached.branches);
  }

  const branches = summarizeSessionBranches(loadTranscriptEventsFromDatabase(database, sessionId));
  sessionBranchCache.delete(cacheKey);
  sessionBranchCache.set(cacheKey, { ...watermark, branches });
  pruneMapToMaxSize(sessionBranchCache, SESSION_BRANCH_CACHE_MAX_ENTRIES);
  return cloneSessionBranchSummaries(branches);
}

function invalidateSessionBranchCache(databasePath: string, sessionIds: readonly string[]): void {
  for (const sessionId of uniqueStrings(sessionIds)) {
    sessionBranchCache.delete(sessionBranchCacheKey(databasePath, sessionId));
  }
}

export async function listSessionBranches(
  params: SessionBranchListParams,
): Promise<SessionBranchListResult> {
  const sourceKey = normalizeSqliteSessionKey(params.sessionStoreKey ?? params.sessionKey);
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.env ? { env: params.env } : {}),
    sessionKey: sourceKey,
    ...(params.storePath ? { storePath: params.storePath } : {}),
  });
  try {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const currentEntry = readSessionEntryRow(database, sourceKey)?.entry;
    if (!currentEntry?.sessionId) {
      return { status: "missing-session" };
    }
    return {
      status: "ok",
      branches: loadSessionBranchSummaries(database, currentEntry.sessionId),
    };
  } catch {
    return { status: "failed" };
  }
}

/** Resolves the active branch leaf from the same transcript tree used by branch listing. */
export function resolveSessionTranscriptActiveLeafEntryId(
  events: readonly TranscriptEvent[],
): string | undefined {
  return scanSessionTranscriptTree(events).leafId ?? undefined;
}

export async function rewindSessionToMessage(
  params: SessionMessageCutMutationParams,
  expectedState?: SessionEntryExpectedState,
): Promise<SessionMessageCutMutationResult | { status: "conflict" }> {
  return await mutateSqliteSessionAtMessage(params, "rewind", expectedState);
}

export async function forkSessionAtMessage(
  params: SessionMessageCutMutationParams & { targetKey: string },
  expectedState?: SessionEntryExpectedState,
): Promise<SessionMessageCutMutationResult | { status: "conflict" }> {
  return await mutateSqliteSessionAtMessage(params, "fork", expectedState);
}

export async function switchSessionBranch(
  params: SessionBranchSwitchMutationParams,
  expectedState?: SessionEntryExpectedState,
): Promise<SessionBranchSwitchMutationResult | { status: "conflict" }> {
  return await mutateSqliteSessionAtMessage(
    { ...params, entryId: params.leafEntryId },
    "switch",
    expectedState,
  );
}

function mutateSqliteSessionAtMessage(
  params: SessionMessageCutMutationParams,
  mode: "fork" | "rewind",
  expectedState?: SessionEntryExpectedState,
): Promise<SessionMessageCutMutationResult | { status: "conflict" }>;
function mutateSqliteSessionAtMessage(
  params: SessionMessageCutMutationParams,
  mode: "switch",
  expectedState?: SessionEntryExpectedState,
): Promise<SessionBranchSwitchMutationResult | { status: "conflict" }>;

async function mutateSqliteSessionAtMessage(
  params: SessionMessageCutMutationParams,
  mode: SessionTranscriptMutationMode,
  expectedState?: SessionEntryExpectedState,
): Promise<SessionTranscriptMutationResult> {
  const canonicalSourceKey = normalizeSqliteSessionKey(params.sessionKey);
  const sourceKey = normalizeSqliteSessionKey(params.sessionStoreKey ?? params.sessionKey);
  const targetKey =
    mode === "fork" ? normalizeSqliteSessionKey(params.targetKey ?? params.sessionKey) : sourceKey;
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.env ? { env: params.env } : {}),
    sessionKey: sourceKey,
    ...(params.storePath ? { storePath: params.storePath } : {}),
  });
  const preparedEntry = readSessionEntryRow(
    openOpenClawAgentDatabase(toDatabaseOptions(resolved)),
    sourceKey,
  )?.entry;
  const preparedExpectedState =
    expectedState ??
    (preparedEntry?.sessionId
      ? {
          sessionId: preparedEntry.sessionId,
          lifecycleRevision: preparedEntry.lifecycleRevision,
        }
      : undefined);
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    let previousIdentity = new Map<string, SessionEntry>();
    let currentIdentity = new Map<string, SessionEntry>();
    let databasePath: string | undefined;
    const result = runOpenClawAgentWriteTransaction((database) => {
      databasePath = database.path;
      const identityKeys = uniqueStrings([
        ...collectSessionEntryLookupKeys(database, sourceKey),
        ...collectSessionEntryLookupKeys(database, targetKey),
      ]);
      previousIdentity = readSessionIdentitySnapshot(database, identityKeys);
      const mutationResult = mutateSqliteSessionAtMessageInTransaction(database, resolved, {
        entryId: params.entryId,
        canonicalSourceKey,
        creation: params.creation,
        mode,
        expectedState: preparedExpectedState,
        sourceKey,
        targetKey,
      });
      currentIdentity = readSessionIdentitySnapshot(database, identityKeys);
      return mutationResult;
    }, toDatabaseOptions(resolved));
    if (result.status === "created" && databasePath) {
      invalidateSessionBranchCache(databasePath, [
        ...[...previousIdentity.values()].flatMap((entry) =>
          entry.sessionId ? [entry.sessionId] : [],
        ),
        ...(result.entry.sessionId ? [result.entry.sessionId] : []),
      ]);
    }
    emitCommittedSessionIdentityDiff(previousIdentity, currentIdentity);
    return result;
  });
}

function mutateSqliteSessionAtMessageInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedSqliteScope,
  params: {
    canonicalSourceKey: string;
    creation?: SessionMessageCutMutationParams["creation"];
    entryId: string;
    expectedState: SessionEntryExpectedState | undefined;
    mode: SessionTranscriptMutationMode;
    sourceKey: string;
    targetKey: string;
  },
): SessionTranscriptMutationResult {
  const currentEntry = readSessionEntryRow(database, params.sourceKey)?.entry;
  if (!currentEntry?.sessionId) {
    return { status: "missing-session" };
  }
  if (
    !params.expectedState ||
    currentEntry.sessionId !== params.expectedState.sessionId ||
    currentEntry.lifecycleRevision !== params.expectedState.lifecycleRevision
  ) {
    return { status: "conflict" };
  }
  const events = loadTranscriptEventsFromDatabase(database, currentEntry.sessionId);
  const cut = params.mode === "switch" ? undefined : resolveMessageCut(events, params.entryId);
  if (cut && cut.status !== "cut") {
    return cut;
  }
  if (params.mode === "switch") {
    const tipStatus = validateBranchTip(events, params.entryId);
    if (tipStatus) {
      return { status: tipStatus };
    }
  }

  const nextSessionId = randomUUID();
  const targetScope = {
    ...resolved,
    sessionId: nextSessionId,
    sessionKey: params.targetKey,
  };
  const header = createSessionTranscriptHeader({
    cwd: readTranscriptHeaderCwd(events),
    sessionId: nextSessionId,
  });
  const nextEvents =
    params.mode === "fork" && cut?.status === "cut"
      ? [header, ...cut.prefix]
      : [
          header,
          ...events.filter((event) => !isSessionHeader(event)),
          {
            type: "leaf",
            id: uniqueEntryId(events),
            parentId: readLastEventId(events),
            timestamp: new Date().toISOString(),
            targetId: params.mode === "switch" ? params.entryId : (cut?.parentId ?? null),
          },
        ];
  appendTranscriptEventsInTransaction(database, targetScope, nextEvents);
  if (params.mode !== "fork") {
    reconcileSessionTranscriptIndexInTransaction(database.db, nextSessionId);
  }

  // Rotating transcript identity fences stale live managers: later snapshot-replace writes
  // target the old session and cannot erase this leaf repoint from the active session.
  const nextEntry = {
    ...cloneMessageCutSessionEntry({
      currentEntry,
      forked: params.mode === "fork",
      forkSource:
        params.mode === "fork"
          ? {
              sessionKey: params.canonicalSourceKey,
              sessionId: currentEntry.sessionId,
              entryId: params.entryId,
            }
          : undefined,
      nextSessionId,
    }),
    ...(params.mode === "fork" && params.creation
      ? buildSessionCreationStamp(params.creation)
      : {}),
  };
  writeSessionEntry(database, params.targetKey, nextEntry);
  return {
    status: "created",
    key: params.targetKey,
    entry: nextEntry,
    ...(cut?.status === "cut" && cut.editorText ? { editorText: cut.editorText } : {}),
    ...(cut?.status === "cut" && cut.editorAttachments
      ? { editorAttachments: cut.editorAttachments }
      : {}),
    ...(cut?.status === "cut" && cut.editorMediaRefs
      ? { editorMediaRefs: cut.editorMediaRefs }
      : {}),
  };
}

function validateBranchTip(
  events: readonly TranscriptEvent[],
  entryId: string,
): "missing-entry" | "not-branch-tip" | "already-active" | undefined {
  const tree = scanSessionTranscriptTree(events);
  const target = tree.byId.get(entryId);
  if (!target) {
    return "missing-entry";
  }
  if (isSessionTranscriptLeafControl(target.entry)) {
    return "not-branch-tip";
  }
  if (!sessionBranchTipNodes(tree).some((node) => node.id === entryId)) {
    return "not-branch-tip";
  }
  return tree.leafId === entryId ? "already-active" : undefined;
}

function summarizeSessionBranches(events: readonly TranscriptEvent[]): SessionBranchSummary[] {
  const tree = scanSessionTranscriptTree(events);
  return sessionBranchTipNodes(tree)
    .toSorted(
      (left, right) =>
        Number(right.id === tree.leafId) - Number(left.id === tree.leafId) ||
        right.index - left.index,
    )
    .map((node) => summarizeSessionBranch(tree, node.id));
}

function sessionBranchTipNodes(tree: SessionTranscriptTree<TranscriptEvent>) {
  const referencedParents = new Set(
    tree.nodes.flatMap((node) =>
      isSessionTranscriptLeafControl(node.entry) || node.parentId === null ? [] : [node.parentId],
    ),
  );
  return tree.nodes.filter(
    (node) =>
      !isSessionTranscriptLeafControl(node.entry) &&
      (node.id === tree.leafId || !referencedParents.has(node.id)),
  );
}

function summarizeSessionBranch(
  tree: SessionTranscriptTree<TranscriptEvent>,
  leafEntryId: string,
): SessionBranchSummary {
  const path = selectSessionTranscriptTreePathNodes(tree, leafEntryId);
  const messages = path.flatMap((node) => {
    const record = asRecord(node.entry);
    return record?.type === "message" ? [record] : [];
  });
  const headline = messages
    .toReversed()
    .map((record) => extractHeadlineText(record.message))
    .find((value): value is string => value !== undefined);
  const timestamp = asRecord(tree.byId.get(leafEntryId)?.entry)?.timestamp;
  return {
    leafEntryId,
    headline: truncateBranchHeadline(headline ?? ""),
    messageCount: messages.length,
    ...(typeof timestamp === "string" && timestamp.trim() ? { updatedAt: timestamp } : {}),
    active: tree.leafId === leafEntryId,
  };
}

function extractHeadlineText(messageValue: unknown): string | undefined {
  const message = asRecord(messageValue);
  if (message?.role !== "user" && message?.role !== "assistant") {
    return undefined;
  }
  const text =
    message.role === "assistant"
      ? extractAssistantPhaseText(message)
      : extractEditorText(message.content ?? message.text);
  const normalized = text?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function truncateBranchHeadline(value: string): string {
  const characters = Array.from(value);
  return characters.length <= BRANCH_HEADLINE_MAX_CHARS
    ? value
    : `${characters.slice(0, BRANCH_HEADLINE_MAX_CHARS - 1).join("")}…`;
}

function resolveMessageCut(
  events: readonly TranscriptEvent[],
  entryId: string,
): MessageCut | Exclude<SessionMessageCutMutationResult, { status: "created" }> {
  const tree = scanSessionTranscriptTree(events);
  const target = tree.byId.get(entryId);
  if (!target) {
    return { status: "missing-entry" };
  }
  const record = asRecord(target.entry);
  const message = asRecord(record?.message);
  if (record?.type !== "message" || message?.role !== "user") {
    return { status: "not-user-message" };
  }
  const activePath = selectSessionTranscriptTreePathNodes(tree, tree.leafId);
  const targetIndex = activePath.findIndex((node) => node.id === entryId);
  if (targetIndex < 0) {
    return { status: "off-active-path" };
  }
  const prefix: TranscriptEvent[] = [];
  for (const node of activePath.slice(0, targetIndex)) {
    const entry = asRecord(node.entry);
    // Spread (not Object.assign) so a parsed own `__proto__` key stays an inert
    // data property instead of rebinding the copy's prototype.
    prefix.push(
      entry && entry.parentId !== node.parentId
        ? ({ ...entry, parentId: node.parentId } as TranscriptEvent)
        : node.entry,
    );
  }
  const editorAttachments = extractEditorAttachments(message.content);
  const editorMediaRefs = extractEditorMediaRefs(message);
  return {
    status: "cut",
    editorText: extractEditorText(message.content),
    ...(editorAttachments ? { editorAttachments } : {}),
    ...(editorMediaRefs ? { editorMediaRefs } : {}),
    parentId: target.parentId,
    prefix,
  };
}

function cloneMessageCutSessionEntry(params: {
  currentEntry: SessionEntry;
  forked: boolean;
  forkSource?: NonNullable<SessionEntry["forkSource"]>;
  nextSessionId: string;
}): SessionEntry {
  const baseEntry = params.forked
    ? inheritSessionSelection(params.currentEntry)
    : params.currentEntry;
  return {
    ...baseEntry,
    sessionId: params.nextSessionId,
    lifecycleRevision: params.forked ? randomUUID() : params.currentEntry.lifecycleRevision,
    updatedAt: Date.now(),
    systemSent: false,
    abortedLastRun: false,
    lifecycleRunId: undefined,
    startedAt: undefined,
    endedAt: undefined,
    runtimeMs: undefined,
    status: undefined,
    inputTokens: undefined,
    outputTokens: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
    estimatedCostUsd: undefined,
    totalTokens: undefined,
    totalTokensFresh: undefined,
    totalTokensVersion: undefined,
    // A rotated transcript cannot resume provider/runtime identity from the old tail.
    // Clear transcript-derived accounting too so the next turn rebuilds canonical state.
    contextTokens: undefined,
    contextBudgetStatus: undefined,
    compactionCount: undefined,
    compactionCheckpoints: undefined,
    memoryFlush: undefined,
    cliSessionBindings: undefined,
    cliSessionIds: undefined,
    claudeCliSessionId: undefined,
    agentHarnessId: undefined,
    modelSelectionLocked: undefined,
    skillsSnapshot: undefined,
    systemPromptReport: undefined,
    restartRecoveryRuns: undefined,
    restartRecoveryForceSafeTools: undefined,
    abortCutoffMessageSid: undefined,
    abortCutoffTimestamp: undefined,
    usageFamilyKey: params.forked ? undefined : params.currentEntry.usageFamilyKey,
    usageFamilySessionIds: params.forked ? undefined : params.currentEntry.usageFamilySessionIds,
    previousSessionId: params.forked ? undefined : params.currentEntry.sessionId,
    ...(params.forkSource
      ? { forkSource: params.forkSource, parentSessionKey: params.forkSource.sessionKey }
      : {}),
  };
}

function extractEditorText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .flatMap((block) => {
      const record = asRecord(block);
      return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
    })
    .join("");
  return text || undefined;
}

// Gateway-written inline images are already size-capped at send time; these bounds
// only keep a corrupted transcript from ballooning the rewind/fork response.
const EDITOR_ATTACHMENT_LIMIT = 10;
const EDITOR_ATTACHMENT_MAX_BASE64_CHARS = Math.ceil((5 * 1024 * 1024) / 3) * 4;

function extractEditorAttachments(
  content: unknown,
): Array<{ mimeType: string; data: string }> | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const attachments = content.flatMap((block) => {
    const record = asRecord(block);
    return record?.type === "image" &&
      typeof record.data === "string" &&
      record.data.trim() &&
      record.data.length <= EDITOR_ATTACHMENT_MAX_BASE64_CHARS &&
      typeof record.mimeType === "string" &&
      record.mimeType.startsWith("image/")
      ? [{ mimeType: record.mimeType, data: record.data }]
      : [];
  });
  return attachments.length > 0 ? attachments.slice(0, EDITOR_ATTACHMENT_LIMIT) : undefined;
}

function extractEditorMediaRefs(
  message: Record<string, unknown>,
): Array<{ path: string; contentType: string }> | undefined {
  const media = asRecord(message["__openclaw"])?.media;
  if (!Array.isArray(media)) {
    return undefined;
  }
  const refs = media.flatMap((entry) => {
    const record = asRecord(entry);
    const mediaPath = typeof record?.path === "string" ? record.path.trim() : "";
    const contentType = record?.contentType;
    return mediaPath && typeof contentType === "string" && contentType.startsWith("image/")
      ? [{ path: mediaPath, contentType }]
      : [];
  });
  return refs.length > 0 ? refs : undefined;
}

function isSessionHeader(event: unknown): boolean {
  return asRecord(event)?.type === "session";
}

function readTranscriptHeaderCwd(events: readonly TranscriptEvent[]): string | undefined {
  const cwd = asRecord(events.find(isSessionHeader))?.cwd;
  return typeof cwd === "string" && cwd.trim() ? cwd : undefined;
}

function readLastEventId(events: readonly TranscriptEvent[]): string | null {
  const id = asRecord(events.findLast((event) => !isSessionHeader(event)))?.id;
  return typeof id === "string" && id.trim() ? id : null;
}

function uniqueEntryId(events: readonly TranscriptEvent[]): string {
  const ids = new Set(
    events.flatMap((event) => {
      const id = asRecord(event)?.id;
      return typeof id === "string" ? [id] : [];
    }),
  );
  for (;;) {
    const id = randomUUID().slice(0, 8);
    if (!ids.has(id)) {
      return id;
    }
  }
}
