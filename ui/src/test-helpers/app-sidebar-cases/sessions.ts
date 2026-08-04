import { describe, expect, it, vi } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../../lib/session-pull-requests.ts";
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
import { waitForFast } from "../wait-for.ts";
import "./session-mutation-feedback.ts";
import "./session-pagination.ts";

describe("AppSidebar session indicators", () => {
  it("trails transient activity while keeping persistent status leading", async () => {
    const keys = {
      plain: "agent:main:plain",
      forked: "agent:main:forked",
      oversizedParent: "agent:main:oversized-parent",
      unread: "agent:main:unread",
      running: "agent:main:status-running",
      openPullRequest: "agent:main:open-pr",
      mergedPullRequest: "agent:main:merged-pr",
    };
    const allKeys = Object.values(keys);
    const sessions = createSessionsHarness("main", allKeys);
    const result = sessions.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    for (const row of result.sessions) {
      if (row.key === keys.forked) {
        row.forkSource = { sessionKey: "agent:main:parent", sessionId: "parent-session" };
      } else if (row.key === keys.oversizedParent) {
        row.forkedFromParent = true;
      } else if (row.key === keys.unread) {
        row.unread = true;
      } else if (row.key === keys.running) {
        row.status = "running";
      } else if (row.key === keys.openPullRequest || row.key === keys.mergedPullRequest) {
        row.worktree = {
          id: `wt-${row.key}`,
          branch: row.key.endsWith("open-pr") ? "feature/open" : "feature/merged",
          repoRoot: "/repo",
        };
      }
    }
    const request = vi.fn(() => Promise.resolve({ subscribed: true }));
    const gatewayHarness = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    gatewayHarness.publish({
      hello: {
        features: { methods: [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    const { sidebar } = await mountSidebar(gatewayHarness.gateway, sessions.sessions);
    sidebar.connected = true;
    await sidebar.updateComplete;
    await waitForFast(() => {
      expect(request).toHaveBeenCalledWith(
        SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
        expect.objectContaining({
          sessionKeys: expect.arrayContaining([keys.openPullRequest, keys.mergedPullRequest]),
        }),
      );
    });
    gatewayHarness.publishEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
      sessions: Object.fromEntries(
        [keys.openPullRequest, keys.mergedPullRequest].map((key) => [
          key,
          {
            pullRequests: [
              {
                number: 1,
                owner: "openclaw",
                repo: "openclaw",
                branch: "feature/test",
                title: "Test",
                url: "https://example.test/pr/1",
                state: key.endsWith("open-pr") ? "open" : "merged",
              },
            ],
            rateLimited: false,
            status: "ready",
          },
        ]),
      ),
    });

    await waitForFast(() => {
      expect(sidebar.querySelector('[data-session-pr-state="open"]')).not.toBeNull();
      expect(sidebar.querySelector('[data-session-pr-state="merged"]')).not.toBeNull();
    });
    const plain = sidebar.querySelector(`[data-session-key="${keys.plain}"]`);
    expect(plain?.querySelector(".sidebar-session-indicator")).toBeNull();
    expect(plain?.querySelector(".session-row-state")).toBeNull();

    const forked = sidebar.querySelector(`[data-session-key="${keys.forked}"]`);
    expect(forked?.querySelector(".sidebar-session-indicator")).toBeNull();
    expect(
      forked?.querySelector(".session-row-aside > .session-row-state .session-row-fork-indicator"),
    ).not.toBeNull();

    const oversizedParent = sidebar.querySelector(`[data-session-key="${keys.oversizedParent}"]`);
    expect(oversizedParent?.querySelector(".session-row-fork-indicator")).toBeNull();

    const unread = sidebar.querySelector(`[data-session-key="${keys.unread}"]`);
    expect(unread?.querySelector(".sidebar-session-indicator")).toBeNull();
    expect(
      unread?.querySelector(".session-row-aside > .session-row-state .session-unread-dot"),
    ).not.toBeNull();

    const running = sidebar.querySelector(`[data-session-key="${keys.running}"]`);
    expect(running?.querySelector(".sidebar-session-indicator")).toBeNull();
    expect(
      running?.querySelector(".session-row-aside > .session-row-state .session-run-spinner"),
    ).not.toBeNull();

    for (const key of [keys.openPullRequest, keys.mergedPullRequest]) {
      const row = sidebar.querySelector(`[data-session-key="${key}"]`);
      expect(row?.querySelector(".sidebar-session-indicator")).toBeNull();
      expect(row?.querySelector(".session-row-state [data-session-pr-state]")).not.toBeNull();
    }

    const openPullRequestRow = result.sessions.find((row) => row.key === keys.openPullRequest);
    if (!openPullRequestRow) {
      throw new Error("expected open PR session");
    }
    openPullRequestRow.worktree = undefined;
    sessions.publishList({ result });
    await waitForFast(() => {
      expect(sidebar.querySelector('[data-session-pr-state="open"]')).toBeNull();
      expect(
        sidebar.querySelector(
          `[data-session-key="${keys.openPullRequest}"] .sidebar-session-indicator`,
        ),
      ).toBeNull();
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
    const link = row?.querySelector<HTMLAnchorElement>(".sidebar-recent-session__link");
    expect(list?.getAttribute("aria-label")).toBe("Threads");
    expect(row?.getAttribute("role")).toBe("listitem");
    expect(row?.hasAttribute("aria-label")).toBe(false);
    expect(link?.hasAttribute("aria-label")).toBe(false);
    expect(link?.getAttribute("aria-current")).toBe("page");
    expect(link?.querySelector(".sidebar-session-indicator")).toBeNull();
    expect(link?.firstElementChild?.classList.contains("sidebar-recent-session__text")).toBe(true);
    expect(row?.querySelector(".session-row-state .session-unread-dot")).not.toBeNull();
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
