import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  createContext,
  createGateway,
  createGatewayHarness,
  createSessions,
  createSessionsHarness,
  createSessionState,
  deferred,
  type LobsterPetElement,
  mountSidebar,
  type SidebarLifecycleState,
  successfulSessionPatch,
  type TestSessionMenu,
  TWO_AGENTS,
} from "../app-sidebar.ts";
import { waitForFast } from "../wait-for.ts";
import "./session-pagination.ts";
import "./session-navigation.ts";

describe("AppSidebar session pagination", () => {
  it("does not show pagination controls at the ten-session boundary", async () => {
    const keys = [
      "agent:main:session-0",
      ...Array.from({ length: 9 }, (_, index) => `agent:main:session-${index + 1}`),
    ];
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", keys));

    expect(sidebar.querySelectorAll(".sidebar-recent-session")).toHaveLength(10);
    expect(sidebar.querySelector(".sidebar-session-pagination")).toBeNull();
  });

  it("reveals sessions ten at a time and offers Collapse after thirty", async () => {
    const keys = [
      "agent:main:session-0",
      ...Array.from({ length: 40 }, (_, index) => `agent:main:session-${index + 1}`),
    ];
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", keys));
    const rows = () => sidebar.querySelectorAll(".sidebar-recent-session");
    const button = (label: string) =>
      sidebar.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

    expect(rows()).toHaveLength(10);
    expect(button("Show more")).not.toBeNull();
    expect(button("Collapse")).toBeNull();

    button("Show more")?.click();
    await sidebar.updateComplete;
    expect(rows()).toHaveLength(20);
    expect(button("Collapse")).toBeNull();

    button("Show more")?.click();
    await sidebar.updateComplete;
    expect(rows()).toHaveLength(30);
    expect(button("Collapse")).toBeNull();

    button("Show more")?.click();
    await sidebar.updateComplete;
    expect(rows()).toHaveLength(40);
    expect(button("Show more")).not.toBeNull();
    expect(button("Collapse")).not.toBeNull();

    button("Show more")?.click();
    await sidebar.updateComplete;
    expect(rows()).toHaveLength(41);
    expect(button("Show more")).toBeNull();
    expect(button("Collapse")).not.toBeNull();

    button("Collapse")?.click();
    await sidebar.updateComplete;
    expect(rows()).toHaveLength(10);
    expect(button("Show more")).not.toBeNull();
    expect(button("Collapse")).toBeNull();
  });
});

describe("AppSidebar lobster outcome wiring", () => {
  it.each([
    ["panel", "failed", "error"],
    ["panel", "killed", "aborted"],
    ["drawer", "failed", "error"],
    ["drawer", "killed", "aborted"],
  ] as const)(
    "passes the %s variant's latest %s session outcome",
    async (variant, status, expectedOutcome) => {
      const client = {} as GatewayBrowserClient;
      const gateway = createGateway(client);
      const sessions = createSessionsHarness("main", ["agent:main:main"]);
      const { sidebar } = await mountSidebar(gateway, sessions.sessions, variant);
      const terminalState = createSessionState("main", ["agent:main:main"]);
      const result = terminalState.result;
      if (!result) {
        throw new Error("expected terminal session result");
      }
      const row = result.sessions[0];
      if (!row) {
        throw new Error("expected terminal session row");
      }

      sessions.publishList({
        result: {
          ...result,
          sessions: [
            {
              ...row,
              status,
              endedAt: 100,
            },
          ],
        },
        agentId: terminalState.agentId,
      });
      await sidebar.updateComplete;

      const pet = sidebar.querySelector<LobsterPetElement>("openclaw-lobster-pet");
      expect(pet?.runOutcome).toBe(expectedOutcome);
    },
  );
});

