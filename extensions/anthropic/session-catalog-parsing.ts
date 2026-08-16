import {
  isRecord,
  normalizeBoundedOptionalString as readBoundedString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { CLAUDE_LOCAL_SESSION_HOST_ID } from "./session-catalog-adoption.js";
import { isExactClaudeSessionCursor } from "./session-catalog-cursor.js";
import { MAX_STRING_LENGTH, parsePullRequestSummary } from "./session-catalog-discovery.js";
import { ClaudeCatalogParamsError } from "./session-catalog-shared.js";
import type {
  ClaudeSessionCatalogPage,
  ClaudeSessionCatalogSession,
} from "./session-catalog-types.js";

const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;
export const DEFAULT_TRANSCRIPT_LIMIT = 20;
export const MAX_TRANSCRIPT_LIMIT = 50;
export const MAX_HOSTS = 100;
const MAX_SEARCH_LENGTH = 500;

export function encodeOffset(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

export function decodeOffset(cursor: string | undefined, label: string): number {
  if (cursor === undefined) {
    return 0;
  }
  if (!isExactClaudeSessionCursor(cursor)) {
    throw new ClaudeCatalogParamsError(`${label} cursor is invalid`);
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      !isRecord(parsed) ||
      !Number.isSafeInteger(parsed.offset) ||
      (parsed.offset as number) < 0
    ) {
      throw new Error("invalid offset");
    }
    return parsed.offset as number;
  } catch (error) {
    throw new ClaudeCatalogParamsError(`${label} cursor is invalid`, { cause: error });
  }
}

function readLimit(value: unknown, fallback: number, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new ClaudeCatalogParamsError(`limit must be an integer from 1 to ${max}`);
  }
  return value as number;
}

function readRequiredCursor(value: unknown, message: string): string {
  if (!isExactClaudeSessionCursor(value)) {
    throw new ClaudeCatalogParamsError(message);
  }
  return value;
}

export function readOptionalCursor(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return readRequiredCursor(value, `${label} cursor is invalid`);
}

export function readListParams(value: unknown): {
  cursor?: string;
  limit: number;
  searchTerm?: string;
} {
  if (value === undefined || value === null) {
    return { limit: DEFAULT_PAGE_LIMIT };
  }
  if (!isRecord(value)) {
    throw new ClaudeCatalogParamsError("Claude session catalog parameters must be an object");
  }
  const allowed = new Set(["cursor", "limit", "searchTerm"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw new ClaudeCatalogParamsError(`unknown Claude session catalog parameter: ${unknown}`);
  }
  const cursor = readOptionalCursor(value.cursor, "catalog");
  const searchTerm = readBoundedString(value.searchTerm, MAX_SEARCH_LENGTH);
  return {
    limit: readLimit(value.limit, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT),
    ...(cursor ? { cursor } : {}),
    ...(searchTerm ? { searchTerm } : {}),
  };
}

export function readTranscriptParams(
  value: unknown,
  options: { includeHostId?: boolean } = {},
): { threadId: string; cursor?: string; limit: number } {
  if (!isRecord(value)) {
    throw new ClaudeCatalogParamsError("Claude session read parameters must be an object");
  }
  const allowed = new Set([
    "threadId",
    "cursor",
    "limit",
    ...(options.includeHostId ? ["hostId"] : []),
  ]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw new ClaudeCatalogParamsError(`unknown Claude session read parameter: ${unknown}`);
  }
  const threadId = readBoundedString(value.threadId, 256);
  if (!threadId || !/^[A-Za-z0-9._:-]+$/.test(threadId)) {
    throw new ClaudeCatalogParamsError("threadId is invalid");
  }
  const cursor = readOptionalCursor(value.cursor, "transcript");
  return {
    threadId,
    limit: readLimit(value.limit, DEFAULT_TRANSCRIPT_LIMIT, MAX_TRANSCRIPT_LIMIT),
    ...(cursor ? { cursor } : {}),
  };
}

export function readNodePageCursor(
  value: Record<string, unknown>,
  invalidPageMessage: string,
): string | undefined {
  if (!("nextCursor" in value)) {
    return undefined;
  }
  if (!isExactClaudeSessionCursor(value.nextCursor)) {
    throw new Error(invalidPageMessage);
  }
  return value.nextCursor;
}

export function parseCatalogPage(value: unknown): ClaudeSessionCatalogPage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.sessions) ||
    value.sessions.length > MAX_PAGE_LIMIT
  ) {
    throw new Error("Claude node returned an invalid session page");
  }
  const sessions = value.sessions.map((candidate): ClaudeSessionCatalogSession => {
    if (!isRecord(candidate)) {
      throw new Error("Claude node returned an invalid session");
    }
    const threadId = readBoundedString(candidate.threadId, 256);
    const source = candidate.source;
    if (
      !threadId ||
      candidate.archived !== false ||
      candidate.status !== "stored" ||
      (source !== "claude-cli" && source !== "claude-desktop") ||
      candidate.modelProvider !== "anthropic"
    ) {
      throw new Error("Claude node returned an invalid session");
    }
    const parseStringField = (key: string, maxLength = MAX_STRING_LENGTH): string | undefined => {
      if (!(key in candidate)) {
        return undefined;
      }
      const parsed = readBoundedString(candidate[key], maxLength);
      if (!parsed) {
        throw new Error("Claude node returned an invalid session");
      }
      return parsed;
    };
    const parseNumberField = (key: string, nullable = false): number | null | undefined => {
      if (!(key in candidate)) {
        return undefined;
      }
      if (nullable && candidate[key] === null) {
        return null;
      }
      const parsed = candidate[key];
      if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
        throw new Error("Claude node returned an invalid session");
      }
      return parsed;
    };
    let name: string | null | undefined;
    if (candidate.name === null) {
      name = null;
    } else {
      name = parseStringField("name", 500);
    }
    const cwd = parseStringField("cwd");
    const createdAt = parseNumberField("createdAt") as number | undefined;
    const updatedAt = parseNumberField("updatedAt") as number | undefined;
    const recencyAt = parseNumberField("recencyAt", true);
    const cliVersion = parseStringField("cliVersion", 256);
    const gitBranch = parseStringField("gitBranch", 500);
    const pullRequest = parsePullRequestSummary(candidate.pullRequest);
    return {
      threadId,
      status: "stored",
      source,
      modelProvider: "anthropic",
      archived: false,
      ...(name !== undefined ? { name } : {}),
      ...(cwd ? { cwd } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      ...(recencyAt !== undefined ? { recencyAt } : {}),
      ...(cliVersion ? { cliVersion } : {}),
      ...(gitBranch ? { gitBranch } : {}),
      ...(pullRequest ? { pullRequest } : {}),
    };
  });
  const nextCursor = readNodePageCursor(value, "Claude node returned an invalid session page");
  return { sessions, ...(nextCursor ? { nextCursor } : {}) };
}

