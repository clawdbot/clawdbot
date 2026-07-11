import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../../api/gateway.ts";
import type { ArtifactDownloadResult, SessionWorkspaceListResult } from "../../../api/types.ts";
import {
  normalizeChatWorkspaceDock,
  patchSettings,
  type ChatWorkspaceDock,
  type UiSettings,
} from "../../../app/settings.ts";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { copyToClipboard } from "../../../lib/clipboard.ts";
import {
  scopedAgentParamsForSession,
  type SessionCapability,
  type SessionScopeHost,
  type SessionScopeHostWithKey,
} from "../../../lib/sessions/index.ts";
import {
  resolveAgentIdFromSessionKey,
  normalizeAgentId,
} from "../../../lib/sessions/session-key.ts";
import { normalizeOptionalString } from "../../../lib/string-coerce.ts";
import type { SidebarContent } from "./chat-sidebar.ts";

export type SessionWorkspaceProps = {
  collapsed: boolean;
  sessionKey: string;
  list: SessionWorkspaceListResult | null;
  loading: boolean;
  error: string | null;
  activeId: string | null;
  dock: ChatWorkspaceDock;
  /** Pane too narrow for a side rail: presentation forces the bottom dock
   * (the persisted dock preference still applies once the pane widens). */
  narrowLayout: boolean;
  dockDragging: boolean;
  dockDragZone: ChatWorkspaceDock | null;
  onToggleCollapsed: () => void;
  onSetDock: (dock: ChatWorkspaceDock) => void;
  onDockDragStart: (event: PointerEvent) => void;
  onRefresh: () => void;
  onBrowsePath: (path: string) => void;
  onCopyPath: (path: string) => void;
  onOpenFile: (path: string, origin: "session" | "workspace") => void;
  onSearch: (search: string) => void;
  onOpenArtifact: (artifactId: string) => void;
  onToggleTerminal?: () => void;
  onToggleBrowser?: () => void;
};

type SessionWorkspaceState = {
  activeId: string | null;
  agentId: string;
  browserPath: string;
  browserSearch: string;
  browserSearchTimer: ReturnType<typeof globalThis.setTimeout> | null;
  collapsed: boolean;
  dock: ChatWorkspaceDock;
  dockDragging: boolean;
  dockDragZone: ChatWorkspaceDock | null;
  error: string | null;
  list: SessionWorkspaceListResult | null;
  loading: boolean;
  pendingReload: boolean;
  requestId: number;
  sessionKey: string;
};

type OpenRequest = {
  agentId: string;
  id: number;
  itemId: string;
  sessionKey: string;
};

type SessionWorkspaceOpenRequest = OpenRequest;

export type SessionWorkspaceHost = {
  sessionKey: string;
  sessions: SessionCapability;
  client: GatewayBrowserClient | null;
  connected: boolean;
  hello: GatewayHelloOk | null;
  terminalAvailable?: boolean;
  browserPanelAvailable?: boolean;
  assistantAgentId?: string | null;
  agentsList?: SessionScopeHost["agentsList"];
  settings?: UiSettings;
  sessionWorkspaceState?: SessionWorkspaceState;
  sessionWorkspaceOpenRequest?: SessionWorkspaceOpenRequest;
  requestUpdate?: () => void;
  handleOpenSidebar: (content: SidebarContent) => void;
};

/** Agent owning the pane's current session: explicit key scope first, then the
 * assistant/default agent. Shared by the workspace and background-tasks rails
 * so both scope their gateway queries the same way. */
