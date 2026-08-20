import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";

export type SessionMutationTarget = {
  sessionKey: string;
  agentId?: string;
};

type SessionMutationTargetField = "key" | "parentSessionKey" | "sessionKey";

const SESSION_TARGET_FIELDS_BY_METHOD = new Map<string, readonly SessionMutationTargetField[]>([
  ["agent", ["sessionKey"]],
  ["board.event", ["sessionKey"]],
  ["board.update", ["sessionKey"]],
  ["board.widget.grant", ["sessionKey"]],
  ["board.widget.put", ["sessionKey"]],
  ["chat.abort", ["sessionKey"]],
  ["chat.inject", ["sessionKey"]],
  ["chat.send", ["sessionKey"]],
  ["message.action", ["sessionKey"]],
  ["plugins.sessionAction", ["sessionKey"]],
  ["progressCard.get", ["sessionKey"]],
  ["progressCard.put", ["sessionKey"]],
  ["send", ["sessionKey"]],
  ["session.discussion.open", ["sessionKey"]],
  ["sessions.abort", ["key"]],
  ["sessions.compaction.branch", ["key"]],
  ["sessions.compaction.restore", ["key"]],
  ["sessions.compact", ["key"]],
  ["sessions.create", ["key", "parentSessionKey"]],
  ["sessions.delete", ["key"]],
  ["sessions.dispatch", ["key"]],
  ["sessions.files.set", ["sessionKey"]],
  ["sessions.github.publish", ["sessionKey"]],
  ["sessions.fork", ["sessionKey"]],
  ["sessions.patch", ["key"]],
  ["sessions.pluginPatch", ["key"]],
  ...(["sessions.move", "sessions.reclaim"] as const).map((method) => [method, ["key"]] as const),
  ["sessions.recover", ["key"]],
  ["sessions.reset", ["key"]],
  ["sessions.rewind", ["sessionKey"]],
  ["sessions.send", ["key"]],
  ["sessions.steer", ["key"]],
  ["sessions.branches.switch", ["sessionKey"]],
  ["tools.invoke", ["sessionKey"]],
]);

const REQUIRED_SESSION_TARGET_METHODS = new Set([
  "board.action",
  "board.event",
  "board.update",
  "board.widget.grant",
  "board.widget.put",
  "chat.abort",
  "chat.inject",
  "chat.send",
  "progressCard.get",
  "progressCard.put",
  "session.discussion.open",
  "sessions.abort",
  "sessions.branches.switch",
  "sessions.compact",
  "sessions.compaction.branch",
  "sessions.compaction.restore",
  "sessions.delete",
  "sessions.dispatch",
  "sessions.files.set",
  "sessions.fork",
  "sessions.groups.delete",
  "sessions.groups.rename",
  "sessions.groups.update",
  "sessions.github.publish",
  "sessions.patch",
  "sessions.pluginPatch",
  "sessions.reclaim",
  "sessions.recover",
  "sessions.move",
  "sessions.reset",
  "sessions.rewind",
  "sessions.send",
  "sessions.steer",
]);

const APPROVAL_SESSION_TARGET_METHODS = new Set([
  "approval.resolve",
  "exec.approval.resolve",
  "plugin.approval.resolve",
]);

export function sessionMutationTargetFields(method: string): readonly SessionMutationTargetField[] {
  return SESSION_TARGET_FIELDS_BY_METHOD.get(method) ?? [];
}

export function isRequiredSessionTargetMethod(method: string): boolean {
  return REQUIRED_SESSION_TARGET_METHODS.has(method);
}

export function isApprovalSessionTargetMethod(method: string): boolean {
  return APPROVAL_SESSION_TARGET_METHODS.has(method);
}

export function isSessionProfileDependentMethod(method: string): boolean {
  return (
    SESSION_TARGET_FIELDS_BY_METHOD.has(method) ||
    REQUIRED_SESSION_TARGET_METHODS.has(method) ||
    APPROVAL_SESSION_TARGET_METHODS.has(method) ||
    method === "sessions.patchMany"
  );
}

export function resolveDirectIncognitoTargets(
  method: string,
  params: unknown,
): SessionMutationTarget[] {
  if (method === "sessions.create" || method === "sessions.list") {
    return [];
  }
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return [];
  }
  const record = params as Record<string, unknown>;
  const candidates = [record.key, record.sessionKey];
  if (Array.isArray(record.keys)) {
    candidates.push(...record.keys);
  }
  if (Array.isArray(record.sessionKeys)) {
    candidates.push(...record.sessionKeys);
  }
  const agentId = normalizeOptionalString(record.agentId);
  return candidates.flatMap((candidate): SessionMutationTarget[] =>
    typeof candidate === "string" && isIncognitoSessionKey(candidate)
      ? [{ sessionKey: candidate, ...(agentId ? { agentId } : {}) }]
      : [],
  );
}

export function readSessionSharingStringParam(params: unknown, key: string): string | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  return normalizeOptionalString((params as Record<string, unknown>)[key]);
}
