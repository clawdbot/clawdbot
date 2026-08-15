import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { catalogPage, createGatewayHarness, createSessions, mountSidebar } from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar session catalog ownership", () => {
  it.each([
    { owner: "the selected agent", assistantAgentId: null },
    { owner: "the advertised catalog capability", assistantAgentId: "main" },
  ])(
    "retires catalog rows and creation after reconnect loses $owner",
    async ({ assistantAgentId }) => {
      vi.useFakeTimers();
      let provider: HTMLElement | undefined;
      try {
        const firstPage = catalogPage(
          [{ threadId: "thread-1", name: "Retired session" }],
          "page-2",
        );
        const catalog = firstPage.catalogs[0];
        if (!catalog) {
          throw new Error("expected a session catalog");
        }
        catalog.capabilities.createSession = { model: "anthropic/claude-opus-4-8" };
        const expandedPage = catalogPage([{ threadId: "thread-2", name: "Retired page" }]);
        const expandedCatalog = expandedPage.catalogs[0];
        if (!expandedCatalog) {
          throw new Error("expected an expanded session catalog");
        }
        expandedCatalog.capabilities.createSession = catalog.capabilities.createSession;
        const request = vi
          .fn()
          .mockResolvedValueOnce(firstPage)
          .mockResolvedValueOnce(expandedPage);
        const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
        const catalogHello = {
          type: "hello-ok",
          protocol: 1,
          auth: { role: "operator", scopes: ["operator.admin"] },
          features: { methods: ["sessions.catalog.list"] },
        } satisfies NonNullable<ApplicationGatewaySnapshot["hello"]>;
        gateway.publish({ hello: catalogHello });
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
        expect(sidebar.textContent).toContain("Retired session");
        expect(sidebar.textContent).toContain("Retired page");
        expect(sidebar.querySelector(".sidebar-session-catalog-new")).not.toBeNull();
        expect(sidebar.sessionData.sessionCatalogPageDepths.size).toBe(1);
        expect(sidebar.sessionData.sessionCatalogRevisions.size).toBe(1);

        gateway.publish({ phase: "reconnecting", hello: null });
        await sidebar.updateComplete;
        expect(sidebar.textContent).toContain("Retired page");
        expect(sidebar.sessionData.sessionCatalogPageDepths.size).toBe(1);

        gateway.publish({
          phase: "connected",
          assistantAgentId,
          hello: { ...catalogHello, features: { ...catalogHello.features, methods: [] } },
        });
        await sidebar.updateComplete;
        await vi.advanceTimersByTimeAsync(0);
        await sidebar.updateComplete;

        expect(sidebar.sessionData.sessionCatalogAgentId).toBeNull();
        expect(sidebar.sessionData.sessionCatalogs).toEqual([]);
        expect(sidebar.sessionData.sessionCatalogPageDepths.size).toBe(0);
        expect(sidebar.sessionData.sessionCatalogRevisions.size).toBe(0);
        expect(sidebar.textContent).not.toContain("Retired session");
        expect(sidebar.textContent).not.toContain("Retired page");
        expect(sidebar.querySelector(".sidebar-session-catalog-new")).toBeNull();
        expect(request).toHaveBeenCalledTimes(2);
      } finally {
        provider?.remove();
        vi.useRealTimers();
      }
    },
  );
});
