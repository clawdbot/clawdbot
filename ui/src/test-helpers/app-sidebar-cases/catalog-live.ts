import { describe, expect, it, vi } from "vitest";
import type {
  SessionsCatalogHostEvent,
  SessionsCatalogListResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  catalogPage,
  createContext,
  createGateway,
  createGatewayHarness,
  createSessions,
  deferred,
  mountSidebar,
  type TestSessionMenu,
} from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar session catalog pagination", () => {
  it("falls back to final pages when an older Gateway rejects progressId", async () => {
    vi.useFakeTimers();
    try {
      const request = vi
        .fn()
        .mockRejectedValueOnce(
          new GatewayRequestError({ code: "INVALID_REQUEST", message: "invalid params" }),
        )
        .mockResolvedValue(catalogPage([]));
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

      expect(request).toHaveBeenNthCalledWith(1, "sessions.catalog.list", {
        agentId: "main",
        limitPerHost: 40,
        progressId: expect.any(String),
      });
      expect(request).toHaveBeenNthCalledWith(2, "sessions.catalog.list", {
        agentId: "main",
        limitPerHost: 40,
      });

      await vi.advanceTimersByTimeAsync(30_000);
      expect(request).toHaveBeenNthCalledWith(3, "sessions.catalog.list", {
        agentId: "main",
        limitPerHost: 40,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a legacy fallback that settles after the Gateway client changes", async () => {
    vi.useFakeTimers();
    try {
      const legacyFallback = deferred<SessionsCatalogListResult>();
      const legacyRequest = vi
        .fn()
        .mockRejectedValueOnce(
          new GatewayRequestError({ code: "INVALID_REQUEST", message: "invalid params" }),
        )
        .mockReturnValueOnce(legacyFallback.promise);
      const legacyGateway = createGatewayHarness({
        request: legacyRequest,
      } as unknown as GatewayBrowserClient);
      legacyGateway.publish({
        hello: {
          features: { methods: ["sessions.catalog.list"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      const sessions = createSessions("main", ["agent:main:main"]);
      const { provider, sidebar } = await mountSidebar(legacyGateway.gateway, sessions);
      sidebar.connected = true;
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);
      expect(legacyRequest).toHaveBeenCalledTimes(2);

      const currentRequest = vi.fn().mockResolvedValue(catalogPage([]));
      const currentGateway = createGatewayHarness({
        request: currentRequest,
      } as unknown as GatewayBrowserClient);
      currentGateway.publish({
        hello: {
          features: { methods: ["sessions.catalog.list"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      provider.setContext(createContext(currentGateway.gateway, sessions));
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);

      legacyFallback.resolve(catalogPage([]));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(currentRequest).toHaveBeenCalledTimes(2);
      expect(currentRequest).toHaveBeenNthCalledWith(2, "sessions.catalog.list", {
        agentId: "main",
        limitPerHost: 40,
        progressId: expect.any(String),
      });
    } finally {
      vi.useRealTimers();
    }
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
    sidebar.sessionData.sessionCatalogs = [
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
    sidebar.sessionData.requestSessionDataUpdate();
    await sidebar.updateComplete;

    const button = sidebar.querySelector<HTMLButtonElement>(".sidebar-session-catalog-new");
    expect(button?.getAttribute("aria-label")).toBe("New thread — Claude Code");
    button?.click();

    expect(onOpenNewSession).toHaveBeenCalledWith("research", { catalogId: "claude" });
  });

  it.each([
    { id: "claude", label: "Claude Code" },
    { id: "codex", label: "Codex" },
  ])("groups $label catalog rows by their owning host", async ({ id, label }) => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    sidebar.sessionData.sessionCatalogs = [
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
                pullRequest: { numbers: [111751, 111772], state: "merged" },
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
    sidebar.sessionData.requestSessionDataUpdate();
    await sidebar.updateComplete;

    const section = sidebar.querySelector(`[data-session-section="catalog:${id}"]`);
    const hostGroups = section?.querySelectorAll<HTMLElement>("[data-session-catalog-host]");
    expect(Array.from(hostGroups ?? []).map((host) => host.dataset.sessionCatalogHost)).toEqual([
      "gateway:local",
      "node:build",
    ]);
    const local = section?.querySelector('[data-session-catalog-host="gateway:local"]');
    const remote = section?.querySelector('[data-session-catalog-host="node:build"]');
    expect(local?.querySelector(".sidebar-session-catalog-host__head")).toBeNull();
    expect(local?.textContent).not.toContain("Gateway Mac");
    expect(local?.textContent).toContain("Local plan");
    const pullRequestBadge = local?.querySelector(".session-row-badge--pull-request");
    expect(pullRequestBadge?.hasAttribute("title")).toBe(false);
    expect(
      (pullRequestBadge?.closest("openclaw-tooltip") as (HTMLElement & { content?: string }) | null)
        ?.content,
    ).toBe("#111751, #111772 · Merged");
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
    sidebar.sessionData.sessionCatalogs = [
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
                pullRequest: { numbers: [107302], state: "draft" },
                archived: false,
                sessionKey: backingSessionKey,
                canContinue: true,
                canArchive: false,
              },
            ],
          },
        ],
      },
    ];
    const backingRows = (sidebar.sessionData.sessionsResult?.sessions ?? []).map((row) =>
      row.key === backingSessionKey ? Object.assign({}, row, { unread: true }) : row,
    );
    sidebar.sessionData.sessionsResult = {
      ...sidebar.sessionData.sessionsResult!,
      sessions: backingRows,
    };
    sidebar.sessionData.sessionRowsByAgent = { main: backingRows };
    sidebar.sessionData.requestSessionDataUpdate();
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
    const pullRequestBadge = linkedRow?.querySelector(".session-row-badge--pull-request");
    expect(pullRequestBadge?.hasAttribute("title")).toBe(false);
    expect(
      (pullRequestBadge?.closest("openclaw-tooltip") as (HTMLElement & { content?: string }) | null)
        ?.content,
    ).toBe("#107302 · Draft");
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
    sidebar.sessionData.sessionsResult = {
      ...sidebar.sessionData.sessionsResult,
      sessions: runningRows,
    };
    sidebar.sessionData.sessionRowsByAgent = { main: runningRows };
    sidebar.sessionData.requestSessionDataUpdate();
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

  it("renders each catalog host before the aggregate list response finishes", async () => {
    vi.useFakeTimers();
    try {
      const pending = deferred<SessionsCatalogListResult>();
      const request = vi.fn().mockReturnValue(pending.promise);
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

      const progressId = (request.mock.calls[0]?.[1] as { progressId?: string })?.progressId;
      expect(progressId).toEqual(expect.any(String));
      const catalog = catalogPage([{ threadId: "thread-fast", name: "Fast host" }]).catalogs[0];
      if (!progressId || !catalog) {
        throw new Error("progressive catalog fixture is incomplete");
      }
      gateway.publishEvent("sessions.catalog.host", {
        progressId,
        agentId: "main",
        catalog,
      } satisfies SessionsCatalogHostEvent);
      await sidebar.updateComplete;

      expect(sidebar.textContent).toContain("Fast host");
      expect(request).toHaveBeenCalledTimes(1);

      pending.resolve(catalogPage([{ threadId: "thread-fast", name: "Fast host" }]));
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a late host event after a newer catalog request starts", async () => {
    vi.useFakeTimers();
    try {
      const initialPage = catalogPage([]);
      const initialCatalog = initialPage.catalogs[0];
      const localHost = initialCatalog?.hosts[0];
      if (!initialCatalog || !localHost) {
        throw new Error("initial catalog fixture is incomplete");
      }
      const removedHost = {
        ...localHost,
        hostId: "node:removed",
        label: "Removed node",
        kind: "node" as const,
        sessions: [],
        error: { code: "NODE_INVOKE_FAILED", message: "Node timed out" },
      };
      const request = vi
        .fn()
        .mockResolvedValueOnce({
          catalogs: [{ ...initialCatalog, hosts: [localHost, removedHost] }],
        })
        .mockResolvedValue(catalogPage([]));
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

      const oldProgressId = (request.mock.calls[0]?.[1] as { progressId?: string })?.progressId;
      expect(oldProgressId).toEqual(expect.any(String));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(request).toHaveBeenCalledTimes(2);

      const staleCatalog = catalogPage([{ threadId: "thread-obsolete", name: "Obsolete session" }])
        .catalogs[0];
      const staleHost = staleCatalog?.hosts[0];
      if (!oldProgressId || !staleCatalog || !staleHost) {
        throw new Error("stale catalog fixture is incomplete");
      }
      gateway.publishEvent("sessions.catalog.host", {
        progressId: oldProgressId,
        agentId: "main",
        catalog: {
          ...staleCatalog,
          hosts: [{ ...staleHost, hostId: "node:removed", label: "Removed node", kind: "node" }],
        },
      } satisfies SessionsCatalogHostEvent);
      await sidebar.updateComplete;

      expect(sidebar.textContent).not.toContain("Obsolete session");
      expect(sidebar.sessionData.sessionCatalogs[0]?.hosts).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts a slow older host when a newer scan has only timed out", async () => {
    vi.useFakeTimers();
    try {
      const timeoutPage = catalogPage([]);
      const catalog = timeoutPage.catalogs[0];
      const localHost = catalog?.hosts[0];
      if (!catalog || !localHost) {
        throw new Error("slow catalog fixture is incomplete");
      }
      const timeoutHost = {
        ...localHost,
        hostId: "node:slow",
        label: "Slow node",
        kind: "node" as const,
        sessions: [],
        error: { code: "NODE_INVOKE_FAILED", message: "Node timed out" },
      };
      const finalPage = {
        catalogs: [{ ...catalog, hosts: [localHost, timeoutHost] }],
      } satisfies SessionsCatalogListResult;
      const pendingTimeout = deferred<SessionsCatalogListResult>();
      const request = vi
        .fn()
        .mockResolvedValueOnce(finalPage)
        .mockReturnValueOnce(pendingTimeout.promise)
        .mockResolvedValue(finalPage);
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

      const oldProgressId = (request.mock.calls[0]?.[1] as { progressId?: string })?.progressId;
      await vi.advanceTimersByTimeAsync(30_000);
      if (!oldProgressId) {
        throw new Error("first catalog request has no progress id");
      }
      gateway.publishEvent("sessions.catalog.host", {
        progressId: oldProgressId,
        agentId: "main",
        catalog: {
          ...catalog,
          hosts: [
            {
              ...timeoutHost,
              sessions: [
                {
                  threadId: "thread-eventual",
                  name: "Eventually ready",
                  status: "idle",
                  archived: false,
                  canContinue: true,
                  canArchive: true,
                },
              ],
              error: undefined,
            },
          ],
        },
      } satisfies SessionsCatalogHostEvent);
      await sidebar.updateComplete;

      expect(sidebar.textContent).toContain("Eventually ready");
      pendingTimeout.resolve(finalPage);
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;
      expect(sidebar.textContent).toContain("Eventually ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it("discovers an external session on the stable poll and then follows changes quickly", async () => {
    vi.useFakeTimers();
    try {
      const empty = catalogPage([]);
      const discovered = catalogPage([{ threadId: "thread-external", name: "External session" }]);
      const request = vi
        .fn()
        .mockResolvedValueOnce(empty)
        .mockResolvedValueOnce(discovered)
        .mockResolvedValue(discovered);
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

      expect(request).toHaveBeenCalledTimes(1);
      expect(sidebar.textContent).not.toContain("External session");

      await vi.advanceTimersByTimeAsync(30_000);
      await sidebar.updateComplete;
      expect(request).toHaveBeenCalledTimes(2);
      expect(sidebar.textContent).toContain("External session");

      await vi.advanceTimersByTimeAsync(4_999);
      expect(request).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns to the stable cadence when only a progressive host order changed", async () => {
    vi.useFakeTimers();
    try {
      const basePage = catalogPage([{ threadId: "thread-local", name: "Local session" }]);
      const catalog = basePage.catalogs[0];
      const localHost = catalog?.hosts[0];
      if (!catalog || !localHost) {
        throw new Error("ordered catalog fixture is incomplete");
      }
      const pairedHost = {
        ...localHost,
        hostId: "node:paired",
        label: "A paired node",
        kind: "node" as const,
        sessions: [],
      };
      const stablePage: SessionsCatalogListResult = {
        catalogs: [
          {
            ...catalog,
            hosts: [{ ...localHost, label: "Z local Gateway" }, pairedHost],
          },
        ],
      };
      const pending = deferred<SessionsCatalogListResult>();
      const request = vi
        .fn()
        .mockResolvedValueOnce(stablePage)
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue(stablePage);
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

      await vi.advanceTimersByTimeAsync(30_000);
      const progressId = (request.mock.calls[1]?.[1] as { progressId?: string })?.progressId;
      if (!progressId) {
        throw new Error("second catalog request has no progress id");
      }
      gateway.publishEvent("sessions.catalog.host", {
        progressId,
        agentId: "main",
        catalog: { ...catalog, hosts: [pairedHost] },
      } satisfies SessionsCatalogHostEvent);
      pending.resolve(stablePage);
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(request).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(request).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes immediately when paired-node presence changes", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn().mockResolvedValue(catalogPage([]));
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

      gateway.publishEvent("presence", {
        presence: [{ deviceId: "node-1", mode: "node", reason: "connect" }],
      });
      expect(request).toHaveBeenCalledTimes(2);

      gateway.publishEvent("presence", {
        presence: [{ deviceId: "node-1", mode: "node", reason: "disconnect" }],
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
