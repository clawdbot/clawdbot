import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createGatewayHarness, createSessions, mountSidebar } from "../app-sidebar.ts";
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

  it("does not retry unrelated INVALID_REQUEST failures and renders a local retry", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const request = vi.fn().mockRejectedValue(
        new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: 'unknown agent id "main"',
        }),
      );
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

      expect(request).toHaveBeenCalledTimes(1);
      const error = sidebar.querySelector<HTMLElement>(".sidebar-session-catalog-error");
      expect(error?.textContent).toContain('unknown agent id "main"');

      error?.querySelector<HTMLButtonElement>("button")?.click();
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;

      expect(request).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});
