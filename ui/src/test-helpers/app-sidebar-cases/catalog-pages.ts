import { describe, expect, it, vi } from "vitest";
import type {
  SessionsCatalogHostEvent,
  SessionsCatalogListResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  catalogErrorPage,
  catalogPage,
  createGatewayHarness,
  createSessions,
  deferred,
  mountSidebar,
} from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar session catalog pagination", () => {
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
        progressId: expect.any(String),
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

  it("keeps a progressive host update that arrives during expanded-page refetch", async () => {
    vi.useFakeTimers();
    try {
      const pageOne = catalogPage([{ threadId: "thread-1", name: "Newest" }], "page-2");
      const pageTwo = catalogPage([{ threadId: "thread-2", name: "Older" }]);
      const pendingRefetch = deferred<SessionsCatalogListResult>();
      const request = vi
        .fn()
        .mockResolvedValueOnce(pageOne)
        .mockResolvedValueOnce(pageTwo)
        .mockResolvedValueOnce(pageOne)
        .mockReturnValueOnce(pendingRefetch.promise)
        .mockResolvedValue(pageOne);
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

      sidebar.querySelector<HTMLButtonElement>('[data-session-catalog-load-more="codex"]')?.click();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(request).toHaveBeenCalledTimes(4);

      const progressId = (request.mock.calls[2]?.[1] as { progressId?: string })?.progressId;
      const catalog = pageOne.catalogs[0];
      const host = catalog?.hosts[0];
      if (!progressId || !catalog || !host) {
        throw new Error("expanded progressive fixture is incomplete");
      }
      gateway.publishEvent("sessions.catalog.host", {
        progressId,
        agentId: "main",
        catalog: {
          ...catalog,
          hosts: [{ ...host, hostId: "gateway:progressive" }],
        },
      } satisfies SessionsCatalogHostEvent);
      await sidebar.updateComplete;
      expect(
        sidebar.querySelector('[data-session-catalog-host="gateway:progressive"]'),
      ).not.toBeNull();

      pendingRefetch.resolve(pageTwo);
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;

      expect(
        sidebar.querySelector('[data-session-catalog-host="gateway:progressive"]'),
      ).not.toBeNull();
      expect(request).toHaveBeenCalledTimes(4);
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
