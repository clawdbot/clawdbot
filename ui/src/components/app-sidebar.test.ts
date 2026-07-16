/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SessionCatalog,
  SessionsCatalogListResult,
} from "../../../packages/gateway-protocol/src/index.ts";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import type { AgentsListResult, SessionsListResult } from "../api/types.ts";
import type { RouteId } from "../app-route-paths.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../app/context.ts";
import { CATALOG_SESSION_CONTINUED_EVENT } from "../lib/sessions/catalog-key.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  LOBSTER_LOGO_VISIT_EVENT,
  createLobsterPetLook,
  type LobsterLogoVisitDetail,
} from "./lobster-pet.ts";
import "./app-sidebar.ts";
import { TERMINAL_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";

type SessionGroupMutationResult = Awaited<ReturnType<SessionCapability["groupsRename"]>>;
type SessionDeleteResult = Awaited<ReturnType<SessionCapability["delete"]>>;
type SessionState = SessionCapability["state"];

// Keep the attention widget inert: it fires its own health RPCs (cron.list,
// models.authStatus) on connect, which would interleave with the nth-call
// assertions on the shared mocked client below. It has its own test file.
vi.mock("./sidebar-attention.ts", () => ({}));

type SidebarLifecycleState = HTMLElement & {
  connected: boolean;
  terminalAvailable: boolean;
  catalogOpenTarget: "viewer" | "terminal";
  canPairDevice: boolean;
  pinnedAgentIds: readonly string[];
  sessionKey: string;
  onNavigate: (routeId: string, options?: { search?: string }) => void;
  sessionCatalogs: SessionCatalog[];
  sessionRowsByAgent: Record<string, SessionsListResult["sessions"]>;
  sessionCreatedOrder: Map<string, number>;
  sessionsAgentId: string | null;
  sessionsResult: SessionsListResult | null;
  requestUpdate: () => void;
  updateComplete: Promise<boolean>;
  updateAvailable: { currentVersion: string; latestVersion: string; channel: string } | null;
  updateRunning: boolean;
  onUpdate: () => void;
  onOpenNewSession?: (agentId: string, target?: { catalogId: string }) => void;
  variant: "panel" | "drawer";
};

type LobsterPetElement = HTMLElement & {
  runOutcome: "ok" | "error" | "aborted";
};

type TestSessionMenu = HTMLElement & {
  forkDisabled: boolean;
  selectionCount: number;
  readonly updateComplete: Promise<boolean>;
};

function createGatewayHarness(client: GatewayBrowserClient) {
  let snapshot: ApplicationGatewaySnapshot = {
    client,
    connected: true,
    reconnecting: false,
    hello: null,
    assistantAgentId: "main",
    sessionKey: "agent:main:main",
    lastError: null,
    lastErrorCode: null,
  };
  const listeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  const gateway = {
    get snapshot() {
      return snapshot;
    },
    setSessionKey: () => undefined,
    subscribe(listener: (next: ApplicationGatewaySnapshot) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as ApplicationGateway;
  return {
    gateway,
    publish(patch: Partial<ApplicationGatewaySnapshot>) {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

function createSessionState(agentId: string, keys: string[]): SessionState {
  const result = {
    ts: 1,
    path: "",
    count: keys.length,
    defaults: {
      modelProvider: null,
      model: null,
      contextTokens: null,
    },
    sessions: keys.map((key, index) => ({
      key,
      kind: "direct" as const,
      updatedAt: index + 1,
    })),
  } satisfies SessionsListResult;
  return {
    result,
    agentId,
    modelOverrides: {},
    loading: false,
    error: null,
    deletedSessions: [],
    groups: [],
  };
}

function successfulSessionPatch(key: string) {
  return {
    ok: true as const,
    path: "",
    key,
    entry: { sessionId: key },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createSessionsHarness(agentId: string, keys: string[]) {
  let state = createSessionState(agentId, keys);
  let canonicalListRevision = 1;
  const listeners = new Set<(next: SessionState) => void>();
  const groupsPut = vi.fn(() => Promise.resolve());
  const groupsRename = vi.fn(() => Promise.resolve<SessionGroupMutationResult>("completed"));
  const groupsDelete = vi.fn(() => Promise.resolve<SessionGroupMutationResult>("completed"));
  const create = vi.fn(() => Promise.resolve("agent:main:fork"));
  const patch = vi.fn((key: string, _patch: Parameters<SessionCapability["patch"]>[1]) =>
    Promise.resolve(successfulSessionPatch(key)),
  );
  const deleteSession = vi.fn(
    (): Promise<SessionDeleteResult> => Promise.resolve({ deleted: false }),
  );
  const deleteMany = vi.fn(() =>
    Promise.resolve({
      deleted: [] as string[],
      errors: [] as string[],
      preservedWorktrees: [] as Array<{ id: string; branch: string; path: string }>,
    }),
  );
  const refresh = vi.fn(() => Promise.resolve());
  const refreshReplacement = vi.fn(() => Promise.resolve());
  const list = vi.fn((_options?: Parameters<SessionCapability["list"]>[0]) =>
    Promise.resolve<SessionsListResult | null>(null),
  );
  const sessions = {
    get state() {
      return state;
    },
    get canonicalListRevision() {
      return canonicalListRevision;
    },
    subscribe(listener: (next: SessionState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeCreated: () => () => undefined,
    groupsLoad: () => Promise.resolve(),
    groupsPut,
    groupsRename,
    groupsDelete,
    create,
    patch,
    delete: deleteSession,
    deleteMany,
    list,
    refresh,
    refreshReplacement,
  } as unknown as SessionCapability;
  const publish = (statePatch: Partial<SessionState>) => {
    state = { ...state, ...statePatch };
    for (const listener of listeners) {
      listener(state);
    }
  };
  return {
    sessions,
    groupsPut,
    groupsRename,
    groupsDelete,
    create,
    patch,
    deleteSession,
    deleteMany,
    list,
    refresh,
    refreshReplacement,
    publish,
    publishList(statePatch: Partial<SessionState>) {
      canonicalListRevision += 1;
      publish(statePatch);
    },
  };
}

function createGateway(client: GatewayBrowserClient): ApplicationGateway {
  return createGatewayHarness(client).gateway;
}

function createSessions(agentId: string, keys: string[]): SessionCapability {
  return createSessionsHarness(agentId, keys).sessions;
}

let originalLocalStorage: PropertyDescriptor | undefined;

beforeEach(() => {
  originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: createStorageMock(),
  });
});

function createContext(
  gateway: ApplicationGateway,
  sessions: SessionCapability,
  agentsList: AgentsListResult | null = null,
): ApplicationContext<RouteId> {
  const selectedAgentId = sessions.state.agentId ?? "main";
  return {
    gateway,
    sessions,
    agents: {
      state: { agentsList },
      subscribe: () => () => undefined,
    },
    agentSelection: {
      state: { selectedId: selectedAgentId, scopeId: selectedAgentId },
      set: () => undefined,
      setScope: () => undefined,
      subscribe: () => () => undefined,
    },
  } as unknown as ApplicationContext<RouteId>;
}

async function mountSidebar(
  gateway: ApplicationGateway,
  sessions: SessionCapability,
  variant: SidebarLifecycleState["variant"] = "panel",
  agentsList: AgentsListResult | null = null,
) {
  const context = createContext(gateway, sessions, agentsList);
  const provider = createApplicationContextProvider(context);
  const sidebar = document.createElement(
    "openclaw-app-sidebar",
  ) as unknown as SidebarLifecycleState;
  sidebar.variant = variant;
  provider.append(sidebar);
  document.body.append(provider);
  await sidebar.updateComplete;
  return { provider, sidebar, context };
}

afterEach(() => {
  document.body.replaceChildren();
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  } else {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});

describe("AppSidebar update card wiring", () => {
  it("renders the update card in the footer after the attention slot and forwards its action", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    const onUpdate = vi.fn();
    sidebar.updateAvailable = {
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "stable",
    };
    sidebar.onUpdate = onUpdate;
    await sidebar.updateComplete;

    const footer = sidebar.querySelector(".sidebar-shell__footer");
    // Attention chips (when present) stack above the update card.
    expect(footer?.firstElementChild?.localName).toBe("openclaw-sidebar-attention");
    const card = footer?.querySelector("openclaw-sidebar-update-card");
    expect(card).not.toBeNull();
    card?.querySelector<HTMLButtonElement>(".sidebar-update-card__action")?.click();
    expect(onUpdate).toHaveBeenCalledOnce();
  });
});

describe("AppSidebar agent chip", () => {
  const TWO_AGENTS = {
    defaultId: "main",
    mainKey: "main",
    scope: "agent",
    agents: [{ id: "main", identity: { name: "Molty" } }, { id: "research" }],
  } as AgentsListResult;

  it("resumes the newest session when the menu switches to an agent with cached rows", async () => {
    const gatewayHarness = createGatewayHarness({} as GatewayBrowserClient);
    const setSessionKey = vi.fn();
    (gatewayHarness.gateway as { setSessionKey: (key: string) => void }).setSessionKey =
      setSessionKey;
    const { sidebar } = await mountSidebar(
      gatewayHarness.gateway,
      createSessions("main", ["agent:main:main", "agent:main:task"]),
      "panel",
      TWO_AGENTS,
    );
    const onNavigate = vi.fn();
    sidebar.connected = true;
    sidebar.onNavigate = onNavigate;
    await sidebar.updateComplete;

    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-chip__main")?.click();
    await sidebar.updateComplete;
    const rows = [
      ...sidebar.querySelectorAll<HTMLElement>(
        ".sidebar-agent-menu wa-dropdown-item.sidebar-agent-menu__agent-switch",
      ),
    ];
    rows.find((row) => row.textContent?.includes("Molty"))?.click();
    // createSessionState stamps ascending updatedAt, so the last key is newest.
    expect(setSessionKey).toHaveBeenCalledWith("agent:main:task");
    expect(onNavigate).toHaveBeenCalledWith("chat", { search: "?session=agent%3Amain%3Atask" });
  });

  it("keeps agent ids distinct from utility command values", async () => {
    const gatewayHarness = createGatewayHarness({} as GatewayBrowserClient);
    const setSessionKey = vi.fn();
    (gatewayHarness.gateway as { setSessionKey: (key: string) => void }).setSessionKey =
      setSessionKey;
    const agents = {
      defaultId: "main",
      mainKey: "main",
      scope: "agent",
      agents: [{ id: "main" }, { id: "settings" }],
    } as AgentsListResult;
    const { sidebar } = await mountSidebar(
      gatewayHarness.gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      agents,
    );
    const onNavigate = vi.fn();
    sidebar.connected = true;
    sidebar.onNavigate = onNavigate;
    await sidebar.updateComplete;

    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-chip__main")?.click();
    await sidebar.updateComplete;
    const menu = sidebar.querySelector<HTMLElement>(".sidebar-agent-menu");
    const settingsAgent = [
      ...(menu?.querySelectorAll<HTMLElement>('wa-dropdown-item[type="checkbox"]') ?? []),
    ].find((row) => row.textContent?.includes("settings"));
    menu?.dispatchEvent(
      new CustomEvent("wa-select", { detail: { item: settingsAgent }, bubbles: true }),
    );
    await sidebar.updateComplete;

    expect(setSessionKey).toHaveBeenCalledWith("agent:settings:main");
    expect(onNavigate).toHaveBeenCalledWith("chat", {
      search: "?session=agent%3Asettings%3Amain",
    });
    expect(onNavigate).not.toHaveBeenCalledWith("config");
  });

  it("shows offline in the chip subtitle when disconnected", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    sidebar.connected = false;
    await sidebar.updateComplete;

    expect(sidebar.querySelector(".sidebar-agent-chip__subtitle")?.textContent?.trim()).toBe(
      "Offline",
    );
  });

  it("shows a working subtitle while the agent has an active run", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", ["agent:main:main"]);
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    sidebar.connected = true;
    harness.publishList({
      result: {
        ts: 2,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [{ key: "agent:main:main", kind: "direct", updatedAt: 5, hasActiveRun: true }],
      },
      agentId: "main",
    });
    await sidebar.updateComplete;

    expect(sidebar.querySelector(".sidebar-agent-chip__subtitle")?.textContent).toContain(
      "Working",
    );
  });

  it("keeps the sessions list flat for the selected agent and flags other-agent unread", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", ["agent:main:main"]);
    const { sidebar, context } = await mountSidebar(gateway, harness.sessions, "panel", TWO_AGENTS);
    sidebar.connected = true;
    const defaults = { modelProvider: null, model: null, contextTokens: null };
    harness.publishList({
      result: {
        ts: 2,
        path: "",
        count: 1,
        defaults,
        sessions: [
          {
            key: "agent:research:one",
            kind: "direct",
            label: "Research task",
            updatedAt: 3,
            unread: true,
          },
        ],
      },
      agentId: "research",
    });
    harness.publishList({
      result: {
        ts: 3,
        path: "",
        count: 1,
        defaults,
        sessions: [{ key: "agent:main:main", kind: "direct", updatedAt: 5 }],
      },
      agentId: "main",
    });
    await sidebar.updateComplete;

    // No per-agent sections: the chip menu owns agent switching now.
    expect(sidebar.querySelector(".sidebar-agent-section")).toBeNull();
    expect(sidebar.querySelectorAll(".sidebar-recent-session")).toHaveLength(1);
    expect(sidebar.querySelector(".sidebar-agent-chip__menu-unread")).not.toBeNull();

    // Mid-switch (selected agent != loaded result agent) the list renders the
    // target agent's cached rows instead of flashing empty until refresh.
    // Chip switch and chat-pane both sync agentSelection with the route.
    context.agentSelection.state.selectedId = "research";
    sidebar.sessionKey = "agent:research:one";
    await sidebar.updateComplete;
    const rows = [...sidebar.querySelectorAll(".sidebar-recent-session")];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("Research task");
  });

  it("loads and expands child sessions inline without root session controls", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", ["agent:main:parent"]);
    harness.list.mockResolvedValue({
      ts: 100_000,
      path: "",
      count: 2,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [
        {
          key: "agent:main:child-one",
          spawnedBy: "agent:main:parent",
          kind: "direct",
          label: "Research sources",
          updatedAt: 2,
          status: "running",
          hasActiveRun: true,
          startedAt: 1_000,
          runtimeMs: 30_000,
        },
        {
          key: "agent:main:child-two",
          spawnedBy: "agent:main:parent",
          kind: "direct",
          label: "Check tests",
          updatedAt: 3,
          status: "done",
          startedAt: 1_000,
          endedAt: 61_000,
        },
      ],
    });
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    harness.publishList({
      result: {
        ts: 2,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:main:parent",
            kind: "direct",
            label: "Plan release",
            updatedAt: 1,
            childSessions: ["agent:main:child-one", "agent:main:child-two"],
          },
        ],
      },
    });
    await sidebar.updateComplete;

    const toggle = sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]");
    expect(toggle?.textContent?.trim()).toContain("2");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(sidebar.querySelector(".sidebar-recent-session--child")).toBeNull();

    toggle?.click();
    await vi.waitFor(() => expect(harness.list).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(sidebar.querySelectorAll(".sidebar-recent-session--child")).toHaveLength(2),
    );

    expect(harness.list).toHaveBeenCalledWith({
      spawnedBy: "agent:main:parent",
      limit: 20,
      includeGlobal: false,
      includeUnknown: false,
      configuredAgentsOnly: true,
    });
    const childRows = [...sidebar.querySelectorAll<HTMLElement>(".sidebar-recent-session--child")];
    expect(childRows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Research sources"),
      expect.stringContaining("Check tests"),
    ]);
    expect(childRows.every((row) => row.getAttribute("draggable") === "false")).toBe(true);
    expect(childRows.every((row) => row.querySelector(".session-row-actions") === null)).toBe(true);
    expect(sidebar.querySelector('[aria-label="Done"]')).not.toBeNull();
    const runtimeStartMs = (
      sidebar.querySelector('[data-session-key="agent:main:child-one"] openclaw-elapsed-time') as
        | (HTMLElement & { startMs: number })
        | null
    )?.startMs;
    expect(runtimeStartMs).toBeGreaterThan(Date.now() - 31_000);
    expect(runtimeStartMs).toBeLessThan(Date.now() - 29_000);

    harness.list.mockResolvedValue({
      ts: 3,
      path: "",
      count: 2,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [
        {
          key: "agent:main:child-one",
          spawnedBy: "agent:main:parent",
          kind: "direct",
          label: "Research sources",
          updatedAt: 4,
          status: "done",
          startedAt: 1_000,
          endedAt: 121_000,
          runtimeMs: 60_000,
        },
        {
          key: "agent:main:child-two",
          spawnedBy: "agent:main:parent",
          kind: "direct",
          label: "Check tests",
          updatedAt: 4,
          status: "done",
          startedAt: 1_000,
          endedAt: 121_000,
          runtimeMs: 60_000,
        },
      ],
    });
    harness.publishList({
      result: {
        ts: 3,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:main:parent",
            kind: "direct",
            label: "Plan release",
            updatedAt: 4,
            childSessions: ["agent:main:child-one"],
          },
        ],
      },
    });
    await vi.waitFor(() => expect(harness.list).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(
        sidebar.querySelector('[data-session-key="agent:main:child-one"] [aria-label="Done"]'),
      ).not.toBeNull(),
    );
  });

  it("loads every child-session page before marking a parent complete", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", ["agent:main:parent"]);
    const page = (key: string, hasMore: boolean): SessionsListResult => ({
      ts: 10,
      path: "",
      count: 1,
      totalCount: 2,
      hasMore,
      nextOffset: hasMore ? 20 : null,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [
        {
          key,
          spawnedBy: "agent:main:parent",
          kind: "direct",
          updatedAt: 1,
        },
      ],
    });
    harness.list
      .mockResolvedValueOnce(page("agent:worker:first", true))
      .mockResolvedValueOnce(page("agent:worker:second", false));
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    harness.publishList({
      result: {
        ts: 10,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:main:parent",
            kind: "direct",
            updatedAt: 1,
            childSessions: ["agent:worker:first", "agent:worker:second"],
          },
        ],
      },
    });
    await sidebar.updateComplete;
    sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]")?.click();

    await vi.waitFor(() => expect(harness.list).toHaveBeenCalledTimes(2));
    expect(harness.list.mock.calls[1]?.[0]).toMatchObject({
      spawnedBy: "agent:main:parent",
      offset: 20,
    });
    await vi.waitFor(() =>
      expect(sidebar.querySelectorAll(".sidebar-recent-session--child")).toHaveLength(2),
    );
  });

  it("retries an incomplete child page set after the canonical list advances", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", ["agent:main:parent"]);
    const page = (sessions: SessionsListResult["sessions"], hasMore: boolean) => ({
      ts: 10,
      path: "",
      count: sessions.length,
      totalCount: 2,
      hasMore,
      nextOffset: hasMore ? 20 : null,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions,
    });
    const firstChild = {
      key: "agent:worker:first",
      spawnedBy: "agent:main:parent",
      kind: "direct" as const,
      updatedAt: 1,
    };
    const secondChild = {
      key: "agent:worker:second",
      spawnedBy: "agent:main:parent",
      kind: "direct" as const,
      updatedAt: 2,
    };
    harness.list
      .mockResolvedValueOnce(page([firstChild], true))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(page([firstChild, secondChild], false));
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    const publishParent = (ts: number) =>
      harness.publishList({
        result: {
          ts,
          path: "",
          count: 1,
          defaults: { modelProvider: null, model: null, contextTokens: null },
          sessions: [
            {
              key: "agent:main:parent",
              kind: "direct",
              updatedAt: ts,
              childSessions: [firstChild.key, secondChild.key],
            },
          ],
        },
      });
    publishParent(10);
    await sidebar.updateComplete;
    sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]")?.click();

    await vi.waitFor(() => expect(harness.list).toHaveBeenCalledTimes(2));
    expect(sidebar.querySelector(".sidebar-recent-session--child")).toBeNull();

    publishParent(11);
    await vi.waitFor(() => expect(harness.list).toHaveBeenCalledTimes(3));
    await vi.waitFor(() =>
      expect(sidebar.querySelectorAll(".sidebar-recent-session--child")).toHaveLength(2),
    );
  });

  it("ignores a rejected child request after the session capability changes", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const stale = deferred<SessionsListResult | null>();
    const original = createSessionsHarness("main", ["agent:main:parent"]);
    original.list.mockReturnValue(stale.promise);
    const { provider, sidebar } = await mountSidebar(gateway, original.sessions);
    original.publishList({
      result: {
        ts: 2,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:main:parent",
            kind: "direct",
            updatedAt: 1,
            childSessions: ["agent:worker:child"],
          },
        ],
      },
    });
    await sidebar.updateComplete;
    sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]")?.click();
    await vi.waitFor(() => expect(original.list).toHaveBeenCalledOnce());

    const replacement = createSessionsHarness("main", ["agent:main:parent"]);
    replacement.list.mockResolvedValue({
      ts: 3,
      path: "",
      count: 1,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [
        {
          key: "agent:worker:child",
          spawnedBy: "agent:main:parent",
          kind: "direct",
          updatedAt: 2,
          label: "Replacement child",
        },
      ],
    });
    replacement.publishList({
      result: {
        ts: 3,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:main:parent",
            kind: "direct",
            updatedAt: 2,
            childSessions: ["agent:worker:child"],
          },
        ],
      },
    });
    provider.setContext(createContext(gateway, replacement.sessions));
    await vi.waitFor(() =>
      expect(sidebar.querySelector('[data-session-key="agent:worker:child"]')).not.toBeNull(),
    );

    stale.reject(new Error("old capability failed"));
    await Promise.resolve();
    await sidebar.updateComplete;
    expect(sidebar.querySelector('[data-session-key="agent:worker:child"]')?.textContent).toContain(
      "Replacement child",
    );
  });

  it("nests the selected child under its parent and reveals the active path", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.describe") {
        return {
          session: {
            key: "agent:worker:child",
            parentSessionKey: "agent:main:parent",
            kind: "direct" as const,
            label: "Selected child",
            updatedAt: 2,
            status: "running" as const,
          },
        };
      }
      return undefined;
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient);
    const harness = createSessionsHarness("main", ["agent:main:parent"]);
    const { sidebar, context } = await mountSidebar(gateway, harness.sessions);
    harness.publishList({
      result: {
        ts: 2,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:main:parent",
            kind: "direct",
            label: "Parent task",
            updatedAt: 1,
            childSessions: ["agent:worker:child"],
          },
        ],
      },
    });
    context.agentSelection.state.selectedId = "worker";
    context.agentSelection.state.scopeId = "worker";
    (sidebar as unknown as { activeRouteId: string }).activeRouteId = "chat";
    sidebar.sessionKey = "agent:worker:child";
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("sessions.describe", {
        key: "agent:worker:child",
      }),
    );
    await vi.waitFor(() =>
      expect(sidebar.querySelectorAll('[data-session-key="agent:worker:child"]')).toHaveLength(1),
    );
    await vi.waitFor(() => expect(harness.list).toHaveBeenCalledOnce());

    expect(sidebar.querySelectorAll(".sidebar-recent-session")).toHaveLength(2);
    expect(sidebar.querySelectorAll('[data-session-key="agent:worker:child"]')).toHaveLength(1);
    expect(
      sidebar
        .querySelector('[data-child-session-toggle="agent:main:parent"]')
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      sidebar
        .querySelector('[data-session-key="agent:worker:child"]')
        ?.classList.contains("sidebar-recent-session--active"),
    ).toBe(true);

    const toggle = sidebar.querySelector<HTMLButtonElement>(
      '[data-child-session-toggle="agent:main:parent"]',
    );
    toggle?.click();
    await sidebar.updateComplete;
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(sidebar.querySelector('[data-session-key="agent:worker:child"]')).toBeNull();

    sidebar.sessionKey = "agent:main:parent";
    await sidebar.updateComplete;
    sidebar.sessionKey = "agent:worker:child";
    await vi.waitFor(() =>
      expect(sidebar.querySelector('[data-session-key="agent:worker:child"]')).not.toBeNull(),
    );
  });

  it("retries a failed child load after collapsing and reopening the parent", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", ["agent:main:parent"]);
    harness.list.mockRejectedValueOnce(new Error("temporary list failure")).mockResolvedValueOnce({
      ts: 2,
      path: "",
      count: 1,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [
        {
          key: "agent:worker:child",
          spawnedBy: "agent:main:parent",
          kind: "direct",
          label: "Recovered child",
          updatedAt: 2,
        },
      ],
    });
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    harness.publishList({
      result: {
        ts: 2,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:main:parent",
            kind: "direct",
            updatedAt: 1,
            childSessions: ["agent:worker:child"],
          },
        ],
      },
    });
    await sidebar.updateComplete;
    sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]")?.click();
    await vi.waitFor(() => expect(harness.list).toHaveBeenCalledOnce());

    sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]")?.click();
    await sidebar.updateComplete;
    sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]")?.click();
    await vi.waitFor(() => expect(harness.list).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(sidebar.textContent).toContain("Recovered child"));
  });

  it("restores a directly opened child whose parent is outside the root page", async () => {
    const request = vi.fn(async (_method: string, params: { key: string }) => ({
      session:
        params.key === "agent:worker:child"
          ? {
              key: "agent:worker:child",
              spawnedBy: "agent:main:hidden-parent",
              kind: "direct" as const,
              label: "Selected child",
              updatedAt: 3,
            }
          : {
              key: "agent:main:hidden-parent",
              kind: "direct" as const,
              label: "Hidden parent",
              updatedAt: 2,
              childSessions: ["agent:worker:child"],
            },
    }));
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient);
    const harness = createSessionsHarness("main", ["agent:main:other"]);
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    (sidebar as unknown as { activeRouteId: string }).activeRouteId = "chat";
    sidebar.sessionKey = "agent:worker:child";

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(sidebar.querySelector('[data-session-key="agent:worker:child"]')).not.toBeNull(),
    );
    expect(
      sidebar.querySelector('[data-session-key="agent:main:hidden-parent"]')?.textContent,
    ).toContain("Hidden parent");
  });

  it("keeps a completed child load when direct-lineage discovery finishes later", async () => {
    const described = deferred<{ session: SessionsListResult["sessions"][number] }>();
    const request = vi.fn(() => described.promise);
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient);
    const harness = createSessionsHarness("main", ["agent:main:parent"]);
    harness.list.mockResolvedValue({
      ts: 2,
      path: "",
      count: 2,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [
        {
          key: "agent:worker:child",
          spawnedBy: "agent:main:parent",
          kind: "direct",
          label: "Selected child",
          updatedAt: 4,
          status: "done",
        },
        {
          key: "agent:worker:sibling",
          spawnedBy: "agent:main:parent",
          kind: "direct",
          label: "Loaded sibling",
          updatedAt: 2,
        },
      ],
    });
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    harness.publishList({
      result: {
        ts: 2,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:main:parent",
            kind: "direct",
            updatedAt: 1,
            childSessions: ["agent:worker:child", "agent:worker:sibling"],
          },
        ],
      },
    });
    (sidebar as unknown as { activeRouteId: string }).activeRouteId = "chat";
    sidebar.sessionKey = "agent:worker:child";
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]")?.click();
    await vi.waitFor(() => expect(harness.list).toHaveBeenCalledOnce());

    described.resolve({
      session: {
        key: "agent:worker:child",
        spawnedBy: "agent:main:parent",
        kind: "direct",
        label: "Selected child",
        updatedAt: 3,
        status: "running",
      },
    });
    await vi.waitFor(() =>
      expect(sidebar.querySelectorAll(".sidebar-recent-session--child")).toHaveLength(2),
    );
    expect(sidebar.textContent).toContain("Loaded sibling");
    expect(
      sidebar.querySelector('[data-session-key="agent:worker:child"] [aria-label="Done"]'),
    ).not.toBeNull();
  });

  it("keeps a selected child reachable when its parent is outside the loaded window", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", ["agent:main:child"]);
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    harness.publishList({
      result: {
        ts: 2,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:main:child",
            spawnedBy: "agent:main:missing-parent",
            kind: "direct",
            label: "Reachable orphan",
            updatedAt: 2,
            status: "done",
          },
        ],
      },
    });
    (sidebar as unknown as { activeRouteId: string }).activeRouteId = "chat";
    sidebar.sessionKey = "agent:main:child";
    await sidebar.updateComplete;

    const row = sidebar.querySelector('[data-session-key="agent:main:child"]');
    expect(row?.textContent).toContain("Reachable orphan");
    expect(row?.classList.contains("sidebar-recent-session--child")).toBe(false);
  });

  it("opens the footer menu with agent switching and folded-in utilities", async () => {
    const gatewayHarness = createGatewayHarness({} as GatewayBrowserClient);
    const setSessionKey = vi.fn();
    (gatewayHarness.gateway as { setSessionKey: (key: string) => void }).setSessionKey =
      setSessionKey;
    const { sidebar } = await mountSidebar(
      gatewayHarness.gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      TWO_AGENTS,
    );
    const onNavigate = vi.fn();
    sidebar.connected = true;
    sidebar.canPairDevice = true;
    sidebar.onNavigate = onNavigate;
    await sidebar.updateComplete;

    expect(sidebar.querySelector(".sidebar-agent-chip__name")?.textContent?.trim()).toBe("Molty");
    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-chip__main")?.click();
    await sidebar.updateComplete;

    const menu = sidebar.querySelector(".sidebar-agent-menu");
    expect(menu).not.toBeNull();
    expect(menu?.querySelector(".sidebar-pair-mobile")).not.toBeNull();
    expect(menu?.querySelector("openclaw-sidebar-build-chip")).not.toBeNull();
    expect(menu?.querySelector("openclaw-theme-mode-toggle")).not.toBeNull();
    // External help links stay folded into Web Awesome's keyboard-navigable submenu.
    const helpRow = [...(menu?.querySelectorAll<HTMLElement>("wa-dropdown-item") ?? [])].find(
      (row) => row.textContent?.includes("Help"),
    );
    await (helpRow as (HTMLElement & { updateComplete?: Promise<unknown> }) | undefined)
      ?.updateComplete;
    expect(helpRow?.getAttribute("aria-haspopup")).toBe("menu");
    helpRow?.click();
    await sidebar.updateComplete;

    const linkHrefs = [
      ...(menu?.querySelectorAll('wa-dropdown-item[slot="submenu"] a[href]') ?? []),
    ].map((link) => link.getAttribute("href"));
    expect(linkHrefs).toEqual([
      "https://docs.openclaw.ai",
      "https://docs.openclaw.ai/help",
      "https://discord.gg/clawd",
      "https://docs.openclaw.ai/releases",
    ]);
    const openExternal = vi.spyOn(window, "open").mockReturnValue(null);
    menu?.querySelector<HTMLElement>('wa-dropdown-item[slot="submenu"]')?.click();
    expect(openExternal).toHaveBeenCalledWith(
      "https://docs.openclaw.ai/",
      "_blank",
      "noopener,noreferrer",
    );
    openExternal.mockRestore();
    await sidebar.updateComplete;

    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-chip__main")?.click();
    await sidebar.updateComplete;
    const reopenedMenu = sidebar.querySelector(".sidebar-agent-menu");

    const agentRows = [
      ...(reopenedMenu?.querySelectorAll('wa-dropdown-item[type="checkbox"]') ?? []),
    ];
    expect(agentRows).toHaveLength(2);
    expect(reopenedMenu?.querySelector(".sidebar-agent-menu__new")).toBeNull();
    const switchMenu = reopenedMenu;
    const researchRow = [
      ...(switchMenu?.querySelectorAll<HTMLElement>('wa-dropdown-item[type="checkbox"]') ?? []),
    ].find((row) => row.textContent?.includes("research"));
    expect(researchRow).toBeDefined();
    switchMenu?.dispatchEvent(
      new CustomEvent("wa-select", { detail: { item: researchRow }, bubbles: true }),
    );
    await sidebar.updateComplete;

    // No cached sessions for the other agent: resume falls back to its main key.
    expect(setSessionKey).toHaveBeenCalledWith("agent:research:main");
    expect(onNavigate).toHaveBeenCalledWith("chat", {
      search: "?session=agent%3Aresearch%3Amain",
    });
    expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
  });

  it("navigates to the agents settings page with the active agent preselected", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      TWO_AGENTS,
    );
    const onNavigate = vi.fn();
    sidebar.connected = true;
    sidebar.onNavigate = onNavigate;
    await sidebar.updateComplete;

    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-chip__main")?.click();
    await sidebar.updateComplete;
    const settingsRow = [
      ...sidebar.querySelectorAll<HTMLElement>(".sidebar-agent-menu wa-dropdown-item"),
    ].find((row) => row.textContent?.includes("Agent settings"));
    expect(settingsRow).toBeDefined();
    settingsRow?.click();
    await sidebar.updateComplete;
    expect(onNavigate).toHaveBeenCalledWith("agents", { search: "?agent=main" });
    expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
  });

  const manyAgents = (count: number) =>
    ({
      defaultId: "agent-1",
      mainKey: "main",
      scope: "agent",
      agents: Array.from({ length: count }, (_, index) => ({ id: `agent-${index + 1}` })),
    }) as AgentsListResult;

  it("keeps the plain roster without a filter at ten agents or fewer", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("agent-1", ["agent:agent-1:main"]),
      "panel",
      manyAgents(10),
    );
    sidebar.connected = true;
    await sidebar.updateComplete;

    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-chip__main")?.click();
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-agent-menu__filter")).toBeNull();
    expect(
      sidebar.querySelectorAll(
        ".sidebar-agent-menu wa-dropdown-item.sidebar-agent-menu__agent-switch",
      ),
    ).toHaveLength(10);
  });

  it("shows pinned agents plus filter for large rosters and filters on input", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar, context } = await mountSidebar(
      gateway,
      createSessions("agent-1", ["agent:agent-1:main"]),
      "panel",
      manyAgents(12),
    );
    sidebar.connected = true;
    sidebar.pinnedAgentIds = ["agent-7", "agent-12"];
    // Two agents pinned while a third is active: the menu must keep all three.
    context.agentSelection.state.selectedId = "agent-1";
    await sidebar.updateComplete;

    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-chip__main")?.click();
    await sidebar.updateComplete;
    const input = sidebar.querySelector<HTMLInputElement>(".sidebar-agent-menu__filter input");
    expect(input).not.toBeNull();
    // Pinned agents plus the active one; pinned sort first.
    const labels = () =>
      [
        ...sidebar.querySelectorAll(
          ".sidebar-agent-menu wa-dropdown-item.sidebar-agent-menu__agent-switch .sidebar-customize-menu__text",
        ),
      ].map((el) => el.textContent?.trim());
    expect(labels()).toEqual(["agent-7", "agent-12", "agent-1"]);

    if (!input) {
      throw new Error("Expected agent menu filter input");
    }
    const dropdown = sidebar.querySelector("wa-dropdown");
    const onDropdownKeydown = vi.fn();
    dropdown?.addEventListener("keydown", onDropdownKeydown);
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(onDropdownKeydown).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      sidebar.querySelector(
        ".sidebar-agent-menu wa-dropdown-item.sidebar-agent-menu__agent-switch",
      ),
    );
    onDropdownKeydown.mockClear();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(onDropdownKeydown).toHaveBeenCalledOnce();
    onDropdownKeydown.mockClear();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(onDropdownKeydown).not.toHaveBeenCalled();

    input.value = "agent-11";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sidebar.updateComplete;
    expect(labels()).toEqual(["agent-11"]);
  });

  it("falls back to the first ten agents when nothing is pinned", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("agent-1", ["agent:agent-1:main"]),
      "panel",
      manyAgents(12),
    );
    sidebar.connected = true;
    await sidebar.updateComplete;

    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-chip__main")?.click();
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-agent-menu__filter")).not.toBeNull();
    expect(
      sidebar.querySelectorAll(
        ".sidebar-agent-menu wa-dropdown-item.sidebar-agent-menu__agent-switch",
      ),
    ).toHaveLength(10);
  });

  it("ignores stale pins when choosing the large-roster fallback", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("agent-1", ["agent:agent-1:main"]),
      "panel",
      manyAgents(12),
    );
    sidebar.connected = true;
    sidebar.pinnedAgentIds = ["deleted-agent"];
    await sidebar.updateComplete;

    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-chip__main")?.click();
    await sidebar.updateComplete;
    expect(
      sidebar.querySelectorAll(
        ".sidebar-agent-menu wa-dropdown-item.sidebar-agent-menu__agent-switch",
      ),
    ).toHaveLength(10);
  });

  it("keeps an active agent outside the first ten reachable when nothing is pinned", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar, context } = await mountSidebar(
      gateway,
      createSessions("agent-12", ["agent:agent-12:main"]),
      "panel",
      manyAgents(12),
    );
    context.agentSelection.state.selectedId = "agent-12";
    context.agentSelection.state.scopeId = "agent-12";
    sidebar.sessionKey = "agent:agent-12:main";
    sidebar.connected = true;
    await sidebar.updateComplete;

    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-chip__main")?.click();
    await sidebar.updateComplete;
    const rows = [
      ...sidebar.querySelectorAll(
        ".sidebar-agent-menu wa-dropdown-item.sidebar-agent-menu__agent-switch",
      ),
    ];
    expect(rows).toHaveLength(10);
    expect(rows.some((row) => row.textContent?.includes("agent-12"))).toBe(true);
  });
});

