import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ensureOpenClawAgentStandingIntentsSchema,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  openOpenClawAgentDatabase,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-runtime";

export const DEFAULT_INTENT_COOLDOWN_SECONDS = 24 * 60 * 60;
export const DEFAULT_INTENT_MAX_FIRES = 3;
export const DEFAULT_INTENT_EXPIRY_MS = 90 * 24 * 60 * 60_000;
const INTENT_MATCH_CANDIDATE_BATCH_SIZE = 32;
const INTENT_MATCH_CANDIDATE_LIMIT = 256;
const INTENT_INJECTION_MAX_COUNT = 3;
export const INTENT_INJECTION_MAX_CHARS = 1_200;

export type StandingIntentStatus = "pending" | "armed" | "fired" | "done" | "cancelled" | "expired";

export type StandingIntent = {
  id: string;
  description: string;
  triggerKeywords: string[];
  triggerEmbedding: string | null;
  scope: IntentScope;
  channelScope: string | null;
  senderScope: string | null;
  creatorSender: string | null;
  status: StandingIntentStatus;
  expiresAt: number;
  maxFires: number;
  fireCount: number;
  cooldownSeconds: number;
  lastFiredAt: number | null;
  createdAt: number;
  sourceSessionId: string | null;
};

type StandingIntentRow = {
  id: string;
  description: string;
  trigger_keywords: string;
  trigger_embedding: string | null;
  channel_scope: string | null;
  sender_scope: string | null;
  creator_sender: string | null;
  status: StandingIntentStatus;
  expires_at: number;
  max_fires: number;
  fire_count: number;
  cooldown_seconds: number;
  last_fired_at: number | null;
  created_at: number;
  source_session_id: string | null;
};

type StandingIntentDatabase = {
  standing_intents: StandingIntentRow;
};

type StandingIntentMatchDatabase = {
  standing_intents: StandingIntentRow & { intent_key: number };
  standing_intents_fts: {
    rowid: number;
    trigger_keywords: string;
  };
};

export type IntentScope = "conversation" | "channel" | "anywhere";

type StoredChannelScope = ["v1", "channel" | "conversation", string, string, string];
type StoredSenderScope = ["v1", string, string, string];

function withStandingIntentDatabase<T>(agentId: string, callback: (db: DatabaseSync) => T): T {
  const db = openOpenClawAgentDatabase({ agentId }).db;
  ensureOpenClawAgentStandingIntentsSchema(db);
  return callback(db);
}

