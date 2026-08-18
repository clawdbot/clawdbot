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
import type { SidebarContent } from "./chat-sidebar.ts";

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

const checkoutSidebarContents = new WeakSet<object>();

export function trackSessionCheckoutSidebar(content: SidebarContent) {
  checkoutSidebarContents.add(content);
}

export function openSessionCheckoutSidebar(state: SessionWorkspaceHost, content: SidebarContent) {
  trackSessionCheckoutSidebar(content);
  state.handleOpenSidebar(content);
}

function clearSessionCheckoutSidebar(state: SessionWorkspaceHost) {
  if (state.sidebarContent && checkoutSidebarContents.has(state.sidebarContent)) {
    state.handleOpenSidebar(null);
  }
}

function createSessionWorkspaceState(
  state: SessionWorkspaceHost,
  previous?: SessionWorkspaceState,
): SessionWorkspaceState {
  return {
    activeId: null,
    agentId: resolvePaneAgent(state),
    browserPath: "",
    browserSearch: "",
    browserSearchTimer: null,
    collapsed: previous?.collapsed ?? true,
    connectionEpoch: state.connectionEpoch,
    // Dock preference is app-wide, seeded from the host's loaded settings;
    // per-session state just carries it forward.
    dock: previous?.dock ?? normalizeChatWorkspaceDock(state.settings?.chatWorkspaceDock),
    error: null,
    list: null,
    loading: false,
    pendingReload: false,
    sessionKey: state.sessionKey,
  };
}

export function isCurrentSessionWorkspace(
  state: SessionWorkspaceHost,
  workspace: SessionWorkspaceState,
) {
  return (
    state.sessionWorkspaceState === workspace &&
    workspace.sessionKey === state.sessionKey &&
    workspace.agentId === resolvePaneAgent(state) &&
    workspace.connectionEpoch === state.connectionEpoch
  );
}

export function getSessionWorkspace(state: SessionWorkspaceHost): SessionWorkspaceState {
  const current = state.sessionWorkspaceState;
  if (current && isCurrentSessionWorkspace(state, current)) {
    return current;
  }
  clearSessionCheckoutSidebar(state);
  clearWorkspaceTimer(current);
  const next = createSessionWorkspaceState(state, current);
  state.sessionWorkspaceState = next;
  return next;
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
  workspace.loading = true;
  workspace.error = null;
  if (force) {
    workspace.list = null;
  }
  workspace.pendingReload = false;
  const sessionKey = state.sessionKey;
  const agentId = workspace.agentId;
  const client = state.client;
  void (async () => {
    try {
      const files = await state.sessions.listFiles(sessionKey, {
        path: workspace.browserSearch ? "" : workspace.browserPath,
        search: workspace.browserSearch,
        agentId,
      });
      if (!isCurrentSessionWorkspace(state, workspace)) {
        return;
      }
      const artifacts = await client.request<{
        artifacts?: SessionWorkspaceListResult["artifacts"];
      } | null>("artifacts.list", {
        sessionKey,
        ...(agentId ? { agentId } : {}),
      });
      if (!isCurrentSessionWorkspace(state, workspace)) {
        return;
      }
      const fileItems = files?.files ?? [];
      const artifactItems = artifacts?.artifacts ?? [];
      const browserItems = files?.browser?.entries ?? [];
      workspace.list = {
        sessionKey,
        ...(files?.root ? { root: files.root } : {}),
        ...(typeof files?.gitCheckout === "boolean" ? { gitCheckout: files.gitCheckout } : {}),
        files: fileItems,
        ...(files?.browser ? { browser: files.browser } : {}),
        artifacts: artifactItems,
      };
      if (
        workspace.activeId &&
        !fileItems.some((file) => `file:${file.path}` === workspace.activeId) &&
        !browserItems.some((entry) => `file:${entry.path}` === workspace.activeId) &&
        !artifactItems.some((artifact) => `artifact:${artifact.id}` === workspace.activeId)
      ) {
        workspace.activeId = null;
      }
    } catch (error) {
      if (isCurrentSessionWorkspace(state, workspace)) {
        workspace.error = formatUiError(error);
      }
    } finally {
      if (isCurrentSessionWorkspace(state, workspace)) {
        workspace.loading = false;
        const reload = workspace.pendingReload;
        workspace.pendingReload = false;
        if (reload) {
          loadSessionWorkspace(state, workspace);
        }
      }
      requestWorkspaceUpdate(state);
    }
  })();
}

/** Refresh workspace facts after a run, which may have created a git checkout. */
export function refreshSessionWorkspaceState(state: SessionWorkspaceHost): boolean {
  const workspace = state.sessionWorkspaceState;
  if (!workspace || workspace.sessionKey !== state.sessionKey) {
    return false;
  }
  const diffOpen =
    workspace.diffContent !== undefined && state.sidebarContent === workspace.diffContent;
  delete workspace.diffContent;
  if (workspace.loading) {
    workspace.pendingReload = true;
  } else {
    loadSessionWorkspace(state, workspace);
  }
  return diffOpen;
}

/** Retire facts owned by one checkout without disturbing panel layout or retained drafts. */
export function retireSessionWorkspaceCheckout(state: SessionWorkspaceHost) {
  const current = state.sessionWorkspaceState;
  if (!current || current.sessionKey !== state.sessionKey) {
    return;
  }
  clearSessionCheckoutSidebar(state);
  clearWorkspaceTimer(current);
  const next = createSessionWorkspaceState(state, current);
  state.sessionWorkspaceState = next;
  if (state.client && state.connected) {
    loadSessionWorkspace(state, next);
  }
  requestWorkspaceUpdate(state);
}
