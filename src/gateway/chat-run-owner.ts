import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";

type ChatRunOwner = { agentId?: string; sessionKey?: string; defaultAgentId?: string };

export function resolveChatRunOwnerAgentId(params: ChatRunOwner): string | undefined {
  const ownerAgentId =
    normalizeOptionalString(params.agentId) ??
    parseAgentSessionKey(params.sessionKey)?.agentId ??
    normalizeOptionalString(params.defaultAgentId);
  return ownerAgentId ? normalizeAgentId(ownerAgentId) : undefined;
}

export function chatRunBelongsToAgent(params: ChatRunOwner, agentId: string): boolean {
  return resolveChatRunOwnerAgentId(params) === normalizeAgentId(agentId);
}

export function chatRunBelongsToSelectedAgent(
  params: ChatRunOwner & { selectedAgentId?: string },
): boolean {
  const selectedAgentId = normalizeOptionalString(params.selectedAgentId);
  return selectedAgentId ? chatRunBelongsToAgent(params, selectedAgentId) : false;
}
