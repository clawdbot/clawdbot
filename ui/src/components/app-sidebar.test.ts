/* @vitest-environment jsdom */

import { ContextProvider } from "@lit/context";
import { LitElement } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SessionCatalog,
  SessionsCatalogListResult,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { SessionsListResult } from "../api/types.ts";
import type { RouteId } from "../app-route-paths.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGateway,
  type ApplicationGatewaySnapshot,
} from "../app/context.ts";
import type { SessionCapability, SessionState } from "../lib/sessions/index.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import "./app-sidebar.ts";
import {
  LOBSTER_LOGO_VISIT_EVENT,
  createLobsterPetLook,
  type LobsterLogoVisitDetail,
} from "./lobster-pet.ts";

// Keep the attention widget inert: it fires its own health RPCs (cron.list,
// models.authStatus) on connect, which would interleave with the nth-call
// assertions on the shared mocked client below. It has its own test file.
vi.mock("./sidebar-attention.ts", () => ({}));

const PROVIDER_ELEMENT_NAME = "test-app-sidebar-context-provider";

class AppSidebarContextProvider extends LitElement {
  private readonly contextProvider = new ContextProvider(this, {
    context: applicationContext,
  });

  setContext(context: ApplicationContext<RouteId>) {
    this.contextProvider.setValue(context);
  }
}

if (!customElements.get(PROVIDER_ELEMENT_NAME)) {
  customElements.define(PROVIDER_ELEMENT_NAME, AppSidebarContextProvider);
}

type SidebarLifecycleState = HTMLElement & {
  connected: boolean;
  sessionCatalogs: SessionCatalog[];
  sessionRowsByAgent: Record<string, SessionsListResult["sessions"]>;
  sessionCreatedOrder: Map<string, number>;
  sessionsAgentId: string | null;
  sessionsResult: SessionsListResult | null;
  updateComplete: Promise<boolean>;
  updateAvailable: { currentVersion: string; latestVersion: string; channel: string } | null;
  updateRunning: boolean;
  onUpdate: () => void;
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

function createSessionsHarness(agentId: string, keys: string[]) {
  let state = createSessionState(agentId, keys);
  let canonicalListRevision = 1;
  const listeners = new Set<(next: SessionState) => void>();
  const groupsPut = vi.fn(() => Promise.resolve());
  const patch = vi.fn(() => Promise.resolve(null));
  const deleteMany = vi.fn(() =>
    Promise.resolve({ deleted: [] as string[], errors: [], preservedWorktrees: [] }),
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
    patch,
    deleteMany,
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
    patch,
    deleteMany,
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
): ApplicationContext<RouteId> {
  return {
    gateway,
    sessions,
    agents: {
      state: { agentsList: null },
      subscribe: () => () => undefined,
    },
    agentSelection: {
      state: { selectedId: "main" },
      set: () => undefined,
      subscribe: () => () => undefined,
    },
  } as unknown as ApplicationContext<RouteId>;
}

async function mountSidebar(
  gateway: ApplicationGateway,
  sessions: SessionCapability,
  variant: SidebarLifecycleState["variant"] = "panel",
) {
  const provider = document.createElement(PROVIDER_ELEMENT_NAME) as AppSidebarContextProvider;
  const sidebar = document.createElement(
    "openclaw-app-sidebar",
  ) as unknown as SidebarLifecycleState;
  sidebar.variant = variant;
  provider.setContext(createContext(gateway, sessions));
  provider.append(sidebar);
  document.body.append(provider);
  await sidebar.updateComplete;
  return { provider, sidebar };
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
        catalogId: "codex",
        cursors: { "gateway:local": "page-2" },
      });
      expect(catalogRows()).toHaveLength(2);
      expect(sidebar.textContent).toContain("Stale title");

      await vi.advanceTimersByTimeAsync(30_000);
      await sidebar.updateComplete;
      expect(request).toHaveBeenNthCalledWith(3, "sessions.catalog.list", {
        limitPerHost: 40,
      });
      expect(request).toHaveBeenNthCalledWith(4, "sessions.catalog.list", {
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

describe("AppSidebar custom group reordering", () => {
  async function mountWithGroups(groups: string[]) {
    const client = {} as GatewayBrowserClient;
    const gateway = createGateway(client);
    const harness = createSessionsHarness("main", ["agent:main:main"]);
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
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
