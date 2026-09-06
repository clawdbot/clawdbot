import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isIncognitoSessionKey } from "./incognito-session-key.js";

export type SessionMutationOperatorScope = "operator.write" | "operator.admin";

const SESSIONS_PATCH_WRITE_SCOPE_MUTATIONS: ReadonlySet<string> = new Set([
  "label",
  "icon",
  "color",
  "category",
  "boardFace",
  "pinned",
  "archived",
  "unread",
  "model",
  "permissionMode",
]);

const SESSIONS_PATCH_WRITE_SCOPE_ENVELOPE_FIELDS: ReadonlySet<string> = new Set([
  "key",
  "agentId",
  "expectedSessionId",
  "expectedLifecycleRevision",
  "expectedPermissionMode",
  "expectedMarkedUnreadAt",
]);

const SESSIONS_DELETE_WRITE_SCOPE_FIELDS: ReadonlySet<string> = new Set([
  "key",
  "agentId",
  "deleteTranscript",
  "expectedSessionId",
  "archivedOnly",
]);

function resolveSessionsPatchRequiredScope(params: unknown): SessionMutationOperatorScope {
  if (!isRecord(params)) {
    return "operator.write";
  }
  if (params.permissionMode === "full") {
    return "operator.admin";
  }
  return Object.keys(params).every(
    (key) =>
      SESSIONS_PATCH_WRITE_SCOPE_ENVELOPE_FIELDS.has(key) ||
      SESSIONS_PATCH_WRITE_SCOPE_MUTATIONS.has(key),
  )
    ? "operator.write"
    : "operator.admin";
}

function resolveSessionsPatchManyRequiredScope(params: unknown): SessionMutationOperatorScope {
  if (!isRecord(params) || !isRecord(params.patch)) {
    return "operator.write";
  }
  if (params.patch.permissionMode === "full") {
    return "operator.admin";
  }
  return Object.keys(params.patch).every((key) => SESSIONS_PATCH_WRITE_SCOPE_MUTATIONS.has(key))
    ? "operator.write"
    : "operator.admin";
}

function resolveSessionsCreateRequiredScope(params: unknown): SessionMutationOperatorScope {
  if (!isRecord(params)) {
    return "operator.write";
  }
  if (
    params.incognito === true ||
    (typeof params.key === "string" && isIncognitoSessionKey(params.key)) ||
    (typeof params.parentSessionKey === "string" &&
      isIncognitoSessionKey(params.parentSessionKey)) ||
    Object.hasOwn(params, "execNode") ||
    Object.hasOwn(params, "toolOverrides") ||
    params.permissionMode === "full"
  ) {
    return "operator.admin";
  }
  return "operator.write";
}

function resolveSessionsDeleteRequiredScope(params: unknown): SessionMutationOperatorScope {
  if (!isRecord(params) || params.archivedOnly !== true) {
    return "operator.admin";
  }
  return Object.keys(params).every((key) => SESSIONS_DELETE_WRITE_SCOPE_FIELDS.has(key))
    ? "operator.write"
    : "operator.admin";
}

/** Browser-safe session mutation policy for methods without protocol validation. */
export function resolveBaseSessionMutationRequiredScope(
  method: string,
  params?: unknown,
): SessionMutationOperatorScope | undefined {
  if (method === "sessions.recover") {
    return "operator.write";
  }
  if (method === "sessions.create") {
    return resolveSessionsCreateRequiredScope(params);
  }
  if (method === "sessions.patch") {
    return resolveSessionsPatchRequiredScope(params);
  }
  if (method === "sessions.patchMany") {
    return resolveSessionsPatchManyRequiredScope(params);
  }
  if (method === "sessions.delete") {
    return resolveSessionsDeleteRequiredScope(params);
  }
  return undefined;
}
