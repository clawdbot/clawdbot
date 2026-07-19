import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { catalogPage, createGatewayHarness, createSessions, mountSidebar } from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar session catalog pagination", () => {
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
        progressId: expect.any(String),
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
        progressId: expect.any(String),
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
});
