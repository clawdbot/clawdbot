import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";

const mocks = vi.hoisted(() => ({
  buildSessionListSqlQuery: vi.fn(() => ({
    lineage: {},
    query: { archived: false, includeGlobal: true, includeUnknown: false, limit: 60 },
  })),
  events: [] as string[],
  sessionEntryCounts: new Map<string, number>(),
  loadCombinedSessionStoreForGateway: vi.fn((_cfg: unknown, options: { agentId: string }) => {
    mocks.events.push(`sessions.load.${options.agentId}`);
    const entryCount = mocks.sessionEntryCounts.get(options.agentId) ?? 0;
    return {
      creatorActors: [],
      durableStorePath: `/state/${options.agentId}.sqlite`,
      selectionExact: true,
      storePath: `/state/${options.agentId}.sqlite`,
      store: {},
      totalCount: entryCount,
    };
  }),
  listSessionsFromStoreAsync: vi.fn(async (params: { opts: { agentId: string } }) => {
    mocks.events.push(`sessions.rows.${params.opts.agentId}`);
    return { sessions: [] };
  }),
  listManagedPlugins: vi.fn(async () => {
    mocks.events.push("plugins");
    return { plugins: [] };
  }),
  prewarmSessionCatalogList: vi.fn(async (params: { agentId: string }) => {
    mocks.events.push(`catalog.${params.agentId}`);
  }),
}));

vi.mock("../config/sessions/combined-store-gateway.js", () => ({
  loadCombinedSessionStoreForGateway: mocks.loadCombinedSessionStoreForGateway,
}));

vi.mock("./session-utils-list.js", () => ({
  buildSessionListSqlQuery: mocks.buildSessionListSqlQuery,
  listSessionsFromStoreAsync: mocks.listSessionsFromStoreAsync,
}));

vi.mock("../plugins/management-service.js", () => ({
  listManagedPlugins: mocks.listManagedPlugins,
}));

vi.mock("./server-methods/session-catalog.js", () => ({
  prewarmSessionCatalogList: mocks.prewarmSessionCatalogList,
}));

const { scheduleGatewayHandlerPrewarm } = await import("./server-startup-handler-prewarm.js");

beforeEach(() => {
  mocks.events.length = 0;
  mocks.sessionEntryCounts.clear();
  mocks.buildSessionListSqlQuery.mockClear();
  mocks.loadCombinedSessionStoreForGateway.mockClear();
  mocks.listSessionsFromStoreAsync.mockClear();
  mocks.listManagedPlugins.mockClear();
  mocks.prewarmSessionCatalogList.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  resetGatewayWorkAdmission();
});

describe("scheduleGatewayHandlerPrewarm", () => {
  it("warms the handler-owned caches in bounded dashboard order", async () => {
    vi.useFakeTimers();
    const cfg = {
      agents: { list: [{ id: "main", default: true }, { id: "research" }] },
    } as never;

    const sidecar = scheduleGatewayHandlerPrewarm({
      cfgAtStart: cfg,
      log: { warn: vi.fn() },
    });

    expect(mocks.events).toEqual([]);
    await vi.runAllTimersAsync();

    expect(mocks.events).toEqual([
      "sessions.load.main",
      "sessions.rows.main",
      "sessions.load.research",
      "sessions.rows.research",
      "plugins",
      "catalog.main",
      "catalog.research",
    ]);
    expect(mocks.loadCombinedSessionStoreForGateway).toHaveBeenNthCalledWith(1, cfg, {
      agentId: "main",
      includeRowContext: true,
      projection: "list",
      query: expect.objectContaining({ limit: 60 }),
    });
    expect(mocks.loadCombinedSessionStoreForGateway).toHaveBeenNthCalledWith(2, cfg, {
      agentId: "research",
      includeRowContext: true,
      projection: "list",
      query: expect.objectContaining({ limit: 60 }),
    });
    expect(mocks.listSessionsFromStoreAsync).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        cfg,
        opts: {
          agentId: "main",
          configuredAgentsOnly: true,
          includeDerivedTitles: true,
          includeGlobal: true,
          includeUnknown: true,
          limit: 60,
        },
      }),
    );
    expect(mocks.listManagedPlugins).toHaveBeenCalledWith({ config: cfg });
    expect(mocks.prewarmSessionCatalogList).toHaveBeenNthCalledWith(1, {
      config: cfg,
      agentId: "main",
      limitPerHost: 40,
    });
    expect(mocks.prewarmSessionCatalogList).toHaveBeenNthCalledWith(2, {
      config: cfg,
      agentId: "research",
      limitPerHost: 40,
    });
    sidecar.stop();
  });

  it("logs failures and continues without changing later request behavior", async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const laterPrewarm = vi.fn(async () => {});
    const requestLoad = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("cold read failed"))
      .mockResolvedValue("request result");

    scheduleGatewayHandlerPrewarm({
      cfgAtStart: {} as never,
      log: { warn },
      items: [
        {
          name: "broken",
          load: requestLoad,
        },
        { name: "later", load: laterPrewarm },
      ],
    });

    await vi.runAllTimersAsync();

    expect(warn).toHaveBeenCalledWith(
      "post-ready gateway data prewarm failed for broken: Error: cold read failed",
    );
    expect(requestLoad).toHaveBeenCalledOnce();
    expect(laterPrewarm).toHaveBeenCalledOnce();
    await expect(requestLoad()).resolves.toBe("request result");
  });

  it("skips optional catalog prewarm when the combined session stores are large", async () => {
    vi.useFakeTimers();
    mocks.sessionEntryCounts.set("main", 2_001);
    const cfg = {
      agents: { list: [{ id: "main", default: true }, { id: "research" }] },
    } as never;

    scheduleGatewayHandlerPrewarm({
      cfgAtStart: cfg,
      log: { warn: vi.fn() },
    });
    await vi.runAllTimersAsync();

    expect(mocks.events).toEqual([
      "sessions.load.main",
      "sessions.rows.main",
      "sessions.load.research",
      "sessions.rows.research",
      "plugins",
    ]);
    expect(mocks.prewarmSessionCatalogList).not.toHaveBeenCalled();
  });

  it("stops before scheduling another event-loop turn", async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    const first = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    const second = vi.fn(async () => {});
    const sidecar = scheduleGatewayHandlerPrewarm({
      cfgAtStart: {} as never,
      log: { warn: vi.fn() },
      items: [
        { name: "first", load: first },
        { name: "second", load: second },
      ],
    });

    await vi.advanceTimersToNextTimerAsync();
    expect(first).toHaveBeenCalledOnce();
    sidecar.stop();
    releaseFirst();
    await vi.runAllTimersAsync();

    expect(second).not.toHaveBeenCalled();
  });
});
