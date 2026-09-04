import { html, nothing, render } from "lit";
import { vi } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { renderChatPaneHeader } from "./chat-pane-header.ts";

export type ChatPaneHeaderProps = Parameters<typeof renderChatPaneHeader>[0];

export function chatPaneHeaderSessionRow(
  patch: Partial<GatewaySessionRow> = {},
): GatewaySessionRow {
  return { key: "agent:main:test", kind: "direct", updatedAt: 0, ...patch };
}

/**
 * Mounts the header with every required prop filled in. Callers own teardown so each suite
 * keeps its own afterEach; `containers` collects the mounted nodes for removal.
 */
export function mountChatPaneHeader(
  containers: HTMLElement[],
  patch: Partial<ChatPaneHeaderProps> = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const props: ChatPaneHeaderProps = {
    paneId: "pane-1",
    narrow: false,
    mergedChrome: false,
    title: "Session title",
    session: chatPaneHeaderSessionRow(),
    catalog: false,
    editing: false,
    renameValue: "Session title",
    workspaceRoot: "/repo/openclaw",
    workspaceLabel: "openclaw",
    workspaceIcon: null,
    parentSession: null,
    branch: "feature/header",
    branches: [],
    branchSwitchDisabledReason: null,
    platform: "darwin",
    canReveal: true,
    copiedAction: null,
    renameDisabledReason: undefined,
    panelActions: nothing,
    panelLayoutActions: nothing,
    discussionAction: nothing,
    diffAction: nothing,
    backgroundTasksAction: nothing,
    workspaceAction: nothing,
    sessionRailAction: nothing,
    sessionMenuAction: nothing,
    onBeginRename: vi.fn(),
    onRenameInput: vi.fn(),
    onCommitRename: vi.fn(),
    onCancelRename: vi.fn(),
    onMenuOpenChange: vi.fn(),
    onMenuAction: vi.fn(),
    onOpenParentSession: vi.fn(),
    onBranchSelect: vi.fn(),
    ...patch,
  };
  props.gatewaysSnapshot ??= props.nativeGateways?.snapshot;
  render(html`${renderChatPaneHeader(props)}`, container);
  return { container, props };
}

export function mockWorkspaceIconFetch() {
  const workspaceFetch = vi.fn<typeof fetch>();
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    // Other header elements fetch assets asynchronously. They must not consume
    // workspace retry responses or count as authenticated icon requests.
    if (typeof input === "string" && input.startsWith("/__openclaw__/workspace-icon/")) {
      return workspaceFetch(input, init);
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  });
  return workspaceFetch;
}