describe("AppSidebar session source lifecycle", () => {
  it("disables Fork session for model-selection-locked rows", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const sessions = createSessionsHarness("main", ["agent:main:locked"]);
    const lockedState = createSessionState("main", ["agent:main:locked"]);
    const lockedRow = lockedState.result?.sessions[0];
    if (!lockedRow) {
      throw new Error("Expected locked session row");
    }
    lockedRow.modelSelectionLocked = true;
    sessions.publishList({ result: lockedState.result, agentId: lockedState.agentId });
    const { sidebar } = await mountSidebar(gateway, sessions.sessions);
    sidebar.connected = true;
    await sidebar.updateComplete;

    const menuButton = sidebar.querySelector<HTMLButtonElement>(
      '[data-session-key="agent:main:locked"] [data-session-menu="true"]',
    );
    if (!menuButton) {
      throw new Error("Expected sidebar session menu button");
    }
    menuButton.click();
    await sidebar.updateComplete;

    const menu = sidebar.querySelector<TestSessionMenu>("openclaw-session-menu");
    if (!menu) {
      throw new Error("Expected sidebar session menu");
    }
    await menu.updateComplete;
    expect(menu.forkDisabled).toBe(true);
    expect(menu.querySelector<HTMLButtonElement>('[data-shortcut="f"]')?.disabled).toBe(true);
  });

  it("resets cached rows and creation order when the sessions source changes", async () => {
    const client = {} as GatewayBrowserClient;
    const gateway = createGateway(client);
    const { provider, sidebar } = await mountSidebar(
      gateway,
      createSessions("first", ["first-a", "first-b"]),
    );

    expect(Object.keys(sidebar.sessionData.sessionRowsByAgent)).toEqual(["first"]);
    expect([...sidebar.sessionData.sessionCreatedOrder]).toEqual([
      ["first-a", 0],
      ["first-b", 1],
    ]);

    // The Gateway and its client stay unchanged while the sessions capability is replaced.
    provider.setContext(createContext(gateway, createSessions("second", ["second-b", "second-a"])));
    await sidebar.updateComplete;

    expect(Object.keys(sidebar.sessionData.sessionRowsByAgent)).toEqual(["second"]);
    expect([...sidebar.sessionData.sessionCreatedOrder]).toEqual([
      ["second-b", 0],
      ["second-a", 1],
    ]);
    expect(sidebar.sessionData.sessionsAgentId).toBe("second");
    expect(sidebar.sessionData.sessionsResult?.sessions.map((row) => row.key)).toEqual([
      "second-b",
      "second-a",
    ]);
  });

  it("preserves the scoped result through a disconnect on the same Gateway client", async () => {
    const client = {} as GatewayBrowserClient;
    const gateway = createGatewayHarness(client);
    const sessions = createSessionsHarness("main", ["main-a", "main-b"]);
    const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
    const cachedResult = sidebar.sessionData.sessionsResult;

    gateway.publish({ phase: "reconnecting" });
    sessions.publish({ result: null, agentId: null, loading: false });
    await sidebar.updateComplete;

    expect(sidebar.sessionData.sessionsResult).toBe(cachedResult);
    expect(sidebar.sessionData.sessionsAgentId).toBe("main");
    expect(Object.keys(sidebar.sessionData.sessionRowsByAgent)).toEqual(["main"]);
    expect([...sidebar.sessionData.sessionCreatedOrder.keys()]).toEqual(["main-a", "main-b"]);

    gateway.publish({ phase: "connected" });
    const partial = createSessionState("main", ["main-a"]);
    sessions.publish({ result: partial.result, agentId: partial.agentId });
    await sidebar.updateComplete;

    expect(sidebar.sessionData.sessionsResult).toBe(cachedResult);
    expect(sidebar.sessionData.sessionsResult?.sessions.map((row) => row.key)).toEqual([
      "main-a",
      "main-b",
    ]);
    expect(sidebar.sessionData.sessionRowsByAgent.main?.map((row) => row.key)).toEqual([
      "main-a",
      "main-b",
    ]);

    const refreshed = createSessionState("main", ["main-c"]);
    sessions.publishList({ result: refreshed.result, agentId: refreshed.agentId });
    await sidebar.updateComplete;

    expect(sidebar.sessionData.sessionsResult?.sessions.map((row) => row.key)).toEqual(["main-c"]);
    expect(sidebar.sessionData.sessionsAgentId).toBe("main");
  });

  it("clears every cached session view when the Gateway client is replaced", async () => {
    const firstClient = {} as GatewayBrowserClient;
    const gateway = createGatewayHarness(firstClient);
    const sessions = createSessionsHarness("main", ["main-a"]);
    const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);

    gateway.publish({
      client: {} as GatewayBrowserClient,
      phase: "reconnecting",
    });
    await sidebar.updateComplete;

    expect(sidebar.sessionData.sessionsResult).toBeNull();
    expect(sidebar.sessionData.sessionsAgentId).toBeNull();
    expect(sidebar.sessionData.sessionRowsByAgent).toEqual({});
    expect(sidebar.sessionData.sessionCreatedOrder.size).toBe(0);
  });

  it("clears every cached session view when the Gateway source is replaced", async () => {
    const client = {} as GatewayBrowserClient;
    const gateway = createGatewayHarness(client);
    const sessions = createSessionsHarness("main", ["main-a"]);
    const { provider, sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);

    const replacementGateway = createGatewayHarness(client);
    provider.setContext(createContext(replacementGateway.gateway, sessions.sessions));
    await sidebar.updateComplete;

    expect(sidebar.sessionData.sessionsResult).toBeNull();
    expect(sidebar.sessionData.sessionsAgentId).toBeNull();
    expect(sidebar.sessionData.sessionRowsByAgent).toEqual({});
    expect(sidebar.sessionData.sessionCreatedOrder.size).toBe(0);
  });
});

