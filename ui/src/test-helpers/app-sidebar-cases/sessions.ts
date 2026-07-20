import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  createLobsterPetLook,
  LOBSTER_LOGO_VISIT_EVENT,
  type LobsterLogoVisitDetail,
} from "../../components/lobster-pet.ts";
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
} from "../app-sidebar.ts";
import { waitForFast } from "../wait-for.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar session indicators", () => {
  it("keeps one leading slot across neutral, running, open, and merged states", async () => {
    const keys = [
      "agent:main:plain",
      "agent:main:status-running",
      "agent:main:open-pr",
      "agent:main:merged-pr",
    ];
    const sessions = createSessionsHarness("main", keys);
    const result = sessions.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    for (const row of result.sessions) {
      if (row.key === keys[1]) {
        row.status = "running";
      } else if (row.key === keys[2] || row.key === keys[3]) {
        row.worktree = {
          id: `wt-${row.key}`,
          branch: row.key.endsWith("open-pr") ? "feature/open" : "feature/merged",
          repoRoot: "/repo",
        };
      }
    }
    const request = vi.fn((_method: string, params: { sessionKey: string }) =>
      Promise.resolve({
        pullRequests: [
          {
            number: 1,
            owner: "openclaw",
            repo: "openclaw",
            branch: "feature/test",
            title: "Test",
            url: "https://example.test/pr/1",
            state: params.sessionKey.endsWith("open-pr") ? "open" : "merged",
          },
        ],
        rateLimited: false,
      }),
    );
    const gatewayHarness = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    gatewayHarness.publish({
      hello: {
        features: { methods: ["controlUi.sessionPullRequests"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    const { sidebar } = await mountSidebar(gatewayHarness.gateway, sessions.sessions);
    sidebar.connected = true;
    await sidebar.updateComplete;

    await waitForFast(() => {
      expect(sidebar.querySelector('[data-session-pr-state="open"]')).not.toBeNull();
      expect(sidebar.querySelector('[data-session-pr-state="merged"]')).not.toBeNull();
    });
    for (const key of keys) {
      expect(
        sidebar.querySelector(`[data-session-key="${key}"] .sidebar-session-indicator`),
      ).not.toBeNull();
    }
    expect(
      sidebar.querySelector(`[data-session-key="${keys[0]}"] .sidebar-session-indicator__dot`),
    ).not.toBeNull();
    expect(
      sidebar.querySelector(`[data-session-key="${keys[1]}"] .session-run-spinner`),
    ).not.toBeNull();

    const openPullRequestRow = result.sessions.find((row) => row.key === keys[2]);
    if (!openPullRequestRow) {
      throw new Error("expected open PR session");
    }
    openPullRequestRow.worktree = undefined;
    sessions.publishList({ result });
    await waitForFast(() => {
      expect(sidebar.querySelector('[data-session-pr-state="open"]')).toBeNull();
      expect(
        sidebar.querySelector(`[data-session-key="${keys[2]}"] .sidebar-session-indicator__dot`),
      ).not.toBeNull();
    });
  });
});

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
    expect(button("Load more threads")).not.toBeNull();
    expect(button("Collapse")).toBeNull();

    button("Load more threads")?.click();
    await sidebar.updateComplete;
    expect(rows()).toHaveLength(20);
    expect(button("Collapse")).toBeNull();

    button("Load more threads")?.click();
    await sidebar.updateComplete;
    expect(rows()).toHaveLength(30);
    expect(button("Collapse")).toBeNull();

    button("Load more threads")?.click();
    await sidebar.updateComplete;
    expect(rows()).toHaveLength(40);
    expect(button("Load more threads")).not.toBeNull();
    expect(button("Collapse")).not.toBeNull();

    button("Load more threads")?.click();
    await sidebar.updateComplete;
    expect(rows()).toHaveLength(41);
    expect(button("Load more threads")).toBeNull();
    expect(button("Collapse")).not.toBeNull();

    button("Collapse")?.click();
    await sidebar.updateComplete;
    expect(rows()).toHaveLength(10);
    expect(button("Load more threads")).not.toBeNull();
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

describe("AppSidebar logo stand-in wiring", () => {
  it("swaps the brand mark while the pet's logo visit is in, leaving, then out", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    const pet = sidebar.querySelector("openclaw-lobster-pet");
    if (!pet) {
      throw new Error("Expected sidebar lobster pet");
    }
    const dispatch = (detail: LobsterLogoVisitDetail) =>
      pet.dispatchEvent(
        new CustomEvent(LOBSTER_LOGO_VISIT_EVENT, { detail, bubbles: true, composed: true }),
      );
    const logo = () => sidebar.querySelector(".sidebar-brand__logo");
    const standIn = () => sidebar.querySelector(".sidebar-brand__pet");
    const standInHost = sidebar.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
      "openclaw-lobster-logo-standin",
    );
    const settleStandIn = async () => {
      await sidebar.updateComplete;
      await standInHost?.updateComplete;
    };

    expect(standInHost).not.toBeNull();
    await standInHost?.updateComplete;
    expect(logo()?.classList.contains("sidebar-brand__logo--vacated")).toBe(false);
    expect(standIn()).toBeNull();

    const look = createLobsterPetLook(70);
    dispatch({ phase: "in", look, name: "Pinchy" });
    await settleStandIn();
    expect(logo()?.classList.contains("sidebar-brand__logo--vacated")).toBe(true);
    const sprite = standIn();
    expect(sprite).not.toBeNull();
    expect(sprite?.classList.contains(`lobster-pet--palette-${look.palette.id}`)).toBe(true);
    expect(sprite?.getAttribute("title")).toContain("Pinchy");
    expect(sprite?.querySelector(".lobster-pet__svg")).not.toBeNull();

    dispatch({ phase: "leaving", look, name: "Pinchy" });
    await settleStandIn();
    expect(standIn()?.classList.contains("sidebar-brand__pet--leaving")).toBe(true);

    dispatch({ phase: "out", look: null, name: null });
    await settleStandIn();
    expect(standIn()).toBeNull();
    expect(logo()?.classList.contains("sidebar-brand__logo--vacated")).toBe(false);

    // A lookless scare phase hides the logo with no stand-in crab, and the
    // "out" edge restores it.
    dispatch({ phase: "in", look: null, name: null });
    await settleStandIn();
    expect(logo()?.classList.contains("sidebar-brand__logo--vacated")).toBe(true);
    expect(standIn()).toBeNull();

    dispatch({ phase: "out", look: null, name: null });
    await settleStandIn();
    expect(logo()?.classList.contains("sidebar-brand__logo--vacated")).toBe(false);
  });
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

    expect(Object.keys(sidebar.sessionRowsByAgent)).toEqual(["first"]);
    expect([...sidebar.sessionCreatedOrder]).toEqual([
      ["first-a", 0],
      ["first-b", 1],
    ]);

    // The Gateway and its client stay unchanged while the sessions capability is replaced.
    provider.setContext(createContext(gateway, createSessions("second", ["second-b", "second-a"])));
    await sidebar.updateComplete;

    expect(Object.keys(sidebar.sessionRowsByAgent)).toEqual(["second"]);
    expect([...sidebar.sessionCreatedOrder]).toEqual([
      ["second-b", 0],
      ["second-a", 1],
    ]);
    expect(sidebar.sessionsAgentId).toBe("second");
    expect(sidebar.sessionsResult?.sessions.map((row) => row.key)).toEqual([
      "second-b",
      "second-a",
    ]);
  });

  it("preserves the scoped result through a disconnect on the same Gateway client", async () => {
    const client = {} as GatewayBrowserClient;
    const gateway = createGatewayHarness(client);
    const sessions = createSessionsHarness("main", ["main-a", "main-b"]);
    const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
    const cachedResult = sidebar.sessionsResult;

    gateway.publish({ connected: false, reconnecting: true });
    sessions.publish({ result: null, agentId: null, loading: false });
    await sidebar.updateComplete;

    expect(sidebar.sessionsResult).toBe(cachedResult);
    expect(sidebar.sessionsAgentId).toBe("main");
    expect(Object.keys(sidebar.sessionRowsByAgent)).toEqual(["main"]);
    expect([...sidebar.sessionCreatedOrder.keys()]).toEqual(["main-a", "main-b"]);

    gateway.publish({ connected: true, reconnecting: false });
    const partial = createSessionState("main", ["main-a"]);
    sessions.publish({ result: partial.result, agentId: partial.agentId });
    await sidebar.updateComplete;

    expect(sidebar.sessionsResult).toBe(cachedResult);
    expect(sidebar.sessionsResult?.sessions.map((row) => row.key)).toEqual(["main-a", "main-b"]);
    expect(sidebar.sessionRowsByAgent.main?.map((row) => row.key)).toEqual(["main-a", "main-b"]);

    const refreshed = createSessionState("main", ["main-c"]);
    sessions.publishList({ result: refreshed.result, agentId: refreshed.agentId });
    await sidebar.updateComplete;

    expect(sidebar.sessionsResult?.sessions.map((row) => row.key)).toEqual(["main-c"]);
    expect(sidebar.sessionsAgentId).toBe("main");
  });

  it("clears every cached session view when the Gateway client is replaced", async () => {
    const firstClient = {} as GatewayBrowserClient;
    const gateway = createGatewayHarness(firstClient);
    const sessions = createSessionsHarness("main", ["main-a"]);
    const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);

    gateway.publish({
      client: {} as GatewayBrowserClient,
      connected: false,
      reconnecting: true,
    });
    await sidebar.updateComplete;

    expect(sidebar.sessionsResult).toBeNull();
    expect(sidebar.sessionsAgentId).toBeNull();
    expect(sidebar.sessionRowsByAgent).toEqual({});
    expect(sidebar.sessionCreatedOrder.size).toBe(0);
  });

  it("clears every cached session view when the Gateway source is replaced", async () => {
    const client = {} as GatewayBrowserClient;
    const gateway = createGatewayHarness(client);
    const sessions = createSessionsHarness("main", ["main-a"]);
    const { provider, sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);

    const replacementGateway = createGatewayHarness(client);
    provider.setContext(createContext(replacementGateway.gateway, sessions.sessions));
    await sidebar.updateComplete;

    expect(sidebar.sessionsResult).toBeNull();
    expect(sidebar.sessionsAgentId).toBeNull();
    expect(sidebar.sessionRowsByAgent).toEqual({});
    expect(sidebar.sessionCreatedOrder.size).toBe(0);
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
    const link = row?.querySelector<HTMLAnchorElement>(".sidebar-recent-session__link");
    expect(list?.getAttribute("aria-label")).toBe("Threads");
    expect(row?.getAttribute("role")).toBe("listitem");
    expect(row?.hasAttribute("aria-label")).toBe(false);
    expect(link?.hasAttribute("aria-label")).toBe(false);
    expect(link?.getAttribute("aria-current")).toBe("page");
    expect(link?.firstElementChild?.classList.contains("sidebar-session-indicator")).toBe(true);
    expect(link?.children[1]?.classList.contains("sidebar-recent-session__text")).toBe(true);
    expect(link?.querySelector(".sidebar-recent-session__name")?.textContent).toBe(
      "Quarterly launch plan",
    );
    expect(link?.getAttribute("title")).toBe("Quarterly launch plan · now");
    expect(link?.hasAttribute("aria-describedby")).toBe(false);
    expect(row?.querySelector(".session-row-trail")?.textContent?.trim()).toBe("");
  });

  it("renders no chat rows when only the main session exists", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    (sidebar as unknown as { activeRouteId: string }).activeRouteId = "chat";
    await sidebar.updateComplete;

    // The identity card is the main-session entry; the list stays empty.
    expect(sidebar.querySelectorAll(".sidebar-recent-session")).toHaveLength(0);
    expect(sidebar.querySelector("openclaw-sidebar-agent-card")).not.toBeNull();
  });
});

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
    const state = createSessionState("main", ["agent:main:main", "agent:main:a", "agent:main:b"]);
    const archivedRow = state.result?.sessions.find((row) => row.key === "agent:main:a");
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
    await vi.waitFor(() => expect(setSessionKey).toHaveBeenLastCalledWith(archivedRow.key));
    expect(harness.patch).toHaveBeenLastCalledWith(
      archivedRow.key,
      { archived: false, pinned: true },
      { agentId: "main" },
    );
    expect(navigate).toHaveBeenLastCalledWith("chat", {
      search: "?session=agent%3Amain%3Aa",
    });
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

    gateway.publish({ connected: false, reconnecting: true });
    gateway.publish({ connected: true, reconnecting: false });
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

    gateway.publish({ connected: false, reconnecting: true });
    gateway.publish({ connected: true, reconnecting: false });
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
        gateway.publish({ connected: false, reconnecting: true });
        gateway.publish({ connected: true, reconnecting: false });
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
