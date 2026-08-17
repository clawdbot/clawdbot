// ACPX tests cover register plugin behavior.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runtimeRegistry } = vi.hoisted(() => ({
  runtimeRegistry: new Map<string, { runtime: unknown }>(),
}));

type BackendLifecycle = {
  publish: (backend: { runtime: unknown }) => void;
  retract: (runtime: unknown) => void;
};

const { realRuntime, realServiceStartMock, realServiceStopMock, createRealServiceMock } =
  vi.hoisted(() => {
    const runtime = {
      async ensureSession(input: { sessionKey: string }) {
        return {
          backend: "acpx",
          runtimeSessionName: input.sessionKey,
          sessionKey: input.sessionKey,
        };
      },
      startTurn(input: { requestId: string }) {
        return {
          requestId: input.requestId,
          events: (async function* () {})(),
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
          cancel: async () => {},
          closeStream: async () => {},
        };
      },
      async *runTurn() {},
      async cancel() {},
      async close() {},
      isHealthy: vi.fn(() => true),
      probeAvailability: vi.fn(async () => {}),
    };
    const start = vi.fn(async (_ctx: unknown, backendLifecycle?: BackendLifecycle) => {
      if (backendLifecycle) {
        backendLifecycle.publish({ runtime });
      } else {
        runtimeRegistry.set("acpx", { runtime });
      }
    });
    const stop = vi.fn(async (_ctx: unknown, backendLifecycle?: BackendLifecycle) => {
      if (backendLifecycle) {
        backendLifecycle.retract(runtime);
      } else {
        runtimeRegistry.delete("acpx");
      }
    });
    return {
      realRuntime: runtime,
      realServiceStartMock: start,
      realServiceStopMock: stop,
      createRealServiceMock: vi.fn((params: { backendLifecycle?: BackendLifecycle } = {}) => ({
        id: "real-acpx-runtime",
        start: (ctx: unknown) => start(ctx, params.backendLifecycle),
        stop: (ctx: unknown) => stop(ctx, params.backendLifecycle),
      })),
    };
  });

vi.mock("openclaw/plugin-sdk/acp-runtime-backend", () => ({
  getAcpRuntimeBackend: (id: string) => runtimeRegistry.get(id),
  registerAcpRuntimeBackend: (entry: { id: string; runtime: unknown }) => {
    runtimeRegistry.set(entry.id, entry);
  },
  unregisterAcpRuntimeBackend: (id: string) => {
    runtimeRegistry.delete(id);
  },
}));

vi.mock("./src/service.js", () => ({
  createAcpxRuntimeService: createRealServiceMock,
}));

import { createAcpxRuntimeService } from "./register.runtime.js";

const previousSkipRuntime = process.env.OPENCLAW_SKIP_ACPX_RUNTIME;

function restoreEnv(): void {
  if (previousSkipRuntime === undefined) {
    delete process.env.OPENCLAW_SKIP_ACPX_RUNTIME;
  } else {
    process.env.OPENCLAW_SKIP_ACPX_RUNTIME = previousSkipRuntime;
  }
}

