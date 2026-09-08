import { describe, expect, it, vi } from "vitest";
import type { SessionsCatalogListResult } from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  catalogErrorPage,
  catalogPage,
  createGatewayHarness,
  createSessions,
  deferred,
  mountSidebar,
  TWO_AGENTS,
} from "../app-sidebar.ts";
import { registerCatalogPageHostTests } from "./catalog-page-hosts.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar session catalog pagination", () => {
  it("keeps an in-flight catalog refresh across a stable same-client Gateway notification", async () => {
    vi.useFakeTimers();
    let provider: HTMLElement | undefined;
    try {
      // Shared UI workers retain real custom elements despite later module mocks.
      await vi.importActual("../../components/sidebar-attention.ts");
      const pendingPage = deferred<SessionsCatalogListResult>();
      const request = vi.fn().mockReturnValue(pendingPage.promise);
      const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
      expect(gateway.gateway.connection).toEqual({
        gatewayUrl: "ws://gateway.test",
        token: "",
        bootstrapToken: "",
        password: "",
      });
      gateway.publish({
        hello: {
          features: { methods: ["sessions.catalog.list"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      const mounted = await mountSidebar(
        gateway.gateway,
        createSessions("main", ["agent:main:main"]),
      );
      const { sidebar } = mounted;
      provider = mounted.provider;
      sidebar.connected = true;
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);

      expect(request).toHaveBeenCalledTimes(1);
      const generation = sidebar.sessionData.sessionScopeGeneration;

      gateway.publish({ offlineStable: true });
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);

      expect(sidebar.sessionData.sessionScopeGeneration).toBe(generation);
      expect(request).toHaveBeenCalledTimes(1);

      pendingPage.resolve(catalogPage([{ threadId: "thread-1", name: "Current session" }]));
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;

      expect(sidebar.textContent).toContain("Current session");
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      provider?.remove();
      vi.useRealTimers();
    }
  });

  it("releases a pending catalog page across a same-client Gateway reconnect", async () => {
    vi.useFakeTimers();
    let provider: HTMLElement | undefined;
    try {
      const pendingStalePage = deferred<SessionsCatalogListResult>();
      const pendingFreshPage = deferred<SessionsCatalogListResult>();
      const firstPage = catalogPage([{ threadId: "thread-1", name: "Newest" }], "page-2");
      const expandedPage = catalogPage([{ threadId: "thread-2", name: "Expanded" }], "page-3");
      let requestedThirdPages = 0;
      const request = vi.fn((_method: string, params: { cursors?: Record<string, string> }) => {
        const cursor = params.cursors?.["gateway:local"];
        if (cursor === "page-2") {
          return Promise.resolve(expandedPage);
        }
        if (cursor === "page-3") {
          requestedThirdPages += 1;
          return requestedThirdPages === 1 ? pendingStalePage.promise : pendingFreshPage.promise;
        }
        return Promise.resolve(firstPage);
      });
      const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
      const hello = {
        features: { methods: ["sessions.catalog.list"] },
      } as ApplicationGatewaySnapshot["hello"];
      gateway.publish({ hello });
      const mounted = await mountSidebar(
        gateway.gateway,
        createSessions("main", ["agent:main:main"]),
      );
      const { sidebar } = mounted;
      provider = mounted.provider;
      sidebar.connected = true;
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);

      await sidebar.sessionData.loadMoreSessionCatalog("codex");
      await sidebar.updateComplete;
      expect(sidebar.textContent).toContain("Expanded");
      expect(sidebar.sessionData.sessionCatalogPageDepths.size).toBe(1);

      const staleLoad = sidebar.sessionData.loadMoreSessionCatalog("codex");
      await sidebar.updateComplete;
      expect(sidebar.sessionData.loadingMoreSessionCatalogIds.has("codex")).toBe(true);

      gateway.publish({ phase: "reconnecting", hello: null });
      sidebar.sessionData.hostUpdate();
      expect(sidebar.sessionData.loadingMoreSessionCatalogIds.has("codex")).toBe(false);
      await sidebar.updateComplete;
      expect(sidebar.sessionData.sessionCatalogPageDepths.size).toBe(1);

      gateway.publish({ phase: "connected", hello });
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;

      expect(sidebar.textContent).toContain("Expanded");
      const loadMore = sidebar.querySelector<HTMLButtonElement>(
        '[data-session-catalog-load-more="codex"]',
      );
      expect(loadMore?.disabled).toBe(false);
      loadMore?.click();
      await sidebar.updateComplete;
      expect(sidebar.sessionData.loadingMoreSessionCatalogIds.has("codex")).toBe(true);

      pendingStalePage.resolve(catalogPage([{ threadId: "stale", name: "Stale page" }]));
      await staleLoad;
      await sidebar.updateComplete;
      expect(sidebar.sessionData.loadingMoreSessionCatalogIds.has("codex")).toBe(true);
      expect(sidebar.textContent).not.toContain("Stale page");

      pendingFreshPage.resolve(catalogPage([{ threadId: "thread-3", name: "Fresh page" }]));
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;
      expect(sidebar.sessionData.loadingMoreSessionCatalogIds.has("codex")).toBe(false);
      expect(sidebar.textContent).toContain("Fresh page");
    } finally {
      provider?.remove();
      vi.useRealTimers();
    }
  });

  it("retires visible catalog rows and expanded cursors when the agent changes", async () => {
    vi.useFakeTimers();
    try {
      const pendingResearch = deferred<SessionsCatalogListResult>();
      const mainFirstPage = catalogPage(
        [{ threadId: "main-newest", name: "Main newest" }],
        "main-page-2",
      );
      const mainSecondPage = catalogPage([{ threadId: "main-older", name: "Main older" }]);
      const researchFirstPage = catalogPage(
        [{ threadId: "research-newest", name: "Research newest" }],
        "research-page-2",
      );
      const request = vi
        .fn()
        .mockResolvedValueOnce(mainFirstPage)
        .mockResolvedValueOnce(mainSecondPage)
        .mockReturnValueOnce(pendingResearch.promise)
        .mockResolvedValue(catalogPage([{ threadId: "research-older", name: "Research older" }]));
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
        TWO_AGENTS,
      );
      sidebar.connected = true;
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;

      sidebar.querySelector<HTMLButtonElement>('[data-session-catalog-load-more="codex"]')?.click();
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;

      expect(sidebar.textContent).toContain("Main newest");
      expect(sidebar.textContent).toContain("Main older");
      expect(sidebar.sessionData.sessionCatalogPageDepths.size).toBe(1);

      context.agentSelection.state.selectedId = "research";
      context.agentSelection.state.scopeId = "research";
      sidebar.requestUpdate();
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(50);
      await sidebar.updateComplete;

      expect(sidebar.textContent).not.toContain("Main newest");
      expect(sidebar.textContent).not.toContain("Main older");
      expect(sidebar.sessionData.sessionCatalogPageDepths.size).toBe(0);

      pendingResearch.resolve(researchFirstPage);
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;

      expect(sidebar.textContent).toContain("Research newest");
      expect(sidebar.textContent).not.toContain("Research older");
      expect(request).not.toHaveBeenCalledWith(
        "sessions.catalog.list",
        expect.objectContaining({
          agentId: "research",
          catalogId: "codex",
          cursors: { "gateway:local": "research-page-2" },
        }),
      );
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
        expect(sidebar.sessionData.sessionCatalogs[0]?.hosts[0]?.nextCursor).toBe("page-2");

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

  registerCatalogPageHostTests();

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
        hostIds: ["gateway:local"],
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
      expect(sidebar.sessionData.sessionCatalogs[0]?.hosts[0]?.nextCursor).toBe("page-2");
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
        expect(sidebar.sessionData.sessionCatalogs[0]?.hosts[0]?.sessions).toHaveLength(2);

        await vi.advanceTimersByTimeAsync(30_000);
        await sidebar.updateComplete;
        const host = sidebar.sessionData.sessionCatalogs[0]?.hosts[0];
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
        .mockResolvedValue(catalogErrorPage("Replay failed"));
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
      expect(sidebar.sessionData.sessionCatalogs[0]?.hosts).toEqual([]);

      await vi.advanceTimersByTimeAsync(30_000);
      await sidebar.updateComplete;
      const host = sidebar.sessionData.sessionCatalogs[0]?.hosts[0];
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
        sidebar.sessionData.sessionCatalogs
          .find((catalog) => catalog.id === "codex")
          ?.hosts[0]?.sessions.map((session) => session.threadId),
      ).toEqual(["codex-1", "codex-2"]);
      expect(
        sidebar.sessionData.sessionCatalogs
          .find((catalog) => catalog.id === "claude")
          ?.hosts[0]?.sessions.map((session) => session.threadId),
      ).toEqual(["claude-1", "claude-2"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
