import { selectApplicationSession } from "../../app/agent-selection.ts";
import { loadLocalAssistantIdentity } from "../../app/assistant-identity.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { isRenderableControlUiAvatarUrl } from "../../lib/avatar.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { resolveSessionKey } from "../../lib/sessions/index.ts";
import {
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  uiSessionRowMatchesSelectedChat,
} from "../../lib/sessions/session-key.ts";
import { resolveChatAgentId } from "./chat-agent-id.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

export { resolveChatAgentId } from "./chat-agent-id.ts";

export function bindChatPageSession(
  context: ApplicationContext,
  routeKey: string,
  routeAgentId?: string,
): void {
  const agentId = parseAgentSessionKey(routeKey)?.agentId ?? routeAgentId?.trim();
  if (parseCatalogSessionKey(routeKey)) {
    if (agentId) {
      context.agentSelection.set(agentId);
    }
    return;
  }
  const sessionKey = resolveSessionKey(routeKey, context.gateway.snapshot.hello);
  const settings = loadSettings();
  // Navigation owns these bindings; focusing or sending from a dock does not.
  if (settings.sessionKey !== sessionKey || settings.lastActiveSessionKey !== sessionKey) {
    patchSettings({ sessionKey, lastActiveSessionKey: sessionKey });
  }
  if (
    context.gateway.snapshot.sessionKey !== sessionKey ||
    (agentId && context.agentSelection.state.selectedId !== agentId)
  ) {
    selectApplicationSession({
      selection: context.agentSelection,
      gateway: context.gateway,
      sessionKey,
      agentId,
    });
  }
}

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
  const row = rows.find((candidate) =>
    uiSessionRowMatchesSelectedChat(state, candidate.key, state.sessionKey, candidate.agentId),
  );
  if (!row || !isUiGlobalSessionKey(row.key)) {
    return row;
  }
  const selectedAgentId = resolveChatAgentId(state);
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
