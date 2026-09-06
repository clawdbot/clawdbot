import { describe, expect, it, vi } from "vitest";
import type { SessionsCatalogListResult } from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  catalogPage,
  createGatewayHarness,
  createSessions,
  deferred,
  mountSidebar,
} from "../app-sidebar.ts";

describe("AppSidebar catalog reconnect", () => {
  it("keeps progressive catalogs after a stale response and same-client reconnect", async () => {
    vi.useFakeTimers();
    try {
      const staleResponse = deferred<SessionsCatalogListResult>();
      const request = vi
        .fn()
        .mockReturnValueOnce(staleResponse.promise)
        .mockResolvedValue(catalogPage([]));
      const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
      const hello = {
        features: { methods: ["sessions.catalog.list"] },
      } as ApplicationGatewaySnapshot["hello"];
      gateway.publish({ hello });
      const { sidebar } = await mountSidebar(
        gateway.gateway,
        createSessions("main", ["agent:main:main"]),
      );
      sidebar.connected = true;
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(1);

      gateway.publish({ phase: "reconnecting", hello: null });
      await sidebar.updateComplete;
      gateway.publish({ phase: "connected", hello });
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(50);

      staleResponse.resolve(catalogPage([{ threadId: "thread-stale", name: "Stale session" }]));
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;
      expect(sidebar.textContent).not.toContain("Stale session");
      await vi.advanceTimersByTimeAsync(30_000);

      expect(request).toHaveBeenLastCalledWith("sessions.catalog.list", {
        agentId: "main",
        limitPerHost: 40,
        progressId: expect.any(String),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