describe("AppSidebar session scroll fade", () => {
  it("shows fades only toward additional session content", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    const scroller = sidebar.querySelector<HTMLElement>(".sidebar-recent-sessions");
    if (!scroller) {
      throw new Error("Expected sidebar session scroller");
    }

    let scrollHeight = 100;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    });

    const expectScrollState = async (
      scrollTop: number,
      expected: "none" | "top" | "middle" | "bottom",
    ) => {
      scroller.scrollTop = scrollTop;
      scroller.dispatchEvent(new Event("scroll"));
      await sidebar.updateComplete;
      expect(scroller.classList.contains(`sidebar-recent-sessions--scroll-${expected}`)).toBe(true);
    };

    await expectScrollState(0, "none");
    scrollHeight = 300;
    await expectScrollState(0, "top");
    await expectScrollState(80, "middle");
    await expectScrollState(200, "bottom");
  });
});

describe("AppSidebar session catalog pagination", () => {
  const catalogPage = (
    sessions: Array<{ threadId: string; name: string }>,
    nextCursor?: string,
    catalogId = "codex",
  ): SessionsCatalogListResult => ({
    catalogs: [
      {
        id: catalogId,
        label: catalogId === "codex" ? "Codex" : "Claude",
        capabilities: { continueSession: true, archive: true },
        hosts: [
          {
            hostId: "gateway:local",
            label: "Local Codex",
            kind: "gateway" as const,
            connected: true,
            sessions: sessions.map((session) => ({
              ...session,
              status: "idle",
              archived: false,
              canContinue: true,
              canArchive: true,
            })),
            ...(nextCursor ? { nextCursor } : {}),
          },
        ],
      },
    ],
  });

  const catalogErrorPage = (message: string, catalogId = "codex"): SessionsCatalogListResult => ({
    catalogs: [
      {
        id: catalogId,
        label: catalogId === "codex" ? "Codex" : "Claude",
        capabilities: { continueSession: true, archive: true },
        hosts: [
          {
            hostId: "gateway:local",
            label: "Unavailable host",
            kind: "gateway",
            connected: false,
            sessions: [],
            error: { code: "unavailable", message },
          },
        ],
      },
    ],
  });

  it("opens a catalog-targeted draft from its new-session action", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("research", ["agent:research:main"]),
      "panel",
      {
        defaultId: "main",
        mainKey: "agent:main:main",
        scope: "global",
        agents: [
          { id: "main", name: "Main" },
          { id: "research", name: "Research" },
        ],
      },
    );
    const onOpenNewSession = vi.fn();
    sidebar.connected = true;
    sidebar.onOpenNewSession = onOpenNewSession;
    sidebar.sessionCatalogs = [
      {
        id: "claude",
        label: "Claude Code",
        capabilities: {
          continueSession: true,
          archive: false,
          createSession: { model: "anthropic/claude-opus-4-8" },
        },
        hosts: [],
      },
    ];
    await sidebar.updateComplete;

    const button = sidebar.querySelector<HTMLButtonElement>(".sidebar-session-catalog-new");
    expect(button?.getAttribute("aria-label")).toBe("New session — Claude Code");
    button?.click();

    expect(onOpenNewSession).toHaveBeenCalledWith("research", { catalogId: "claude" });
  });

  it.each([
    { id: "claude", label: "Claude Code" },
    { id: "codex", label: "Codex" },
  ])("groups $label catalog rows by their owning host", async ({ id, label }) => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    sidebar.sessionCatalogs = [
      {
        id,
        label,
        capabilities: { continueSession: true, archive: false },
        hosts: [
          {
            hostId: "gateway:local",
            label: "Gateway Mac",
            kind: "gateway",
            connected: true,
            sessions: [
              {
                threadId: "local-thread",
                name: "Local plan",
                status: "stored",
                archived: false,
                canContinue: true,
                canArchive: false,
              },
            ],
          },
          {
            hostId: "node:offline",
            label: "Offline Node",
            kind: "node",
            connected: false,
            nodeId: "offline",
            sessions: [],
            error: { code: "NODE_OFFLINE", message: "Paired node is offline" },
          },
          {
            hostId: "node:build",
            label: "Build Node",
            kind: "node",
            connected: true,
            nodeId: "build",
            sessions: [
              {
                threadId: "remote-thread",
                name: "Remote review",
                status: "stored",
                archived: false,
                canContinue: false,
                canArchive: false,
              },
            ],
          },
        ],
      },
    ];
    await sidebar.updateComplete;

    const section = sidebar.querySelector(`[data-session-section="catalog:${id}"]`);
    const hostGroups = section?.querySelectorAll<HTMLElement>("[data-session-catalog-host]");
    expect(Array.from(hostGroups ?? []).map((host) => host.dataset.sessionCatalogHost)).toEqual([
      "gateway:local",
      "node:build",
    ]);
    const local = section?.querySelector('[data-session-catalog-host="gateway:local"]');
    const remote = section?.querySelector('[data-session-catalog-host="node:build"]');
    expect(local?.textContent).toContain("Gateway Mac");
    expect(local?.textContent).toContain("Local plan");
    expect(local?.textContent).not.toContain("Remote review");
    expect(remote?.textContent).toContain("Build Node");
    expect(remote?.textContent).toContain("Remote review");
    expect(remote?.textContent).not.toContain("Local plan");
    expect(section?.textContent).not.toContain("Offline Node");
  });

  it("shows a catalog-owned OpenClaw session only in its catalog section", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const backingSessionKey = "agent:main:claude-bound";
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("main", ["agent:main:main", backingSessionKey]),
      "panel",
      {
        defaultId: "main",
        mainKey: "agent:main:main",
        scope: "global",
        agents: [
          { id: "main", name: "Main" },
          { id: "research", name: "Research" },
        ],
      },
    );
    sidebar.sessionCatalogs = [
      {
        id: "claude",
        label: "Claude Code",
        capabilities: { continueSession: true, archive: false },
        hosts: [
          {
            hostId: "gateway:local",
            label: "Local Claude",
            kind: "gateway",
            connected: true,
            sessions: [
              {
                threadId: "claude-thread",
                name: "Claude session",
                status: "stored",
                archived: false,
                openClawSessionKey: backingSessionKey,
                canContinue: true,
                canArchive: false,
              },
            ],
          },
        ],
      },
    ];
    const backingRows = (sidebar.sessionsResult?.sessions ?? []).map((row) =>
      row.key === backingSessionKey ? Object.assign({}, row, { unread: true }) : row,
    );
    sidebar.sessionsResult = { ...sidebar.sessionsResult!, sessions: backingRows };
    sidebar.sessionRowsByAgent = { main: backingRows };
    await sidebar.updateComplete;

    expect(
      sidebar.querySelectorAll(
        `.sidebar-agent-section__body [data-session-key="${backingSessionKey}"]`,
      ),
    ).toHaveLength(0);
    expect(
      sidebar.querySelectorAll(
        `[data-session-section="catalog:claude"] [data-session-key="${backingSessionKey}"]`,
      ),
    ).toHaveLength(1);
    expect(sidebar.querySelectorAll(`[data-session-key="${backingSessionKey}"]`)).toHaveLength(1);
    const catalogSection = sidebar.querySelector('[data-session-section="catalog:claude"]');
    const linkedRow = catalogSection?.querySelector<HTMLElement>(
      `[data-session-key="${backingSessionKey}"]`,
    );
    expect(linkedRow?.getAttribute("draggable")).toBe("true");
    expect(linkedRow?.querySelector('[data-sidebar-session-pin="true"]')).not.toBeNull();
    expect(linkedRow?.querySelector('[data-session-menu="true"]')).not.toBeNull();
    linkedRow?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await sidebar.updateComplete;
    const linkedMenu = sidebar.querySelector<TestSessionMenu>("openclaw-session-menu");
    await linkedMenu?.updateComplete;
    expect(linkedMenu?.querySelector('[data-shortcut="a"]')).not.toBeNull();
    expect(linkedMenu?.querySelector('[data-shortcut="d"]')).not.toBeNull();
    expect(
      catalogSection?.querySelector(
        `[data-session-key="${backingSessionKey}"] .session-unread-dot`,
      ),
    ).not.toBeNull();
    expect(
      catalogSection?.querySelector(".sidebar-recent-sessions__head .session-unread-dot"),
    ).not.toBeNull();

    const runningRows = backingRows.map((row) =>
      row.key === backingSessionKey
        ? Object.assign({}, row, { unread: false, hasActiveRun: true })
        : row,
    );
    sidebar.sessionsResult = { ...sidebar.sessionsResult, sessions: runningRows };
    sidebar.sessionRowsByAgent = { main: runningRows };
    await sidebar.updateComplete;

    const runningCatalogSection = sidebar.querySelector('[data-session-section="catalog:claude"]');
    expect(
      runningCatalogSection?.querySelector(
        `[data-session-key="${backingSessionKey}"].session-row-host--running .session-run-spinner`,
      ),
    ).not.toBeNull();
    expect(
      runningCatalogSection?.querySelector(".sidebar-recent-sessions__head .session-run-spinner"),
    ).not.toBeNull();
  });

  it("renders catalog groups inside the shared sessions scroller", async () => {
    vi.useFakeTimers();
    try {
      const request = vi
        .fn()
        .mockResolvedValue(catalogPage([{ threadId: "thread-1", name: "Newest" }]));
      const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
      gateway.publish({
        hello: {
          features: { methods: ["sessions.catalog.list"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      const { sidebar } = await mountSidebar(
        gateway.gateway,
        createSessions("main", ["agent:main:main"]),
      );
      sidebar.connected = true;
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;

      // One scroll region: catalog groups live inside the sessions scroller.
      // Sibling scroll-less sections flex-squeeze and paint over each other.
      expect(
        sidebar.querySelector('.sidebar-recent-sessions [data-session-section="catalog:codex"]'),
      ).not.toBeNull();
      expect(sidebar.querySelectorAll(".sidebar-sessions")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes catalog creation capability for the expanded agent", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn().mockResolvedValue(catalogPage([]));
      const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
      gateway.publish({
        hello: {
          features: { methods: ["sessions.catalog.list"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      const { sidebar, context } = await mountSidebar(
        gateway.gateway,
        createSessions("main", ["agent:main:main"]),
        "panel",
        {
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
          agents: [{ id: "main" }, { id: "research" }],
        },
      );
      sidebar.connected = true;
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);

      expect(request).toHaveBeenNthCalledWith(1, "sessions.catalog.list", {
        agentId: "main",
        limitPerHost: 40,
      });

      const selection = context.agentSelection.state as {
        selectedId: string | null;
        scopeId: string | null;
      };
      selection.selectedId = "research";
      selection.scopeId = "research";
      sidebar.requestUpdate();
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);

      expect(request).toHaveBeenNthCalledWith(2, "sessions.catalog.list", {
        agentId: "research",
        limitPerHost: 40,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides catalog groups that have no sessions", async () => {
    vi.useFakeTimers();
    try {
      const codex = catalogPage([]);
      const claude = catalogPage([], undefined, "claude");
      const request = vi.fn().mockResolvedValue({
        catalogs: [...codex.catalogs, ...claude.catalogs],
      });
      const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
      gateway.publish({
        hello: {
          features: { methods: ["sessions.catalog.list"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      const { sidebar } = await mountSidebar(
        gateway.gateway,
        createSessions("main", ["agent:main:main"]),
      );
      sidebar.connected = true;
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;

      expect(sidebar.querySelector('[data-session-section="catalog:codex"]')).toBeNull();
      expect(sidebar.querySelector('[data-session-section="catalog:claude"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows actionable catalog errors once and hides empty offline hosts", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn().mockResolvedValue({
        catalogs: [
          {
            id: "codex",
            label: "Codex",
            capabilities: { continueSession: true, archive: true },
            hosts: [],
            error: { code: "unavailable", message: "Codex provider unavailable" },
          },
          {
            id: "claude",
            label: "Claude",
            capabilities: {
              continueSession: true,
              archive: true,
              createSession: { model: "anthropic/claude-opus-4-8" },
            },
            hosts: [
              {
                hostId: "node:offline-a",
                label: "Offline A",
                kind: "node",
                connected: false,
                sessions: [],
                error: { code: "NODE_OFFLINE", message: "Paired node is offline" },
              },
              {
                hostId: "node:offline-b",
                label: "Offline B",
                kind: "node",
                connected: false,
                sessions: [],
                error: { code: "NODE_OFFLINE", message: "Paired node is offline" },
              },
              {
                hostId: "node:registry",
                label: "Paired nodes",
                kind: "node",
                connected: false,
                sessions: [],
                error: {
                  code: "NODE_LIST_FAILED",
                  message: "Paired nodes could not be listed",
                },
              },
              {
                hostId: "node:registry-duplicate",
                label: "Paired nodes",
                kind: "node",
                connected: false,
                sessions: [],
                error: {
                  code: "NODE_LIST_FAILED",
                  message: "Paired nodes could not be listed",
                },
              },
            ],
          },
        ],
      });
      const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
      gateway.publish({
        hello: {
          features: { methods: ["sessions.catalog.list"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      const { sidebar } = await mountSidebar(
        gateway.gateway,
        createSessions("main", ["agent:main:main"]),
      );
      sidebar.connected = true;
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;

      const codexSection = sidebar.querySelector('[data-session-section="catalog:codex"]');
      const claudeSection = sidebar.querySelector('[data-session-section="catalog:claude"]');
      expect(codexSection).not.toBeNull();
      expect(claudeSection).not.toBeNull();
      expect(codexSection?.querySelector(".sidebar-session-group-count")?.textContent).not.toBe(
        "0",
      );
      expect(claudeSection?.querySelector(".sidebar-session-group-count")?.textContent).not.toBe(
        "0",
      );
      expect(
        codexSection?.querySelector(".sidebar-session-group-toggle")?.getAttribute("aria-label"),
      ).toContain("[unavailable] Codex provider unavailable");
      expect(
        claudeSection?.querySelector(".sidebar-session-group-toggle")?.getAttribute("aria-label"),
      ).toContain("[NODE_LIST_FAILED] Paired nodes could not be listed");
      const claudeTitle =
        claudeSection?.querySelector(".sidebar-session-group-toggle")?.getAttribute("title") ?? "";
      expect(claudeTitle).not.toContain("NODE_OFFLINE");
      expect(claudeTitle.match(/NODE_LIST_FAILED/g)).toHaveLength(1);
      expect(claudeSection?.querySelectorAll("[data-session-catalog-host]")).toHaveLength(0);
      expect(
        codexSection?.querySelector(".sidebar-session-group-toggle")?.getAttribute("title"),
      ).toContain("Settings > Automation > Plugins");
      expect(codexSection?.querySelector('[data-session-catalog-error="codex"]')).not.toBeNull();
      expect(claudeSection?.querySelector('[data-session-catalog-error="claude"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an empty catalog reachable while a later page remains", async () => {
    vi.useFakeTimers();
    try {
      const request = vi
        .fn()
        .mockResolvedValueOnce(catalogPage([], "page-2"))
        .mockResolvedValueOnce(catalogPage([{ threadId: "thread-1", name: "Later session" }]));
      const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
      gateway.publish({
        hello: {
          features: { methods: ["sessions.catalog.list"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      const { sidebar } = await mountSidebar(
        gateway.gateway,
        createSessions("main", ["agent:main:main"]),
      );
      sidebar.connected = true;
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;

      expect(sidebar.querySelector('[data-session-section="catalog:codex"]')).not.toBeNull();
      sidebar.querySelector<HTMLButtonElement>('[data-session-catalog-load-more="codex"]')?.click();
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;
      expect(sidebar.textContent).toContain("Later session");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a rejected load-more request and clears it after a successful retry", async () => {
    vi.useFakeTimers();
    try {
      const request = vi
        .fn()
        .mockResolvedValueOnce(catalogPage([{ threadId: "thread-1", name: "Newest" }], "page-2"))
        .mockRejectedValueOnce(
          new GatewayRequestError({ code: "UNAVAILABLE", message: "Second page unavailable" }),
        )
        .mockResolvedValueOnce(catalogPage([{ threadId: "thread-2", name: "Older" }]));
      const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
      gateway.publish({
        hello: {
          features: { methods: ["sessions.catalog.list"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      const { sidebar } = await mountSidebar(
        gateway.gateway,
        createSessions("main", ["agent:main:main"]),
      );
      sidebar.connected = true;
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;

      const section = () => sidebar.querySelector('[data-session-section="catalog:codex"]');
      const loadMore = () =>
        sidebar.querySelector<HTMLButtonElement>('[data-session-catalog-load-more="codex"]');
      loadMore()?.click();
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;

      expect(section()?.querySelector('[data-session-catalog-error="codex"]')).not.toBeNull();
      expect(
        section()?.querySelector(".sidebar-session-group-toggle")?.getAttribute("aria-label"),
      ).toContain("Second page unavailable");
      expect(sidebar.sessionCatalogs[0]?.error?.code).toBe("UNAVAILABLE");
      expect(sidebar.sessionCatalogs[0]?.hosts[0]?.nextCursor).toBe("page-2");
      expect(loadMore()?.disabled).toBe(false);

      loadMore()?.click();
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;

      expect(request).toHaveBeenNthCalledWith(3, "sessions.catalog.list", {
        agentId: "main",
        catalogId: "codex",
        cursors: { "gateway:local": "page-2" },
      });
      expect(section()?.querySelector('[data-session-catalog-error="codex"]')).toBeNull();
      expect(sidebar.textContent).toContain("Older");
      expect(loadMore()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["catalog", "host"] as const)(
    "preserves the current page while exposing a structured %s load-more error",
    async (errorOwner) => {
      vi.useFakeTimers();
      try {
        const structuredError =
          errorOwner === "catalog"
            ? {
                catalogs: [
                  {
                    id: "codex",
                    label: "Codex",
                    capabilities: { continueSession: true, archive: true },
                    hosts: [],
                    error: { code: "catalog_error", message: "Catalog page failed" },
                  },
                ],
              }
            : catalogErrorPage("Host page failed");
        const request = vi
          .fn()
          .mockResolvedValueOnce(catalogPage([{ threadId: "thread-1", name: "Newest" }], "page-2"))
          .mockResolvedValueOnce(structuredError)
          .mockResolvedValueOnce(catalogPage([{ threadId: "thread-2", name: "Older" }]));
        const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
        gateway.publish({
          hello: {
            features: { methods: ["sessions.catalog.list"] },
          } as ApplicationGatewaySnapshot["hello"],
        });
        const { sidebar } = await mountSidebar(
          gateway.gateway,
          createSessions("main", ["agent:main:main"]),
        );
        sidebar.connected = true;
        await sidebar.updateComplete;
        await vi.advanceTimersByTimeAsync(0);
        await sidebar.updateComplete;

        const loadMore = () =>
          sidebar.querySelector<HTMLButtonElement>('[data-session-catalog-load-more="codex"]');
        loadMore()?.click();
        await vi.advanceTimersByTimeAsync(0);
        await sidebar.updateComplete;

        const section = sidebar.querySelector('[data-session-section="catalog:codex"]');
        expect(section?.querySelector('[data-session-catalog-error="codex"]')).not.toBeNull();
        expect(
          section?.querySelector(".sidebar-session-group-toggle")?.getAttribute("aria-label"),
        ).toContain(errorOwner === "catalog" ? "Catalog page failed" : "Host page failed");
        expect(sidebar.textContent).toContain("Newest");
        expect(sidebar.sessionCatalogs[0]?.hosts[0]?.nextCursor).toBe("page-2");

        loadMore()?.click();
        await vi.advanceTimersByTimeAsync(0);
        await sidebar.updateComplete;
        expect(sidebar.querySelector('[data-session-catalog-error="codex"]')).toBeNull();
        expect(sidebar.textContent).toContain("Older");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("appends host pages and keeps them through the next poll refresh", async () => {
    vi.useFakeTimers();
    try {
      const request = vi
        .fn()
        .mockResolvedValueOnce(catalogPage([{ threadId: "thread-1", name: "Newest" }], "page-2"))
        .mockResolvedValueOnce(
          catalogPage([{ threadId: "thread-2", name: "Stale title" }], "page-3"),
        )
        .mockResolvedValueOnce(
          catalogPage([{ threadId: "thread-1", name: "Newest refreshed" }], "page-2"),
        )
        .mockResolvedValueOnce(
          catalogPage([{ threadId: "thread-2", name: "Current title" }], "page-3"),
        )
        .mockResolvedValueOnce(catalogPage([{ threadId: "thread-3", name: "Oldest" }]));
      const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
      gateway.publish({
        hello: {
          features: { methods: ["sessions.catalog.list"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      const { sidebar } = await mountSidebar(
        gateway.gateway,
        createSessions("main", ["agent:main:main"]),
      );
      sidebar.connected = true;
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;

      const catalogRows = () =>
        sidebar.querySelectorAll('[data-session-section="catalog:codex"] [data-session-key]');
      const loadMore = () =>
        sidebar.querySelector<HTMLButtonElement>('[data-session-catalog-load-more="codex"]');
      expect(catalogRows()).toHaveLength(1);
      loadMore()?.click();
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;

      expect(request).toHaveBeenNthCalledWith(2, "sessions.catalog.list", {
        agentId: "main",
        catalogId: "codex",
        cursors: { "gateway:local": "page-2" },
      });
      expect(catalogRows()).toHaveLength(2);
      expect(sidebar.textContent).toContain("Stale title");

      await vi.advanceTimersByTimeAsync(30_000);
      await sidebar.updateComplete;
      expect(request).toHaveBeenNthCalledWith(3, "sessions.catalog.list", {
        agentId: "main",
        limitPerHost: 40,
      });
      expect(request).toHaveBeenNthCalledWith(4, "sessions.catalog.list", {
        agentId: "main",
        catalogId: "codex",
        cursors: { "gateway:local": "page-2" },
      });
      expect(catalogRows()).toHaveLength(2);
      expect(sidebar.textContent).toContain("Newest refreshed");
      expect(sidebar.textContent).toContain("Current title");
      expect(sidebar.textContent).not.toContain("Stale title");

      loadMore()?.click();
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;
      expect(request).toHaveBeenNthCalledWith(5, "sessions.catalog.list", {
        agentId: "main",
        catalogId: "codex",
        cursors: { "gateway:local": "page-3" },
      });
      expect(catalogRows()).toHaveLength(3);
      expect(sidebar.textContent).toContain("Oldest");
      expect(loadMore()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards a load-more response after a poll replaces its cursor", async () => {
    vi.useFakeTimers();
    try {
      let resolveStalePage!: (value: ReturnType<typeof catalogPage>) => void;
      const stalePage = new Promise<ReturnType<typeof catalogPage>>((resolve) => {
        resolveStalePage = resolve;
      });
      const request = vi
        .fn()
        .mockResolvedValueOnce(catalogPage([{ threadId: "thread-1", name: "Initial" }], "page-2"))
        .mockReturnValueOnce(stalePage)
        .mockResolvedValueOnce(
          catalogPage([{ threadId: "thread-1", name: "Polled" }], "replacement-page"),
        )
        .mockResolvedValueOnce(catalogPage([{ threadId: "thread-3", name: "Replacement" }]));
      const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
      gateway.publish({
        hello: {
          features: { methods: ["sessions.catalog.list"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      const { sidebar } = await mountSidebar(
        gateway.gateway,
        createSessions("main", ["agent:main:main"]),
      );
      sidebar.connected = true;
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;

      const loadMore = () =>
        sidebar.querySelector<HTMLButtonElement>('[data-session-catalog-load-more="codex"]');
      loadMore()?.click();
      await vi.advanceTimersByTimeAsync(30_000);
      await sidebar.updateComplete;
      expect(sidebar.textContent).toContain("Polled");

      resolveStalePage(catalogPage([{ threadId: "thread-2", name: "Stale page" }], "page-3"));
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;
      expect(sidebar.textContent).not.toContain("Stale page");

      loadMore()?.click();
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;
      expect(request).toHaveBeenNthCalledWith(4, "sessions.catalog.list", {
        agentId: "main",
        catalogId: "codex",
        cursors: { "gateway:local": "replacement-page" },
      });
      expect(sidebar.textContent).toContain("Replacement");
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards a load-more response after a poll refreshes the same cursor", async () => {
    vi.useFakeTimers();
    try {
      let resolveStalePage!: (value: SessionsCatalogListResult) => void;
      const stalePage = new Promise<SessionsCatalogListResult>((resolve) => {
        resolveStalePage = resolve;
      });
      const request = vi
        .fn()
        .mockResolvedValueOnce(catalogPage([{ threadId: "thread-1", name: "Initial" }], "page-2"))
        .mockReturnValueOnce(stalePage)
        .mockResolvedValueOnce(catalogPage([{ threadId: "thread-1", name: "Polled" }], "page-2"));
      const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
      gateway.publish({
        hello: {
          features: { methods: ["sessions.catalog.list"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      const { sidebar } = await mountSidebar(
        gateway.gateway,
        createSessions("main", ["agent:main:main"]),
      );
      sidebar.connected = true;
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;

      sidebar.querySelector<HTMLButtonElement>('[data-session-catalog-load-more="codex"]')?.click();
      await vi.advanceTimersByTimeAsync(30_000);
      await sidebar.updateComplete;
      expect(sidebar.textContent).toContain("Polled");

      resolveStalePage(catalogPage([{ threadId: "thread-2", name: "Stale page" }], "page-3"));
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;
      expect(sidebar.textContent).not.toContain("Stale page");
      expect(sidebar.sessionCatalogs[0]?.hosts[0]?.nextCursor).toBe("page-2");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["first page", "expanded page"])(
    "keeps expanded rows while exposing a structured error from the %s refresh",
    async (errorPage) => {
      vi.useFakeTimers();
      try {
        const request = vi
          .fn()
          .mockResolvedValueOnce(catalogPage([{ threadId: "thread-1", name: "Newest" }], "page-2"))
          .mockResolvedValueOnce(catalogPage([{ threadId: "thread-2", name: "Older" }]))
          .mockResolvedValueOnce(
            errorPage === "first page"
              ? catalogErrorPage("Base refresh failed")
              : catalogPage([{ threadId: "thread-1", name: "Newest" }], "page-2"),
          );
        if (errorPage === "expanded page") {
          request.mockResolvedValueOnce(catalogErrorPage("Page refresh failed"));
        }
        const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
        gateway.publish({
          hello: {
            features: { methods: ["sessions.catalog.list"] },
          } as ApplicationGatewaySnapshot["hello"],
        });
        const { sidebar } = await mountSidebar(
          gateway.gateway,
          createSessions("main", ["agent:main:main"]),
        );
        sidebar.connected = true;
        await sidebar.updateComplete;
        await vi.advanceTimersByTimeAsync(0);
        await sidebar.updateComplete;

        sidebar
          .querySelector<HTMLButtonElement>('[data-session-catalog-load-more="codex"]')
          ?.click();
        await vi.advanceTimersByTimeAsync(0);
        await sidebar.updateComplete;
        expect(sidebar.sessionCatalogs[0]?.hosts[0]?.sessions).toHaveLength(2);

        await vi.advanceTimersByTimeAsync(30_000);
        await sidebar.updateComplete;
        const host = sidebar.sessionCatalogs[0]?.hosts[0];
        expect(host?.sessions.map((session) => session.threadId)).toEqual(["thread-1", "thread-2"]);
        expect(host?.connected).toBe(false);
        expect(host?.label).toBe("Unavailable host");
        expect(host?.error?.message).toBe(
          errorPage === "first page" ? "Base refresh failed" : "Page refresh failed",
        );
        expect(host?.nextCursor).toBeUndefined();
        expect(sidebar.querySelector('[data-session-catalog-load-more="codex"]')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("keeps a reappearing host's first page when replaying its saved depth fails", async () => {
    vi.useFakeTimers();
    try {
      const emptyCatalog: SessionsCatalogListResult = {
        catalogs: [
          {
            id: "codex",
            label: "Codex",
            capabilities: { continueSession: true, archive: true },
            hosts: [],
          },
        ],
      };
      const request = vi
        .fn()
        .mockResolvedValueOnce(catalogPage([{ threadId: "thread-1", name: "Initial" }], "page-2"))
        .mockResolvedValueOnce(catalogPage([{ threadId: "thread-2", name: "Older" }]))
        .mockResolvedValueOnce(emptyCatalog)
        .mockResolvedValueOnce(
          catalogPage([{ threadId: "thread-3", name: "Reappeared" }], "page-2"),
        )
        .mockResolvedValueOnce(catalogErrorPage("Replay failed"));
      const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
      gateway.publish({
        hello: {
          features: { methods: ["sessions.catalog.list"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      const { sidebar } = await mountSidebar(
        gateway.gateway,
        createSessions("main", ["agent:main:main"]),
      );
      sidebar.connected = true;
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;
      sidebar.querySelector<HTMLButtonElement>('[data-session-catalog-load-more="codex"]')?.click();
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;

      await vi.advanceTimersByTimeAsync(30_000);
      await sidebar.updateComplete;
      expect(sidebar.sessionCatalogs[0]?.hosts).toEqual([]);

      await vi.advanceTimersByTimeAsync(30_000);
      await sidebar.updateComplete;
      const host = sidebar.sessionCatalogs[0]?.hosts[0];
      expect(host?.sessions.map((session) => session.threadId)).toEqual(["thread-3"]);
      expect(host?.nextCursor).toBe("page-2");
      expect(host?.connected).toBe(false);
      expect(host?.error?.message).toBe("Replay failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies concurrent load-more responses for different catalogs", async () => {
    vi.useFakeTimers();
    try {
      let resolveCodex!: (value: SessionsCatalogListResult) => void;
      let resolveClaude!: (value: SessionsCatalogListResult) => void;
      const codexPage = new Promise<SessionsCatalogListResult>((resolve) => {
        resolveCodex = resolve;
      });
      const claudePage = new Promise<SessionsCatalogListResult>((resolve) => {
        resolveClaude = resolve;
      });
      const initialCodex = catalogPage(
        [{ threadId: "codex-1", name: "Codex newest" }],
        "codex-page-2",
      );
      const initialClaude = catalogPage(
        [{ threadId: "claude-1", name: "Claude newest" }],
        "claude-page-2",
        "claude",
      );
      const request = vi
        .fn()
        .mockResolvedValueOnce({
          catalogs: [...initialCodex.catalogs, ...initialClaude.catalogs],
        })
        .mockReturnValueOnce(codexPage)
        .mockReturnValueOnce(claudePage);
      const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
      gateway.publish({
        hello: {
          features: { methods: ["sessions.catalog.list"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      const { sidebar } = await mountSidebar(
        gateway.gateway,
        createSessions("main", ["agent:main:main"]),
      );
      sidebar.connected = true;
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;

      sidebar.querySelector<HTMLButtonElement>('[data-session-catalog-load-more="codex"]')?.click();
      sidebar
        .querySelector<HTMLButtonElement>('[data-session-catalog-load-more="claude"]')
        ?.click();
      resolveCodex(catalogPage([{ threadId: "codex-2", name: "Codex older" }]));
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;
      resolveClaude(
        catalogPage([{ threadId: "claude-2", name: "Claude older" }], undefined, "claude"),
      );
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;

      expect(
        sidebar.sessionCatalogs
          .find((catalog) => catalog.id === "codex")
          ?.hosts[0]?.sessions.map((session) => session.threadId),
      ).toEqual(["codex-1", "codex-2"]);
      expect(
        sidebar.sessionCatalogs
          .find((catalog) => catalog.id === "claude")
          ?.hosts[0]?.sessions.map((session) => session.threadId),
      ).toEqual(["claude-1", "claude-2"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AppSidebar session pagination", () => {
  it("does not show pagination controls at the ten-session boundary", async () => {
    const keys = [
      "agent:main:main",
      ...Array.from({ length: 9 }, (_, index) => `agent:main:session-${index + 1}`),
    ];
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", keys));

    expect(sidebar.querySelectorAll(".sidebar-recent-session")).toHaveLength(10);
    expect(sidebar.querySelector(".sidebar-session-pagination")).toBeNull();
  });

  it("keeps active and pinned sessions visible beyond the first page", async () => {
    const pinnedKey = "agent:main:pinned";
    const keys = [
      ...Array.from({ length: 10 }, (_, index) => `agent:main:session-${index + 1}`),
      pinnedKey,
      "agent:main:main",
    ];
    const sessions = createSessionsHarness("main", keys);
    const result = sessions.sessions.state.result;
    expect(result).not.toBeNull();
    if (!result) {
      return;
    }
    const pinnedIndex = result.sessions.findIndex((row) => row.key === pinnedKey);
    const pinned = result.sessions[pinnedIndex];
    expect(pinned).toBeDefined();
    if (!pinned) {
      return;
    }
    const sessionRows = [...result.sessions];
    sessionRows[pinnedIndex] = { ...pinned, pinned: true };
    sessions.publish({
      result: {
        ...result,
        sessions: sessionRows,
      },
    });
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, sessions.sessions);

    expect(sidebar.querySelectorAll(".sidebar-recent-session")).toHaveLength(10);
    expect(sidebar.querySelector(`[data-session-key="${pinnedKey}"]`)).not.toBeNull();
    expect(sidebar.querySelector('[data-session-key="agent:main:main"]')).not.toBeNull();
    expect(sidebar.querySelector('[data-session-key="agent:main:session-9"]')).toBeNull();
  });

  it("hides pagination when required sessions cannot be collapsed", async () => {
    const keys = [
      "agent:main:main",
      ...Array.from({ length: 30 }, (_, index) => `agent:main:pinned-${index + 1}`),
    ];
    const sessions = createSessionsHarness("main", keys);
    const result = sessions.sessions.state.result;
    expect(result).not.toBeNull();
    if (!result) {
      return;
    }
    for (const row of result.sessions) {
      row.pinned = true;
    }
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, sessions.sessions);

    expect(sidebar.querySelectorAll(".sidebar-recent-session")).toHaveLength(31);
    expect(sidebar.querySelector(".sidebar-session-pagination")).toBeNull();
  });

  it("reveals optional sessions immediately when required sessions exceed the page size", async () => {
    const keys = [
      "agent:main:main",
      ...Array.from({ length: 40 }, (_, index) => `agent:main:session-${index + 1}`),
    ];
    const sessions = createSessionsHarness("main", keys);
    const result = sessions.sessions.state.result;
    expect(result).not.toBeNull();
    if (!result) {
      return;
    }
    for (const row of result.sessions.slice(0, 31)) {
      row.pinned = true;
    }
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, sessions.sessions);
    const rows = () => sidebar.querySelectorAll(".sidebar-recent-session");
    const button = (label: string) =>
      sidebar.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

    expect(rows()).toHaveLength(31);
    expect(button("Load more sessions")).not.toBeNull();
    expect(button("Collapse")).toBeNull();

    button("Load more sessions")?.click();
    await sidebar.updateComplete;
    expect(rows()).toHaveLength(41);
    expect(button("Load more sessions")).toBeNull();
    expect(button("Collapse")).not.toBeNull();

    button("Collapse")?.click();
    await sidebar.updateComplete;
    expect(rows()).toHaveLength(31);
    expect(button("Load more sessions")).not.toBeNull();
    expect(button("Collapse")).toBeNull();
  });

  it("reveals sessions ten at a time and offers Collapse after thirty", async () => {
    const keys = [
      "agent:main:main",
      ...Array.from({ length: 40 }, (_, index) => `agent:main:session-${index + 1}`),
    ];
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", keys));
    const rows = () => sidebar.querySelectorAll(".sidebar-recent-session");
    const button = (label: string) =>
      sidebar.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

    expect(rows()).toHaveLength(10);
    expect(button("Load more sessions")).not.toBeNull();
    expect(button("Collapse")).toBeNull();

    button("Load more sessions")?.click();
    await sidebar.updateComplete;
    expect(rows()).toHaveLength(20);
    expect(button("Collapse")).toBeNull();

    button("Load more sessions")?.click();
    await sidebar.updateComplete;
    expect(rows()).toHaveLength(30);
    expect(button("Collapse")).toBeNull();

    button("Load more sessions")?.click();
    await sidebar.updateComplete;
    expect(rows()).toHaveLength(40);
    expect(button("Load more sessions")).not.toBeNull();
    expect(button("Collapse")).not.toBeNull();

    button("Load more sessions")?.click();
    await sidebar.updateComplete;
    expect(rows()).toHaveLength(41);
    expect(button("Load more sessions")).toBeNull();
    expect(button("Collapse")).not.toBeNull();

    button("Collapse")?.click();
    await sidebar.updateComplete;
    expect(rows()).toHaveLength(10);
    expect(button("Load more sessions")).not.toBeNull();
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

    expect(logo()?.classList.contains("sidebar-brand__logo--vacated")).toBe(false);
    expect(standIn()).toBeNull();

    const look = createLobsterPetLook(70);
    dispatch({ phase: "in", look, name: "Pinchy" });
    await sidebar.updateComplete;
    expect(logo()?.classList.contains("sidebar-brand__logo--vacated")).toBe(true);
    const sprite = standIn();
    expect(sprite).not.toBeNull();
    expect(sprite?.classList.contains(`lobster-pet--palette-${look.palette.id}`)).toBe(true);
    expect(sprite?.getAttribute("title")).toContain("Pinchy");
    expect(sprite?.querySelector(".lobster-pet__svg")).not.toBeNull();

    dispatch({ phase: "leaving", look, name: "Pinchy" });
    await sidebar.updateComplete;
    expect(standIn()?.classList.contains("sidebar-brand__pet--leaving")).toBe(true);

    dispatch({ phase: "out", look: null, name: null });
    await sidebar.updateComplete;
    expect(standIn()).toBeNull();
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
    expect(list?.getAttribute("aria-label")).toBe("Chats");
    expect(row?.getAttribute("role")).toBe("listitem");
    expect(row?.hasAttribute("aria-label")).toBe(false);
    expect(link?.hasAttribute("aria-label")).toBe(false);
    expect(link?.getAttribute("aria-current")).toBe("page");
    expect(link?.firstElementChild?.classList.contains("sidebar-recent-session__text")).toBe(true);
    expect(link?.querySelector(".sidebar-recent-session__name")?.textContent).toBe(
      "Quarterly launch plan",
    );
    const descriptionId = link?.getAttribute("aria-describedby");
    expect(descriptionId).toBeTruthy();
    expect(descriptionId ? document.getElementById(descriptionId)?.textContent : "").toBe("now");
  });

  it("keeps the empty-chat fallback as a current link inside a list item", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", []));
    (sidebar as unknown as { activeRouteId: string }).activeRouteId = "chat";
    await sidebar.updateComplete;

    const fallback = sidebar.querySelector(".sidebar-recent-session--active");
    expect(fallback?.getAttribute("role")).toBe("listitem");
    expect(fallback?.querySelector("a")?.getAttribute("aria-current")).toBe("page");
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

    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(confirm).toHaveBeenCalledWith('Stop the cloud worker for "a"?');
    expect(request).toHaveBeenCalledWith(
      "sessions.reclaim",
      { key: "agent:main:a", agentId: "main" },
      { timeoutMs: 10 * 60_000 },
    );
    await vi.waitFor(() => expect(harness.refreshReplacement).toHaveBeenCalledWith("main"));
  });

  it("shows and dismisses a fixed sidebar error when a session patch is rejected", async () => {
    const { harness, sidebar } = await mountMutationHarness();
    harness.patch.mockRejectedValueOnce(new Error("rename rejected by Gateway"));
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("Rejected rename");
    try {
      const menu = await openSessionMenu(sidebar, "agent:main:a");
      menu.querySelector<HTMLButtonElement>('[data-shortcut="r"]')?.click();

      await vi.waitFor(() => {
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

      await vi.waitFor(() => {
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
    await vi.waitFor(() => expect(harness.patch).toHaveBeenCalledOnce());

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
    await vi.waitFor(() => expect(harness.patch).toHaveBeenCalledOnce());

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
    await vi.waitFor(() => expect(harness.patch).toHaveBeenCalledOnce());

    row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await sidebar.updateComplete;
    menu = sidebar.querySelector<TestSessionMenu>("openclaw-session-menu");
    await menu?.updateComplete;
    menu?.querySelector<HTMLButtonElement>('[data-shortcut="u"]')?.click();
    await vi.waitFor(() => expect(harness.patch).toHaveBeenCalledTimes(3));

    firstPatch.resolve(successfulSessionPatch("agent:main:a"));
    await vi.waitFor(() => expect(harness.patch).toHaveBeenCalledTimes(4));
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
      await vi.waitFor(() => expect(confirmations).toBe(2));

      expect(request).not.toHaveBeenCalled();
    } finally {
      confirmSpy.mockRestore();
    }
  });
});

function createDataTransferStub() {
  const data = new Map<string, string>();
  return {
    get types() {
      return [...data.keys()];
    },
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
    effectAllowed: "none",
    dropEffect: "none",
  };
}

function dispatchDragEvent(
  target: Element,
  type: "dragstart" | "dragover" | "drop",
  dataTransfer: ReturnType<typeof createDataTransferStub>,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  target.dispatchEvent(event);
}

describe("AppSidebar multi-select", () => {
  const KEYS = ["agent:main:main", "agent:main:a", "agent:main:b", "agent:main:c"];

  function rowLink(sidebar: SidebarLifecycleState, key: string): HTMLAnchorElement {
    const link = sidebar.querySelector<HTMLAnchorElement>(
      `[data-session-key="${key}"] .sidebar-recent-session__link`,
    );
    if (!link) {
      throw new Error(`expected row link for ${key}`);
    }
    return link;
  }

  function selectedRowKeys(sidebar: SidebarLifecycleState): string[] {
    return Array.from(sidebar.querySelectorAll(".sidebar-recent-session--selected")).map(
      (row) => row.getAttribute("data-session-key") ?? "",
    );
  }

  function click(target: Element, init: MouseEventInit = {}) {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  }

  function openContextMenu(sidebar: SidebarLifecycleState, key: string) {
    const row = sidebar.querySelector(`[data-session-key="${key}"]`);
    if (!row) {
      throw new Error(`expected row for ${key}`);
    }
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  }

  async function sessionMenu(sidebar: SidebarLifecycleState): Promise<TestSessionMenu> {
    const menu = sidebar.querySelector<TestSessionMenu>("openclaw-session-menu");
    if (!menu) {
      throw new Error("expected session menu");
    }
    await menu.updateComplete;
    return menu;
  }

  async function mountMultiSelect() {
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", KEYS);
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    sidebar.connected = true;
    await sidebar.updateComplete;
    return { sidebar, harness };
  }

  it("cmd-click toggles rows into the selection and plain click clears it", async () => {
    const { sidebar } = await mountMultiSelect();

    click(rowLink(sidebar, "agent:main:a"), { metaKey: true });
    click(rowLink(sidebar, "agent:main:b"), { metaKey: true });
    await sidebar.updateComplete;
    expect(selectedRowKeys(sidebar)).toEqual(["agent:main:a", "agent:main:b"]);

    click(rowLink(sidebar, "agent:main:b"), { metaKey: true });
    await sidebar.updateComplete;
    expect(selectedRowKeys(sidebar)).toEqual(["agent:main:a"]);

    click(rowLink(sidebar, "agent:main:c"));
    await sidebar.updateComplete;
    expect(selectedRowKeys(sidebar)).toEqual([]);
  });

  it("shift-click extends the selection from the anchor across the visible order", async () => {
    const { sidebar } = await mountMultiSelect();

    click(rowLink(sidebar, "agent:main:a"), { metaKey: true });
    click(rowLink(sidebar, "agent:main:c"), { shiftKey: true });
    await sidebar.updateComplete;

    expect(selectedRowKeys(sidebar)).toEqual(["agent:main:a", "agent:main:b", "agent:main:c"]);
  });

  it("archives every selected session from the batch menu", async () => {
    const { sidebar, harness } = await mountMultiSelect();

    click(rowLink(sidebar, "agent:main:a"), { metaKey: true });
    click(rowLink(sidebar, "agent:main:b"), { metaKey: true });
    await sidebar.updateComplete;
    openContextMenu(sidebar, "agent:main:a");
    await sidebar.updateComplete;

    const menu = await sessionMenu(sidebar);
    expect(menu.selectionCount).toBe(2);
    // Batch menus drop single-session actions like Rename.
    expect(menu.querySelector('[data-shortcut="r"]')).toBeNull();
    menu.querySelector<HTMLButtonElement>('[data-shortcut="a"]')?.click();

    await vi.waitFor(() => expect(harness.patch).toHaveBeenCalledTimes(2));
    expect(harness.patch).toHaveBeenNthCalledWith(
      1,
      "agent:main:a",
      { archived: true },
      { agentId: "main" },
    );
    expect(harness.patch).toHaveBeenNthCalledWith(
      2,
      "agent:main:b",
      { archived: true },
      { agentId: "main" },
    );
  });

  it("deletes the selection in one batch after a single confirm", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      const { sidebar, harness } = await mountMultiSelect();

      click(rowLink(sidebar, "agent:main:a"), { metaKey: true });
      click(rowLink(sidebar, "agent:main:b"), { metaKey: true });
      await sidebar.updateComplete;
      openContextMenu(sidebar, "agent:main:b");
      await sidebar.updateComplete;

      const menu = await sessionMenu(sidebar);
      menu.querySelector<HTMLButtonElement>('[data-shortcut="d"]')?.click();

      await vi.waitFor(() => expect(harness.deleteMany).toHaveBeenCalledOnce());
      expect(confirmSpy).toHaveBeenCalledOnce();
      expect(confirmSpy.mock.calls[0]?.[0]).toContain("2");
      expect(harness.deleteMany).toHaveBeenCalledWith([
        { key: "agent:main:a", agentId: "main", deleteTranscript: true },
        { key: "agent:main:b", agentId: "main", deleteTranscript: true },
      ]);
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it("retargets the menu to an unselected row and drops the selection", async () => {
    const { sidebar } = await mountMultiSelect();

    click(rowLink(sidebar, "agent:main:a"), { metaKey: true });
    click(rowLink(sidebar, "agent:main:b"), { metaKey: true });
    await sidebar.updateComplete;
    openContextMenu(sidebar, "agent:main:c");
    await sidebar.updateComplete;

    expect(selectedRowKeys(sidebar)).toEqual([]);
    const menu = await sessionMenu(sidebar);
    expect(menu.selectionCount).toBe(1);
    expect(menu.querySelector('[data-shortcut="r"]')).not.toBeNull();
  });
});

describe("AppSidebar transient menus", () => {
  // Regression: the nav column is a stacking context (z-index 10) painted
  // below the sidebar resizer (z-index 20), so transient menus must render
  // through the top-layer surface host instead of plain fixed divs.
  it("hosts the session sort menu in the top-layer menu surface", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));

    const trigger = sidebar.querySelector<HTMLButtonElement>(".sidebar-session-sort");
    if (!trigger) {
      throw new Error("expected sort menu trigger");
    }
    trigger.click();
    await sidebar.updateComplete;

    const menu = sidebar.querySelector(".sidebar-session-sort-menu");
    expect(menu).not.toBeNull();
    expect(menu?.closest("openclaw-menu-surface")).not.toBeNull();
  });

  it("ignores a stale sort-menu hide after opening its replacement", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    const trigger = sidebar.querySelector<HTMLButtonElement>(".sidebar-session-sort");
    if (!trigger) {
      throw new Error("expected sort menu trigger");
    }

    trigger.click();
    await sidebar.updateComplete;
    const firstMenu = sidebar.querySelector<HTMLElement>(".sidebar-session-sort-menu");
    expect(firstMenu).not.toBeNull();
    firstMenu?.dispatchEvent(
      new CustomEvent("wa-select", {
        bubbles: true,
        detail: { item: { value: "sort:created" } },
      }),
    );
    await sidebar.updateComplete;

    trigger.click();
    await sidebar.updateComplete;
    const replacement = sidebar.querySelector<HTMLElement>(".sidebar-session-sort-menu");
    expect(replacement).not.toBe(firstMenu);

    firstMenu?.dispatchEvent(new CustomEvent("wa-after-hide", { bubbles: true, composed: true }));
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-session-sort-menu")).toBe(replacement);
  });

  it("ignores a stale agent-menu hide after opening its replacement", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    const trigger = sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-chip__main");
    if (!trigger) {
      throw new Error("expected agent menu trigger");
    }

    trigger.click();
    await sidebar.updateComplete;
    const firstMenu = sidebar.querySelector<HTMLElement>(".sidebar-agent-menu");
    const settingsItem = firstMenu?.querySelector<HTMLElement>(
      'wa-dropdown-item[value="command:settings"]',
    );
    expect(firstMenu).not.toBeNull();
    expect(settingsItem).not.toBeNull();
    firstMenu?.dispatchEvent(
      new CustomEvent("wa-select", {
        bubbles: true,
        detail: { item: settingsItem },
      }),
    );
    await sidebar.updateComplete;

    trigger.click();
    await sidebar.updateComplete;
    const replacement = sidebar.querySelector<HTMLElement>(".sidebar-agent-menu");
    expect(replacement).not.toBe(firstMenu);

    firstMenu?.dispatchEvent(new CustomEvent("wa-after-hide", { bubbles: true, composed: true }));
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-agent-menu")).toBe(replacement);
  });

  it("ignores a stale More-menu hide after opening its replacement", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    const trigger = sidebar.querySelector<HTMLButtonElement>("button.nav-item--action");
    if (!trigger) {
      throw new Error("expected More menu trigger");
    }

    trigger.click();
    await sidebar.updateComplete;
    const firstMenu = sidebar.querySelector<HTMLElement>(".sidebar-more-menu");
    expect(firstMenu).not.toBeNull();
    trigger.click();
    await sidebar.updateComplete;
    trigger.click();
    await sidebar.updateComplete;
    const replacement = sidebar.querySelector<HTMLElement>(".sidebar-more-menu");
    expect(replacement).not.toBe(firstMenu);

    firstMenu?.dispatchEvent(new CustomEvent("wa-after-hide", { bubbles: true, composed: true }));
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-more-menu")).toBe(replacement);
  });

  it("ignores a stale Customize-menu hide after opening its replacement", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    const nav = sidebar.querySelector<HTMLElement>(".sidebar-nav");
    if (!nav) {
      throw new Error("expected sidebar navigation");
    }

    nav.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }),
    );
    await sidebar.updateComplete;
    const firstMenu = sidebar.querySelector<HTMLElement>(".sidebar-customize-menu");
    expect(firstMenu).not.toBeNull();
    firstMenu?.dispatchEvent(
      new CustomEvent("wa-select", {
        bubbles: true,
        detail: { item: { value: "reset" } },
      }),
    );
    await sidebar.updateComplete;

    nav.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 24, clientY: 24 }),
    );
    await sidebar.updateComplete;
    const replacement = sidebar.querySelector<HTMLElement>(".sidebar-customize-menu");
    expect(replacement).not.toBe(firstMenu);

    firstMenu?.dispatchEvent(new CustomEvent("wa-after-hide", { bubbles: true, composed: true }));
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-customize-menu")).toBe(replacement);
  });
});

describe("AppSidebar custom group reordering", () => {
  async function mountWithGroups(groups: string[]) {
    const client = {} as GatewayBrowserClient;
    const gateway = createGateway(client);
    const harness = createSessionsHarness("main", ["agent:main:main"]);
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    sidebar.connected = true;
    harness.publish({ groups });
    await sidebar.updateComplete;
    return { sidebar, harness };
  }

  function groupHeader(sidebar: SidebarLifecycleState, sectionId: string) {
    const header = sidebar.querySelector(
      `[data-session-section="${sectionId}"] .sidebar-recent-sessions__head`,
    );
    if (!header) {
      throw new Error(`expected header for section ${sectionId}`);
    }
    return header;
  }

  it("marks custom group headers draggable but keeps smart sections static", async () => {
    const { sidebar } = await mountWithGroups(["Alpha", "Beta"]);

    expect(groupHeader(sidebar, "category:Alpha").getAttribute("draggable")).toBe("true");
    expect(groupHeader(sidebar, "ungrouped").getAttribute("draggable")).toBe("false");
  });

  it("persists the new catalog order when a group header drops onto another group", async () => {
    const { sidebar, harness } = await mountWithGroups(["Alpha", "Beta", "Gamma"]);
    const dataTransfer = createDataTransferStub();

    dispatchDragEvent(groupHeader(sidebar, "category:Gamma"), "dragstart", dataTransfer);
    const alphaSection = sidebar.querySelector('[data-session-section="category:Alpha"]');
    if (!alphaSection) {
      throw new Error("expected Alpha section");
    }
    dispatchDragEvent(alphaSection, "drop", dataTransfer);

    expect(harness.groupsPut).toHaveBeenCalledWith(["Gamma", "Alpha", "Beta"]);
  });
});
describe("AppSidebar catalog session rows", () => {
  const catalogList = (
    sessions: Array<Record<string, unknown>>,
    hosts?: SessionCatalog["hosts"],
  ): SessionsCatalogListResult => ({
    catalogs: [
      {
        id: "codex",
        label: "Codex",
        capabilities: { continueSession: true, archive: true },
        hosts: hosts ?? [
          {
            hostId: "gateway:local",
            label: "Local Codex",
            kind: "gateway" as const,
            connected: true,
            sessions: sessions.map((session) => ({
              status: "idle",
              archived: false,
              canContinue: true,
              canArchive: true,
              ...session,
            })) as SessionCatalog["hosts"][number]["sessions"],
          },
        ],
      },
    ],
  });

  async function mountWithCatalog(result: SessionsCatalogListResult, sessionKeys: string[]) {
    const request = vi.fn().mockResolvedValue(result);
    const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    gateway.publish({
      hello: {
        features: { methods: ["sessions.catalog.list"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    const { sidebar } = await mountSidebar(gateway.gateway, createSessions("main", sessionKeys));
    sidebar.connected = true;
    await sidebar.updateComplete;
    await vi.advanceTimersByTimeAsync(0);
    await sidebar.updateComplete;
    return { sidebar, request };
  }

  it("renders local and paired-node rows under persistent host headings", async () => {
    vi.useFakeTimers();
    try {
      const { sidebar } = await mountWithCatalog(
        catalogList(
          [],
          [
            {
              hostId: "gateway:local",
              label: "Local Codex",
              kind: "gateway",
              connected: true,
              sessions: [
                {
                  threadId: "thread-local",
                  name: "Local session",
                  status: "idle",
                  archived: false,
                  canContinue: true,
                  canArchive: true,
                },
              ],
            },
            {
              hostId: "node:devbox",
              label: "Dev Box",
              kind: "node",
              nodeId: "devbox",
              connected: true,
              sessions: [
                {
                  threadId: "thread-node",
                  name: "Node session",
                  status: "stored",
                  archived: false,
                  canContinue: false,
                  canArchive: false,
                },
              ],
            },
          ],
        ),
        ["agent:main:main"],
      );

      const section = sidebar.querySelector('[data-session-section="catalog:codex"]');
      const local = section?.querySelector('[data-session-catalog-host="gateway:local"]');
      const node = section?.querySelector('[data-session-catalog-host="node:devbox"]');
      expect(local?.querySelector(".sidebar-session-catalog-host__label")?.textContent).toBe(
        "Local Codex",
      );
      expect(local?.textContent).toContain("Local session");
      expect(local?.textContent).not.toContain("Node session");
      expect(node?.querySelector(".sidebar-session-catalog-host__label")?.textContent).toBe(
        "Dev Box",
      );
      expect(node?.textContent).toContain("Node session");
      expect(node?.textContent).not.toContain("Local session");
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes terminal-preferred clicks to a typed terminal toggle", async () => {
    vi.useFakeTimers();
    try {
      const { sidebar } = await mountWithCatalog(
        catalogList([{ threadId: "thread-1", name: "Resume me", canOpenTerminal: true }]),
        ["agent:main:main"],
      );
      sidebar.catalogOpenTarget = "terminal";
      sidebar.terminalAvailable = true;
      const navigate = vi.fn();
      sidebar.onNavigate = navigate;
      let detail: unknown;
      const listener = (event: Event) => {
        detail = (event as CustomEvent).detail;
      };
      window.addEventListener(TERMINAL_PANEL_TOGGLE_EVENT, listener);
      try {
        await sidebar.updateComplete;
        (sidebar.querySelector('[data-session-key*="thread-1"] a') as HTMLElement).click();
      } finally {
        window.removeEventListener(TERMINAL_PANEL_TOGGLE_EVENT, listener);
      }
      expect(detail).toEqual({
        open: true,
        catalog: { catalogId: "codex", hostId: "gateway:local", threadId: "thread-1" },
      });
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the viewer and disables the terminal menu item when ineligible", async () => {
    vi.useFakeTimers();
    try {
      const { sidebar } = await mountWithCatalog(
        catalogList([{ threadId: "thread-1", name: "View me", canOpenTerminal: false }]),
        ["agent:main:main"],
      );
      sidebar.catalogOpenTarget = "terminal";
      sidebar.terminalAvailable = true;
      const navigate = vi.fn();
      sidebar.onNavigate = navigate;
      await sidebar.updateComplete;
      const row = sidebar.querySelector('[data-session-key*="thread-1"]') as HTMLElement;
      (row.querySelector("a") as HTMLElement).click();
      expect(navigate).toHaveBeenCalledWith("chat", {
        search: "?session=catalog%3Acodex%3Agateway%253Alocal%3Athread-1",
      });
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 30,
        }),
      );
      await sidebar.updateComplete;
      const menu = sidebar.querySelector("openclaw-catalog-session-menu") as HTMLElement & {
        updateComplete: Promise<boolean>;
      };
      await menu.updateComplete;
      const items = menu.querySelectorAll<HTMLElement & { disabled: boolean }>("wa-dropdown-item");
      expect(items).toHaveLength(2);
      expect(items[1]?.disabled).toBe(true);
      expect(row.querySelector("[data-catalog-session-menu]")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks the routed catalog session row active without a phantom chat row", async () => {
    vi.useFakeTimers();
    try {
      const { sidebar } = await mountWithCatalog(
        catalogList([{ threadId: "thread-1", name: "Release checklist" }]),
        ["agent:main:main"],
      );
      (sidebar as unknown as { activeRouteId: string }).activeRouteId = "chat";
      sidebar.sessionKey = "catalog:codex:gateway%3Alocal:thread-1";
      await sidebar.updateComplete;

      const active = sidebar.querySelectorAll(".sidebar-recent-session--active");
      expect(active).toHaveLength(1);
      expect(active[0]?.getAttribute("data-session-key")).toBe(
        "catalog:codex:gateway%3Alocal:thread-1",
      );
      expect(active[0]?.getAttribute("role")).toBe("listitem");
      expect(active[0]?.closest('[role="list"]')?.getAttribute("aria-label")).toBe("Local Codex");
      expect(active[0]?.querySelector("a")?.getAttribute("aria-current")).toBe("page");
      // The raw catalog key must not surface as a synthesized chat row.
      const chatRows = [
        ...sidebar.querySelectorAll(
          '.sidebar-recent-sessions__group:not([data-session-section^="catalog:"]) [data-session-key]',
        ),
      ].map((row) => row.getAttribute("data-session-key"));
      expect(chatRows).not.toContain("catalog:codex:gateway%3Alocal:thread-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders an adopted catalog session as its live row and hides the duplicate", async () => {
    vi.useFakeTimers();
    try {
      const { sidebar } = await mountWithCatalog(
        catalogList([
          {
            threadId: "thread-1",
            name: "Release checklist",
            openClawSessionKey: "agent:main:adopted-codex",
          },
        ]),
        ["agent:main:main", "agent:main:adopted-codex"],
      );

      const rows = [...sidebar.querySelectorAll('[data-session-key="agent:main:adopted-codex"]')];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.closest('[data-session-section="catalog:codex"]')).not.toBeNull();
      // Live-row parity: the adopted row exposes the regular session actions.
      expect(rows[0]?.querySelector("[data-session-menu]")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds the adopted session immediately on the catalog-continued event", async () => {
    vi.useFakeTimers();
    try {
      const { sidebar } = await mountWithCatalog(
        catalogList([{ threadId: "thread-1", name: "Release checklist" }]),
        ["agent:main:main", "agent:main:adopted-codex"],
      );
      expect(
        sidebar.querySelectorAll('[data-session-key="agent:main:adopted-codex"]'),
      ).toHaveLength(1);

      document.dispatchEvent(
        new CustomEvent(CATALOG_SESSION_CONTINUED_EVENT, {
          detail: {
            catalogId: "codex",
            hostId: "gateway:local",
            threadId: "thread-1",
            sessionKey: "agent:main:adopted-codex",
          },
        }),
      );
      await sidebar.updateComplete;

      const rows = [...sidebar.querySelectorAll('[data-session-key="agent:main:adopted-codex"]')];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.closest('[data-session-section="catalog:codex"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
describe("AppSidebar group mutation collapsed state", () => {
  const COLLAPSED_STORAGE_KEY = "openclaw:sidebar:sessions:collapsed-sections";

  async function mountCollapsedGroup(options: {
    groupsRename?: () => Promise<SessionGroupMutationResult>;
    groupsDelete?: () => Promise<SessionGroupMutationResult>;
  }) {
    localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(["category:Alpha"]));
    const gatewayHarness = createGatewayHarness({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", ["agent:main:main"]);
    if (options.groupsRename) {
      harness.groupsRename.mockImplementation(options.groupsRename);
    }
    if (options.groupsDelete) {
      harness.groupsDelete.mockImplementation(options.groupsDelete);
    }
    const { sidebar } = await mountSidebar(gatewayHarness.gateway, harness.sessions);
    sidebar.connected = true;
    harness.publish({ groups: ["Alpha"] });
    await sidebar.updateComplete;
    return { sidebar, harness, gatewayHarness };
  }

  async function openGroupMenu(sidebar: SidebarLifecycleState) {
    const actions = sidebar.querySelector<HTMLButtonElement>(
      '[data-session-section="category:Alpha"] .sidebar-session-group-actions',
    );
    if (!actions) {
      throw new Error("expected group actions trigger");
    }
    actions.click();
    await sidebar.updateComplete;
    const menu = sidebar.querySelector(".sidebar-session-group-menu");
    if (!menu) {
      throw new Error("expected group menu");
    }
    return menu;
  }

  it("keeps collapsed keys when group rename is rejected", async () => {
    const { sidebar, harness } = await mountCollapsedGroup({
      groupsRename: () => Promise.reject(new Error("rename failed")),
    });
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("Beta");
    const menu = await openGroupMenu(sidebar);
    const rename = menu.querySelectorAll<HTMLButtonElement>(".session-menu__item")[0];
    rename?.click();
    await vi.waitFor(() => expect(harness.groupsRename).toHaveBeenCalledWith("Alpha", "Beta"));
    await Promise.resolve();
    await Promise.resolve();

    expect(localStorage.getItem(COLLAPSED_STORAGE_KEY)).toBe(JSON.stringify(["category:Alpha"]));
    promptSpy.mockRestore();
  });

  it("rewrites collapsed keys only after group rename succeeds", async () => {
    const { sidebar, harness } = await mountCollapsedGroup({
      groupsRename: () => Promise.resolve("completed"),
    });
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("Beta");
    const menu = await openGroupMenu(sidebar);
    menu.querySelectorAll<HTMLButtonElement>(".session-menu__item")[0]?.click();
    await vi.waitFor(() => expect(harness.groupsRename).toHaveBeenCalledWith("Alpha", "Beta"));
    await Promise.resolve();
    await Promise.resolve();

    expect(JSON.parse(localStorage.getItem(COLLAPSED_STORAGE_KEY) ?? "[]")).toEqual([
      "category:Beta",
    ]);
    promptSpy.mockRestore();
  });

  it("ignores a stale group rename after its Gateway reconnects with the same client", async () => {
    let resolveRename!: (result: SessionGroupMutationResult) => void;
    const rename = new Promise<SessionGroupMutationResult>((resolve) => {
      resolveRename = resolve;
    });
    const { sidebar, harness, gatewayHarness } = await mountCollapsedGroup({
      groupsRename: () => rename,
    });
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("Beta");
    const menu = await openGroupMenu(sidebar);
    menu.querySelectorAll<HTMLButtonElement>(".session-menu__item")[0]?.click();
    await vi.waitFor(() => expect(harness.groupsRename).toHaveBeenCalledWith("Alpha", "Beta"));

    gatewayHarness.publish({ connected: false });
    gatewayHarness.publish({ connected: true });
    resolveRename("stale");
    await Promise.resolve();
    await Promise.resolve();

    expect(localStorage.getItem(COLLAPSED_STORAGE_KEY)).toBe(JSON.stringify(["category:Alpha"]));
    promptSpy.mockRestore();
  });

  it("keeps collapsed keys when group delete is rejected", async () => {
    const { sidebar, harness } = await mountCollapsedGroup({
      groupsDelete: () => Promise.reject(new Error("delete failed")),
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const menu = await openGroupMenu(sidebar);
    const items = menu.querySelectorAll<HTMLButtonElement>(".session-menu__item");
    items[items.length - 1]?.click();
    await vi.waitFor(() => expect(harness.groupsDelete).toHaveBeenCalledWith("Alpha"));
    await Promise.resolve();
    await Promise.resolve();

    expect(localStorage.getItem(COLLAPSED_STORAGE_KEY)).toBe(JSON.stringify(["category:Alpha"]));
    confirmSpy.mockRestore();
  });

  it("drops collapsed keys only after group delete succeeds", async () => {
    const { sidebar, harness } = await mountCollapsedGroup({
      groupsDelete: () => Promise.resolve("completed"),
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const menu = await openGroupMenu(sidebar);
    const items = menu.querySelectorAll<HTMLButtonElement>(".session-menu__item");
    items[items.length - 1]?.click();
    await vi.waitFor(() => expect(harness.groupsDelete).toHaveBeenCalledWith("Alpha"));
    await Promise.resolve();
    await Promise.resolve();

    expect(JSON.parse(localStorage.getItem(COLLAPSED_STORAGE_KEY) ?? "[]")).toEqual([]);
    confirmSpy.mockRestore();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
