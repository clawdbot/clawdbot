import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isIncognitoSessionKey } from "../routing/session-key.js";

export type SessionMutationTarget = {
  sessionKey: string;
  agentId?: string;
};

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