export function unwrapNodePayload(value: unknown): unknown {
  if (isRecord(value) && typeof value.payloadJSON === "string") {
    return JSON.parse(value.payloadJSON) as unknown;
  }
  return value;
}

export function parseGatewayQuery(value: unknown): {
  search?: string;
  limitPerHost: number;
  hostIds?: string[];
  cursors?: Record<string, string>;
} {
  if (value === undefined || value === null) {
    return { limitPerHost: DEFAULT_PAGE_LIMIT };
  }
  if (!isRecord(value)) {
    throw new ClaudeCatalogParamsError("Claude session catalog parameters must be an object");
  }
  const allowed = new Set(["search", "limitPerHost", "hostIds", "cursors"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw new ClaudeCatalogParamsError(`unknown Claude session catalog parameter: ${unknown}`);
  }
  const search = readBoundedString(value.search, MAX_SEARCH_LENGTH);
  let hostIds: string[] | undefined;
  if (value.hostIds !== undefined) {
    if (!Array.isArray(value.hostIds) || value.hostIds.length > MAX_HOSTS) {
      throw new ClaudeCatalogParamsError("hostIds must be a bounded array");
    }
    hostIds = [
      ...new Set(
        value.hostIds.map((hostId) => {
          const normalized = readBoundedString(hostId, 256);
          if (
            !normalized ||
            (normalized !== CLAUDE_LOCAL_SESSION_HOST_ID && !normalized.startsWith("node:"))
          ) {
            throw new ClaudeCatalogParamsError("hostId is invalid");
          }
          return normalized;
        }),
      ),
    ];
  }
  let cursors: Record<string, string> | undefined;
  if (value.cursors !== undefined) {
    if (!isRecord(value.cursors) || Object.keys(value.cursors).length > MAX_HOSTS) {
      throw new ClaudeCatalogParamsError("cursors must be a bounded object");
    }
    cursors = Object.fromEntries(
      Object.entries(value.cursors).map(([hostId, cursor]) => {
        return [hostId, readRequiredCursor(cursor, `cursor for ${hostId} is invalid`)];
      }),
    );
  }
  return {
    limitPerHost: readLimit(value.limitPerHost, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT),
    ...(search ? { search } : {}),
    ...(hostIds ? { hostIds } : {}),
    ...(cursors ? { cursors } : {}),
  };
}
