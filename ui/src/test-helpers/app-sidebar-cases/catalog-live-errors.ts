import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  catalogPage,
  createGatewayHarness,
  createSessions,
  deferred,
  mountSidebar,
} from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar session catalog request errors", () => {
  it("uses the gateway default before the agent roster loads", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn().mockResolvedValue({ catalogs: [] });
      const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
      gateway.publish({
        assistantAgentId: "roboclaw",
        hello: {
          features: { methods: ["sessions.catalog.list"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      const { sidebar } = await mountSidebar(
        gateway.gateway,
        createSessions("roboclaw", ["agent:roboclaw:main"]),
      );
      sidebar.connected = true;
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);

      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith(
        "sessions.catalog.list",
        expect.objectContaining({ agentId: "roboclaw" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers catalog requests while a pre-roster selection conflicts with the hello default", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn().mockResolvedValue({ catalogs: [] });
      const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
      gateway.publish({
        assistantAgentId: "roboclaw",
        hello: {
          features: { methods: ["sessions.catalog.list"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      // A selection hello knows nothing about must not fetch the default's
      // catalog; it waits for the roster to validate or reconcile it.
      const { sidebar } = await mountSidebar(
        gateway.gateway,
        createSessions("main", ["agent:main:main"]),
      );
      sidebar.connected = true;
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);

      expect(request).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles an unknown selected agent before catalog requests", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn().mockResolvedValue({ catalogs: [] });
      const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
      gateway.publish({
        hello: {
          features: { methods: ["sessions.catalog.list"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      const { sidebar } = await mountSidebar(
        gateway.gateway,
        createSessions("main", ["agent:main:main"]),
        "panel",
        {
          defaultId: "roboclaw",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "roboclaw" }],
        },
      );
      sidebar.connected = true;
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);

      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith(
        "sessions.catalog.list",
        expect.objectContaining({ agentId: "roboclaw" }),
      );
      expect(request).not.toHaveBeenCalledWith(
        "sessions.catalog.list",
        expect.objectContaining({ agentId: "main" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the roster default when no agent is selected", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn().mockResolvedValue({ catalogs: [] });
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
          defaultId: "roboclaw",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "main" }, { id: "roboclaw" }],
        },
      );
      context.agentSelection.state.selectedId = null;
      sidebar.connected = true;
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);

      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith(
        "sessions.catalog.list",
        expect.objectContaining({ agentId: "roboclaw" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a roster owned by a replaced gateway client", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn().mockResolvedValue({ catalogs: [] });
      const currentClient = { request } as unknown as GatewayBrowserClient;
      const gateway = createGatewayHarness(currentClient);
      gateway.publish({
        assistantAgentId: "roboclaw",
        hello: {
          features: { methods: ["sessions.catalog.list"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      const { sidebar, context } = await mountSidebar(
        gateway.gateway,
        createSessions("roboclaw", ["agent:roboclaw:main"]),
        "panel",
        {
          defaultId: "roboclaw",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "roboclaw" }],
        },
      );
      expect(context.agentSelection.state.selectedId).toBe("roboclaw");
      // Establish selection from the current roster before exposing a stale snapshot.
      context.agents.state.client = {
        request: vi.fn(),
      } as unknown as GatewayBrowserClient;
      context.agents.state.agentsList = {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main" }],
      };
      sidebar.connected = true;
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);

      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith(
        "sessions.catalog.list",
        expect.objectContaining({ agentId: "roboclaw" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers catalog requests without a roster or hello default", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn().mockResolvedValue({ catalogs: [] });
      const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
      gateway.publish({
        assistantAgentId: null,
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

      expect(request).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("queues one recovery when a pending catalog rejects after admission reopens", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const pending = deferred<ReturnType<typeof catalogPage>>();
      const request = vi
        .fn()
        .mockResolvedValueOnce(catalogPage([{ threadId: "thread-one", name: "Retained session" }]))
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue(catalogPage([{ threadId: "thread-one", name: "Recovered session" }]));
      const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
      gateway.publish({
        suspensionPhase: "accepting",
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
      const refresh = sidebar.sessionData.refreshSessionCatalogs();
      gateway.publish({ suspensionPhase: "draining" });
      gateway.publish({ suspensionPhase: "accepting" });
      await vi.advanceTimersByTimeAsync(50);
      expect(request).toHaveBeenCalledTimes(2);
      pending.reject(
        new GatewayRequestError({
          code: "UNAVAILABLE",
          message: "Gateway is suspending",
          retryable: true,
          details: { reason: "gateway-suspending", phase: "draining" },
        }),
      );
      await refresh;
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;
      expect(request).toHaveBeenCalledTimes(3);
      expect(sidebar.textContent).toContain("Recovered session");
      expect(sidebar.querySelector(".sidebar-session-catalog-error")).toBeNull();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([
    {
      code: "UNAVAILABLE",
      reason: "gateway-suspending",
      message: "sessions.catalog.list unavailable during gateway suspension",
    },
    { code: "UNAVAILABLE", reason: undefined, message: "Catalog service unavailable" },
    { code: "INVALID_REQUEST", reason: undefined, message: 'unknown agent id "main"' },
  ])(
    "recovers $code/$reason once when the same Gateway accepts work",
    async ({ code, reason, message }) => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const request = vi
          .fn()
          .mockResolvedValue(catalogPage([{ threadId: "thread-one", name: "Retained session" }]));
        const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
        gateway.publish({
          suspensionPhase: "accepting",
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
        expect(sidebar.textContent).toContain("Retained session");
        request.mockRejectedValue(
          new GatewayRequestError({
            code,
            message,
            retryable: true,
            details: reason ? { reason, phase: "draining" } : undefined,
          }),
        );
        if (reason) {
          gateway.publish({ suspensionPhase: "draining" });
        }
        await sidebar.sessionData.refreshSessionCatalogs();
        await sidebar.updateComplete;
        const error = sidebar.querySelector<HTMLElement>(".sidebar-session-catalog-error");
        if (reason) {
          expect(error).toBeNull();
        } else {
          expect(error?.textContent).toContain(message);
          expect(error?.textContent).toContain("Showing stale data");
          expect(error?.querySelector("button")).toBeNull();
          gateway.publish({ suspensionPhase: "draining" });
        }
        expect(sidebar.textContent).toContain("Retained session");
        expect(request).toHaveBeenCalledTimes(2);
        request.mockResolvedValue(
          catalogPage([{ threadId: "thread-one", name: "Recovered session" }]),
        );
        gateway.publish({ suspensionPhase: "accepting" });
        await vi.advanceTimersByTimeAsync(49);
        expect(request).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        await sidebar.updateComplete;
        expect(request).toHaveBeenCalledTimes(3);
        expect(sidebar.textContent).toContain("Recovered session");
        expect(sidebar.querySelector(".sidebar-session-catalog-error")).toBeNull();
        gateway.publish({ assistantAgentId: "main" });
        await vi.advanceTimersByTimeAsync(50);
        expect(request).toHaveBeenCalledTimes(3);
      } finally {
        warn.mockRestore();
        vi.useRealTimers();
      }
    },
  );
});
