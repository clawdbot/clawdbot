import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  canPrewarmCombinedSessionStoresForGateway: vi.fn(() => {
    mocks.events.push("sessions.count");
    return true;
  }),
  loadCombinedSessionStoreForGateway: vi.fn((_cfg: unknown, options: { agentId: string }) => {
    mocks.events.push(`sessions.load.${options.agentId}`);
    return {
      durableStorePath: `/state/${options.agentId}.sqlite`,
      storePath: `/state/${options.agentId}.sqlite`,
      store: {},
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
  canPrewarmCombinedSessionStoresForGateway: mocks.canPrewarmCombinedSessionStoresForGateway,
  loadCombinedSessionStoreForGateway: mocks.loadCombinedSessionStoreForGateway,
}));

vi.mock("./session-utils-list.js", () => ({
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
  mocks.canPrewarmCombinedSessionStoresForGateway.mockClear();
  mocks.canPrewarmCombinedSessionStoresForGateway.mockImplementation(() => {
    mocks.events.push("sessions.count");
    return true;
  });
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
      "sessions.count",
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
      projection: "list",
    });
    expect(mocks.loadCombinedSessionStoreForGateway).toHaveBeenNthCalledWith(2, cfg, {
      agentId: "research",
      projection: "list",
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
    expect(mocks.canPrewarmCombinedSessionStoresForGateway).toHaveBeenCalledWith(cfg, {
      agentIds: ["main", "research"],
      maxRows: 2_000,
    });
    sidecar.stop();
  });

  it("waits for gateway readiness before warming handler data", async () => {
    vi.useFakeTimers();
    let releaseGatewayReady!: () => void;
    const gatewayReady = new Promise<void>((resolve) => {
      releaseGatewayReady = resolve;
    });
    const load = vi.fn(async () => {});

    const sidecar = scheduleGatewayHandlerPrewarm({
      cfgAtStart: {} as never,
      log: { warn: vi.fn() },
      items: [{ name: "sessions", load }],
      waitForPostReadyWork: () => gatewayReady,
    });

    await vi.advanceTimersToNextTimerAsync();
    expect(load).not.toHaveBeenCalled();

    releaseGatewayReady();
    await vi.runAllTimersAsync();
    expect(load).toHaveBeenCalledOnce();
    sidecar.stop();
  });

  it("waits for admitted request work before warming handler data", async () => {
    vi.useFakeTimers();
    const admission = tryBeginGatewayRootWorkAdmission();
    if (!admission) {
      throw new Error("Expected request work admission");
    }
    const load = vi.fn(async () => {});
    const sidecar = scheduleGatewayHandlerPrewarm({
      cfgAtStart: {} as never,
      log: { warn: vi.fn() },
      items: [{ name: "sessions", load }],
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(load).not.toHaveBeenCalled();

    admission.release();
    await vi.advanceTimersByTimeAsync(249);
    expect(load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    sidecar.stop();
  });

  it("stays stopped when readiness arrives after shutdown", async () => {
    vi.useFakeTimers();
    let releaseGatewayReady!: () => void;
    const gatewayReady = new Promise<void>((resolve) => {
      releaseGatewayReady = resolve;
    });
    const load = vi.fn(async () => {});

    const sidecar = scheduleGatewayHandlerPrewarm({
      cfgAtStart: {} as never,
      log: { warn: vi.fn() },
      items: [{ name: "sessions", load }],
      waitForPostReadyWork: () => gatewayReady,
    });

    await vi.advanceTimersToNextTimerAsync();
    sidecar.stop();
    releaseGatewayReady();
    await vi.runAllTimersAsync();

    expect(load).not.toHaveBeenCalled();
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
    const info = vi.fn();
    mocks.canPrewarmCombinedSessionStoresForGateway.mockImplementation(() => {
      mocks.events.push("sessions.count");
      return false;
    });
    const cfg = {
      agents: { list: [{ id: "main", default: true }, { id: "research" }] },
    } as never;

    scheduleGatewayHandlerPrewarm({
      cfgAtStart: cfg,
      log: { info, warn: vi.fn() },
    });
    await vi.runAllTimersAsync();

    expect(mocks.events).toEqual(["sessions.count", "plugins"]);
    expect(mocks.prewarmSessionCatalogList).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      "skipping optional dashboard session prewarm: combined stores exceed 2000 rows",
    );
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
