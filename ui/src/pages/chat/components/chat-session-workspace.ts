import type { SessionsDiffResult } from "../../../../../packages/gateway-protocol/src/index.js";
import { GatewayRequestError } from "../../../api/gateway.ts";
import type { ArtifactDownloadResult, SessionWorkspaceGetResult } from "../../../api/types.ts";
import { hasOperatorAdminAccess } from "../../../app/operator-access.ts";
import { patchSettings, type ChatWorkspaceDock } from "../../../app/settings.ts";
import { t } from "../../../i18n/index.ts";
import { copyToClipboard } from "../../../lib/clipboard.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { isGatewayMethodAdvertised } from "../../../lib/gateway-methods.ts";
import {
  clearWorkspaceTimer,
  getSessionWorkspace,
  isCurrentSessionWorkspace,
  loadSessionWorkspace,
  openSessionCheckoutSidebar,
  refreshSessionWorkspaceState,
  requestWorkspaceUpdate,
  trackSessionCheckoutSidebar,
} from "./chat-session-workspace-state.ts";
import type {
  SessionWorkspaceHost,
  SessionWorkspaceProps,
  SessionWorkspaceState,
} from "./chat-session-workspace-types.ts";
import { hasUniformLineEndings, type SidebarContent } from "./chat-sidebar.ts";

export {
  clearSessionWorkspaceTimers,
  retireSessionWorkspaceCheckout,
} from "./chat-session-workspace-state.ts";
export { renderSessionWorkspaceRail } from "./chat-session-workspace-rail.ts";
export type {
  SessionWorkspaceHost,
  SessionWorkspaceProps,
} from "./chat-session-workspace-types.ts";

function languageForFile(name: string): string {
  const extension = name.match(/\.([a-z0-9_-]+)$/i)?.[1]?.toLowerCase() ?? "";
  if (extension === "yml") {
    return "yaml";
  }
  return extension;
}

function basenameForPath(filePath: string): string {
  return filePath.split(/[\\/]/).findLast((part) => part) ?? filePath;
}