function createServiceContext() {
  return {
    workspaceDir: "/tmp/openclaw-acpx-register-test",
    stateDir: "/tmp/openclaw-acpx-register-test/state",
    config: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

describe("acpx register runtime service", () => {
  afterEach(() => {
    runtimeRegistry.clear();
    realServiceStartMock.mockClear();
    realServiceStopMock.mockClear();
    createRealServiceMock.mockClear();
    restoreEnv();
  });

  it("registers the acpx backend at startup and starts the real service on first use", async () => {
    delete process.env.OPENCLAW_SKIP_ACPX_RUNTIME;
    const ctx = createServiceContext();
    const service = createAcpxRuntimeService({
      pluginConfig: { timeoutSeconds: 10 },
    });

    await service.start(ctx as never);

    const deferredRuntime = runtimeRegistry.get("acpx")?.runtime as {
      ensureSession(input: { sessionKey: string; agent: string; mode: string }): Promise<unknown>;
      startTurn(input: {
        handle: { sessionKey: string; backend: string; runtimeSessionName: string };
        text: string;
        mode: string;
        requestId: string;
      }): {
        events: AsyncIterable<unknown>;
        result: Promise<unknown>;
      };
    };
    expect(deferredRuntime).toBeTruthy();
    expect(createRealServiceMock).not.toHaveBeenCalled();
    expect(realServiceStartMock).not.toHaveBeenCalled();

    await expect(
      deferredRuntime.ensureSession({
        sessionKey: "agent:codex:acp:test",
        agent: "codex",
        mode: "oneshot",
      }),
    ).resolves.toEqual({
      backend: "acpx",
      runtimeSessionName: "agent:codex:acp:test",
      sessionKey: "agent:codex:acp:test",
    });

    expect(createRealServiceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        backendLifecycle: expect.objectContaining({
          publish: expect.any(Function),
          retract: expect.any(Function),
        }),
        pluginConfig: { timeoutSeconds: 10 },
      }),
    );
    expect(realServiceStartMock).toHaveBeenCalledWith(ctx, expect.any(Object));
    expect(runtimeRegistry.get("acpx")?.runtime).toBe(realRuntime);
    expect(ctx.logger.info).toHaveBeenCalledWith("embedded acpx runtime backend registered lazily");

    const turn = deferredRuntime.startTurn({
      handle: {
        sessionKey: "agent:codex:acp:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:test",
      },
      text: "hello",
      mode: "prompt",
      requestId: "turn-1",
    });
    await expect(turn.result).resolves.toEqual({
      status: "completed",
      stopReason: "end_turn",
    });

    await service.stop?.(ctx as never);

    expect(realServiceStopMock).toHaveBeenCalledWith(ctx, expect.any(Object));
    expect(runtimeRegistry.get("acpx")).toBeUndefined();
  });

  it("rejects stale publication after stop invalidates the deferred backend", async () => {
    delete process.env.OPENCLAW_SKIP_ACPX_RUNTIME;
    const startEntered = createDeferred<void>();
    const releasePublication = createDeferred<void>();
    realServiceStartMock.mockImplementationOnce(async (_ctx, backendLifecycle) => {
      startEntered.resolve();
      await releasePublication.promise;
      backendLifecycle?.publish({ runtime: realRuntime });
    });
    const ctx = createServiceContext();
    const service = createAcpxRuntimeService();

    await service.start(ctx as never);
    const deferredRuntime = runtimeRegistry.get("acpx")?.runtime as {
      ensureSession(input: { sessionKey: string; agent: string; mode: string }): Promise<unknown>;
    };
    const activation = deferredRuntime.ensureSession({
      sessionKey: "agent:codex:acp:shutdown-race",
      agent: "codex",
      mode: "oneshot",
    });
    const activationResult = activation.then(
      () => null,
      (error: unknown) => error,
    );
    await startEntered.promise;

    const stopping = service.stop?.(ctx as never);
    await Promise.resolve();
    expect(realServiceStopMock).not.toHaveBeenCalled();

    releasePublication.resolve();
    await stopping;

    expect(await activationResult).toEqual(
      expect.objectContaining({
        message: "ACPX runtime service stopped during activation",
      }),
    );
    expect(realServiceStopMock).toHaveBeenCalledOnce();
    expect(realServiceStopMock).toHaveBeenCalledWith(ctx, expect.any(Object));
    expect(runtimeRegistry.get("acpx")).toBeUndefined();
    await expect(
      deferredRuntime.ensureSession({
        sessionKey: "agent:codex:acp:stale-proxy",
        agent: "codex",
        mode: "oneshot",
      }),
    ).rejects.toThrow("ACPX runtime service is not started");
  });

  it("keeps a successor generation registered when old cleanup finishes late", async () => {
    delete process.env.OPENCLAW_SKIP_ACPX_RUNTIME;
    const published = createDeferred<void>();
    const releaseProbe = createDeferred<void>();
    realServiceStartMock.mockImplementationOnce(async (_ctx, backendLifecycle) => {
      if (!backendLifecycle) {
        throw new Error("expected outer backend lifecycle");
      }
      backendLifecycle.publish({ runtime: realRuntime });
      published.resolve();
      await releaseProbe.promise;
    });
    const ctx = createServiceContext();
    const generationA = createAcpxRuntimeService();

    await generationA.start(ctx as never);
    const deferredRuntimeA = runtimeRegistry.get("acpx")?.runtime as {
      ensureSession(input: { sessionKey: string; agent: string; mode: string }): Promise<unknown>;
    };
    const activation = deferredRuntimeA.ensureSession({
      sessionKey: "agent:codex:acp:generation-a",
      agent: "codex",
      mode: "oneshot",
    });
    const activationResult = activation.then(
      () => null,
      (error: unknown) => error,
    );
    await published.promise;
    expect(runtimeRegistry.get("acpx")?.runtime).toBe(realRuntime);

    let concurrentCallSettled = false;
    const concurrentCallResult = deferredRuntimeA
      .ensureSession({
        sessionKey: "agent:codex:acp:generation-a-concurrent",
        agent: "codex",
        mode: "oneshot",
      })
      .then(
        () => {
          concurrentCallSettled = true;
          return null;
        },
        (error: unknown) => {
          concurrentCallSettled = true;
          return error;
        },
      );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(concurrentCallSettled).toBe(false);

    const stoppingA = generationA.stop?.(ctx as never);
    expect(runtimeRegistry.get("acpx")).toBeUndefined();

    const generationB = createAcpxRuntimeService();
    await generationB.start(ctx as never);
    const deferredRuntimeB = runtimeRegistry.get("acpx")?.runtime;
    expect(deferredRuntimeB).toBeTruthy();
    expect(deferredRuntimeB).not.toBe(deferredRuntimeA);
    expect(deferredRuntimeB).not.toBe(realRuntime);
    expect(concurrentCallSettled).toBe(false);

    releaseProbe.resolve();
    await stoppingA;

    expect(await activationResult).toEqual(
      expect.objectContaining({ message: "ACPX runtime service stopped during activation" }),
    );
    expect(await concurrentCallResult).toEqual(
      expect.objectContaining({ message: "ACPX runtime service stopped during activation" }),
    );
    expect(runtimeRegistry.get("acpx")?.runtime).toBe(deferredRuntimeB);
    await expect(
      deferredRuntimeA.ensureSession({
        sessionKey: "agent:codex:acp:stale-generation-a",
        agent: "codex",
        mode: "oneshot",
      }),
    ).rejects.toThrow("ACPX runtime service is not started");

    await generationB.stop?.(ctx as never);
    expect(runtimeRegistry.get("acpx")).toBeUndefined();
  });

  it("keeps the explicit runtime skip env as the only outer startup skip", async () => {
    process.env.OPENCLAW_SKIP_ACPX_RUNTIME = "1";
    const ctx = createServiceContext();
    const service = createAcpxRuntimeService();

    await service.start(ctx as never);

    expect(createRealServiceMock).not.toHaveBeenCalled();
    expect(runtimeRegistry.get("acpx")).toBeUndefined();
    expect(ctx.logger.info).toHaveBeenCalledWith(
      "skipping embedded acpx runtime backend (OPENCLAW_SKIP_ACPX_RUNTIME=1)",
    );
  });
});
