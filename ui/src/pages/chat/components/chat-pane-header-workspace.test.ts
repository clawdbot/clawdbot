/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import {
  canRevealSessionWorkspace,
  renderChatPaneHeader,
  resolveChatPaneWorkspace,
} from "./chat-pane-header.ts";

type ChatPaneHeaderProps = Parameters<typeof renderChatPaneHeader>[0];

const containers: HTMLElement[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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
    workspaceIcon: null,
    workspaceIconAvailability: false,
    parentSession: null,
    branch: "feature/header",
    branches: [],
    branchSwitchDisabledReason: null,
    platform: "darwin",
    canReveal: true,
    copiedAction: null,
    panelActions: nothing,
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
  render(html`${renderChatPaneHeader(props)}`, container);
  return { container, props };
}

async function mountChip(
  workspaceIcon: ChatPaneHeaderProps["workspaceIcon"],
  onWorkspaceIconAvailabilityChange?: (available: boolean | null) => void,
) {
  const { container } = mount({ workspaceIcon, onWorkspaceIconAvailabilityChange });
  const element = container.querySelector("openclaw-workspace-icon") as
    | (HTMLElement & { updateComplete?: Promise<unknown> })
    | null;
  await element?.updateComplete;
  return { container, element };
}

describe("chat pane workspace chip icon", () => {
  it("keeps the folder glyph when the gateway resolved no project icon", async () => {
    const { container, element } = await mountChip(null);
    expect(element).toBeNull();
    expect(container.querySelector(".chat-pane__workspace-chip svg")).not.toBeNull();
  });

  it("keeps the folder glyph while credentials are not ready", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { container, element } = await mountChip({
      routeUrl: "/__openclaw__/workspace-icon/agent%3Amain%3Aone",
      authTokens: [],
      authReady: false,
    });
    expect(element).not.toBeNull();
    expect(container.querySelector(".workspace-icon")).toBeNull();
    expect(container.querySelector(".chat-pane__workspace-chip svg")).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the folder glyph when the icon route fails", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("workspace icon unavailable"));
    const { container } = await mountChip({
      routeUrl: "/__openclaw__/workspace-icon/agent%3Amain%3Aone",
      authTokens: ["token"],
      authReady: true,
    });
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledWith(
      "/__openclaw__/workspace-icon/agent%3Amain%3Aone",
      expect.objectContaining({ headers: { Authorization: "Bearer token" } }),
    );
    expect(container.querySelector(".workspace-icon")).toBeNull();
    expect(container.querySelector(".chat-pane__workspace-chip svg")).not.toBeNull();
  });

  it("reports project icon availability", async () => {
    const png = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => png,
    } as unknown as Response);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:workspace-icon");
    const onAvailabilityChange = vi.fn();
    const { element } = await mountChip(
      {
        routeUrl: "/__openclaw__/workspace-icon/agent%3Amain%3Aone",
        authTokens: ["token"],
        authReady: true,
      },
      onAvailabilityChange,
    );
    await element?.updateComplete;
    await vi.waitFor(() => expect(onAvailabilityChange).toHaveBeenLastCalledWith(true));
  });

  it("reports a project icon as pending until the gateway confirms it is absent", async () => {
    let resolveRoute: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveRoute = resolve;
        }),
    );
    const onAvailabilityChange = vi.fn();
    const { element } = await mountChip(
      {
        routeUrl: "/__openclaw__/workspace-icon/agent%3Amain%3Amissing",
        authTokens: ["token"],
        authReady: true,
      },
      onAvailabilityChange,
    );

    expect(onAvailabilityChange).toHaveBeenLastCalledWith(null);
    resolveRoute?.({ ok: false, status: 404 } as Response);
    await element?.updateComplete;
    await vi.waitFor(() => expect(onAvailabilityChange).toHaveBeenLastCalledWith(false));
  });

  it("recovers the workspace icon after a transient route timeout", async () => {
    vi.useFakeTimers();
    const png = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: new Headers({ "retry-after": "1" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        blob: async () => png,
      } as unknown as Response);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:recovered-workspace-icon");
    const { container, element } = await mountChip({
      routeUrl: "/__openclaw__/workspace-icon/agent%3Amain%3Arecovering",
      authTokens: ["token"],
      authReady: true,
    });
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();
    await element?.updateComplete;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(container.querySelector<HTMLImageElement>(".workspace-icon")?.src).toBe(
      "blob:recovered-workspace-icon",
    );
  });

  it("does not refetch a missing project icon until its credentials change", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: false, status: 404 } as Response);
    const workspaceIcon = {
      routeUrl: "/__openclaw__/workspace-icon/agent%3Amain%3Aone",
      authTokens: ["token"],
      authReady: true,
    };
    const mounted = mount({ workspaceIcon });
    const element = mounted.container.querySelector("openclaw-workspace-icon") as
      | (HTMLElement & { updateComplete?: Promise<unknown> })
      | null;

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    await element?.updateComplete;
    render(
      html`${renderChatPaneHeader({ ...mounted.props, title: "Updated title", workspaceIcon })}`,
      mounted.container,
    );
    await element?.updateComplete;
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    render(
      html`${renderChatPaneHeader({
        ...mounted.props,
        workspaceIcon: { ...workspaceIcon, authTokens: ["new-token"] },
      })}`,
      mounted.container,
    );
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
  });

  it("retries the next credential when a stale token is rejected", async () => {
    const png = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: false, status: 401 } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        blob: async () => png,
      } as unknown as Response);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:workspace-icon");

    await mountChip({
      routeUrl: "/__openclaw__/workspace-icon/agent%3Amain%3Aone",
      authTokens: ["stale-token", "session-password"],
      authReady: true,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer session-password" },
    });
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

  it("matches the gateway root order", () => {
    expect(
      resolveChatPaneWorkspace({
        session: row({
          spawnedWorkspaceDir: "/src/openclaw",
          spawnedCwd: "/src/openclaw/packages/nested",
        }),
      }),
    ).toEqual({ root: "/src/openclaw", label: "openclaw" });
    expect(
      resolveChatPaneWorkspace({
        session: row({ execCwd: "/remote/stale", spawnedCwd: "/src/openclaw" }),
      }),
    ).toEqual({ root: "/src/openclaw", label: "openclaw" });
  });

  it("isolates exec-node paths from gateway-local facts", () => {
    expect(
      resolveChatPaneWorkspace({
        session: row({ execNode: "build-mac", execCwd: "/remote/build" }),
        agentWorkspace: "/local/default",
      }),
    ).toEqual({ root: "/remote/build", label: "build" });
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

  it("disables reveal outside an advertised local admin surface", () => {
    for (const params of [
      {
        session: row({ execNode: "build-mac", execCwd: "/remote/build" }),
        workspaceRoot: "/remote/build",
        methodAdvertised: true,
        hasAdminAccess: true,
      },
      {
        session: row({ placement: { state: "requested" } as GatewaySessionRow["placement"] }),
        workspaceRoot: "/cloud/work",
        methodAdvertised: true,
        hasAdminAccess: true,
      },
      {
        session: row(),
        workspaceRoot: "/src/openclaw",
        methodAdvertised: false,
        hasAdminAccess: true,
      },
      {
        session: row(),
        workspaceRoot: "/src/openclaw",
        methodAdvertised: true,
        hasAdminAccess: false,
      },
    ]) {
      expect(canRevealSessionWorkspace(params)).toBe(false);
    }
  });
});