export function paneSessionAgentId(state: SessionScopeHostWithKey): string {
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

function clearWorkspaceSearchTimer(workspace: SessionWorkspaceState | undefined) {
  if (workspace?.browserSearchTimer) {
    globalThis.clearTimeout(workspace.browserSearchTimer);
    workspace.browserSearchTimer = null;
  }
}

export function clearSessionWorkspaceTimers(state: SessionWorkspaceHost) {
  clearWorkspaceSearchTimer(state.sessionWorkspaceState);
}

function getWorkspaceState(state: SessionWorkspaceHost): SessionWorkspaceState {
  const sessionKey = state.sessionKey;
  const agentId = paneSessionAgentId(state);
  const current = state.sessionWorkspaceState;
  if (current?.sessionKey === sessionKey && current.agentId === agentId) {
    return current;
  }
  clearWorkspaceSearchTimer(current);
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
    dockDragging: false,
    dockDragZone: null,
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

function currentWorkspaceState(state: SessionWorkspaceHost): SessionWorkspaceState {
  return getWorkspaceState(state);
}

function requestUpdate(state: SessionWorkspaceHost) {
  state.requestUpdate?.();
}

function languageForFile(name: string): string {
  const extension = name.match(/\.([a-z0-9_-]+)$/i)?.[1]?.toLowerCase() ?? "";
  if (extension === "yml") {
    return "yaml";
  }
  return extension;
}

function fileSidebarContent(name: string, content: string): string {
  if (/\.(?:md|markdown|mdx)$/i.test(name)) {
    return content;
  }
  return `# ${name}\n\n\`\`\`${languageForFile(name)}\n${content}\n\`\`\``;
}

function basenameForPath(filePath: string): string {
  return filePath.split(/[\\/]/).findLast((part) => part) ?? filePath;
}

export function workspaceBrowserFilePath(root: string | undefined, filePath: string): string {
  if (!root) {
    return filePath;
  }
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const base = root.replace(/[\\/]+$/, "");
  const relative = filePath.replace(/^[\\/]+/, "").replaceAll(/[\\/]/g, separator);
  return base ? `${base}${separator}${relative}` : `${separator}${relative}`;
}

function artifactSidebarContent(params: {
  data?: string;
  encoding?: string;
  mimeType: string;
  title: string;
  url?: string;
}): SidebarContent {
  const { data, encoding, mimeType, title, url } = params;
  if (encoding === "base64" && data && mimeType.startsWith("image/")) {
    return {
      kind: "image",
      title,
      src: `data:${mimeType};base64,${data}`,
      mimeType,
      rawText: url ?? null,
    };
  }
  if (encoding === "base64" && data && mimeType === "application/json") {
    const decoded = globalThis.atob(data);
    return {
      kind: "markdown",
      content: `# ${title}\n\n\`\`\`json\n${decoded}\n\`\`\``,
      rawText: decoded,
    };
  }
  if (encoding === "base64" && data && mimeType.startsWith("text/")) {
    const decoded = globalThis.atob(data);
    return {
      kind: "markdown",
      content: `# ${title}\n\n\`\`\`\n${decoded}\n\`\`\``,
      rawText: decoded,
    };
  }
  if (url) {
    const content = `# ${title}\n\n[Open artifact](${url})`;
    return { kind: "markdown", content, rawText: content };
  }
  const content = `# ${title}\n\nArtifact download is not previewable in the sidebar.`;
  return { kind: "markdown", content, rawText: content };
}

function loadWorkspace(
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
      const current = currentWorkspaceState(state);
      if (current !== workspace || current.requestId !== requestId) {
        return;
      }
      const fileItems = files?.files ?? [];
      const artifactItems = artifacts?.artifacts ?? [];
      const browserItems = files?.browser?.entries ?? [];
      current.list = {
        sessionKey,
        ...(files?.root ? { root: files.root } : {}),
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
      const current = currentWorkspaceState(state);
      if (current === workspace && current.requestId === requestId) {
        current.error = String(error);
      }
    } finally {
      const current = currentWorkspaceState(state);
      if (current === workspace && current.requestId === requestId) {
        current.loading = false;
        const reload = current.pendingReload;
        current.pendingReload = false;
        if (reload) {
          loadWorkspace(state, current, true);
        }
      }
      requestUpdate(state);
    }
  })();
}

function beginOpenRequest(
  state: SessionWorkspaceHost,
  workspace: SessionWorkspaceState,
  itemId: string,
): OpenRequest {
  workspace.activeId = itemId;
  const previous = state.sessionWorkspaceOpenRequest;
  const request: OpenRequest = {
    agentId: workspace.agentId,
    id: (previous?.id ?? 0) + 1,
    itemId,
    sessionKey: state.sessionKey,
  };
  state.sessionWorkspaceOpenRequest = request;
  return request;
}

function isCurrentOpenRequest(state: SessionWorkspaceHost, request: OpenRequest): boolean {
  const currentRequest = state.sessionWorkspaceOpenRequest;
  const current = currentWorkspaceState(state);
  return (
    currentRequest?.id === request.id &&
    currentRequest.agentId === paneSessionAgentId(state) &&
    currentRequest.itemId === request.itemId &&
    currentRequest.sessionKey === state.sessionKey &&
    current?.agentId === request.agentId &&
    current.activeId === request.itemId
  );
}

