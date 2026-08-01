import type { DatabaseSync } from "node:sqlite";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { stripInboundMetadata } from "../../auto-reply/reply/strip-inbound-meta.js";
import { getNodeSqliteKysely, iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import { hasInterSessionUserProvenance } from "../../sessions/input-provenance.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import { truncateUtf16Safe } from "../../utils.js";
import type { SessionEntry } from "./types.js";

const DERIVED_TITLE_MAX_LEN = 60;
const PROJECTED_TITLE = Symbol("projectedTitle");
type ProjectedTitleEntry = SessionEntry & { [PROJECTED_TITLE]?: string };
type SessionTitleDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "session_transcript_active_events" | "transcript_events"
>;

export function setSessionProjectedTitle(entry: SessionEntry, title: string | null): void {
  if (title) {
    (entry as ProjectedTitleEntry)[PROJECTED_TITLE] = title;
  } else {
    delete (entry as ProjectedTitleEntry)[PROJECTED_TITLE];
  }
}

export function getSessionProjectedTitle(entry: SessionEntry | undefined): string | undefined {
  return (entry as ProjectedTitleEntry | undefined)?.[PROJECTED_TITLE];
}

export function deriveSessionTitle(
  entry: SessionEntry | undefined,
  firstUserMessage?: string | null,
  externalDisplayName?: string | null,
): string | undefined {
  if (!entry) {
    return undefined;
  }
  for (const value of [entry.label, externalDisplayName, entry.displayName, entry.subject]) {
    const title = normalizeOptionalString(value);
    if (title) {
      return title;
    }
  }
  const normalized = firstUserMessage
    ? stripInboundMetadata(firstUserMessage).replace(/\s+/g, " ").trim()
    : "";
  if (normalized) {
    if (normalized.length <= DERIVED_TITLE_MAX_LEN) {
      return normalized;
    }
    const cut = truncateUtf16Safe(normalized, DERIVED_TITLE_MAX_LEN - 1);
    const lastSpace = cut.lastIndexOf(" ");
    return lastSpace > DERIVED_TITLE_MAX_LEN * 0.6 ? `${cut.slice(0, lastSpace)}…` : `${cut}…`;
  }
  if (!entry.sessionId) {
    return undefined;
  }
  const prefix = entry.sessionId.slice(0, 8);
  const updatedAt = entry.updatedAt && entry.updatedAt > 0 ? new Date(entry.updatedAt) : null;
  return updatedAt && Number.isFinite(updatedAt.getTime())
    ? `${prefix} (${updatedAt.toISOString().slice(0, 10)})`
    : prefix;
}

export function deriveSqliteSessionTitle(
  database: DatabaseSync,
  entry: SessionEntry,
): string | null {
  const db = getNodeSqliteKysely<SessionTitleDatabase>(database);
  const rows = iterateSqliteQuerySync(
    database,
    db
      .selectFrom("session_transcript_active_events as active")
      .innerJoin("transcript_events as event", (join) =>
        join
          .onRef("event.session_id", "=", "active.session_id")
          .onRef("event.seq", "=", "active.event_seq"),
      )
      .select("event.event_json")
      .where("active.session_id", "=", entry.sessionId)
      .where("active.message_position", "is not", null)
      .orderBy("active.message_position", "asc"),
  );
  let firstUserMessage: string | undefined;
  for (const row of rows) {
    let parsed: { message?: unknown } | null;
    try {
      const value = JSON.parse(row.event_json) as unknown;
      parsed = value && typeof value === "object" ? (value as { message?: unknown }) : null;
    } catch {
      continue;
    }
    const message = parsed?.message as
      | { content?: unknown; provenance?: unknown; role?: unknown; text?: unknown }
      | undefined;
    if (message?.role !== "user" || hasInterSessionUserProvenance(message)) {
      continue;
    }
    const text =
      extractTextFromChatContent(message.content) ??
      (typeof message.text === "string" ? message.text.trim() || null : null);
    if (text) {
      firstUserMessage = text;
      break;
    }
  }
  return deriveSessionTitle(entry, firstUserMessage) ?? null;
}
