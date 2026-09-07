import { expect, it, vi } from "vitest";
import type {
  SessionCatalogHost,
  SessionsCatalogHostEvent,
  SessionsCatalogListResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  catalogPage,
  createGatewayHarness,
  createSessions,
  deferred,
  mountSidebar,
} from "../app-sidebar.ts";

export function registerCatalogPageHostTests() {
  it("pages only cursor hosts and preserves exhausted hosts through the next poll refresh", async () => {
    vi.useFakeTimers();
    try {
      const exhaustedHost: SessionCatalogHost = {
        ...catalogPage([{ threadId: "exhausted", name: "Retained remote session" }]).catalogs[0]!
          .hosts[0]!,
        hostId: "node:exhausted",
        label: "Exhausted host",
        kind: "node",
        connected: false,
        error: { code: "NODE_OFFLINE", message: "Remote host unavailable" },
      };
      const firstPage = catalogPage([{ threadId: "thread-1", name: "Newest" }], "page-2");
      const refreshedFirstPage = catalogPage(
        [{ threadId: "thread-1", name: "Newest refreshed" }],
        "page-2",
      );
      for (const page of [firstPage, refreshedFirstPage]) {
        page.catalogs[0]!.hosts.push(exhaustedHost);
      }
      const request = vi
        .fn()
        .mockResolvedValueOnce(firstPage)
        .mockResolvedValueOnce(
          catalogPage([{ threadId: "thread-2", name: "Stale title" }], "page-3"),
        )
        .mockResolvedValueOnce(refreshedFirstPage)
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
      const retainedHost = () =>
        sidebar.sessionData.sessionCatalogs[0]?.hosts.find(
          (host) => host.hostId === exhaustedHost.hostId,
        );
      expect(request).toHaveBeenNthCalledWith(1, "sessions.catalog.list", {
        agentId: "main",
        limitPerHost: 40,
        progressId: expect.any(String),
      });
      expect(catalogRows()).toHaveLength(2);
      loadMore()?.click();
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;

      expect(request).toHaveBeenNthCalledWith(2, "sessions.catalog.list", {
        agentId: "main",
        catalogId: "codex",
        hostIds: ["gateway:local"],
        cursors: { "gateway:local": "page-2" },
      });
      expect(catalogRows()).toHaveLength(3);
      expect(sidebar.textContent).toContain("Stale title");
      expect(sidebar.textContent).toContain("Retained remote session");
      expect(retainedHost()).toEqual(exhaustedHost);

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
        hostIds: ["gateway:local"],
        cursors: { "gateway:local": "page-2" },
      });
      expect(catalogRows()).toHaveLength(3);
      expect(sidebar.textContent).toContain("Newest refreshed");
      expect(sidebar.textContent).toContain("Current title");
      expect(sidebar.textContent).not.toContain("Stale title");
      expect(retainedHost()).toEqual(exhaustedHost);

      loadMore()?.click();
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;
      expect(request).toHaveBeenNthCalledWith(5, "sessions.catalog.list", {
        agentId: "main",
        catalogId: "codex",
        hostIds: ["gateway:local"],
        cursors: { "gateway:local": "page-3" },
      });
      expect(catalogRows()).toHaveLength(4);
      expect(sidebar.textContent).toContain("Oldest");
      expect(retainedHost()).toEqual(exhaustedHost);
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
      const progressiveHost = { ...host, hostId: "gateway:progressive" };
      gateway.publishEvent("sessions.catalog.host", {
        progressId,
        agentId: "main",
        catalog: {
          ...catalog,
          hosts: [progressiveHost],
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
      expect(request).toHaveBeenNthCalledWith(4, "sessions.catalog.list", {
        agentId: "main",
        catalogId: "codex",
        hostIds: ["gateway:local"],
        cursors: { "gateway:local": "page-2" },
      });
      expect(
        sidebar.sessionData.sessionCatalogs[0]?.hosts.find(
          (candidate) => candidate.hostId === progressiveHost.hostId,
        ),
      ).toEqual(progressiveHost);
    } finally {
      vi.useRealTimers();
    }
  });
}
