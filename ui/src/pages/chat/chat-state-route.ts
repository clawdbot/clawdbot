import { loadLocalAssistantIdentity } from "../../app/assistant-identity.ts";
import { patchSettings } from "../../app/settings.ts";
import { isRenderableControlUiAvatarUrl } from "../../lib/avatar.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  isUiGlobalScopeConfigured,
  normalizeAgentId,
  resolveUiSelectedGlobalAgentId,
  uiSessionRowMatchesSelectedChat,
} from "../../lib/sessions/session-key.ts";
import { resolveChatAgentId } from "./chat-agent-id.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

export { resolveChatAgentId } from "./chat-agent-id.ts";

export function canCreateChatSession(state: ChatPageHost) {
  return (
    !state.chatLoading &&
    !state.chatSending &&
    !state.chatRunId &&
    state.chatStream === null &&
    state.chatQueue.length === 0
  );
}

export function selectedChatSessionRow(state: ChatPageHost) {
  const rows = state.sessionsResult?.sessions ?? [];
  const exact = rows.find((candidate) =>
    areUiSessionKeysEquivalent(candidate.key, state.sessionKey),
  );
  const row =
    exact ??
    (isUiGlobalScopeConfigured(state)
      ? rows.find((candidate) =>
          uiSessionRowMatchesSelectedChat(state, candidate.key, state.sessionKey),
        )
      : undefined);
  if (!row || !isUiGlobalSessionKey(row.key)) {
    return row;
  }
  const selectedAgentId = resolveUiSelectedGlobalAgentId(state);
  if (
    state.sessionsResultAgentId &&
    normalizeAgentId(state.sessionsResultAgentId) !== selectedAgentId
  ) {
    return undefined;
  }
  if (
    row.observerDigest?.agentId &&
    normalizeAgentId(row.observerDigest.agentId) !== selectedAgentId
  ) {
    return { ...row, observerDigest: undefined };
  }
  return row;
}

export function saveRouteSessionSettings(state: ChatPageHost, sessionKey: string) {
  if (
    state.settings.sessionKey === sessionKey &&
    state.settings.lastActiveSessionKey === sessionKey
  ) {
    return;
  }
  state.settings = patchSettings({ sessionKey, lastActiveSessionKey: sessionKey });
}

export function patchChatSessionLabel(
  state: ChatPageHost,
  sessions: Pick<SessionCapability, "patch">,
  sessionKey: string,
  label: string | null,
) {
  return sessions.patch(sessionKey, { label }, { agentId: resolveChatAgentId(state) });
}

export function resolveChatAvatarUrl(state: ChatPageHost): string | null {
  const agentId = resolveChatAgentId(state);
  if (state.chatAvatarUrl) {
    return state.chatAvatarUrl;
  }
  const localAvatar = loadLocalAssistantIdentity({ agentId }).avatar;
  if (localAvatar) {
    return localAvatar;
  }
  const avatarMissing =
    (state.chatAvatarStatus ?? state.assistantAvatarStatus) === "none" &&
    (state.chatAvatarReason ?? state.assistantAvatarReason) === "missing";
  const assistantAvatar = state.assistantAvatar;
  if (
    !avatarMissing &&
    assistantAvatar &&
    isRenderableControlUiAvatarUrl(assistantAvatar) &&
    state.assistantAgentId === agentId
  ) {
    return assistantAvatar;
  }
  const agent = state.agentsList?.agents?.find((candidate) => candidate.id === agentId) as
    | { identity?: { avatar?: string; avatarUrl?: string } }
    | undefined;
  const identity = agent?.identity;
  const avatar = identity?.avatarUrl ?? identity?.avatar;
  return typeof avatar === "string" && isRenderableControlUiAvatarUrl(avatar) ? avatar : null;
}
