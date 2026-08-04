import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  createGatewayHarness,
  createSessionsHarness,
  createSessionState,
  deferred,
  mountSidebar,
  type SidebarLifecycleState,
  successfulSessionPatch,
  type TestSessionMenu,
} from "../app-sidebar.ts";
import { waitForFast } from "../wait-for.ts";

describe("AppSidebar session mutation feedback", () => {
  async function mountMutationHarness(client: GatewayBrowserClient = {} as GatewayBrowserClient) {
    const gateway = createGatewayHarness(client);
    const harness = createSessionsHarness("main", [
      "agent:main:main",
      "agent:main:a",
      "agent:main:b",
    ]);
    const { sidebar } = await mountSidebar(gateway.gateway, harness.sessions);
    sidebar.connected = true;
    await sidebar.updateComplete;
    return { gateway, harness, sidebar };
  }

  async function openSessionMenu(sidebar: SidebarLifecycleState, key: string) {
    const button = sidebar.querySelector<HTMLButtonElement>(
      `[data-session-key="${key}"] [data-session-menu="true"]`,
    );
    if (!button) {
      throw new Error(`expected menu button for ${key}`);
    }
    button.click();
    await sidebar.updateComplete;
    const menu = sidebar.querySelector<TestSessionMenu>("openclaw-session-menu");
    if (!menu) {
      throw new Error("expected session menu");
    }
    await menu.updateComplete;
    return menu;
  }

  function selectSession(sidebar: SidebarLifecycleState, key: string) {
    const link = sidebar.querySelector<HTMLAnchorElement>(
      `[data-session-key="${key}"] .sidebar-recent-session__link`,
    );
    if (!link) {
      throw new Error(`expected row link for ${key}`);
    }
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }));
  }

  async function mountToastHost() {
    const host = document.createElement("openclaw-toast-host");
    document.body.append(host);
    await host.updateComplete;
    return host;
  }

  it("offers undo after archiving and restores a pinned active session", async () => {
    const { gateway, harness, sidebar } = await mountMutationHarness();
    const setSessionKey = vi.fn();
    (gateway.gateway as { setSessionKey: (key: string) => void }).setSessionKey = setSessionKey;
    const archivedKey = "agent:main:dashboard:00000002-0000-4000-8000-000000000000";
    const state = createSessionState("main", ["agent:main:main", archivedKey, "agent:main:b"]);
    const archivedRow = state.result?.sessions.find((row) => row.key === archivedKey);
    if (!archivedRow) {
      throw new Error("expected archive row");
    }
    archivedRow.pinned = true;
    harness.publishList({ result: state.result, agentId: state.agentId });
    gateway.publish({ sessionKey: archivedRow.key });
    sidebar.sessionKey = archivedRow.key;
    (sidebar as unknown as { activeRouteId: string }).activeRouteId = "chat";
    const navigate = vi.fn();
    sidebar.onNavigate = navigate;
    const toast = await mountToastHost();
    await sidebar.updateComplete;

    const menu = await openSessionMenu(sidebar, archivedRow.key);
    menu.querySelector<HTMLButtonElement>('[data-shortcut="a"]')?.click();
    await vi.waitFor(() => expect(harness.patch).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(toast.querySelector(".app-toast__message")?.textContent).toBe("Thread archived"),
    );
    expect(harness.patch).toHaveBeenCalledWith(
      archivedRow.key,
      { archived: true },
      { agentId: "main" },
    );
    toast.querySelector<HTMLButtonElement>(".app-toast__action")?.click();

    await vi.waitFor(() => expect(harness.patch).toHaveBeenCalledTimes(2));
    expect(setSessionKey).not.toHaveBeenCalled();
    // Undo restores through the batch helper, which refreshes once at the end.
    expect(harness.patch).toHaveBeenLastCalledWith(
      archivedRow.key,
      { archived: false, pinned: true },
      { agentId: "main", deferListRefresh: true },
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it("patches a session icon from the picker", async () => {
    const { harness, sidebar } = await mountMutationHarness();
    const menu = await openSessionMenu(sidebar, "agent:main:a");
    menu.querySelector<HTMLElement>('wa-dropdown-item[value="change-icon"]')?.click();
    await menu.updateComplete;

    menu
      .querySelector<HTMLButtonElement>('.session-menu__icon-choice[aria-label="spark"]')
      ?.click();

    await waitForFast(() =>
      expect(harness.patch).toHaveBeenCalledWith(
        "agent:main:a",
        { icon: "name:spark" },
        { agentId: "main" },
      ),
    );
  });

  it("reconciles and stops an idle active cloud worker through its session", async () => {
    const request = vi.fn(() => Promise.resolve({ ok: true }));
    const { gateway, harness, sidebar } = await mountMutationHarness({
      request,
    } as unknown as GatewayBrowserClient);
    gateway.publish({
      hello: { features: { methods: ["sessions.reclaim"] } } as ApplicationGatewaySnapshot["hello"],
    });
    const state = createSessionState("main", ["agent:main:main", "agent:main:a"]);
    const row = state.result?.sessions.find((candidate) => candidate.key === "agent:main:a");
    if (!row) {
      throw new Error("expected cloud session row");
    }
    row.placement = {
      state: "active",
      generation: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
      stateChangedAtMs: 1,
      environmentId: "environment-1",
      activeOwnerEpoch: 1,
      workerBundleHash: "0".repeat(64),
      workspaceBaseManifestRef: "base-ref",
      remoteWorkspaceDir: "/workspace",
    };
    harness.publishList({ result: state.result, agentId: state.agentId });
    await sidebar.updateComplete;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    const menu = await openSessionMenu(sidebar, row.key);
    menu.querySelector<HTMLElement>('[value="stop-cloud-worker"]')?.click();

    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    expect(confirm).toHaveBeenCalledWith('Stop the cloud worker for "a"?');
    expect(request).toHaveBeenCalledWith(
      "sessions.reclaim",
      { key: "agent:main:a", agentId: "main" },
      { timeoutMs: 10 * 60_000 },
    );
    await waitForFast(() => expect(harness.refreshReplacement).toHaveBeenCalledWith("main"));
  });

  it("shows and dismisses a fixed sidebar error when a session patch is rejected", async () => {
    const { harness, sidebar } = await mountMutationHarness();
    harness.patch.mockRejectedValueOnce(new Error("rename rejected by Gateway"));
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("Rejected rename");
    try {
      const menu = await openSessionMenu(sidebar, "agent:main:a");
      menu.querySelector<HTMLButtonElement>('[data-shortcut="r"]')?.click();

      await waitForFast(() => {
        expect(sidebar.querySelector("[data-sidebar-session-error]")?.textContent).toContain(
          "rename rejected by Gateway",
        );
      });
      const error = sidebar.querySelector("[data-sidebar-session-error]");
      expect(error?.parentElement?.classList.contains("sidebar-sessions")).toBe(true);
      expect(error?.closest(".sidebar-recent-sessions")).toBeNull();

      error?.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]')?.click();
      await sidebar.updateComplete;
      expect(sidebar.querySelector("[data-sidebar-session-error]")).toBeNull();
    } finally {
      promptSpy.mockRestore();
    }
  });

  it("surfaces partial batch-delete errors", async () => {
    const { harness, sidebar } = await mountMutationHarness();
    harness.deleteMany.mockResolvedValueOnce({
      deleted: ["agent:main:a"],
      errors: ["agent:main:b: permission denied"],
      preservedWorktrees: [],
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      selectSession(sidebar, "agent:main:a");
      selectSession(sidebar, "agent:main:b");
      await sidebar.updateComplete;
      const row = sidebar.querySelector('[data-session-key="agent:main:b"]');
      row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      await sidebar.updateComplete;
      const menu = sidebar.querySelector<TestSessionMenu>("openclaw-session-menu");
      await menu?.updateComplete;
      menu?.querySelector<HTMLButtonElement>('[data-shortcut="d"]')?.click();

      await waitForFast(() => {
        expect(sidebar.querySelector("[data-sidebar-session-error]")?.textContent).toContain(
          "agent:main:b: permission denied",
        );
      });
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it("suppresses a late rejection after a same-client reconnect", async () => {
    const { gateway, harness, sidebar } = await mountMutationHarness();
    const pending = deferred<ReturnType<typeof successfulSessionPatch>>();
    harness.patch.mockImplementationOnce(() => pending.promise);
    const menu = await openSessionMenu(sidebar, "agent:main:a");
    menu.querySelector<HTMLButtonElement>('[data-shortcut="p"]')?.click();
    await waitForFast(() => expect(harness.patch).toHaveBeenCalledOnce());

    gateway.publish({ phase: "reconnecting" });
    gateway.publish({ phase: "connected" });
    pending.reject(new Error("late old-connection rejection"));
    await pending.promise.catch(() => undefined);
    await Promise.resolve();
    await sidebar.updateComplete;

    expect(sidebar.querySelector("[data-sidebar-session-error]")).toBeNull();
  });

  it("does not continue a batch patch on a reconnected Gateway", async () => {
    const { gateway, harness, sidebar } = await mountMutationHarness();
    const pending = deferred<ReturnType<typeof successfulSessionPatch>>();
    harness.patch.mockImplementationOnce(() => pending.promise);
    selectSession(sidebar, "agent:main:a");
    selectSession(sidebar, "agent:main:b");
    await sidebar.updateComplete;
    const row = sidebar.querySelector('[data-session-key="agent:main:b"]');
    row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await sidebar.updateComplete;
    const menu = sidebar.querySelector<TestSessionMenu>("openclaw-session-menu");
    await menu?.updateComplete;
    menu?.querySelector<HTMLButtonElement>('[data-shortcut="a"]')?.click();
    await waitForFast(() => expect(harness.patch).toHaveBeenCalledOnce());

    gateway.publish({ phase: "reconnecting" });
    gateway.publish({ phase: "connected" });
    pending.resolve(successfulSessionPatch("agent:main:a"));
    await pending.promise;
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });

    expect(harness.patch).toHaveBeenCalledOnce();
  });

  it("does not truncate a pending batch when another mutation starts", async () => {
    const { harness, sidebar } = await mountMutationHarness();
    const firstPatch = deferred<ReturnType<typeof successfulSessionPatch>>();
    harness.patch.mockImplementationOnce(() => firstPatch.promise);
    selectSession(sidebar, "agent:main:a");
    selectSession(sidebar, "agent:main:b");
    await sidebar.updateComplete;
    const row = sidebar.querySelector('[data-session-key="agent:main:b"]');

    row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await sidebar.updateComplete;
    let menu = sidebar.querySelector<TestSessionMenu>("openclaw-session-menu");
    await menu?.updateComplete;
    menu?.querySelector<HTMLButtonElement>('[data-shortcut="a"]')?.click();
    await waitForFast(() => expect(harness.patch).toHaveBeenCalledOnce());

    row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await sidebar.updateComplete;
    menu = sidebar.querySelector<TestSessionMenu>("openclaw-session-menu");
    await menu?.updateComplete;
    menu?.querySelector<HTMLButtonElement>('[data-shortcut="u"]')?.click();
    await waitForFast(() => expect(harness.patch).toHaveBeenCalledTimes(3));

    firstPatch.resolve(successfulSessionPatch("agent:main:a"));
    await waitForFast(() => expect(harness.patch).toHaveBeenCalledTimes(4));
    expect(harness.patch.mock.calls.map(([, patch]) => patch)).toEqual(
      expect.arrayContaining([
        { archived: true },
        { archived: true },
        { unread: true },
        { unread: true },
      ]),
    );
  });

  it("never force-removes a preserved worktree through a reconnected client", async () => {
    const request = vi.fn(() => Promise.resolve({}));
    const { gateway, harness, sidebar } = await mountMutationHarness({
      request,
    } as unknown as GatewayBrowserClient);
    harness.deleteSession.mockResolvedValueOnce({
      deleted: true,
      worktreePreserved: { id: "wt-1", branch: "feature", path: "/tmp/worktree" },
    });
    let confirmations = 0;
    const confirmSpy = vi.spyOn(window, "confirm").mockImplementation(() => {
      confirmations += 1;
      if (confirmations === 2) {
        gateway.publish({ phase: "reconnecting" });
        gateway.publish({ phase: "connected" });
      }
      return true;
    });
    try {
      const menu = await openSessionMenu(sidebar, "agent:main:a");
      menu.querySelector<HTMLButtonElement>('[data-shortcut="d"]')?.click();
      await waitForFast(() => expect(confirmations).toBe(2));

      expect(request).not.toHaveBeenCalled();
    } finally {
      confirmSpy.mockRestore();
    }
  });
});