function openWorkspaceItem<T>(
  state: SessionWorkspaceHost,
  workspace: SessionWorkspaceState,
  itemId: string,
  load: (request: OpenRequest) => Promise<T | null | undefined>,
  render: (result: T) => SidebarContent | null,
  missingMessage: string,
) {
  const request = beginOpenRequest(state, workspace, itemId);
  void (async () => {
    if (!state.client || !state.connected) {
      return;
    }
    workspace.error = null;
    try {
      const result = await load(request);
      const content = result == null ? null : render(result);
      if (!content) {
        if (isCurrentOpenRequest(state, request)) {
          workspace.error = missingMessage;
          requestUpdate(state);
        }
        return;
      }
      if (isCurrentOpenRequest(state, request)) {
        state.handleOpenSidebar(content);
      }
    } catch (error) {
      if (isCurrentOpenRequest(state, request)) {
        workspace.error = String(error);
      }
    } finally {
      requestUpdate(state);
    }
  })();
}

function openFile(
  state: SessionWorkspaceHost,
  workspace: SessionWorkspaceState,
  path: string,
  opts: { line?: number | null; requestPath?: string } = {},
) {
  openWorkspaceItem(
    state,
    workspace,
    `file:${path}`,
    (request) =>
      state.sessions.getFile(request.sessionKey, opts.requestPath ?? path, {
        agentId: request.agentId,
      }),
    (result) => {
      const file = result.file;
      if (!file || typeof file.content !== "string") {
        return null;
      }
      const name = file.name || basenameForPath(path);
      if (/\.(?:md|markdown|mdx)$/i.test(name) && opts.line == null) {
        return {
          kind: "markdown",
          content: fileSidebarContent(name, file.content),
          rawText: file.content,
        };
      }
      return {
        kind: "file",
        path: file.workspacePath || file.path || path,
        name,
        content: file.content,
        root: result.root ?? null,
        language: languageForFile(name),
        line: opts.line ?? null,
        rawText: file.content,
      };
    },
    `Failed to load ${path}`,
  );
}

export function openSessionWorkspaceFile(
  state: SessionWorkspaceHost,
  target: { path: string; line?: number | null },
) {
  openFile(state, getWorkspaceState(state), target.path, { line: target.line });
}

export function toggleSessionWorkspace(state: SessionWorkspaceHost) {
  const workspace = getWorkspaceState(state);
  workspace.collapsed = !workspace.collapsed;
  if (!workspace.collapsed && workspace.list?.sessionKey !== state.sessionKey) {
    loadWorkspace(state, workspace);
  }
  requestUpdate(state);
}

function setSessionWorkspaceDock(state: SessionWorkspaceHost, dock: ChatWorkspaceDock) {
  const workspace = getWorkspaceState(state);
  if (workspace.dock !== dock) {
    workspace.dock = dock;
    // Keep the host's settings snapshot in step so the next session's
    // workspace state seeds from the same dock without a storage read.
    if (state.settings) {
      state.settings = { ...state.settings, chatWorkspaceDock: dock };
    }
    patchSettings({ chatWorkspaceDock: dock });
  }
  requestUpdate(state);
}

/** Drag the rail by its header to re-dock it inside the pane: the right and
 * bottom bands of .chat-workbench are drop zones (mirrors the terminal
 * panel's right/bottom dock). A small threshold keeps plain clicks intact. */
function startSessionWorkspaceDockDrag(state: SessionWorkspaceHost, event: PointerEvent) {
  if (event.button !== 0) {
    return;
  }
  const grip = event.currentTarget;
  if (!(grip instanceof HTMLElement)) {
    return;
  }
  const workbench = grip.closest<HTMLElement>(".chat-workbench");
  if (!workbench) {
    return;
  }
  const workspace = getWorkspaceState(state);
  const startX = event.clientX;
  const startY = event.clientY;

  const resolveZone = (x: number, y: number): ChatWorkspaceDock | null => {
    const rect = workbench.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      return null;
    }
    if (y > rect.bottom - rect.height * 0.32) {
      return "bottom";
    }
    return x > rect.right - rect.width * 0.3 ? "right" : null;
  };

  const handleMove = (move: PointerEvent) => {
    if (!workspace.dockDragging) {
      if (Math.hypot(move.clientX - startX, move.clientY - startY) < 5) {
        return;
      }
      workspace.dockDragging = true;
      workspace.dockDragZone = resolveZone(move.clientX, move.clientY);
      requestUpdate(state);
      return;
    }
    const zone = resolveZone(move.clientX, move.clientY);
    if (zone !== workspace.dockDragZone) {
      workspace.dockDragZone = zone;
      requestUpdate(state);
    }
  };
  const finish = (apply: boolean) => {
    grip.removeEventListener("pointermove", handleMove);
    grip.removeEventListener("pointerup", handleUp);
    grip.removeEventListener("pointercancel", handleCancel);
    const zone = workspace.dockDragZone;
    workspace.dockDragging = false;
    workspace.dockDragZone = null;
    if (apply && zone) {
      setSessionWorkspaceDock(state, zone);
      return;
    }
    requestUpdate(state);
  };
  const handleUp = () => finish(true);
  const handleCancel = () => finish(false);

  grip.setPointerCapture(event.pointerId);
  grip.addEventListener("pointermove", handleMove);
  grip.addEventListener("pointerup", handleUp);
  grip.addEventListener("pointercancel", handleCancel);
}

