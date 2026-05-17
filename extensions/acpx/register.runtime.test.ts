import { afterEach, describe, expect, it, vi } from "vitest";

const { runtimeRegistry } = vi.hoisted(() => ({
  runtimeRegistry: new Map<string, { runtime: unknown }>(),
}));

const { realRuntime, realServiceStartMock, realServiceStopMock, createRealServiceMock } =
  vi.hoisted(() => {
    const runtime = { isHealthy: vi.fn(() => true), probeAvailability: vi.fn(async () => {}) };
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

  it("starts the real service by default while leaving probe policy to the inner service", async () => {
    delete process.env.OPENCLAW_SKIP_ACPX_RUNTIME;
    const ctx = createServiceContext();
    const service = createAcpxRuntimeService({
      pluginConfig: { timeoutSeconds: 10 },
    });

    await service.start(ctx as never);

    expect(createRealServiceMock).toHaveBeenCalledWith({
      pluginConfig: { timeoutSeconds: 10 },
    });
    expect(realServiceStartMock).toHaveBeenCalledWith(ctx);
    expect(runtimeRegistry.get("acpx")?.runtime).toBe(realRuntime);

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