const SESSION_FILE_IMAGE_MIME_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function formatMarkdownCodeSpan(value: string): string {
  // Markdown finds block boundaries before inline spans, so filenames must
  // stay on one logical line even when the Gateway returns hostile metadata.
  const singleLineValue = value.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  const longestBacktickRun = Math.max(
    0,
    ...(singleLineValue.match(/`+/g)?.map((run) => run.length) ?? []),
  );
  const delimiter = "`".repeat(longestBacktickRun + 1);
  const hasBoundarySpaces = singleLineValue.startsWith(" ") && singleLineValue.endsWith(" ");
  const isOnlySpaces = /^ +$/.test(singleLineValue);
  const padding =
    singleLineValue.startsWith("`") ||
    singleLineValue.endsWith("`") ||
    (hasBoundarySpaces && !isOnlySpaces)
      ? " "
      : "";
  return `${delimiter}${padding}${singleLineValue}${padding}${delimiter}`;
}

function formatFileUpdatedAt(updatedAtMs: number | undefined): string | null {
  if (typeof updatedAtMs !== "number") {
    return null;
  }
  const updatedAt = new Date(updatedAtMs);
  return Number.isNaN(updatedAt.getTime()) ? null : updatedAt.toISOString();
}

function unsupportedFileSidebarContent(
  file: SessionWorkspaceGetResult["file"],
  fallbackPath: string,
): SidebarContent {
  const filePath = file.workspacePath || file.path || fallbackPath;
  const updatedAt = formatFileUpdatedAt(file.updatedAtMs);
  const lines = [
    "This file is not previewable inline.",
    "",
    `- Path: ${formatMarkdownCodeSpan(filePath)}`,
    file.mimeType ? `- Type: ${formatMarkdownCodeSpan(file.mimeType)}` : null,
    typeof file.size === "number" ? `- Size: ${file.size.toLocaleString()} bytes` : null,
    updatedAt ? `- Updated: ${updatedAt}` : null,
  ].filter((line): line is string => line !== null);
  const content = lines.join("\n");
  return {
    kind: "markdown",
    content,
    rawText: content,
  };
}

function workspaceBrowserFilePath(root: string | undefined, filePath: string): string {
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
  if (
    encoding === "base64" &&
    data &&
    (mimeType === "application/json" || mimeType.startsWith("text/"))
  ) {
    const bytes = Uint8Array.from(globalThis.atob(data), (char) => char.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    const language = mimeType === "application/json" ? "json" : "";
    return {
      kind: "markdown",
      content: `# ${title}\n\n\`\`\`${language}\n${decoded}\n\`\`\``,
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

export function refreshSessionWorkspace(state: SessionWorkspaceHost) {
  if (refreshSessionWorkspaceState(state)) {
    state.handleOpenSidebar(resolveSessionDiffSidebarContent(state));
  }
}

function beginWorkspaceOpenRequest(workspace: SessionWorkspaceState, itemId: string): object {
  workspace.activeId = itemId;
  return (workspace.openRequest = {});
}

function isCurrentWorkspaceOpenRequest(
  state: SessionWorkspaceHost,
  workspace: SessionWorkspaceState,
  request: object,
  itemId: string,
): boolean {
  return (
    workspace.openRequest === request &&
    isCurrentSessionWorkspace(state, workspace) &&
    workspace.activeId === itemId
  );
}

function openWorkspaceItem<T>(
  state: SessionWorkspaceHost,
  workspace: SessionWorkspaceState,
  itemId: string,
  load: () => Promise<T | null | undefined>,
  render: (result: T) => SidebarContent | null,
  missingMessage: string,
) {
  const request = beginWorkspaceOpenRequest(workspace, itemId);
  void (async () => {
    if (!state.client || !state.connected) {
      return;
    }
    state.handleOpenSidebar(null);
    workspace.error = null;
    try {
      const result = await load();
      const content = result == null ? null : render(result);
      if (!content) {
        if (isCurrentWorkspaceOpenRequest(state, workspace, request, itemId)) {
          workspace.error = missingMessage;
        }
        return;
      }
      if (isCurrentWorkspaceOpenRequest(state, workspace, request, itemId)) {
        openSessionCheckoutSidebar(state, content);
      }
    } catch (error) {
      if (isCurrentWorkspaceOpenRequest(state, workspace, request, itemId)) {
        workspace.error = formatUiError(error);
      }
    } finally {
      requestWorkspaceUpdate(state);
    }
  })();
}

function openFile(
  state: SessionWorkspaceHost,
  workspace: SessionWorkspaceState,
  path: string,
  opts: { line?: number | null; requestPath?: string } = {},
) {
  const requestPath = opts.requestPath ?? path;
  openWorkspaceItem(
    state,
    workspace,
    `file:${path}`,
    () =>
      state.sessions.getFile(workspace.sessionKey, requestPath, {
        agentId: workspace.agentId,
      }),
    (result) => {
      const file = result.file;
      if (!file) {
        return null;
      }
      const name = file.name || basenameForPath(path);
      if (file.previewKind === "image") {
        if (
          file.contentEncoding !== "base64" ||
          typeof file.content !== "string" ||
          !file.mimeType ||
          !SESSION_FILE_IMAGE_MIME_TYPES.has(file.mimeType)
        ) {
          return null;
        }
        return {
          kind: "image",
          title: name,
          src: `data:${file.mimeType};base64,${file.content}`,
          mimeType: file.mimeType,
          rawText: file.workspacePath || file.path || path,
        };
      }
      if (file.previewKind === "unsupported") {
        return unsupportedFileSidebarContent(file, path);
      }
      // Missing previewKind is the pre-image-preview Gateway contract.
      if (
        (file.previewKind !== undefined && file.previewKind !== "text") ||
        (file.previewKind === "text" &&
          file.contentEncoding !== undefined &&
          file.contentEncoding !== "utf8") ||
        typeof file.content !== "string"
      ) {
        return null;
      }
      const canEdit =
        typeof file.hash === "string" &&
        hasUniformLineEndings(file.content) &&
        isGatewayMethodAdvertised(state, "sessions.files.set") === true &&
        hasOperatorAdminAccess(state.hello?.auth ?? null);
      const edit = canEdit
        ? {
            hash: file.hash!,
            save: async ({ content, expectedHash }: { content: string; expectedHash: string }) => {
              try {
                const saved = await state.sessions.setFile(
                  result.sessionKey,
                  requestPath,
                  content,
                  {
                    agentId: workspace.agentId,
                    expectedHash,
                  },
                );
                const hash = saved?.file.hash;
                const updatedAtMs = saved?.file.updatedAtMs;
                return typeof hash === "string"
                  ? {
                      ok: true as const,
                      hash,
                      ...(typeof updatedAtMs === "number" ? { updatedAtMs } : {}),
                    }
                  : { ok: false as const, code: "error" as const, message: "Save failed." };
              } catch (error) {
                const details =
                  error instanceof GatewayRequestError &&
                  error.details &&
                  typeof error.details === "object"
                    ? (error.details as { type?: unknown; currentHash?: unknown })
                    : null;
                if (details?.type === "session_file_conflict") {
                  return {
                    ok: false as const,
                    code: "conflict" as const,
                    ...(typeof details.currentHash === "string"
                      ? { currentHash: details.currentHash }
                      : {}),
                  };
                }
                return {
                  ok: false as const,
                  code: "error" as const,
                  message: formatUiError(error),
                };
              }
            },
            fetchLatest: async () => {
              const latest = await state.sessions.getFile(result.sessionKey, requestPath, {
                agentId: workspace.agentId,
              });
              const latestFile = latest?.file;
              if (
                !latestFile ||
                typeof latestFile.content !== "string" ||
                typeof latestFile.hash !== "string"
              ) {
                return null;
              }
              return {
                content: latestFile.content,
                hash: latestFile.hash,
                // Reloaded content re-passes the uniform-endings gate so a
                // conflict reload cannot smuggle mixed endings into edit mode.
                editable: hasUniformLineEndings(latestFile.content),
              };
            },
          }
        : undefined;
      return {
        kind: "file",
        path: file.workspacePath || file.path || path,
        name,
        content: file.content,
        draftKey: [
          state.settings?.gatewayUrl ?? "",
          state.sessionWorkspaceDraftScope ?? "",
          result.sessionKey,
          result.root ?? "",
          file.workspacePath || file.path || path,
        ].join("\u0000"),
        root: result.root ?? null,
        language: languageForFile(name),
        line: opts.line ?? null,
        rawText: file.content,
        ...(edit ? { edit } : {}),
      };
    },
    `Failed to load ${path}`,
  );
}

export function openSessionWorkspaceFile(
  state: SessionWorkspaceHost,
  target: { path: string; line?: number | null },
) {
  openFile(state, getSessionWorkspace(state), target.path, { line: target.line });
}

function toggleSessionWorkspace(state: SessionWorkspaceHost) {
  const workspace = getSessionWorkspace(state);
  workspace.collapsed = !workspace.collapsed;
  if (!workspace.collapsed && workspace.list?.sessionKey !== state.sessionKey) {
    loadSessionWorkspace(state, workspace);
  }
  requestWorkspaceUpdate(state);
}

function setSessionWorkspaceDock(state: SessionWorkspaceHost, dock: ChatWorkspaceDock) {
  const workspace = getSessionWorkspace(state);
  if (workspace.dock !== dock) {
    workspace.dock = dock;
    if (state.settings) {
      state.settings = { ...state.settings, chatWorkspaceDock: dock };
    }
    patchSettings({ chatWorkspaceDock: dock });
  }
  requestWorkspaceUpdate(state);
}

export function revealSessionWorkspaceFile(state: SessionWorkspaceHost, path: string) {
  const workspace = getSessionWorkspace(state);
  clearWorkspaceTimer(workspace);
  const normalizedPath = path.replaceAll("\\", "/");
  const separator = normalizedPath.lastIndexOf("/");
  workspace.collapsed = false;
  workspace.browserPath = separator > 0 ? normalizedPath.slice(0, separator) : "";
  workspace.browserSearch = "";
  workspace.activeId = `file:${path}`;
  loadSessionWorkspace(state, workspace, true);
  requestWorkspaceUpdate(state);
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
    () =>
      state.client!.request<ArtifactDownloadResult | null>("artifacts.download", {
        sessionKey: workspace.sessionKey,
        artifactId,
        ...(workspace.agentId ? { agentId: workspace.agentId } : {}),
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
  options?: {
    narrowLayout?: boolean;
    draftScope?: string;
    expanded?: boolean;
    presented?: boolean;
  },
): SessionWorkspaceProps {
  state.sessionWorkspaceDraftScope = options?.draftScope;
  const workspace = getSessionWorkspace(state);
  if (
    // The collapsed header still renders the diff action, so load its checkout
    // capability eagerly instead of waiting for the file rail to open.
    options?.presented !== false &&
    (options?.expanded === true ||
      !workspace.collapsed ||
      isGatewayMethodAdvertised(state, "sessions.diff") === true) &&
    state.connected &&
    state.agentsList &&
    !workspace.loading &&
    !workspace.error &&
    workspace.list?.sessionKey !== state.sessionKey
  ) {
    loadSessionWorkspace(state, workspace);
  }
  const diffContent = resolveSessionDiffSidebarContent(state);
  return {
    collapsed: options?.expanded === true ? false : workspace.collapsed,
    sessionKey: state.sessionKey,
    list: workspace.list?.sessionKey === state.sessionKey ? workspace.list : null,
    loading: workspace.loading,
    error: workspace.error,
    activeId: workspace.activeId,
    dock: workspace.dock,
    narrowLayout: options?.narrowLayout === true,
    onToggleCollapsed: () => toggleSessionWorkspace(state),
    onSetDock: (dock) => setSessionWorkspaceDock(state, dock),
    onRefresh: () => loadSessionWorkspace(state, workspace, true),
    onBrowsePath: (path) => {
      clearWorkspaceTimer(workspace);
      workspace.browserPath = path;
      workspace.browserSearch = "";
      loadSessionWorkspace(state, workspace, true);
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
      clearWorkspaceTimer(workspace);
      workspace.browserSearchTimer = globalThis.setTimeout(() => {
        workspace.browserSearchTimer = null;
        loadSessionWorkspace(state, workspace, true);
      }, 160);
    },
    onOpenArtifact: (artifactId) => openArtifact(state, workspace, artifactId),
    onOpenDiff: diffContent ? () => openSessionCheckoutSidebar(state, diffContent) : undefined,
  };
}

export function resolveSessionDiffSidebarContent(
  state: SessionWorkspaceHost,
): SidebarContent | null {
  const workspace = getSessionWorkspace(state);
  const canOpenDiff =
    isGatewayMethodAdvertised(state, "sessions.diff") === true &&
    Boolean(state.client) &&
    workspace.list?.sessionKey === state.sessionKey &&
    workspace.list.gitCheckout !== false;
  if (!canOpenDiff) {
    return null;
  }
  if (workspace.diffContent) {
    return workspace.diffContent;
  }
  const content = buildSessionDiffSidebarContent(state, workspace);
  trackSessionCheckoutSidebar(content);
  workspace.diffContent = content;
  return content;
}

/** Sidebar payload whose loader refetches sessions.diff for the pane's session. */
function buildSessionDiffSidebarContent(
  state: SessionWorkspaceHost,
  workspace: SessionWorkspaceState,
): SidebarContent {
  const sessionKey = state.sessionKey;
  const client = state.client;
  const agentId = workspace.agentId;
  const canLoadFileText =
    isGatewayMethodAdvertised(state, "sessions.files.get") === true && Boolean(state.client);
  return {
    kind: "session-diff",
    load: async (scope) => {
      if (!client) {
        throw new Error(t("chat.sessionDiff.disconnected"));
      }
      return await client.request<SessionsDiffResult>("sessions.diff", {
        sessionKey,
        ...(agentId ? { agentId } : {}),
        ...scope,
      });
    },
    loadFileText: canLoadFileText
      ? async (path) => {
          try {
            const result = await state.sessions.getFile(sessionKey, path, {
              agentId,
            });
            const file = result?.file;
            if (
              !file ||
              (file.previewKind !== undefined && file.previewKind !== "text") ||
              (file.contentEncoding !== undefined && file.contentEncoding !== "utf8") ||
              typeof file.content !== "string"
            ) {
              return null;
            }
            return file.content;
          } catch {
            return null;
          }
        }
      : undefined,
    openFile: (path) => openFile(state, getSessionWorkspace(state), path),
    revealFile: (path) => revealSessionWorkspaceFile(state, path),
  };
}
