import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionWorkspaceListResult } from "../../../api/types.ts";
import { normalizeChatWorkspaceDock } from "../../../app/settings.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import {
  scopedAgentParamsForSession,
  type SessionScopeHostWithKey,
} from "../../../lib/sessions/index.ts";
import {
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
} from "../../../lib/sessions/session-key.ts";
import type {
  SessionWorkspaceHost,
  SessionWorkspaceState,
} from "./chat-session-workspace-types.ts";

export function resolvePaneAgent(state: SessionScopeHostWithKey): string {
  const normalizedKey = normalizeOptionalString(state.sessionKey)?.toLowerCase();
  const activeAgentId =
    normalizedKey === "global" ? null : resolveAgentIdFromSessionKey(state.sessionKey);
  const scopedAgentId = scopedAgentParamsForSession(state, state.sessionKey).agentId;
  const fallback = normalizeAgentId(
    state.assistantAgentId ??
      state.agentsList?.defaultId ??
      state.agentsList?.agents?.[0]?.id ??
      "main",
  );
  return normalizedKey === "global"
    ? (scopedAgentId ?? fallback)
    : (activeAgentId ?? scopedAgentId ?? fallback);
}

export function clearWorkspaceTimer(workspace: SessionWorkspaceState | undefined) {
  if (workspace?.browserSearchTimer) {
    globalThis.clearTimeout(workspace.browserSearchTimer);
    workspace.browserSearchTimer = null;
  }
}

export function clearSessionWorkspaceTimers(state: SessionWorkspaceHost) {
  clearWorkspaceTimer(state.sessionWorkspaceState);
}

export function getSessionWorkspace(state: SessionWorkspaceHost): SessionWorkspaceState {
  const sessionKey = state.sessionKey;
  const agentId = resolvePaneAgent(state);
  const current = state.sessionWorkspaceState;
  if (current?.sessionKey === sessionKey && current.agentId === agentId) {
    return current;
  }
  clearWorkspaceTimer(current);
  const next: SessionWorkspaceState = {
    activeId: null,
    agentId,
    browserPath: "",
    browserSearch: "",
    browserSearchTimer: null,
    collapsed: true,
    // Dock preference is app-wide, seeded from the host's loaded settings;
    // per-session state just carries it forward.
    dock: current?.dock ?? normalizeChatWorkspaceDock(state.settings?.chatWorkspaceDock),
    error: null,
    list: null,
    loading: false,
    pendingReload: false,
    requestId: 0,
    sessionKey,
  };
  state.sessionWorkspaceState = next;
  return next;
}

export function currentSessionWorkspace(state: SessionWorkspaceHost): SessionWorkspaceState {
  return getSessionWorkspace(state);
}

export function requestWorkspaceUpdate(state: SessionWorkspaceHost) {
  state.requestUpdate?.();
}

export function loadSessionWorkspace(
  state: SessionWorkspaceHost,
  workspace: SessionWorkspaceState,
  force = false,
) {
  if (!state.client || !state.connected) {
    return;
  }
  if (workspace.loading) {
    if (force) {
      workspace.pendingReload = true;
    }
    return;
  }
  const requestId = workspace.requestId + 1;
  workspace.requestId = requestId;
  workspace.loading = true;
  workspace.error = null;
  if (force) {
    workspace.list = null;
  }
  workspace.pendingReload = false;
  const sessionKey = state.sessionKey;
  const agentId = workspace.agentId;
  void (async () => {
    try {
      const files = await state.sessions.listFiles(sessionKey, {
        path: workspace.browserSearch ? "" : workspace.browserPath,
        search: workspace.browserSearch,
        agentId,
      });
      const artifacts = await state.client?.request<{
        artifacts?: SessionWorkspaceListResult["artifacts"];
      } | null>("artifacts.list", {
        sessionKey,
        ...(agentId ? { agentId } : {}),
      });
      const current = currentSessionWorkspace(state);
      if (current !== workspace || current.requestId !== requestId) {
        return;
      }
      const fileItems = files?.files ?? [];
      const artifactItems = artifacts?.artifacts ?? [];
      const browserItems = files?.browser?.entries ?? [];
      current.list = {
        sessionKey,
        ...(files?.root ? { root: files.root } : {}),
        ...(typeof files?.gitCheckout === "boolean" ? { gitCheckout: files.gitCheckout } : {}),
        files: fileItems,
        ...(files?.browser ? { browser: files.browser } : {}),
        artifacts: artifactItems,
      };
      if (
        current.activeId &&
        !fileItems.some((file) => `file:${file.path}` === current.activeId) &&
        !browserItems.some((entry) => `file:${entry.path}` === current.activeId) &&
        !artifactItems.some((artifact) => `artifact:${artifact.id}` === current.activeId)
      ) {
        current.activeId = null;
      }
    } catch (error) {
      const current = currentSessionWorkspace(state);
      if (current === workspace && current.requestId === requestId) {
        current.error = formatUiError(error);
      }
    } finally {
      const current = currentSessionWorkspace(state);
      if (current === workspace && current.requestId === requestId) {
        current.loading = false;
        const reload = current.pendingReload;
        current.pendingReload = false;
        if (reload) {
          loadSessionWorkspace(state, current);
        }
      }
      requestWorkspaceUpdate(state);
    }
  })();
}

/** Refresh workspace facts after a run, which may have created a git checkout. */
export function refreshSessionWorkspace(state: SessionWorkspaceHost) {
  const workspace = state.sessionWorkspaceState;
  if (!workspace || workspace.sessionKey !== state.sessionKey) {
    return;
  }
  if (workspace.loading) {
    workspace.pendingReload = true;
  } else {
    loadSessionWorkspace(state, workspace);
  }
}