describe("AppSidebar session accessibility", () => {
  it("exposes a derived title through native list and link semantics", async () => {
    const key = "agent:main:dashboard:opaque-id";
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", [key]);
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    (sidebar as unknown as { activeRouteId: string }).activeRouteId = "chat";
    sidebar.sessionKey = key;
    harness.publishList({
      result: {
        ts: 2,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key,
            kind: "direct",
            label: key,
            displayName: key,
            derivedTitle: "Quarterly launch plan",
            updatedAt: Date.now(),
            unread: true,
          },
        ],
      },
      agentId: "main",
    });
    await sidebar.updateComplete;

    const list = sidebar.querySelector('[data-session-section="ungrouped"] [role="list"]');
    const row = sidebar.querySelector(`[data-session-key="${key}"]`);
    const tree = row?.closest(".sidebar-session-tree");
    const link = row?.querySelector<HTMLAnchorElement>(".sidebar-recent-session__link");
    expect(list?.getAttribute("aria-label")).toBe("Sessions");
    expect(tree?.parentElement).toBe(list);
    expect(tree?.getAttribute("role")).toBe("listitem");
    expect(row?.hasAttribute("role")).toBe(false);
    expect(sidebar.querySelector(".sidebar-recent-sessions")?.hasAttribute("aria-label")).toBe(
      false,
    );
    expect(row?.hasAttribute("aria-label")).toBe(false);
    expect(link?.hasAttribute("aria-label")).toBe(false);
    expect(link?.getAttribute("aria-current")).toBe("page");
    const lead = link?.querySelector(".sidebar-session-indicator");
    expect(lead).not.toBeNull();
    expect(lead?.childElementCount).toBe(0);
    expect(link?.querySelector(".sidebar-recent-session__text")).not.toBeNull();
    const rowState = row?.querySelector(".session-row-state");
    expect(rowState?.getAttribute("role")).toBe("img");
    expect(rowState?.getAttribute("aria-label")).toBe("Unread");
    expect(rowState?.querySelector(".session-unread-dot")).not.toBeNull();
    expect(link?.querySelector(".sidebar-recent-session__name")?.textContent).toBe(
      "Quarterly launch plan",
    );
    expect(link?.getAttribute("title")).toBe("Quarterly launch plan · now · Unread");
    expect(link?.getAttribute("aria-describedby")).toBe(
      `sidebar-session-state-${encodeURIComponent(key)}`,
    );
    expect(row?.querySelector(".session-row-trail")).toBeNull();
  });
});

describe("AppSidebar session navigation", () => {
  it("selects a literal session's agent before changing the active session", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar, context } = await mountSidebar(
      gateway,
      createSessions("main", ["agent:main:main", "agent:research:work"]),
      "panel",
      TWO_AGENTS,
    );
    const calls: string[] = [];
    context.agentSelection.set = vi.fn((agentId) => calls.push(`agent:${agentId}`));
    gateway.setSessionKey = vi.fn((sessionKey) => calls.push(`session:${sessionKey}`));

    (sidebar as unknown as { selectSession: (sessionKey: string) => void }).selectSession(
      "agent:research:work",
    );

    expect(calls).toEqual(["agent:research", "session:agent:research:work"]);
  });
});

describe("AppSidebar session mutation feedback", () => {
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
      expect(toast.querySelector(".app-toast__message")?.textContent).toBe("Session archived"),
    );
    expect(harness.patch).toHaveBeenCalledWith(
      archivedRow.key,
      { archived: true },
      { agentId: "main" },
    );
    toast.querySelector<HTMLButtonElement>(".app-toast__action")?.click();

    await vi.waitFor(() => expect(harness.patch).toHaveBeenCalledTimes(3));
    expect(setSessionKey).not.toHaveBeenCalled();
    expect(harness.patch).toHaveBeenNthCalledWith(
      2,
      archivedRow.key,
      { archived: false },
      { agentId: "main", deferListRefresh: true },
    );
    expect(harness.patch).toHaveBeenNthCalledWith(
      3,
      archivedRow.key,
      { pinned: true },
      { agentId: "main", deferListRefresh: true },
    );
    expect(harness.patchMany).not.toHaveBeenCalled();
    expect(harness.refreshReplacement).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
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

  it("destroys a pending cloud worker through its session", async () => {
    const request = vi.fn(() =>
      Promise.resolve({ status: "unavailable", worker: { state: "destroyed" } }),
    );
    const { gateway, harness, sidebar } = await mountMutationHarness({
      request,
    } as unknown as GatewayBrowserClient);
    gateway.publish({
      hello: {
        features: { methods: ["environments.destroy"] },
      } as ApplicationGatewaySnapshot["hello"],
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
    const toast = await mountToastHost();
    await sidebar.updateComplete;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    const menu = await openSessionMenu(sidebar, row.key);
    menu.querySelector<HTMLElement>('[value="stop-cloud-worker"]')?.click();

    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    expect(confirm).toHaveBeenCalledWith('Stop the cloud worker for "a"?');
    expect(request).toHaveBeenCalledWith("environments.destroy", {
      environmentId: "environment-1",
    });
    await waitForFast(() => expect(harness.refreshReplacement).toHaveBeenCalledWith("main"));
    await waitForFast(() =>
      expect(toast.querySelector(".app-toast__message")?.textContent).toBe(
        'Cloud worker for "a" is destroyed.',
      ),
    );
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
