import { createHash } from "node:crypto";
import type {
  SessionCatalogProvider,
  SessionCatalogTranscriptItem,
} from "openclaw/plugin-sdk/session-catalog";
import type { BeamStore } from "./store.js";
import { BEAM_HOST_ID, type BeamStoredSession } from "./types.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function boundedLimit(value: number | undefined): number {
  return Math.min(MAX_LIMIT, Math.max(1, value ?? DEFAULT_LIMIT));
}

function cursorOffset(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) {
    return 0;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function searchableText(session: BeamStoredSession): string {
  return `${session.title}\n${session.source}`.toLowerCase();
}

function transcriptItems(session: BeamStoredSession): SessionCatalogTranscriptItem[] {
  return session.items.map((item, index) => ({
    id: `${session.beamId}:${index}`,
    type: item.type,
    text: item.text,
    timestamp: session.updatedAt,
  }));
}

type TranscriptCursor = { revision: string; end: number };

function transcriptRevision(session: BeamStoredSession): string {
  return createHash("sha256").update(JSON.stringify(session.items)).digest("base64url");
}

function encodeTranscriptCursor(cursor: TranscriptCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeTranscriptCursor(value: string): TranscriptCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as TranscriptCursor).revision === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test((parsed as TranscriptCursor).revision) &&
      typeof (parsed as TranscriptCursor).end === "number" &&
      Number.isSafeInteger((parsed as TranscriptCursor).end) &&
      (parsed as TranscriptCursor).end >= 0
    ) {
      return parsed as TranscriptCursor;
    }
  } catch {
    // Reject malformed cursors below.
  }
  throw new Error("invalid Beam transcript cursor");
}

function transcriptPage(
  items: SessionCatalogTranscriptItem[],
  limit: number,
  revision: string,
  cursor?: TranscriptCursor,
): { items: SessionCatalogTranscriptItem[]; nextCursor?: string } {
  if (cursor && cursor.revision !== revision) {
    throw new Error("stale Beam transcript cursor");
  }
  const end = Math.min(items.length, Math.max(0, cursor?.end ?? items.length));
  const start = Math.max(0, end - limit);
  return {
    items: items.slice(start, end),
    ...(start > 0 ? { nextCursor: encodeTranscriptCursor({ revision, end: start }) } : {}),
  };
}

export function createBeamSessionCatalog(store: BeamStore): SessionCatalogProvider {
  return {
    id: "beam",
    label: "Beam",
    async list(params) {
      const search = params.search?.trim().toLowerCase();
      const sessions = (await store.list())
        .filter((session) => !search || searchableText(session).includes(search))
        .toSorted((left, right) => right.receivedAt - left.receivedAt);
      const offset = cursorOffset(params.cursors?.[BEAM_HOST_ID]);
      const limit = boundedLimit(params.limitPerHost);
      const page = sessions.slice(offset, offset + limit);
      return [
        {
          hostId: BEAM_HOST_ID,
          label: "Beamed sessions",
          kind: "gateway",
          connected: true,
          sessions: page.map((session) => ({
            threadId: session.beamId,
            name: session.title,
            status: session.completed ? "completed" : "live",
            createdAt: session.createdAt,
            updatedAt: session.receivedAt,
            recencyAt: session.receivedAt,
            source: session.source,
            archived: false,
            canContinue: false,
            canArchive: false,
          })),
          ...(offset + page.length < sessions.length
            ? { nextCursor: String(offset + page.length) }
            : {}),
        },
      ];
    },
    async read(params) {
      if (params.hostId !== BEAM_HOST_ID) {
        throw new Error(`unknown Beam host: ${params.hostId}`);
      }
      const session = await store.get(params.threadId);
      if (!session) {
        throw new Error(`unknown Beam session: ${params.threadId}`);
      }
      const page = transcriptPage(
        transcriptItems(session),
        boundedLimit(params.limit),
        transcriptRevision(session),
        params.cursor === undefined ? undefined : decodeTranscriptCursor(params.cursor),
      );
      return {
        hostId: BEAM_HOST_ID,
        label: session.title,
        threadId: session.beamId,
        ...page,
      };
    },
  };
}
