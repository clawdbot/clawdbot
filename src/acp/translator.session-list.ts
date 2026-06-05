/** Cursor and pagination helpers for ACP session/list requests. */
import path from "node:path";
import { readNumber } from "@openclaw/acp-core/meta";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

const ACP_LIST_SESSIONS_DEFAULT_PAGE_SIZE = 100;
const ACP_LIST_SESSIONS_MAX_PAGE_SIZE = 100;
const ACP_LIST_SESSIONS_MAX_CURSOR_OFFSET = 10_000;

/** Maximum rows fetched to satisfy ACP session-list pagination plus next-page detection. */
export const ACP_LIST_SESSIONS_MAX_FETCH_LIMIT =
  ACP_LIST_SESSIONS_MAX_CURSOR_OFFSET + ACP_LIST_SESSIONS_MAX_PAGE_SIZE + 1;

/** Opaque cursor payload used to page ACP session list results. */
export type ListSessionsCursor = {
  offset: number;
  cwd?: string;
};

/** Encodes an ACP session-list cursor as base64url JSON. */
export function encodeListSessionsCursor(cursor: ListSessionsCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), "utf8").toString("base64url");
}

/** Decodes and validates an ACP session-list cursor, defaulting to the first page. */
export function decodeListSessionsCursor(value: string | null | undefined): ListSessionsCursor {
  if (!value) {
    return { offset: 0 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid ACP session list cursor.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid ACP session list cursor.");
  }
  const record = parsed as Record<string, unknown>;
  if (record.v !== 1) {
    throw new Error("Unsupported ACP session list cursor.");
  }
  if (
    typeof record.offset !== "number" ||
    !Number.isInteger(record.offset) ||
    record.offset < 0 ||
    record.offset > ACP_LIST_SESSIONS_MAX_CURSOR_OFFSET
  ) {
    throw new Error("Invalid ACP session list cursor offset.");
  }
  const cwd = normalizeOptionalString(record.cwd);
  return {
    offset: record.offset,
    ...(cwd ? { cwd } : {}),
  };
}

/** Throws when an ACP method receives a relative cwd filter/path. */
export function assertAbsoluteCwd(cwd: string, method: string): void {
  if (!path.isAbsolute(cwd)) {
    throw new Error(`ACP ${method} requires an absolute cwd.`);
  }
}

/** Resolves requested ACP session-list page size with bridge limits. */
export function resolveListSessionsPageSize(
  meta: Record<string, unknown> | null | undefined,
): number {
  const requested = readNumber(meta, ["limit", "pageSize"]);
  if (requested === undefined) {
    return ACP_LIST_SESSIONS_DEFAULT_PAGE_SIZE;
  }
  return Math.min(ACP_LIST_SESSIONS_MAX_PAGE_SIZE, Math.max(1, Math.floor(requested)));
}