function normalizeScopeIdentity(value: string, field: string, lowercase = false): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} is unavailable for this creating turn`);
  }
  return lowercase ? normalized.toLowerCase() : normalized;
}

function normalizeScopeAccountId(accountId: string | undefined): string {
  return accountId?.trim() || "default";
}

function normalizeCreatorSender(value: string): string {
  const creatorSender = value.trim();
  if (!creatorSender || creatorSender.toLowerCase() === "unknown") {
    throw new Error("creating sender is unavailable for this turn");
  }
  return creatorSender;
}

function readKnownCreatorSender(value: string | null): string | null {
  const creatorSender = value?.trim();
  return creatorSender && creatorSender.toLowerCase() !== "unknown" ? creatorSender : null;
}

export function encodeStandingIntentChannelScope(params: {
  scope: Exclude<IntentScope, "anywhere">;
  provider: string;
  accountId?: string;
  conversationId?: string;
}): string {
  const provider = normalizeScopeIdentity(params.provider, "channel identity", true);
  const identity =
    params.scope === "channel"
      ? provider
      : normalizeScopeIdentity(params.conversationId ?? "", "conversation identity");
  return JSON.stringify([
    "v1",
    params.scope,
    provider,
    normalizeScopeAccountId(params.accountId),
    identity,
  ] satisfies StoredChannelScope);
}

export function encodeStandingIntentSenderScope(params: {
  provider: string;
  accountId?: string;
  senderId: string;
}): string {
  return JSON.stringify([
    "v1",
    normalizeScopeIdentity(params.provider, "channel identity", true),
    normalizeScopeAccountId(params.accountId),
    normalizeScopeIdentity(params.senderId, "sender identity"),
  ] satisfies StoredSenderScope);
}

function parseStoredChannelScope(value: string | null): {
  scope: IntentScope;
  identity: string | null;
} {
  if (value === null) {
    return { scope: "anywhere", identity: null };
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length === 5 &&
      parsed[0] === "v1" &&
      (parsed[1] === "channel" || parsed[1] === "conversation") &&
      parsed.slice(2).every((entry) => typeof entry === "string" && entry.length > 0)
    ) {
      return { scope: parsed[1], identity: parsed[4] as string };
    }
  } catch {}
  // Standing-intent storage is unreleased. Untagged rows are not a compatibility
  // contract and must fail closed rather than collapsing provider/conversation scopes.
  return { scope: "anywhere", identity: null };
}

function parseStoredSenderScope(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) &&
      parsed.length === 4 &&
      parsed[0] === "v1" &&
      parsed.slice(1).every((entry) => typeof entry === "string" && entry.length > 0)
      ? (parsed[3] as string)
      : null;
  } catch {
    // See parseStoredChannelScope: raw sender ids are not globally safe identities.
    return null;
  }
}

function rowToIntent(row: StandingIntentRow): StandingIntent {
  const channelScope = parseStoredChannelScope(row.channel_scope);
  return {
    id: row.id,
    description: row.description,
    triggerKeywords: parseStoredTriggerKeywords(row.trigger_keywords),
    triggerEmbedding: row.trigger_embedding,
    scope: channelScope.scope,
    channelScope: channelScope.identity,
    senderScope: parseStoredSenderScope(row.sender_scope),
    creatorSender: readKnownCreatorSender(row.creator_sender),
    status: row.status,
    expiresAt: row.expires_at,
    maxFires: row.max_fires,
    fireCount: row.fire_count,
    cooldownSeconds: row.cooldown_seconds,
    lastFiredAt: row.last_fired_at,
    createdAt: row.created_at,
    sourceSessionId: row.source_session_id,
  };
}

function parseStoredTriggerKeywords(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string" && Boolean(entry))
      : [];
  } catch {
    return [];
  }
}

function shouldRearm(row: StandingIntentRow, nowMs: number): boolean {
  if (row.status !== "fired" || row.last_fired_at === null) {
    return false;
  }
  return row.last_fired_at + row.cooldown_seconds * 1_000 <= nowMs;
}

function maintainStandingIntentLifecycle(db: DatabaseSync, nowMs: number): void {
  const kysely = getNodeSqliteKysely<StandingIntentDatabase>(db);
  executeSqliteQuerySync(
    db,
    kysely
      .updateTable("standing_intents")
      .set({ status: "expired" })
      .where("status", "in", ["pending", "armed", "fired"])
      .where("expires_at", "<=", nowMs),
  );
  const fired = executeSqliteQuerySync(
    db,
    kysely
      .selectFrom("standing_intents")
      .selectAll()
      .where("status", "=", "fired")
      .where("expires_at", ">", nowMs)
      .whereRef("fire_count", "<", "max_fires"),
  ).rows;
  for (const row of fired) {
    if (!shouldRearm(row, nowMs)) {
      continue;
    }
    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("standing_intents")
        .set({ status: "armed" })
        .where("id", "=", row.id)
        .where("status", "=", "fired"),
    );
  }
}

export function createStandingIntent(params: {
  agentId: string;
  description: string;
  triggerKeywords: string[];
  channelScope?: string | null;
  senderScope?: string | null;
  creatorSender: string;
  expiresAt?: number;
  maxFires?: number;
  cooldownSeconds?: number;
  sourceSessionId?: string | null;
  nowMs?: number;
}): StandingIntent {
  const nowMs = params.nowMs ?? Date.now();
  const row: StandingIntentRow = {
    id: randomUUID(),
    description: params.description,
    trigger_keywords: JSON.stringify(params.triggerKeywords),
    trigger_embedding: null,
    channel_scope: params.channelScope ?? null,
    sender_scope: params.senderScope ?? null,
    creator_sender: normalizeCreatorSender(params.creatorSender),
    status: "armed",
    expires_at: params.expiresAt ?? nowMs + DEFAULT_INTENT_EXPIRY_MS,
    max_fires: params.maxFires ?? DEFAULT_INTENT_MAX_FIRES,
    fire_count: 0,
    cooldown_seconds: params.cooldownSeconds ?? DEFAULT_INTENT_COOLDOWN_SECONDS,
    last_fired_at: null,
    created_at: nowMs,
    source_session_id: params.sourceSessionId ?? null,
  };
  withStandingIntentDatabase(params.agentId, (db) => {
    runSqliteImmediateTransactionSync(db, () => {
      const kysely = getNodeSqliteKysely<StandingIntentDatabase>(db);
      executeSqliteQuerySync(db, kysely.insertInto("standing_intents").values(row));
    });
  });
  return rowToIntent(row);
}

export function listStandingIntents(params: {
  agentId: string;
  status?: StandingIntentStatus;
  nowMs?: number;
}): StandingIntent[] {
  return withStandingIntentDatabase(params.agentId, (db) =>
    runSqliteImmediateTransactionSync(db, () => {
      const nowMs = params.nowMs ?? Date.now();
      maintainStandingIntentLifecycle(db, nowMs);
      const kysely = getNodeSqliteKysely<StandingIntentDatabase>(db);
      let query = kysely.selectFrom("standing_intents").selectAll();
      if (params.status) {
        query = query.where("status", "=", params.status);
      }
      return executeSqliteQuerySync(
        db,
        query.orderBy("created_at", "asc").orderBy("id", "asc"),
      ).rows.map(rowToIntent);
    }),
  );
}

export function sweepStandingIntents(params: { agentId: string; nowMs?: number }): void {
  withStandingIntentDatabase(params.agentId, (db) => {
    runSqliteImmediateTransactionSync(db, () => {
      maintainStandingIntentLifecycle(db, params.nowMs ?? Date.now());
    });
  });
}

export function cancelStandingIntent(params: {
  agentId: string;
  id: string;
}): StandingIntent | null {
  return withStandingIntentDatabase(params.agentId, (db) =>
    runSqliteImmediateTransactionSync(db, () => {
      const kysely = getNodeSqliteKysely<StandingIntentDatabase>(db);
      const result = executeSqliteQuerySync(
        db,
        kysely
          .updateTable("standing_intents")
          .set({ status: "cancelled" })
          .where("id", "=", params.id)
          .where("status", "in", ["pending", "armed", "fired"]),
      );
      if (result.numAffectedRows === 0n) {
        return null;
      }
      const row = executeSqliteQueryTakeFirstSync(
        db,
        kysely.selectFrom("standing_intents").selectAll().where("id", "=", params.id),
      );
      return row ? rowToIntent(row) : null;
    }),
  );
}

function tokenizeIntentText(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

function buildFtsQuery(promptTokens: ReadonlySet<string>): string | null {
  const unique = [...promptTokens];
  if (unique.length === 0) {
    return null;
  }
  return unique.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}

function triggerMatchesPrompt(row: StandingIntentRow, promptTokens: ReadonlySet<string>): boolean {
  return parseStoredTriggerKeywords(row.trigger_keywords)
    .map((keyword) => tokenizeIntentText(keyword))
    .some(
      (keywordTokens) =>
        keywordTokens.length > 0 && keywordTokens.every((token) => promptTokens.has(token)),
    );
}

function scopesMatch(
  row: StandingIntentRow,
  channelScopes: ReadonlySet<string>,
  senderScope: string | undefined,
): boolean {
  return (
    (row.channel_scope === null || channelScopes.has(row.channel_scope)) &&
    (row.sender_scope === null || row.sender_scope === senderScope)
  );
}

function canFire(row: StandingIntentRow, nowMs: number): boolean {
  return (
    row.status === "armed" &&
    row.expires_at > nowMs &&
    row.fire_count < row.max_fires &&
    (row.last_fired_at === null || row.last_fired_at + row.cooldown_seconds * 1_000 <= nowMs)
  );
}

export function matchStandingIntents(params: {
  agentId: string;
  prompt: string;
  channel?: string;
  provider?: string;
  accountId?: string;
  senderId?: string;
  nowMs?: number;
}): StandingIntent[] {
  const promptTokens = new Set(tokenizeIntentText(params.prompt));
  const ftsQuery = buildFtsQuery(promptTokens);
  if (!ftsQuery) {
    return [];
  }
  const channel = params.channel?.trim() || undefined;
  const provider = params.provider?.trim().toLowerCase() || undefined;
  const senderId = params.senderId?.trim() || undefined;
  const channelScopes = new Set<string>();
  if (provider) {
    channelScopes.add(
      encodeStandingIntentChannelScope({
        scope: "channel",
        provider,
        accountId: params.accountId,
      }),
    );
    if (channel) {
      channelScopes.add(
        encodeStandingIntentChannelScope({
          scope: "conversation",
          provider,
          accountId: params.accountId,
          conversationId: channel,
        }),
      );
    }
  }
  const storedSenderScope =
    provider && senderId
      ? encodeStandingIntentSenderScope({
          provider,
          accountId: params.accountId,
          senderId,
        })
      : undefined;
  return withStandingIntentDatabase(params.agentId, (db) =>
    runSqliteImmediateTransactionSync(db, () => {
      const nowMs = params.nowMs ?? Date.now();
      maintainStandingIntentLifecycle(db, nowMs);
      const matchDb = getNodeSqliteKysely<StandingIntentMatchDatabase>(db);
      let candidatesQuery = matchDb
        .selectFrom("standing_intents as intent")
        .innerJoin("standing_intents_fts as fts", "fts.rowid", "intent.intent_key")
        .selectAll("intent")
        .where("fts.trigger_keywords", "match", ftsQuery)
        .where("intent.status", "=", "armed")
        .where("intent.creator_sender", "is not", null)
        .where("intent.expires_at", ">", nowMs)
        .whereRef("intent.fire_count", "<", "intent.max_fires");
      candidatesQuery =
        channelScopes.size > 0
          ? candidatesQuery.where((expression) =>
              expression.or([
                expression("intent.channel_scope", "is", null),
                ...[...channelScopes].map((scope) =>
                  expression("intent.channel_scope", "=", scope),
                ),
              ]),
            )
          : candidatesQuery.where("intent.channel_scope", "is", null);
      candidatesQuery = storedSenderScope
        ? candidatesQuery.where((expression) =>
            expression.or([
              expression("intent.sender_scope", "is", null),
              expression("intent.sender_scope", "=", storedSenderScope),
            ]),
          )
        : candidatesQuery.where("intent.sender_scope", "is", null);
      const kysely = getNodeSqliteKysely<StandingIntentDatabase>(db);
      const fired: StandingIntent[] = [];
      let scannedCandidates = 0;
      let cursor: { createdAt: number; id: string } | undefined;
      while (
        fired.length < INTENT_INJECTION_MAX_COUNT &&
        scannedCandidates < INTENT_MATCH_CANDIDATE_LIMIT
      ) {
        let pageQuery = candidatesQuery;
        const currentCursor = cursor;
        if (currentCursor) {
          pageQuery = pageQuery.where((expression) =>
            expression.or([
              expression("intent.created_at", ">", currentCursor.createdAt),
              expression.and([
                expression("intent.created_at", "=", currentCursor.createdAt),
                expression("intent.id", ">", currentCursor.id),
              ]),
            ]),
          );
        }
        const candidates = executeSqliteQuerySync(
          db,
          pageQuery
            .orderBy("intent.created_at", "asc")
            .orderBy("intent.id", "asc")
            .limit(
              Math.min(
                INTENT_MATCH_CANDIDATE_BATCH_SIZE,
                INTENT_MATCH_CANDIDATE_LIMIT - scannedCandidates,
              ),
            ),
        ).rows;
        if (candidates.length === 0) {
          break;
        }
        const lastCandidate = candidates.at(-1);
        scannedCandidates += candidates.length;
        cursor = lastCandidate
          ? { createdAt: lastCandidate.created_at, id: lastCandidate.id }
          : cursor;
        for (const candidate of candidates) {
          if (fired.length >= INTENT_INJECTION_MAX_COUNT) {
            break;
          }
          const current = executeSqliteQueryTakeFirstSync(
            db,
            kysely.selectFrom("standing_intents").selectAll().where("id", "=", candidate.id),
          );
          if (
            !current ||
            !readKnownCreatorSender(current.creator_sender) ||
            !canFire(current, nowMs) ||
            !scopesMatch(current, channelScopes, storedSenderScope) ||
            !triggerMatchesPrompt(current, promptTokens)
          ) {
            continue;
          }
          const nextFireCount = current.fire_count + 1;
          const firedIntent = rowToIntent({
            ...current,
            fire_count: nextFireCount,
            last_fired_at: nowMs,
            status: nextFireCount >= current.max_fires ? "done" : "fired",
          });
          if (!standingIntentsFitContext([...fired, firedIntent])) {
            continue;
          }
          executeSqliteQuerySync(
            db,
            kysely
              .updateTable("standing_intents")
              .set({
                fire_count: nextFireCount,
                last_fired_at: nowMs,
                status: nextFireCount >= current.max_fires ? "done" : "fired",
              })
              .where("id", "=", current.id)
              .where("status", "=", "armed"),
          );
          fired.push(firedIntent);
        }
        if (candidates.length < INTENT_MATCH_CANDIDATE_BATCH_SIZE) {
          break;
        }
      }
      return fired;
    }),
  );
}

function renderStandingIntentContext(intents: StandingIntent[]): string {
  const lines = intents.map((intent) => {
    const createdDate = new Date(intent.createdAt).toISOString().slice(0, 10);
    return `Standing intent (created ${createdDate}): ${intent.description}`;
  });
  return `<standing_intents>\n${lines.join("\n")}\n</standing_intents>`;
}

function standingIntentsFitContext(intents: StandingIntent[]): boolean {
  return (
    intents.length <= INTENT_INJECTION_MAX_COUNT &&
    renderStandingIntentContext(intents).length <= INTENT_INJECTION_MAX_CHARS
  );
}

export function buildStandingIntentContext(intents: StandingIntent[]): string | undefined {
  const included: StandingIntent[] = [];
  for (const intent of intents.slice(0, INTENT_INJECTION_MAX_COUNT)) {
    if (!standingIntentsFitContext([...included, intent])) {
      continue;
    }
    included.push(intent);
  }
  return included.length > 0 ? renderStandingIntentContext(included) : undefined;
}

export function isEligibleStandingIntentTurn(ctx: {
  trigger?: string;
  sessionKey?: string;
  sessionId?: string;
  messageProvider?: string;
  channelId?: string;
  chatId?: string;
}): boolean {
  if (ctx.trigger !== "user" || (!ctx.sessionKey && !ctx.sessionId)) {
    return false;
  }
  const provider = ctx.messageProvider?.trim().toLowerCase();
  return provider === "webchat" || Boolean(ctx.channelId?.trim() || ctx.chatId?.trim());
}
