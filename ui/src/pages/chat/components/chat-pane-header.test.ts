/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import {
  COMMAND_PALETTE_OPEN_EVENT,
  SHELL_NAV_DRAWER_TOGGLE_EVENT,
  type ShellNavDrawerToggleDetail,
} from "../../../components/command-palette-contract.ts";
import {
  canRevealSessionWorkspace,
  renderChatPaneHeader,
  resolveChatPaneWorkspace,
} from "./chat-pane-header.ts";

type ChatPaneHeaderProps = Parameters<typeof renderChatPaneHeader>[0];

const containers: HTMLElement[] = [];

afterEach(() => {
  containers.splice(0).forEach((container) => container.remove());
});

function row(patch: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return { key: "agent:main:test", kind: "direct", updatedAt: 0, ...patch };
}

function mount(patch: Partial<ChatPaneHeaderProps> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const props: ChatPaneHeaderProps = {
    paneId: "pane-1",
    narrow: false,
    mergedChrome: false,
    title: "Session title",
    session: row(),
    catalog: false,
    editing: false,
    renameValue: "Session title",
    workspaceRoot: "/repo/openclaw",
    workspaceLabel: "openclaw",
    branch: "feature/header",
    platform: "darwin",
    canReveal: true,
    copiedAction: null,
    canRename: true,
    terminalAction: nothing,
    diffAction: nothing,
    backgroundTasksAction: nothing,
    workspaceAction: nothing,
    onBeginRename: vi.fn(),
    onRenameInput: vi.fn(),
    onCommitRename: vi.fn(),
    onCancelRename: vi.fn(),
    onMenuOpenChange: vi.fn(),
    onMenuAction: vi.fn(),
    ...patch,
  };
  render(html`${renderChatPaneHeader(props)}`, container);
  return { container, props };
}

describe("chat pane header", () => {
  it("renders and dispatches merged chrome actions for catalog sessions", () => {
    const drawerEvents: CustomEvent<ShellNavDrawerToggleDetail>[] = [];
    const paletteEvents: Event[] = [];
    const onDrawer = (event: Event) =>
      drawerEvents.push(event as CustomEvent<ShellNavDrawerToggleDetail>);
    const onPalette = (event: Event) => paletteEvents.push(event);
    window.addEventListener(SHELL_NAV_DRAWER_TOGGLE_EVENT, onDrawer);
    window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, onPalette);
    const { container } = mount({ mergedChrome: true, catalog: true, session: undefined });
    const drawer = container.querySelector<HTMLButtonElement>('[aria-label="Expand sidebar"]');
    const palette = container.querySelector<HTMLButtonElement>(
      '[aria-label="Open command palette"]',
    );

    drawer?.click();
    palette?.click();

    expect(drawer).not.toBeNull();
    expect(palette).not.toBeNull();
    expect(drawerEvents).toHaveLength(1);
    expect(drawerEvents[0]?.detail.trigger).toBe(drawer);
    expect(paletteEvents).toHaveLength(1);
    window.removeEventListener(SHELL_NAV_DRAWER_TOGGLE_EVENT, onDrawer);
    window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, onPalette);
  });

  it("omits shell chrome actions when the header is not merged", () => {
    const { container } = mount();
    expect(container.querySelector(".chat-pane__nav-toggle")).toBeNull();
    expect(container.querySelector(".chat-pane__palette-open")).toBeNull();
  });

  it("renders an editable title and workspace chip", () => {
    const { container, props } = mount();
    const title = container.querySelector<HTMLButtonElement>(".chat-pane__session-title-button");
    const chip = container.querySelector<HTMLButtonElement>(".chat-pane__workspace-chip");
    expect(title?.textContent?.trim()).toBe("Session title");
    expect(chip?.textContent?.trim()).toContain("openclaw");
    title?.click();
    expect(props.onBeginRename).toHaveBeenCalledOnce();
  });

  it("routes Enter and Escape from the rename input", () => {
    const enter = mount({ editing: true, renameValue: "  Updated  " });
    const enterInput = enter.container.querySelector<HTMLInputElement>("input");
    enterInput?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    expect(enter.props.onCommitRename).toHaveBeenCalledOnce();

    const escape = mount({ editing: true });
    escape.container
      .querySelector("input")
      ?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    expect(escape.props.onCancelRename).toHaveBeenCalledOnce();
    expect(escape.props.onCommitRename).not.toHaveBeenCalled();
  });

  it("keeps catalog sessions static and without a workspace chip", () => {
    const { container } = mount({
      catalog: true,
      session: undefined,
      terminalAction: html`<span data-action="terminal"></span>`,
      diffAction: html`<span data-action="diff"></span>`,
      backgroundTasksAction: html`<span data-action="tasks"></span>`,
      workspaceAction: html`<span data-action="workspace"></span>`,
    });
    expect(container.querySelector(".chat-pane__session-title-button")).toBeNull();
    expect(container.querySelector(".chat-pane__session-title")?.textContent).toContain(
      "Session title",
    );
    expect(container.querySelector(".chat-pane__workspace-chip")).toBeNull();
    expect(container.querySelector('[data-action="terminal"]')).not.toBeNull();
    expect(container.querySelector('[data-action="diff"]')).toBeNull();
    expect(container.querySelector('[data-action="tasks"]')).toBeNull();
    expect(container.querySelector('[data-action="workspace"]')).toBeNull();
  });

  it("keeps read-only gateway session titles static", () => {
    const { container } = mount({ canRename: false });
    expect(container.querySelector(".chat-pane__session-title-button")).toBeNull();
    expect(container.querySelector(".chat-pane__session-title")?.textContent).toContain(
      "Session title",
    );
  });

  it("shows copied feedback on the workspace chip", () => {
    const { container } = mount({ copiedAction: "copy-path" });
    expect(container.querySelector(".chat-pane__workspace-chip")?.textContent).toContain("Copied");
  });

  it("shows cloud placement and hides reveal when disabled", () => {
    const { container } = mount({
      session: row({
        placement: { state: "active" } as GatewaySessionRow["placement"],
      }),
      canReveal: false,
    });
    expect(container.querySelector(".chat-pane__cloud")).not.toBeNull();
    expect(container.querySelector('wa-dropdown-item[value="reveal"]')).toBeNull();
    expect(container.querySelector('wa-dropdown-item[value="copy-path"]')).not.toBeNull();
  });
});

