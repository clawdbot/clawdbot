import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  pauseSessionPlacementRecovery,
  readSessionPlacementRecovery,
} from "../../lib/sessions/session-placement-recovery.ts";
import {
  createGatewayHarness,
  createSessionState,
  createSessionsHarness,
  deferred,
  mountSidebar,
  type SidebarLifecycleState,
  successfulSessionPatch,
  type TestSessionMenu,
} from "../app-sidebar.ts";
import { gatewayHelloForMethods } from "../gateway-methods.ts";
import {
  answerConfirmDialog,
  installDialogPolyfill,
  waitForConfirmDialogActions,
} from "../modal-dialog.ts";
import { waitForFast } from "../wait-for.ts";

describe("AppSidebar session mutation feedback", () => {
  let restoreDialogPolyfill: () => void;

  beforeEach(() => {
    restoreDialogPolyfill = installDialogPolyfill();
  });

  afterEach(() => {
    restoreDialogPolyfill();
  });

  async function mountMutationHarness(client: GatewayBrowserClient = {} as GatewayBrowserClient) {
    const harness = createSessionsHarness("main", [
      "agent:main:main",
      "agent:main:a",
      "agent:main:b",
    ]);
    const originalRequest = client.request?.bind(client) as
      | GatewayBrowserClient["request"]
      | undefined;
    client.request = <T = unknown>(
      ...args: Parameters<GatewayBrowserClient["request"]>
    ): Promise<T> => {
      const [method, params] = args;
      if (method === "sessions.patchMany") {
        const request = params as {
          targets: Array<{ key: string; agentId?: string }>;
          patch: Record<string, unknown>;
        };
        return harness.patchMany(request.targets, request.patch).then((result) => result as T);
      }
      return originalRequest
        ? originalRequest<T>(...args)
        : Promise.reject(new Error(`unexpected request: ${method}`));
    };
    const gateway = createGatewayHarness(client);
    const { sidebar, context } = await mountSidebar(gateway.gateway, harness.sessions);
    sidebar.connected = true;
    await sidebar.updateComplete;
    return { gateway, harness, sidebar, context };
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
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, altKey: true }));
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
      expect(toast.querySelector(".app-toast__message")?.textContent).toBe("Session archived"),
    );
    expect(harness.patch).toHaveBeenCalledWith(
      archivedRow.key,
      { archived: true },
      { agentId: "main", expectedSessionId: `session:${archivedRow.key}` },
    );
    toast.querySelector<HTMLButtonElement>(".app-toast__action")?.click();

    await vi.waitFor(() => expect(harness.patch).toHaveBeenCalledTimes(3));
    expect(setSessionKey).not.toHaveBeenCalled();
    expect(harness.patch).toHaveBeenNthCalledWith(
      2,
      archivedRow.key,
      { archived: false },
      {
        agentId: "main",
        expectedSessionId: `session:${archivedRow.key}`,
        deferListRefresh: true,
      },
    );
    expect(harness.patch).toHaveBeenNthCalledWith(
      3,
      archivedRow.key,
      { pinned: true },
      {
        agentId: "main",
        expectedSessionId: `session:${archivedRow.key}`,
        deferListRefresh: true,
      },
    );
    expect(harness.patchMany).not.toHaveBeenCalled();
    expect(harness.refreshReplacement).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("assigns owners from the row menu and updates the owner chip", async () => {
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method !== "sessions.assignOwner") {
        throw new Error(`unexpected method: ${method}`);
      }
      const owner = (params as { owner: { type: "human"; id: string } }).owner;
      const label = owner.id === "profile-ada" ? "Ada" : "Bob";
      return {
        ok: true,
        key: "agent:main:a",
        owner: {
          actor: { ...owner, label },
          assignedBy: { type: "human", id: "profile-ada", label: "Ada" },
          assignedAt: 10,
        },
      };
    });
    const { gateway, harness, sidebar } = await mountMutationHarness({
      request,
    } as unknown as GatewayBrowserClient);
    gateway.publish({
      selfUser: { id: "profile-ada", name: "Ada" },
      hello: gatewayHelloForMethods(["sessions.assignOwner"], ["operator.write"]),
    });
    const result = harness.sessions.state.result;
    const row = result?.sessions.find((session) => session.key === "agent:main:a");
    if (!result || !row) {
      throw new Error("expected session owner fixture");
    }
    row.createdActor = { type: "human", id: "profile-ada", label: "Ada" };
    row.owner = { actor: row.createdActor };
    result.owners = [
      { type: "human", id: "profile-ada", label: "Ada" },
      { type: "human", id: "profile-bob", label: "Bob" },
    ];
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;

    const menu = await openSessionMenu(sidebar, row.key);
    expect(menu.textContent).toContain("Assign to me");
    expect(menu.textContent).toContain("Assign to…");
    menu.querySelector("wa-dropdown")?.dispatchEvent(
      new CustomEvent("wa-select", {
        bubbles: true,
        detail: { item: { value: "assign-owner:human:profile-bob" } },
      }),
    );

    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith("sessions.assignOwner", {
      key: row.key,
      agentId: "main",
      owner: { type: "human", id: "profile-bob" },
    });
    await waitForFast(() => {
      expect(
        sidebar
          .querySelector(`[data-session-key="${row.key}"] .session-owner-chip`)
          ?.getAttribute("title"),
      ).toBe("Owned by Bob");
    });

    const selfMenu = await openSessionMenu(sidebar, row.key);
    const selfItem = selfMenu.querySelector<HTMLElement>(
      ':scope > wa-dropdown > wa-dropdown-item[value="assign-owner:human:profile-ada"]',
    );
    selfMenu.querySelector("wa-dropdown")?.dispatchEvent(
      new CustomEvent("wa-select", {
        bubbles: true,
        detail: { item: { value: selfItem?.getAttribute("value") } },
      }),
    );

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request).toHaveBeenNthCalledWith(2, "sessions.assignOwner", {
      key: row.key,
      agentId: "main",
      owner: { type: "human", id: "profile-ada" },
    });
    await waitForFast(() => {
      expect(
        sidebar
          .querySelector(`[data-session-key="${row.key}"] .session-owner-chip`)
          ?.getAttribute("title"),
      ).toBe("Owned by Ada");
    });
  });

  it("reconciles and stops an idle active cloud worker through its session", async () => {
    const request = vi.fn(() => Promise.resolve({ ok: true }));
    const { gateway, harness, sidebar, context } = await mountMutationHarness({
      request,
    } as unknown as GatewayBrowserClient);
    gateway.publish({
      hello: gatewayHelloForMethods(["sessions.reclaim"]),
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

    const menu = await openSessionMenu(sidebar, row.key);
    menu.querySelector<HTMLElement>('[value="stop-cloud-worker"]')?.click();
    const actions = await waitForConfirmDialogActions();
    expect(document.body.querySelector("openclaw-modal-dialog")?.textContent).toContain(
      'Stop the cloud worker for "a"?',
    );
    answerConfirmDialog(actions, "confirm");

    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    expect(context.placementStartup.pause).toHaveBeenCalledExactlyOnceWith(
      "agent:main:a",
      "Worker stop requested. Review the initial message before retrying.",
      { readSessionPlacementRecovery, pauseSessionPlacementRecovery },
    );
    expect(context.placementStartup.pause).toHaveBeenCalledBefore(request);
    expect(request).toHaveBeenCalledWith(
      "sessions.reclaim",
      { key: "agent:main:a", agentId: "main" },
      { timeoutMs: null },
    );
    await waitForFast(() => expect(harness.refreshReplacement).toHaveBeenCalledWith("main"));
  });

  it("reclaims a pending cloud worker through its session", async () => {
    const request = vi.fn(() => Promise.resolve({ ok: true }));
    const { gateway, harness, sidebar, context } = await mountMutationHarness({
      request,
    } as unknown as GatewayBrowserClient);
    gateway.publish({
      hello: gatewayHelloForMethods(["sessions.reclaim"]),
    });
    const state = createSessionState("main", ["agent:main:main", "agent:main:a"]);
    const row = state.result?.sessions.find((candidate) => candidate.key === "agent:main:a");
    if (!row) {
      throw new Error("expected cloud session row");
    }
    row.placement = {
      state: "provisioning",
      generation: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
      stateChangedAtMs: 1,
      environmentId: "environment-1",
    };
    row.hasActiveRun = true;
    harness.publishList({ result: state.result, agentId: state.agentId });
    await sidebar.updateComplete;

    const menu = await openSessionMenu(sidebar, row.key);
    menu.querySelector<HTMLElement>('[value="stop-cloud-worker"]')?.click();
    answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");

    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    expect(context.placementStartup.pause).toHaveBeenCalledExactlyOnceWith(
      "agent:main:a",
      "Worker stop requested. Review the initial message before retrying.",
      { readSessionPlacementRecovery, pauseSessionPlacementRecovery },
    );
    expect(context.placementStartup.pause).toHaveBeenCalledBefore(request);
    expect(request).toHaveBeenCalledWith(
      "sessions.reclaim",
      { key: "agent:main:a", agentId: "main" },
      { timeoutMs: null },
    );
    await waitForFast(() => expect(harness.refreshReplacement).toHaveBeenCalledWith("main"));
  });

  it("shows and dismisses a fixed sidebar error when a session patch is rejected", async () => {
    const { harness, sidebar } = await mountMutationHarness();
    harness.patch.mockRejectedValueOnce(new Error("rename rejected by Gateway"));
    const menu = await openSessionMenu(sidebar, "agent:main:a");
    menu.querySelector<HTMLButtonElement>('[data-shortcut="r"]')?.click();
    await waitForFast(() => {
      expect(document.body.querySelector('input[name="value"]')).toBeInstanceOf(HTMLInputElement);
    });
    document.body.querySelector<HTMLInputElement>('input[name="value"]')!.value = "Rejected rename";
    document.body.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();

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
  });

  it("surfaces partial batch-delete errors", async () => {
    const { harness, sidebar } = await mountMutationHarness();
    harness.deleteMany.mockResolvedValueOnce({
      deleted: ["agent:main:a"],
      errors: ["agent:main:b: permission denied"],
      preservedWorktrees: [],
    });
    selectSession(sidebar, "agent:main:a");
    selectSession(sidebar, "agent:main:b");
    await sidebar.updateComplete;
    const row = sidebar.querySelector('[data-session-key="agent:main:b"]');
    row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await sidebar.updateComplete;
    const menu = sidebar.querySelector<TestSessionMenu>("openclaw-session-menu");
    await menu?.updateComplete;
    menu?.querySelector<HTMLButtonElement>('[data-shortcut="d"]')?.click();
    answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");

    await waitForFast(() => {
      expect(sidebar.querySelector("[data-sidebar-session-error]")?.textContent).toContain(
        "agent:main:b: permission denied",
      );
    });
  });

  it("surfaces ordered partial batch-archive errors", async () => {
    const { harness, sidebar } = await mountMutationHarness();
    harness.patchMany.mockImplementationOnce(async (targets) => {
      return {
        outcomes: [
          { ok: true, key: targets[0]!.key, agentId: targets[0]!.agentId },
          {
            ok: false,
            key: targets[1]!.key,
            agentId: targets[1]!.agentId,
            error: { code: "INVALID_REQUEST", message: "active run" },
          },
        ],
      };
    });
    selectSession(sidebar, "agent:main:a");
    selectSession(sidebar, "agent:main:b");
    await sidebar.updateComplete;
    const row = sidebar.querySelector('[data-session-key="agent:main:b"]');
    row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await sidebar.updateComplete;
    const menu = sidebar.querySelector<TestSessionMenu>("openclaw-session-menu");
    await menu?.updateComplete;
    menu?.querySelector<HTMLButtonElement>('[data-shortcut="a"]')?.click();

    await waitForFast(() => {
      expect(sidebar.querySelector("[data-sidebar-session-error]")?.textContent).toContain(
        "agent:main:b: active run",
      );
    });
    expect(harness.patchMany).toHaveBeenCalledOnce();
    expect(harness.patch).not.toHaveBeenCalled();
    expect(harness.refreshReplacement).toHaveBeenCalledOnce();
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

  it("suppresses a late batch archive result after a reconnect", async () => {
    const { gateway, harness, sidebar } = await mountMutationHarness();
    const pending = deferred<Awaited<ReturnType<typeof harness.patchMany>>>();
    harness.patchMany.mockImplementationOnce(() => pending.promise);
    selectSession(sidebar, "agent:main:a");
    selectSession(sidebar, "agent:main:b");
    await sidebar.updateComplete;
    const row = sidebar.querySelector('[data-session-key="agent:main:b"]');
    row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await sidebar.updateComplete;
    const menu = sidebar.querySelector<TestSessionMenu>("openclaw-session-menu");
    await menu?.updateComplete;
    menu?.querySelector<HTMLButtonElement>('[data-shortcut="a"]')?.click();
    await waitForFast(() => expect(harness.patchMany).toHaveBeenCalledOnce());

    gateway.publish({ phase: "reconnecting" });
    gateway.publish({ phase: "connected" });
    pending.resolve({
      outcomes: [
        { ok: true, key: "agent:main:a" },
        { ok: true, key: "agent:main:b" },
      ],
    });
    await pending.promise;
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });

    expect(harness.patchMany).toHaveBeenCalledOnce();
    expect(harness.patch).not.toHaveBeenCalled();
  });

  it("does not truncate a pending batch when another mutation starts", async () => {
    const { harness, sidebar } = await mountMutationHarness();
    const archive = deferred<Awaited<ReturnType<typeof harness.patchMany>>>();
    harness.patchMany.mockImplementationOnce(() => archive.promise);
    selectSession(sidebar, "agent:main:a");
    selectSession(sidebar, "agent:main:b");
    await sidebar.updateComplete;
    const row = sidebar.querySelector('[data-session-key="agent:main:b"]');

    row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await sidebar.updateComplete;
    let menu = sidebar.querySelector<TestSessionMenu>("openclaw-session-menu");
    await menu?.updateComplete;
    menu?.querySelector<HTMLButtonElement>('[data-shortcut="a"]')?.click();
    await waitForFast(() => expect(harness.patchMany).toHaveBeenCalledOnce());

    row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await sidebar.updateComplete;
    menu = sidebar.querySelector<TestSessionMenu>("openclaw-session-menu");
    await menu?.updateComplete;
    menu?.querySelector<HTMLButtonElement>('[data-shortcut="u"]')?.click();
    await waitForFast(() => expect(harness.patchMany).toHaveBeenCalledTimes(2));

    archive.resolve({
      outcomes: [
        { ok: true, key: "agent:main:a" },
        { ok: true, key: "agent:main:b" },
      ],
    });
    await archive.promise;
    expect(harness.patchMany).toHaveBeenCalledTimes(2);
    expect(harness.patchMany.mock.calls[1]?.[1]).toEqual({ unread: true });
    expect(harness.patch).not.toHaveBeenCalled();
  });

  it("never force-removes a preserved worktree through a reconnected client", async () => {
    const request = vi.fn(() => Promise.resolve({}));
    const { gateway, harness, sidebar } = await mountMutationHarness({
      request,
    } as unknown as GatewayBrowserClient);
    harness.deleteSession.mockResolvedValueOnce({
      deleted: true,
      worktreePreserved: {
        id: "wt-1",
        branch: "feature",
        path: "/tmp/worktree",
        reason: "busy",
      },
    });
    const menu = await openSessionMenu(sidebar, "agent:main:a");
    menu.querySelector<HTMLButtonElement>('[data-shortcut="d"]')?.click();
    answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");
    await waitForFast(() => expect(harness.deleteSession).toHaveBeenCalledOnce());

    // The worktree-removal confirm is open; a reconnect retires the captured
    // client, so accepting it must not force-remove through the new one.
    const worktreeActions = await waitForConfirmDialogActions();
    gateway.publish({ phase: "reconnecting" });
    gateway.publish({ phase: "connected" });
    answerConfirmDialog(worktreeActions, "confirm");

    await waitForFast(() =>
      expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull(),
    );
    expect(request).not.toHaveBeenCalled();
  });
});
