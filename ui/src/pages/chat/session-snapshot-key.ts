import {
  DEFAULT_MAIN_KEY,
  isUiGlobalSessionKey,
  normalizeAgentId,
  normalizeSessionKeyForUiComparison,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
  resolveUiSelectedGlobalAgentId,
  type UiSessionDefaultsHost,
} from "../../lib/sessions/session-key.ts";

type ChatSnapshotKeyHost = Pick<UiSessionDefaultsHost, "assistantAgentId" | "agentsList" | "hello">;

type ChatSnapshotKeyTarget = {
  sessionKey: string;
  agentId?: string | null;
};

export function resolveChatSnapshotKey(
  host: ChatSnapshotKeyHost,
  target: ChatSnapshotKeyTarget,
): string {
  const parsed = parseAgentSessionKey(target.sessionKey);
  const explicitAgentId = target.agentId?.trim();
  const agentId = explicitAgentId
    ? normalizeAgentId(explicitAgentId)
    : parsed
      ? normalizeAgentId(parsed.agentId)
      : isUiGlobalSessionKey(target.sessionKey)
        ? resolveUiSelectedGlobalAgentId(host)
        : resolveUiDefaultAgentId(host);
  const normalizedSessionKey = normalizeSessionKeyForUiComparison(target.sessionKey);
  const normalized = parsed
    ? normalizedSessionKey.split(":").slice(2).join(":")
    : normalizedSessionKey;
  const configuredMainKey = resolveUiConfiguredMainKey(host);
  const sessionKey =
    isUiGlobalSessionKey(target.sessionKey) ||
    normalized === DEFAULT_MAIN_KEY ||
    normalized === configuredMainKey
      ? DEFAULT_MAIN_KEY
      : normalized;
  return `agent:${agentId}:${sessionKey}`;
}