export function revealSessionWorkspaceFile(state: SessionWorkspaceHost, path: string) {
  const workspace = getWorkspaceState(state);
  clearWorkspaceSearchTimer(workspace);
  const normalizedPath = path.replaceAll("\\", "/");
  const separator = normalizedPath.lastIndexOf("/");
  workspace.collapsed = false;
  workspace.browserPath = separator > 0 ? normalizedPath.slice(0, separator) : "";
  workspace.browserSearch = "";
  workspace.activeId = `file:${path}`;
  loadWorkspace(state, workspace, true);
  requestUpdate(state);
}

function openArtifact(
  state: SessionWorkspaceHost,
  workspace: SessionWorkspaceState,
  artifactId: string,
) {
  openWorkspaceItem(
    state,
    workspace,
    `artifact:${artifactId}`,
    (request) =>
      state.client!.request<ArtifactDownloadResult | null>("artifacts.download", {
        sessionKey: request.sessionKey,
        artifactId,
        ...(request.agentId ? { agentId: request.agentId } : {}),
      }),
    (result) =>
      !result.artifact
        ? null
        : artifactSidebarContent({
            data: result.data,
            encoding: result.encoding,
            mimeType: result.artifact.mimeType ?? "",
            title: result.artifact.title,
            url: result.url,
          }),
    `Failed to load artifact ${artifactId}`,
  );
}

export function createSessionWorkspaceProps(
  state: SessionWorkspaceHost,
  options?: { narrowLayout?: boolean },
): SessionWorkspaceProps {
  const workspace = getWorkspaceState(state);
  if (
    !workspace.collapsed &&
    state.connected &&
    state.agentsList &&
    !workspace.loading &&
    !workspace.error &&
    workspace.list?.sessionKey !== state.sessionKey
  ) {
    loadWorkspace(state, workspace);
  }
  return {
    collapsed: workspace.collapsed,
    sessionKey: state.sessionKey,
    list: workspace.list?.sessionKey === state.sessionKey ? workspace.list : null,
    loading: workspace.loading,
    error: workspace.error,
    activeId: workspace.activeId,
    dock: workspace.dock,
    narrowLayout: options?.narrowLayout === true,
    dockDragging: workspace.dockDragging,
    dockDragZone: workspace.dockDragZone,
    onToggleCollapsed: () => toggleSessionWorkspace(state),
    onSetDock: (dock) => setSessionWorkspaceDock(state, dock),
    onDockDragStart: (event) => startSessionWorkspaceDockDrag(state, event),
    onRefresh: () => loadWorkspace(state, workspace, true),
    onBrowsePath: (path) => {
      clearWorkspaceSearchTimer(workspace);
      workspace.browserPath = path;
      workspace.browserSearch = "";
      loadWorkspace(state, workspace, true);
    },
    onCopyPath: (path) => {
      void copyToClipboard(path);
    },
    onOpenFile: (path, origin) => {
      // Session paths are cwd-relative; browser rows are workspace-root-relative.
      // Keep the origin explicit so a nested cwd cannot shadow the selected browser file.
      const opts =
        origin === "workspace"
          ? { requestPath: workspaceBrowserFilePath(workspace.list?.root, path) }
          : {};
      openFile(state, workspace, path, opts);
    },
    onSearch: (search) => {
      workspace.browserSearch = search;
      clearWorkspaceSearchTimer(workspace);
      workspace.browserSearchTimer = globalThis.setTimeout(() => {
        workspace.browserSearchTimer = null;
        loadWorkspace(state, workspace, true);
      }, 160);
    },
    onOpenArtifact: (artifactId) => openArtifact(state, workspace, artifactId),
    onToggleTerminal: state.terminalAvailable
      ? () => {
          window.dispatchEvent(
            new CustomEvent("openclaw:terminal-toggle", {
              detail: { dock: "right", open: true },
            }),
          );
        }
      : undefined,
    onToggleBrowser: state.browserPanelAvailable
      ? () => {
          window.dispatchEvent(new CustomEvent("openclaw:browser-toggle", {}));
        }
      : undefined,
  };
}

