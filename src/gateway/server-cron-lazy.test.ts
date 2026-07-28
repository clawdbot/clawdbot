/**
 * Tests lazy cron startup behavior in the gateway server.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayCronServiceContract } from "./server-cron-contract.js";
import type { GatewayCronState } from "./server-cron.js";

const hoisted = vi.hoisted(() => {
  let state: unknown;
  return {
    buildGatewayCronService: vi.fn(() => state),
    setState(nextState: unknown) {
      state = nextState;
    },
  };
});

vi.mock("./server-cron.js", () => ({
  buildGatewayCronService: hoisted.buildGatewayCronService,
}));

const { createLazyGatewayCronState } = await import("./server-cron-lazy.js");

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createLazyGatewayCronState", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    hoisted.buildGatewayCronService.mockClear();
  });

  it("resolves its default store path from the prepared env", () => {
    const stateRoot = "/tmp/openclaw-candidate-state";
    const lazy = createLazyGatewayCronState({
      ...createParams(),
      env: { ...process.env, OPENCLAW_STATE_DIR: stateRoot },
    });

    expect(lazy.storePath).toBe(`${stateRoot}/cron/jobs.json`);
    expect(hoisted.buildGatewayCronService).not.toHaveBeenCalled();
  });

  it("respects a configured legacy cron store partition", () => {
    const customStore = "/tmp/openclaw-custom-cron/jobs.json";
    const params = createParams();
    const lazy = createLazyGatewayCronState({
      ...params,
      cfg: { ...params.cfg, cron: { store: customStore } } as unknown as OpenClawConfig,
    });

    expect(lazy.storePath).toBe(customStore);
  });

  it("does not build the heavy cron service until an async cron operation needs it", async () => {
    const cron = createCronService();
    const state = createCronState(cron);
    hoisted.setState(state);

    const lazy = createLazyGatewayCronState(createParams());

    expect(hoisted.buildGatewayCronService).not.toHaveBeenCalled();
    expect(lazy.cron.getJob("demo")).toBeUndefined();
    expect(lazy.cron.getDefaultAgentId()).toBeUndefined();

    await lazy.cron.status();

    expect(hoisted.buildGatewayCronService).toHaveBeenCalledTimes(1);
    expect(cron["status"]).toHaveBeenCalledTimes(1);
  });

  it("loads the cron service for direct job reads", async () => {
    const cron = createCronService();
    hoisted.setState(createCronState(cron));

    const lazy = createLazyGatewayCronState(createParams());
    await lazy.cron.readJob("demo");

    expect(hoisted.buildGatewayCronService).toHaveBeenCalledTimes(1);
    expect(cron["readJob"]).toHaveBeenCalledWith("demo");
  });

  it("forwards run payload overrides to the loaded cron service", async () => {
    const cron = createCronService();
    hoisted.setState(createCronState(cron));

    const lazy = createLazyGatewayCronState(createParams());
    const payload = { kind: "systemEvent" as const, text: "done" };
    await lazy.cron.run("demo", "force", { payload });

    expect(hoisted.buildGatewayCronService).toHaveBeenCalledTimes(1);
    expect(cron["run"]).toHaveBeenCalledWith("demo", "force", { payload });
  });

  it("starts the loaded cron service once", async () => {
    const cron = createCronService();
    hoisted.setState(createCronState(cron));

    const lazy = createLazyGatewayCronState(createParams());

    await lazy.cron.start();
    await lazy.cron.start();

    expect(hoisted.buildGatewayCronService).toHaveBeenCalledTimes(1);
    expect(cron["start"]).toHaveBeenCalledTimes(1);
  });

  it("does not start cron after stop wins the lazy startup race", async () => {
    const cron = createCronService();
    hoisted.setState(createCronState(cron));

    const lazy = createLazyGatewayCronState(createParams());
    const startPromise = lazy.cron.start();

    lazy.cron.stop();
    await startPromise;

    expect(cron["start"]).not.toHaveBeenCalled();
    expect(cron["stop"]).toHaveBeenCalledTimes(1);
  });

  it("allows a stopped loaded cron service to start again", async () => {
    const cron = createCronService();
    hoisted.setState(createCronState(cron));

    const lazy = createLazyGatewayCronState(createParams());

    await lazy.cron.start();
    lazy.cron.stop();
    await lazy.cron.start();

    expect(hoisted.buildGatewayCronService).toHaveBeenCalledTimes(1);
    expect(cron["stop"]).toHaveBeenCalledTimes(1);
    expect(cron["start"]).toHaveBeenCalledTimes(2);
  });

  it("restarts after stop interrupts an in-flight startup", async () => {
    const finishFirstStart = deferred();
    const cron = createCronService();
    cron.start = vi
      .fn()
      .mockImplementationOnce(async () => await finishFirstStart.promise)
      .mockResolvedValueOnce(undefined);
    hoisted.setState(createCronState(cron));
    const lazy = createLazyGatewayCronState(createParams());

    const firstStart = lazy.cron.start();
    await vi.waitFor(() => expect(cron["start"]).toHaveBeenCalledOnce());
    lazy.cron.stop();
    const restarted = lazy.cron.start();
    finishFirstStart.resolve();
    await Promise.all([firstStart, restarted]);

    expect(cron["start"]).toHaveBeenCalledTimes(2);
  });

  it("keeps synchronous wake non-blocking before the cron service is loaded", async () => {
    const cron = createCronService();
    hoisted.setState(createCronState(cron));

    const lazy = createLazyGatewayCronState(createParams());

    expect(lazy.cron.wake({ mode: "now", text: "ping" })).toEqual({ ok: false });

    await vi.waitFor(() => {
      expect(hoisted.buildGatewayCronService).toHaveBeenCalledTimes(1);
    });
    expect(cron["wake"]).not.toHaveBeenCalled();
  });

  it("preserves the startup cron enabled flag without loading cron runtime", () => {
    vi.stubEnv("OPENCLAW_SKIP_CRON", "1");

    const lazy = createLazyGatewayCronState(createParams());

    expect(lazy.cronEnabled).toBe(false);
    expect(hoisted.buildGatewayCronService).not.toHaveBeenCalled();
  });

  it("does not arm a read-loaded scheduler when suspension ends", async () => {
    const cron = createCronService();
    hoisted.setState(createCronState(cron));
    const lazy = createLazyGatewayCronState(createParams());

    lazy.cron.pauseScheduling();
    expect(hoisted.buildGatewayCronService).not.toHaveBeenCalled();

    await lazy.cron.status();
    expect(cron["pauseScheduling"]).toHaveBeenCalledOnce();
    lazy.cron.resumeScheduling();
    expect(cron["resumeScheduling"]).not.toHaveBeenCalled();

    await lazy.cron.start();
    expect(cron["resumeScheduling"]).toHaveBeenCalledOnce();
    lazy.cron.pauseScheduling();
    lazy.cron.resumeScheduling();
    expect(cron["resumeScheduling"]).toHaveBeenCalledTimes(2);
  });

  it("waits to start while scheduling is paused", async () => {
    const cron = createCronService();
    hoisted.setState(createCronState(cron));
    const lazy = createLazyGatewayCronState(createParams());

    lazy.cron.pauseScheduling();
    const startPromise = lazy.cron.start();
    await vi.waitFor(() => expect(lazy.cron.getSuspensionBlockerCount?.()).toBe(1));
    expect(cron["start"]).not.toHaveBeenCalled();

    lazy.cron.resumeScheduling();
    await startPromise;
    expect(cron["start"]).toHaveBeenCalledOnce();
    expect(lazy.cron.getSuspensionBlockerCount?.()).toBe(0);
  });

  it("keeps in-flight startup as a blocker until startup settles", async () => {
    const finishStart = deferred();
    const cron = createCronService();
    cron.start = vi.fn(async () => await finishStart.promise);
    hoisted.setState(createCronState(cron));
    const lazy = createLazyGatewayCronState(createParams());

    const startPromise = lazy.cron.start();
    await vi.waitFor(() => expect(cron["start"]).toHaveBeenCalledOnce());
    expect(lazy.cron.getSuspensionBlockerCount?.()).toBe(1);

    lazy.cron.pauseScheduling();
    lazy.cron.resumeScheduling();
    expect(cron["resumeScheduling"]).toHaveBeenCalledOnce();
    expect(lazy.cron.getSuspensionBlockerCount?.()).toBe(1);

    finishStart.resolve();
    await startPromise;
    expect(lazy.cron.getSuspensionBlockerCount?.()).toBe(0);
  });

  it("resumes a paused scheduler while exit watchers are reconciling", async () => {
    const reconcileStarted = deferred();
    const finishReconcile = deferred();
    const cron = createCronService();
    hoisted.setState({
      ...createCronState(cron),
      reconcileExitWatchers: vi.fn(async () => {
        reconcileStarted.resolve();
        await finishReconcile.promise;
      }),
    });
    const lazy = createLazyGatewayCronState(createParams());

    const startPromise = lazy.cron.start();
    await reconcileStarted.promise;
    expect(lazy.cron.getSuspensionBlockerCount?.()).toBe(1);

    lazy.cron.pauseScheduling();
    lazy.cron.resumeScheduling();
    expect(cron["resumeScheduling"]).toHaveBeenCalledOnce();

    finishReconcile.resolve();
    await startPromise;
    expect(lazy.cron.getSuspensionBlockerCount?.()).toBe(0);
  });

  it("allows startup to retry after the underlying service rejects", async () => {
    const cron = createCronService();
    cron.start = vi
      .fn()
      .mockRejectedValueOnce(new Error("startup failed"))
      .mockResolvedValueOnce(undefined);
    hoisted.setState(createCronState(cron));
    const lazy = createLazyGatewayCronState(createParams());

    await expect(lazy.cron.start()).rejects.toThrow("startup failed");
    await lazy.cron.start();

    expect(cron["start"]).toHaveBeenCalledTimes(2);
  });

  it("does not reconcile exit watchers when cron is disabled", async () => {
    const cron = createCronService();
    const reconcileExitWatchers = vi.fn(async () => {});
    hoisted.setState({
      ...createCronState(cron),
      cronEnabled: false,
      reconcileExitWatchers,
    });

    const lazy = createLazyGatewayCronState(createParams({ cron: { enabled: false } }));
    await lazy.cron.start();

    expect(cron["start"]).toHaveBeenCalledTimes(1);
    expect(reconcileExitWatchers).not.toHaveBeenCalled();
  });
});

function createParams(overrides: Partial<OpenClawConfig> = {}) {
  return {
    cfg: {
      ...overrides,
    } as OpenClawConfig,
    deps: {} as CliDeps,
    broadcast: vi.fn(),
  };
}

function createCronState(cron: GatewayCronServiceContract): GatewayCronState {
  return {
    cron,
    storePath: "/tmp/openclaw-cron.json",
    cronEnabled: true,
  } as GatewayCronState;
}

function createCronService(): GatewayCronServiceContract {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    pauseScheduling: vi.fn(),
    resumeScheduling: vi.fn(),
    status: vi.fn(async () => ({ enabled: true }) as never),
    list: vi.fn(async () => [] as never),
    listPage: vi.fn(async () => ({ items: [], total: 0 }) as never),
    add: vi.fn(async () => ({ ok: true }) as never),
    update: vi.fn(async () => ({ ok: true }) as never),
    updateWithPrecondition: vi.fn(async () => ({ ok: true }) as never),
    remove: vi.fn(async () => ({ ok: true }) as never),
    removeAgentJobsTransactional: vi.fn(async (_agentId, commit) => await commit()),
    run: vi.fn(async () => ({ ok: true, ran: false, reason: "invalid-spec" }) as never),
    enqueueRun: vi.fn(async () => ({ ok: true, ran: false, reason: "invalid-spec" }) as never),
    getJob: vi.fn(() => undefined),
    readJob: vi.fn(async () => undefined),
    readScratch: vi.fn(async () => ({ currentRevision: 0 })),
    writeScratch: vi.fn(async () => ({ ok: true, currentRevision: 1 }) as never),
    getDefaultAgentId: vi.fn(() => "default"),
    wake: vi.fn(() => ({ ok: true })),
  };
}
