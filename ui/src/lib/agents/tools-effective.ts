// Shared effective-tools loading for agent and Chat model changes.
import type {
  ModelCatalogEntry,
  SessionsListResult,
  ToolsEffectiveResult,
} from "../../api/types.ts";
import {
  createChatModelOverride,
  normalizeChatModelOverrideValue,
  resolvePreferredServerChatModelValue,
} from "../chat/model-ref.ts";
import type { SessionCapability } from "../sessions/index.ts";
import { resolveAgentIdFromSessionKey } from "../sessions/session-key.ts";

type ToolsEffectiveState = {
  chatModelCatalog?: ModelCatalogEntry[];
  client: {
    request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  } | null;
  connected: boolean;
  sessions: Pick<SessionCapability, "state">;
  sessionsResult?: SessionsListResult | null;
  toolsEffectiveError: string | null;
  toolsEffectiveLoading: boolean;
  toolsEffectiveLoadingKey?: string | null;
  toolsEffectiveResult: ToolsEffectiveResult | null;
  toolsEffectiveResultKey?: string | null;
};

export function buildToolsEffectiveRequestKey(
  state: Pick<ToolsEffectiveState, "sessions" | "sessionsResult" | "chatModelCatalog">,
  params: { agentId: string; sessionKey: string },
): string {
  const resolvedAgentId = params.agentId.trim();
  const resolvedSessionKey = params.sessionKey.trim();
  const modelKey = resolveEffectiveToolsModelKey(state, resolvedSessionKey);
  return `${resolvedAgentId}:${resolvedSessionKey}:model=${modelKey || "(default)"}`;
}

export async function loadToolsEffective(
  state: ToolsEffectiveState,
  params: { agentId: string; sessionKey: string },
  options: {
    isCurrent?: () => boolean;
    ignoreResponse?: (agentId: string, requestKey: string) => boolean;
    onError?: (error: unknown) => string;
  } = {},
) {
  const resolvedAgentId = params.agentId.trim();
  const resolvedSessionKey = params.sessionKey.trim();
  const requestKey = buildToolsEffectiveRequestKey(state, {
    agentId: resolvedAgentId,
    sessionKey: resolvedSessionKey,
  });
  if (
    !state.client ||
    !state.connected ||
    !resolvedAgentId ||
    !resolvedSessionKey ||
    (state.toolsEffectiveLoading && state.toolsEffectiveLoadingKey === requestKey)
  ) {
    return;
  }
  const isCurrentRequest = () => options.isCurrent?.() ?? true;
  const shouldIgnoreResponse = () =>
    !isCurrentRequest() || (options.ignoreResponse?.(resolvedAgentId, requestKey) ?? false);
  state.toolsEffectiveLoading = true;
  state.toolsEffectiveLoadingKey = requestKey;
  state.toolsEffectiveResultKey = null;
  state.toolsEffectiveError = null;
  state.toolsEffectiveResult = null;
  try {
    const result = await state.client.request<ToolsEffectiveResult>("tools.effective", {
      agentId: resolvedAgentId,
      sessionKey: resolvedSessionKey,
    });
    if (shouldIgnoreResponse()) {
      return;
    }
    state.toolsEffectiveResultKey = requestKey;
    state.toolsEffectiveResult = result;
  } catch (error) {
    if (shouldIgnoreResponse()) {
      return;
    }
    state.toolsEffectiveError = options.onError?.(error) ?? String(error);
  } finally {
    if (isCurrentRequest() && state.toolsEffectiveLoadingKey === requestKey) {
      state.toolsEffectiveLoadingKey = null;
      state.toolsEffectiveLoading = false;
    }
  }
}

export function resetToolsEffectiveState(state: ToolsEffectiveState) {
  state.toolsEffectiveResult = null;
  state.toolsEffectiveResultKey = null;
  state.toolsEffectiveError = null;
  state.toolsEffectiveLoading = false;
  state.toolsEffectiveLoadingKey = null;
}

export function refreshVisibleToolsEffectiveForCurrentSession(
  state: ToolsEffectiveState & {
    agentsPanel?: string;
    agentsSelectedId?: string | null;
    sessionKey?: string;
  },
): Promise<void> | undefined {
  const resolvedSessionKey = state.sessionKey?.trim();
  if (!resolvedSessionKey || state.agentsPanel !== "tools" || !state.agentsSelectedId) {
    return undefined;
  }
  const sessionAgentId = resolveAgentIdFromSessionKey(resolvedSessionKey);
  if (!sessionAgentId || state.agentsSelectedId !== sessionAgentId) {
    return undefined;
  }
  return loadToolsEffective(state, {
    agentId: sessionAgentId,
    sessionKey: resolvedSessionKey,
  });
}

function resolveEffectiveToolsModelKey(
  state: Pick<ToolsEffectiveState, "sessions" | "sessionsResult" | "chatModelCatalog">,
  sessionKey: string,
): string {
  const resolvedSessionKey = sessionKey.trim();
  if (!resolvedSessionKey) {
    return "";
  }
  const catalog = state.chatModelCatalog ?? [];
  const cachedOverride = state.sessions.state.modelOverrides[resolvedSessionKey];
  const defaults = state.sessionsResult?.defaults;
  const defaultModel = resolvePreferredServerChatModelValue(
    defaults?.model,
    defaults?.modelProvider,
    catalog,
  );
  if (cachedOverride === null) {
    return defaultModel;
  }
  if (cachedOverride) {
    return normalizeChatModelOverrideValue(createChatModelOverride(cachedOverride), catalog);
  }
  const activeRow = state.sessionsResult?.sessions?.find((row) => row.key === resolvedSessionKey);
  if (activeRow?.model) {
    return resolvePreferredServerChatModelValue(activeRow.model, activeRow.modelProvider, catalog);
  }
  return defaultModel;
}
