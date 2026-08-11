import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isIncognitoSessionKey } from "./incognito-session-key.js";

export type SessionMutationOperatorScope = "operator.write" | "operator.admin";

const SESSIONS_PATCH_WRITE_SCOPE_MUTATIONS: ReadonlySet<string> = new Set([
  "label",
  "category",
  "boardFace",
  "pinned",
  "archived",
  "unread",
  "model",
]);

// Beta v4 clients may still send this ignored field to sessions.patch. It is
// not a sessions.patchMany mutation and must not gain admin scope while retiring.
const SESSIONS_PATCH_RETIRED_COMPATIBILITY_FIELDS: ReadonlySet<string> = new Set(["icon"]);

const SESSIONS_PATCH_WRITE_SCOPE_ENVELOPE_FIELDS: ReadonlySet<string> = new Set([
  "key",
  "agentId",
  "expectedSessionId",
  "expectedLifecycleRevision",
]);

const SESSIONS_DELETE_WRITE_SCOPE_FIELDS: ReadonlySet<string> = new Set([
  "key",
  "agentId",
  "deleteTranscript",
  "archivedOnly",
]);

function resolveSessionsPatchRequiredScope(params: unknown): SessionMutationOperatorScope {
  if (!isRecord(params)) {
    // Malformed params cannot mutate anything; let the handler return the
    // precise validation error instead of a misleading missing-scope error.
    return "operator.write";
  }
  return Object.keys(params).every(
    (key) =>
      SESSIONS_PATCH_WRITE_SCOPE_ENVELOPE_FIELDS.has(key) ||
      SESSIONS_PATCH_WRITE_SCOPE_MUTATIONS.has(key) ||
      SESSIONS_PATCH_RETIRED_COMPATIBILITY_FIELDS.has(key),
  )
    ? "operator.write"
    : "operator.admin";
}

function resolveSessionsPatchManyRequiredScope(params: unknown): SessionMutationOperatorScope {
  if (!isRecord(params) || !isRecord(params.patch)) {
    // Malformed params cannot mutate anything; schema validation should report
    // the exact closed/non-empty patch failure under the least privilege scope.
    return "operator.write";
  }
  return Object.keys(params.patch).every((key) => SESSIONS_PATCH_WRITE_SCOPE_MUTATIONS.has(key))
    ? "operator.write"
    : "operator.admin";
}

function resolveSessionsCreateRequiredScope(params: unknown): SessionMutationOperatorScope {
  if (!isRecord(params)) {
    return "operator.write";
  }
  // Incognito creation and inheritance expose process-only session state, while
  // execNode targets privileged host resources. Gateway cwd containment needs
  // runtime config and filesystem facts, so the create handler owns that check.
  if (
    params.incognito === true ||
    (typeof params.key === "string" && isIncognitoSessionKey(params.key)) ||
    (typeof params.parentSessionKey === "string" &&
      isIncognitoSessionKey(params.parentSessionKey)) ||
    Object.hasOwn(params, "execNode")
  ) {
    return "operator.admin";
  }
  return "operator.write";
}

function resolveSessionsDeleteRequiredScope(params: unknown): SessionMutationOperatorScope {
  // archivedOnly is the explicit archive-then-delete opt-in: write scope may
  // delete only already-archived sessions. Internal controls stay admin-only.
  if (!isRecord(params) || params.archivedOnly !== true) {
    return "operator.admin";
  }
  return Object.keys(params).every((key) => SESSIONS_DELETE_WRITE_SCOPE_FIELDS.has(key))
    ? "operator.write"
    : "operator.admin";
}

/** Returns the exact scope for the Gateway's params-aware session mutations. */
export function resolveDynamicSessionMutationRequiredScope(
  method: string,
  params?: unknown,
): SessionMutationOperatorScope | undefined {
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