function formatWorkspaceFileSize(file: { size?: number }): string {
  const size = file.size;
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
    return "";
  }
  if (size >= 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
  }
  if (size >= 1024) {
    return `${(size / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
  }
  return `${size} B`;
}

function renderWorkspaceArtifactSize(artifact: { sizeBytes?: number }): string {
  return formatWorkspaceFileSize({ size: artifact.sizeBytes });
}

function renderWorkspaceRailSection(
  title: string,
  content: TemplateResult | typeof nothing,
): TemplateResult | typeof nothing {
  if (content === nothing) {
    return nothing;
  }
  return html`
    <section class="chat-workspace-rail__section">
      <div class="chat-workspace-rail__section-title">${title}</div>
      ${content}
    </section>
  `;
}

/** Changed-file count shown on the collapsed-rail toggles (pane header /
 * floating opener); 0 until the workspace list has loaded. */
export function sessionWorkspaceModifiedCount(
  sessionWorkspace: SessionWorkspaceProps | undefined,
): number {
  return sessionWorkspace?.list?.files.filter((file) => file.kind === "modified").length ?? 0;
}

/** Toggle used wherever the rail itself is not visible: the split pane header
 * and the single-pane floating opener. Collapsed rails render nothing, so
 * this button is the only pointer affordance (⇧⌘B still works). */
export function renderSessionWorkspaceToggle(
  sessionWorkspace: SessionWorkspaceProps | undefined,
  variant: "pane-header" | "floating",
): TemplateResult | typeof nothing {
  if (!sessionWorkspace) {
    return nothing;
  }
  const expanded = !sessionWorkspace.collapsed;
  const label = expanded ? t("chat.workspaceFiles.collapse") : t("chat.workspaceFiles.showFiles");
  const modifiedCount = sessionWorkspaceModifiedCount(sessionWorkspace);
  return html`
    <openclaw-tooltip .content=${`${label} (⇧⌘B)`}>
      <button
        class="${variant === "pane-header"
          ? "btn btn--ghost btn--icon"
          : "btn btn--sm btn--icon chat-workspace-open"} chat-workspace-toggle"
        type="button"
        aria-label=${label}
        aria-keyshortcuts="Meta+Shift+B"
        aria-expanded=${String(expanded)}
        @click=${sessionWorkspace.onToggleCollapsed}
      >
        ${icons.fileText}
        ${!expanded && modifiedCount > 0
          ? html`<span class="chat-workspace-toggle__badge" aria-hidden="true"
              >${modifiedCount}</span
            >`
          : nothing}
      </button>
    </openclaw-tooltip>
  `;
}

export function renderSessionWorkspaceRail(
  sessionWorkspace: SessionWorkspaceProps | undefined,
): TemplateResult | typeof nothing {
  // Collapsed rails render nothing at all — no icon strip. Reopening happens
  // through renderSessionWorkspaceToggle or ⇧⌘B.
  if (!sessionWorkspace || sessionWorkspace.collapsed) {
    return nothing;
  }
  // Narrow panes always present the rail as a bottom strip; a side column
  // would crush the thread below its readable minimum.
  const dock = sessionWorkspace.narrowLayout ? "bottom" : sessionWorkspace.dock;
  const terminalButton = sessionWorkspace.onToggleTerminal
    ? html`
        <openclaw-tooltip .content=${t("terminal.toggle")}>
          <button
            type="button"
            class="chat-workspace-rail__terminal"
            aria-label=${t("terminal.toggle")}
            @click=${sessionWorkspace.onToggleTerminal}
          >
            ${icons.terminal}
          </button>
        </openclaw-tooltip>
      `
    : nothing;
  const browserButton = sessionWorkspace.onToggleBrowser
    ? html`
        <openclaw-tooltip .content=${t("browser.toggle")}>
          <button
            type="button"
            class="chat-workspace-rail__terminal"
            aria-label=${t("browser.toggle")}
            @click=${sessionWorkspace.onToggleBrowser}
          >
            ${icons.globe}
          </button>
        </openclaw-tooltip>
      `
    : nothing;
  const files = sessionWorkspace.list?.files ?? [];
  const modifiedFiles = files.filter((file) => file.kind === "modified");
  const readFiles = files.filter((file) => file.kind === "read");
  const artifacts = sessionWorkspace.list?.artifacts ?? [];
  const browser = sessionWorkspace.list?.browser ?? null;
  const hasSessionItems = files.length > 0 || artifacts.length > 0;
  const hasBrowserItems = (browser?.entries.length ?? 0) > 0;
  const hasItems = hasSessionItems || hasBrowserItems;
  const renderPathActions = (path: string, origin: "session" | "workspace"): TemplateResult => html`
    <span
      class="chat-workspace-rail__row-actions"
      role="group"
      aria-label=${t("chat.workspaceFiles.actions")}
    >
      <openclaw-tooltip .content=${t("chat.workspaceFiles.preview")}>
        <button
          class="chat-workspace-rail__row-action"
          type="button"
          aria-label=${t("chat.workspaceFiles.preview")}
          @click=${(event: Event) => {
            event.stopPropagation();
            sessionWorkspace.onOpenFile(path, origin);
          }}
        >
          ${icons.eye}
        </button>
      </openclaw-tooltip>
      <openclaw-tooltip .content=${t("chat.workspaceFiles.copyPath")}>
        <button
          class="chat-workspace-rail__row-action"
          type="button"
          aria-label=${t("chat.workspaceFiles.copyPath")}
          @click=${(event: Event) => {
            event.stopPropagation();
            sessionWorkspace.onCopyPath(path);
          }}
        >
          ${icons.copy}
        </button>
      </openclaw-tooltip>
    </span>
  `;
  const renderSessionSummary = (): TemplateResult | typeof nothing => {
    if (!sessionWorkspace.list) {
      return nothing;
    }
    const browserCount = browser?.entries.length ?? 0;
    return html`
      <div class="chat-workspace-rail__summary" aria-label=${t("chat.workspaceFiles.summary")}>
        <span
          >${t("chat.workspaceFiles.changedCount", { count: String(modifiedFiles.length) })}</span
        >
        <span>${t("chat.workspaceFiles.readCount", { count: String(readFiles.length) })}</span>
        <span>${t("chat.workspaceFiles.artifactCount", { count: String(artifacts.length) })}</span>
        <span>${t("chat.workspaceFiles.browserCount", { count: String(browserCount) })}</span>
      </div>
    `;
  };
  const renderFileRows = (rows: typeof files): TemplateResult | typeof nothing =>
    rows.length === 0
      ? nothing
      : html`
          <div class="chat-workspace-rail__list" role="list">
            ${rows.map((file) => {
              const size = formatWorkspaceFileSize(file);
              const itemId = `file:${file.path}`;
              const isActive = itemId === sessionWorkspace.activeId;
              return html`
                <div
                  class="chat-workspace-rail__file ${isActive
                    ? "chat-workspace-rail__file--active"
                    : ""}"
                  role="listitem"
                >
                  <button
                    class="chat-workspace-rail__file-open"
                    type="button"
                    @click=${() => sessionWorkspace.onOpenFile(file.path, "session")}
                  >
                    <span class="chat-workspace-rail__file-icon">${icons.fileText}</span>
                    <span class="chat-workspace-rail__file-main">
                      <openclaw-tooltip .content=${file.path || file.name}>
                        <span class="chat-workspace-rail__file-name"
                          >${file.path || file.name}</span
                        >
                      </openclaw-tooltip>
                      ${size
                        ? html`<span class="chat-workspace-rail__file-meta">${size}</span>`
                        : nothing}
                    </span>
                  </button>
                  ${file.missing
                    ? html`<span class="chat-workspace-rail__file-badge"
                        >${t("chat.workspaceFiles.missing")}</span
                      >`
                    : nothing}
                  ${renderPathActions(file.path, "session")}
                </div>
              `;
            })}
          </div>
        `;
  const renderBrowserBadge = (
    sessionKind: "modified" | "read" | "mixed" | undefined,
  ): TemplateResult | typeof nothing => {
    if (!sessionKind) {
      return nothing;
    }
    const label =
      sessionKind === "modified"
        ? t("chat.workspaceFiles.changed")
        : sessionKind === "read"
          ? t("chat.workspaceFiles.read")
          : t("chat.workspaceFiles.session");
    return html`<span class="chat-workspace-rail__file-badge">${label}</span>`;
  };
  const renderBrowserRows = (): TemplateResult => {
    const entries = browser?.entries ?? [];
    const parentPath = browser?.parentPath;
    return html`
      <section class="chat-workspace-rail__browser">
        <div class="chat-workspace-rail__browser-tools">
          <label class="chat-workspace-rail__search">
            <span class="chat-workspace-rail__search-icon" aria-hidden="true">${icons.search}</span>
            <input
              type="search"
              placeholder=${t("chat.workspaceFiles.search")}
              aria-label=${t("chat.workspaceFiles.search")}
              .value=${browser?.search ?? ""}
              @input=${(event: Event) => {
                const target = event.target as HTMLInputElement;
                sessionWorkspace.onSearch(target.value);
              }}
            />
          </label>
        </div>
        ${browser?.search
          ? html`<div class="chat-workspace-rail__browser-caption">
              ${t("chat.workspaceFiles.searchResults")}
            </div>`
          : nothing}
        <div class="chat-workspace-rail__list chat-workspace-rail__list--browser" role="list">
          ${!browser?.search && parentPath != null
            ? html`
                <div
                  class="chat-workspace-rail__file chat-workspace-rail__file--directory"
                  role="listitem"
                >
                  <button
                    class="chat-workspace-rail__file-open"
                    type="button"
                    @click=${() => sessionWorkspace.onBrowsePath(parentPath)}
                  >
                    <span class="chat-workspace-rail__file-icon">${icons.folder}</span>
                    <span class="chat-workspace-rail__file-main">
                      <span class="chat-workspace-rail__file-name">..</span>
                      <span class="chat-workspace-rail__file-meta"
                        >${t("chat.workspaceFiles.parentFolder")}</span
                      >
                    </span>
                  </button>
                </div>
              `
            : nothing}
          ${entries.length === 0
            ? html`<div class="chat-workspace-rail__state">
                ${browser?.search
                  ? t("chat.workspaceFiles.noSearchResults")
                  : t("chat.workspaceFiles.noBrowserFiles")}
              </div>`
            : entries.map((entry) => {
                const size = entry.kind === "file" ? formatWorkspaceFileSize(entry) : "";
                const itemId = `file:${entry.path}`;
                const isActive = itemId === sessionWorkspace.activeId;
                return html`
                  <div
                    class="chat-workspace-rail__file ${entry.kind === "directory"
                      ? "chat-workspace-rail__file--directory"
                      : ""} ${isActive ? "chat-workspace-rail__file--active" : ""}"
                    role="listitem"
                  >
                    <button
                      class="chat-workspace-rail__file-open"
                      type="button"
                      @click=${() =>
                        entry.kind === "directory"
                          ? sessionWorkspace.onBrowsePath(entry.path)
                          : sessionWorkspace.onOpenFile(entry.path, "workspace")}
                    >
                      <span class="chat-workspace-rail__file-icon"
                        >${entry.kind === "directory" ? icons.folder : icons.fileText}</span
                      >
                      <span class="chat-workspace-rail__file-main">
                        <openclaw-tooltip .content=${entry.path || entry.name}>
                          <span class="chat-workspace-rail__file-name">${entry.name}</span>
                        </openclaw-tooltip>
                        <span class="chat-workspace-rail__file-meta">
                          ${entry.kind === "directory"
                            ? entry.path || t("chat.workspaceFiles.root")
                            : [entry.path, size].filter(Boolean).join(" / ")}
                        </span>
                      </span>
                    </button>
                    ${renderBrowserBadge(entry.sessionKind)}
                    ${entry.kind === "file" ? renderPathActions(entry.path, "workspace") : nothing}
                  </div>
                `;
              })}
        </div>
        ${browser?.truncated
          ? html`<div class="chat-workspace-rail__state">
              ${t("chat.workspaceFiles.truncated")}
            </div>`
          : nothing}
      </section>
    `;
  };
  const renderArtifactRows = (): TemplateResult | typeof nothing =>
    artifacts.length === 0
      ? nothing
      : html`
          <div class="chat-workspace-rail__list" role="list">
            ${artifacts.map((artifact) => {
              const size = renderWorkspaceArtifactSize(artifact);
              const itemId = `artifact:${artifact.id}`;
              const isActive = itemId === sessionWorkspace.activeId;
              const isImage = artifact.mimeType?.startsWith("image/");
              return html`
                <div
                  class="chat-workspace-rail__file ${isActive
                    ? "chat-workspace-rail__file--active"
                    : ""}"
                  role="listitem"
                >
                  <button
                    class="chat-workspace-rail__file-open"
                    type="button"
                    @click=${() => sessionWorkspace.onOpenArtifact(artifact.id)}
                  >
                    <span class="chat-workspace-rail__file-icon"
                      >${isImage ? icons.image : icons.paperclip}</span
                    >
                    <span class="chat-workspace-rail__file-main">
                      <openclaw-tooltip .content=${artifact.title}>
                        <span class="chat-workspace-rail__file-name">${artifact.title}</span>
                      </openclaw-tooltip>
                      ${size || artifact.mimeType
                        ? html`<span class="chat-workspace-rail__file-meta"
                            >${[artifact.mimeType, size].filter(Boolean).join(" / ")}</span
                          >`
                        : nothing}
                    </span>
                  </button>
                  <span class="chat-workspace-rail__row-actions">
                    <openclaw-tooltip .content=${t("chat.workspaceFiles.preview")}>
                      <button
                        class="chat-workspace-rail__row-action"
                        type="button"
                        aria-label=${t("chat.workspaceFiles.preview")}
                        @click=${(event: Event) => {
                          event.stopPropagation();
                          sessionWorkspace.onOpenArtifact(artifact.id);
                        }}
                      >
                        ${icons.eye}
                      </button>
                    </openclaw-tooltip>
                  </span>
                </div>
              `;
            })}
          </div>
        `;
  return html`
    <aside class="chat-workspace-rail" aria-label=${t("chat.workspaceFiles.label")}>
      <div class="chat-workspace-rail__header">
        <!-- Grip: drag the rail onto the pane's right/bottom band to re-dock
             it (chat-view renders the drop zones while dragging). -->
        <div
          class="chat-workspace-rail__title ${sessionWorkspace.narrowLayout
            ? ""
            : "chat-workspace-rail__grip"}"
          title=${sessionWorkspace.narrowLayout ? nothing : t("chat.workspaceFiles.dragToDock")}
          @pointerdown=${sessionWorkspace.narrowLayout ? nothing : sessionWorkspace.onDockDragStart}
        >
          <span class="chat-workspace-rail__eyebrow">${t("chat.workspaceFiles.workspace")}</span>
          <strong>${t("chat.workspaceFiles.files")}</strong>
        </div>
        <div class="chat-workspace-rail__actions">
          ${terminalButton} ${browserButton}
          ${sessionWorkspace.narrowLayout
            ? nothing
            : html`
                <openclaw-tooltip
                  .content=${dock === "bottom"
                    ? t("chat.workspaceFiles.dockRight")
                    : t("chat.workspaceFiles.dockBottom")}
                >
                  <button
                    class="btn btn--ghost btn--sm chat-workspace-rail__dock"
                    type="button"
                    aria-label=${dock === "bottom"
                      ? t("chat.workspaceFiles.dockRight")
                      : t("chat.workspaceFiles.dockBottom")}
                    @click=${() =>
                      sessionWorkspace.onSetDock(dock === "bottom" ? "right" : "bottom")}
                  >
                    ${dock === "bottom" ? icons.panelRightOpen : icons.panelBottomOpen}
                  </button>
                </openclaw-tooltip>
              `}
          <openclaw-tooltip .content=${t("chat.workspaceFiles.refresh")}>
            <button
              class="btn btn--ghost btn--sm chat-workspace-rail__refresh"
              type="button"
              aria-label=${t("chat.workspaceFiles.refresh")}
              ?disabled=${sessionWorkspace.loading}
              @click=${sessionWorkspace.onRefresh}
            >
              ${icons.refresh}
            </button>
          </openclaw-tooltip>
          <openclaw-tooltip .content=${`${t("chat.workspaceFiles.collapse")} (⇧⌘B)`}>
            <button
              type="button"
              class="nav-collapse-toggle chat-workspace-rail__collapse-toggle"
              aria-label=${t("chat.workspaceFiles.collapse")}
              aria-keyshortcuts="Meta+Shift+B"
              aria-expanded="true"
              @click=${sessionWorkspace.onToggleCollapsed}
            >
              <span class="nav-collapse-toggle__icon" aria-hidden="true"
                >${dock === "bottom" ? icons.panelBottomClose : icons.panelRightClose}</span
              >
            </button>
          </openclaw-tooltip>
        </div>
      </div>
      ${sessionWorkspace.list?.root
        ? html`
            <openclaw-tooltip .content=${sessionWorkspace.list.root}>
              <div class="chat-workspace-rail__path">${sessionWorkspace.list.root}</div>
            </openclaw-tooltip>
          `
        : nothing}
      ${renderSessionSummary()}
      ${sessionWorkspace.error
        ? html`<div class="chat-workspace-rail__state chat-workspace-rail__state--error">
            ${sessionWorkspace.error}
          </div>`
        : sessionWorkspace.loading && !hasItems
          ? html`<div class="chat-workspace-rail__state">${t("chat.workspaceFiles.loading")}</div>`
          : html`
              <div class="chat-workspace-rail__scroll">
                ${!hasSessionItems
                  ? html`<div class="chat-workspace-rail__state">
                      ${t("chat.workspaceFiles.empty")}
                    </div>`
                  : html`
                      ${renderWorkspaceRailSection(
                        t("chat.workspaceFiles.changed"),
                        renderFileRows(modifiedFiles),
                      )}
                      ${renderWorkspaceRailSection(
                        t("chat.workspaceFiles.read"),
                        renderFileRows(readFiles),
                      )}
                      ${renderWorkspaceRailSection(
                        t("chat.workspaceFiles.artifacts"),
                        renderArtifactRows(),
                      )}
                    `}
                ${renderWorkspaceRailSection(
                  t("chat.workspaceFiles.browser"),
                  browser ? renderBrowserRows() : nothing,
                )}
              </div>
            `}
    </aside>
  `;
}