describe("chat pane workspace resolution", () => {
  it("uses worktree repo vocabulary with spawned cwd", () => {
    expect(
      resolveChatPaneWorkspace({
        session: row({
          spawnedCwd: "/tmp/worktrees/title-bar",
          worktree: { id: "wt-1", branch: "title-bar", repoRoot: "/src/openclaw" },
        }),
      }),
    ).toEqual({ root: "/tmp/worktrees/title-bar", label: "openclaw" });
  });

  it("does not substitute the agent workspace for a missing worktree checkout", () => {
    expect(
      resolveChatPaneWorkspace({
        session: row({
          worktree: { id: "wt-missing", branch: "feature", repoRoot: "/src/openclaw" },
        }),
        agentWorkspace: "/src/default-agent-workspace",
        worktreePath: null,
      }),
    ).toEqual({ root: null, label: "openclaw" });
  });

  it("matches the gateway root order: spawned workspace before spawned cwd", () => {
    expect(
      resolveChatPaneWorkspace({
        session: row({
          spawnedWorkspaceDir: "/src/openclaw",
          spawnedCwd: "/src/openclaw/packages/nested",
        }),
      }),
    ).toEqual({ root: "/src/openclaw", label: "openclaw" });
    // execCwd is exec-node routing state; it never overrides local facts.
    expect(
      resolveChatPaneWorkspace({
        session: row({ execCwd: "/remote/stale", spawnedCwd: "/src/openclaw" }),
      }),
    ).toEqual({ root: "/src/openclaw", label: "openclaw" });
  });

  it("prefers exec cwd and falls back to the agent workspace", () => {
    expect(
      resolveChatPaneWorkspace({
        session: row({ execNode: "build-mac", execCwd: "/remote/build" }),
        agentWorkspace: "/local/default",
      }),
    ).toEqual({ root: "/remote/build", label: "build" });
    // Without execCwd, gateway-local facts must not stand in for a path that
    // lives on another machine.
    expect(
      resolveChatPaneWorkspace({
        session: row({ execNode: "build-mac", spawnedCwd: "/local/spawned" }),
        agentWorkspace: "/local/default",
        worktreePath: "/local/worktree",
      }),
    ).toEqual({ root: null, label: null });
    expect(resolveChatPaneWorkspace({ session: row(), agentWorkspace: "/src/openclaw" })).toEqual({
      root: "/src/openclaw",
      label: "openclaw",
    });
  });

  it("disables reveal for exec nodes, remote placement, and missing advertisement", () => {
    expect(
      canRevealSessionWorkspace({
        session: row({ execNode: "build-mac", execCwd: "/remote/build" }),
        workspaceRoot: "/remote/build",
        methodAdvertised: true,
        hasAdminAccess: true,
      }),
    ).toBe(false);
    expect(
      canRevealSessionWorkspace({
        session: row({ placement: { state: "requested" } as GatewaySessionRow["placement"] }),
        workspaceRoot: "/cloud/work",
        methodAdvertised: true,
        hasAdminAccess: true,
      }),
    ).toBe(false);
    expect(
      canRevealSessionWorkspace({
        session: row(),
        workspaceRoot: "/src/openclaw",
        methodAdvertised: false,
        hasAdminAccess: true,
      }),
    ).toBe(false);
    expect(
      canRevealSessionWorkspace({
        session: row(),
        workspaceRoot: "/src/openclaw",
        methodAdvertised: true,
        hasAdminAccess: false,
      }),
    ).toBe(false);
  });
});
