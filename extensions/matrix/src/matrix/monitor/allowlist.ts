// Matrix plugin module implements allowlist behavior.
import {
  resolveAllowlistMatchByCandidates,
  type AllowlistMatch,
} from "openclaw/plugin-sdk/allow-from";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-normalization-runtime";

function normalizeAllowList(list?: Array<string | number>) {
  return normalizeStringEntries(list);
}

function normalizeMatrixUser(raw?: string | null): string {
  const value = (raw ?? "").trim();
  if (!value) {
    return "";
  }
  if (!value.startsWith("@") || !value.includes(":")) {
    return normalizeLowercaseStringOrEmpty(value);
  }
  return value;
}

export function normalizeMatrixUserId(raw?: string | null): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return "";
  }
  const lowered = normalizeLowercaseStringOrEmpty(trimmed);
  if (lowered.startsWith("matrix:")) {
    return normalizeMatrixUser(trimmed.slice("matrix:".length));
  }
  if (lowered.startsWith("user:")) {
    return normalizeMatrixUser(trimmed.slice("user:".length));
  }
  return normalizeMatrixUser(trimmed);
}

function normalizeMatrixAllowListEntry(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "*") {
    return trimmed;
  }
  const lowered = normalizeLowercaseStringOrEmpty(trimmed);
  if (lowered.startsWith("matrix:")) {
    return `matrix:${normalizeMatrixUser(trimmed.slice("matrix:".length))}`;
  }
  if (lowered.startsWith("user:")) {
    return `user:${normalizeMatrixUser(trimmed.slice("user:".length))}`;
  }
  return normalizeMatrixUser(trimmed);
}

export function normalizeMatrixAllowList(list?: Array<string | number>) {
  return normalizeAllowList(list).map((entry) => normalizeMatrixAllowListEntry(entry));
}

type MatrixAllowListMatch = AllowlistMatch<"wildcard" | "id" | "prefixed-id" | "prefixed-user">;

type MatrixAllowListMatchSource = NonNullable<MatrixAllowListMatch["matchSource"]>;

export function resolveMatrixAllowListMatch(params: {
  allowList: string[];
  userId?: string;
}): MatrixAllowListMatch {
  const allowList = params.allowList;
  if (allowList.length === 0) {
    return { allowed: false };
  }
  if (allowList.includes("*")) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" };
  }
  const userId = normalizeMatrixUser(params.userId);
  const candidates: Array<{ value?: string; source: MatrixAllowListMatchSource }> = [
    { value: userId, source: "id" },
    { value: userId ? `matrix:${userId}` : "", source: "prefixed-id" },
    { value: userId ? `user:${userId}` : "", source: "prefixed-user" },
  ];
  return resolveAllowlistMatchByCandidates<MatrixAllowListMatchSource>({ allowList, candidates });
}
