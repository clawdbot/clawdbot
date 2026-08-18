import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SidebarSessionSortMode } from "../../components/app-sidebar-session-types.ts";
import {
  createContext,
  createGateway,
  createGatewayHarness,
  createSessions,
  createSessionsHarness,
  createSessionState,
  type LobsterPetElement,
  mountSidebar,
  type TestSessionMenu,
  TWO_AGENTS,
} from "../app-sidebar.ts";
import "./session-pagination.ts";
import "./session-navigation.ts";

type SidebarSortModeHost = {
  sessionSortMode: SidebarSessionSortMode;
  setSessionSortMode: (mode: SidebarSessionSortMode) => void;
};

describe("AppSidebar session sort persistence", () => {
  it("restores the selected sort mode on a later mount", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const first = await mountSidebar(gateway, createSessions("main", ["agent:main:session-a"]));
    const firstSidebar = first.sidebar as unknown as SidebarSortModeHost;
    expect(firstSidebar.sessionSortMode).toBe("created");

    firstSidebar.setSessionSortMode("updated");
    expect(localStorage.getItem("openclaw:sidebar:sessions:sort-mode")).toBe("updated");

    // A remount is what a reload does to this element; the preference must
    // survive it like every other stored sidebar choice.
    document.body.replaceChildren();
    const second = await mountSidebar(gateway, createSessions("main", ["agent:main:session-a"]));

    expect((second.sidebar as unknown as SidebarSortModeHost).sessionSortMode).toBe("updated");
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

  it("shows a newly discovered session above the created-sort pagination boundary", async () => {
    const olderKeys = Array.from({ length: 10 }, (_, index) => `agent:main:older-${index}`);
    const gateway = createGateway({} as GatewayBrowserClient);
    const sessions = createSessionsHarness("main", olderKeys);
    const { sidebar } = await mountSidebar(gateway, sessions.sessions);
    const refreshed = createSessionState("main", [...olderKeys, "agent:main:external-new"]);
    const rows = refreshed.result?.sessions;
    if (!rows) {
      throw new Error("expected refreshed session rows");
    }
    const newestRow = rows.at(-1);
    if (!newestRow) {
      throw new Error("expected newest session row");
    }
    newestRow.createdAt = 2_000;

    sessions.publishList({ result: refreshed.result, agentId: refreshed.agentId });
    await sidebar.updateComplete;

    expect(
      Array.from(
        sidebar.querySelectorAll<HTMLElement>("[data-session-key]"),
        (row) => row.dataset.sessionKey,
      ),
    ).toEqual(["agent:main:external-new", ...olderKeys.slice(0, 9)]);
    expect(sidebar.querySelectorAll(".sidebar-recent-session")).toHaveLength(10);
    expect(sidebar.querySelector('button[aria-label="Show more"]')).not.toBeNull();
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

  it("forks from stable history when Gateway liveness outlives display status", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const sessions = createSessionsHarness("main", ["agent:main:active"]);
    const state = createSessionState("main", ["agent:main:active"]);
    const row = state.result?.sessions[0];
    if (!row) {
      throw new Error("Expected active session row");
    }
    row.status = "done";
    row.hasActiveRun = true;
    sessions.publishList({ result: state.result, agentId: state.agentId });
    const { sidebar } = await mountSidebar(gateway, sessions.sessions);
    sidebar.connected = true;
    await sidebar.updateComplete;

    sidebar
      .querySelector<HTMLButtonElement>(
        '[data-session-key="agent:main:active"] [data-session-menu="true"]',
      )
      ?.click();
    await sidebar.updateComplete;

    const menu = sidebar.querySelector<TestSessionMenu>("openclaw-session-menu");
    if (!menu) {
      throw new Error("Expected sidebar session menu");
    }
    await menu.updateComplete;
    expect(menu.forkFromLastCompleted).toBe(true);
    menu.onAction({ kind: "fork" });

    await vi.waitFor(() =>
      expect(sessions.create).toHaveBeenCalledWith({
        parentSessionKey: "agent:main:active",
        fork: true,
        forkFrom: "last-completed",
        agentId: "main",
      }),
    );
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
    expect(link?.hasAttribute("title")).toBe(false);
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
