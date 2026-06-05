// ACPX tests cover register plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";

const { runtimeRegistry } = vi.hoisted(() => ({
  runtimeRegistry: new Map<string, { runtime: unknown }>(),
}));

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
      async *runTurn() {},
      async cancel() {},
      async close() {},
      isHealthy: vi.fn(() => true),
      probeAvailability: vi.fn(async () => {}),
    };
    const start = vi.fn(async () => {
      runtimeRegistry.set("acpx", { runtime });
    });
    const stop = vi.fn(async () => {
      runtimeRegistry.delete("acpx");
    });
    return {
      realRuntime: runtime,
      realServiceStartMock: start,
      realServiceStopMock: stop,
      createRealServiceMock: vi.fn(() => ({ id: "real-acpx-runtime", start, stop })),
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

    expect(createRealServiceMock).toHaveBeenCalledWith({
      pluginConfig: { timeoutSeconds: 10 },
    });
    expect(realServiceStartMock).toHaveBeenCalledWith(ctx);
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
      status: "failed",
      error: {
        code: "ACP_TURN_FAILED",
        message: "ACP turn ended without a terminal done event.",
      },
    });

    await service.stop?.(ctx as never);

    expect(realServiceStopMock).toHaveBeenCalledWith(ctx);
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
