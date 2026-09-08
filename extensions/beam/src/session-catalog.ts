import { createHash } from "node:crypto";
import type { SessionCatalogProvider } from "openclaw/plugin-sdk/session-catalog";
import { isControlUiCatalogShareId } from "openclaw/plugin-sdk/session-catalog-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { BeamStore } from "./store.js";
import { BEAM_HOST_ID, BEAM_SESSION_SHARE_ROUTE, type BeamStoredSession } from "./types.js";

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
      isRecord(parsed) &&
      typeof parsed.revision === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test(parsed.revision) &&
      typeof parsed.end === "number" &&
      Number.isSafeInteger(parsed.end) &&
      parsed.end >= 0
    ) {
      return { revision: parsed.revision, end: parsed.end };
    }
  } catch {
    // Reject malformed cursors below.
  }
  throw new Error("invalid Beam transcript cursor");
}

export function createBeamSessionCatalog(store: BeamStore): SessionCatalogProvider {
  return {
    id: "beam",
    label: "Beam",
    audience: "gateway-operators",
    shareRoute: BEAM_SESSION_SHARE_ROUTE,
    supportsProcessHomeIsolation: true,
    async list(params) {
      const search = params.search?.trim().toLowerCase();
      const shareId =
        search && isControlUiCatalogShareId(BEAM_SESSION_SHARE_ROUTE, search) ? search : undefined;
      const sessions = (await store.list())
        .filter(
          (session) =>
            !search ||
            (shareId
              ? session.beamId.startsWith(shareId)
              : searchableText(session).includes(search)),
        )
        .toSorted(
          (left, right) =>
            right.receivedAt - left.receivedAt || left.beamId.localeCompare(right.beamId),
        );
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
            canContinue: true,
            canArchive: true,
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
      const cursor =
        params.cursor === undefined ? undefined : decodeTranscriptCursor(params.cursor);
      const revision = transcriptRevision(session);
      if (cursor && cursor.revision !== revision) {
        throw new Error("stale Beam transcript cursor");
      }
      const end = Math.min(session.items.length, cursor?.end ?? session.items.length);
      const start = Math.max(0, end - boundedLimit(params.limit));
      return {
        hostId: BEAM_HOST_ID,
        label: session.title,
        threadId: session.beamId,
        // Project only the selected page; keep chronological source indices in IDs
        // while exposing newest-first items on the catalog wire.
        items: session.items
          .slice(start, end)
          .map((item, index) => ({
            id: `${session.beamId}:${start + index}`,
            type: item.type,
            text: item.text,
            timestamp: session.updatedAt,
            sender:
              item.type === "userMessage" && session.uploaderProfileId
                ? { identity: { type: "profile" as const, id: session.uploaderProfileId } }
                : undefined,
          }))
          .toReversed(),
        ...(start > 0 ? { nextCursor: encodeTranscriptCursor({ revision, end: start }) } : {}),
      };
    },
    async archive(params) {
      if (params.hostId !== BEAM_HOST_ID) {
        throw new Error(`unknown Beam host: ${params.hostId}`);
      }
      if (!(await store.delete(params.threadId))) {
        throw new Error(`unknown Beam session: ${params.threadId}`);
      }
      return { ok: true };
    },
    async copyToGatewaySession(params) {
      if (params.hostId !== BEAM_HOST_ID) {
        throw new Error(`unknown Beam host: ${params.hostId}`);
      }
      const session = await store.get(params.threadId);
      if (!session) {
        throw new Error(`unknown Beam session: ${params.threadId}`);
      }
      return {
        displayName: session.title,
        ...(session.sourceModel
          ? { preferredModel: `${session.sourceModel.provider}/${session.sourceModel.model}` }
          : {}),
      };
    },
  };
}
