import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronServiceContract } from "../cron/service-contract.js";
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

describe("createLazyGatewayCronState", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    hoisted.buildGatewayCronService.mockClear();
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
    expect(cron.status).toHaveBeenCalledTimes(1);
  });

  it("starts the loaded cron service once", async () => {
    const cron = createCronService();
    hoisted.setState(createCronState(cron));

    const lazy = createLazyGatewayCronState(createParams());

    await lazy.cron.start();
    await lazy.cron.start();

    expect(hoisted.buildGatewayCronService).toHaveBeenCalledTimes(1);
    expect(cron.start).toHaveBeenCalledTimes(1);
  });

  it("does not start cron after stop wins the lazy startup race", async () => {
    const cron = createCronService();
    hoisted.setState(createCronState(cron));

    const lazy = createLazyGatewayCronState(createParams());
    const startPromise = lazy.cron.start();

    lazy.cron.stop();
    await startPromise;

    expect(cron.start).not.toHaveBeenCalled();
    expect(cron.stop).toHaveBeenCalledTimes(1);
  });

  it("allows a stopped loaded cron service to start again", async () => {
    const cron = createCronService();
    hoisted.setState(createCronState(cron));

    const lazy = createLazyGatewayCronState(createParams());

    await lazy.cron.start();
    lazy.cron.stop();
    await lazy.cron.start();

    expect(hoisted.buildGatewayCronService).toHaveBeenCalledTimes(1);
    expect(cron.stop).toHaveBeenCalledTimes(1);
    expect(cron.start).toHaveBeenCalledTimes(2);
  });

  it("keeps synchronous wake non-blocking before the cron service is loaded", async () => {
    const cron = createCronService();
    hoisted.setState(createCronState(cron));

    const lazy = createLazyGatewayCronState(createParams());

    expect(lazy.cron.wake({ mode: "now", text: "ping" })).toEqual({ ok: false });

    await vi.waitFor(() => {
      expect(hoisted.buildGatewayCronService).toHaveBeenCalledTimes(1);
    });
    expect(cron.wake).not.toHaveBeenCalled();
  });

  it("preserves the startup cron enabled flag without loading cron runtime", () => {
    vi.stubEnv("OPENCLAW_SKIP_CRON", "1");

    const lazy = createLazyGatewayCronState(createParams());

    expect(lazy.cronEnabled).toBe(false);
    expect(hoisted.buildGatewayCronService).not.toHaveBeenCalled();
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

function createCronState(cron: CronServiceContract): GatewayCronState {
  return {
    cron,
    storePath: "/tmp/openclaw-cron.json",
    cronEnabled: true,
  } as GatewayCronState;
}

function createCronService(): CronServiceContract {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    status: vi.fn(async () => ({ enabled: true }) as never),
    list: vi.fn(async () => [] as never),
    listPage: vi.fn(async () => ({ items: [], total: 0 }) as never),
    add: vi.fn(async () => ({ ok: true }) as never),
    update: vi.fn(async () => ({ ok: true }) as never),
    remove: vi.fn(async () => ({ ok: true }) as never),
    run: vi.fn(async () => ({ ok: true, ran: false, reason: "invalid-spec" }) as never),
    enqueueRun: vi.fn(async () => ({ ok: true, ran: false, reason: "invalid-spec" }) as never),
    getJob: vi.fn(() => undefined),
    getDefaultAgentId: vi.fn(() => "default"),
    wake: vi.fn(() => ({ ok: true })),
  };
}
