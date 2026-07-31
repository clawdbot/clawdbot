// Browser tests cover shared browser-control lifecycle serialization.
import type { Server } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { markBrowserRuntimeStopping } from "./browser/server-context.lifecycle.js";

const runtimeMocks = vi.hoisted(() => ({
  stopBrowserRuntime: vi.fn(),
}));

vi.mock("./browser/runtime-lifecycle.js", () => ({
  createBrowserRuntimeState: (params: {
    server: Server | null;
    port: number;
    resolved: unknown;
  }) => ({
    server: params.server,
    port: params.port,
    resolved: params.resolved,
    profiles: new Map(),
  }),
  stopBrowserRuntime: runtimeMocks.stopBrowserRuntime,
}));

const {
  ensureBrowserControlRuntime,
  getBrowserControlState,
  stopBrowserControlRuntime,
  withBrowserControlStart,
} = await import("./browser-control-state.js");

const resolved = { profiles: {}, controlPort: 18_791 } as never;
const onWarn = vi.fn();

function start(owner: "server" | "service", server: Server | null = null) {
  return withBrowserControlStart(() =>
    ensureBrowserControlRuntime({ server, port: 18_791, resolved, owner, onWarn }),
  );
}

function stop(requestedBy: "server" | "service") {
  return stopBrowserControlRuntime({ requestedBy, onWarn });
}

beforeEach(() => {
  runtimeMocks.stopBrowserRuntime.mockReset().mockImplementation(async (params) => {
    params.clearState();
  });
});

describe("browser control lifecycle", () => {
  it("allows a start queued after a no-state stop", async () => {
    const stopping = stop("service");
    const starting = start("service");

    await expect(stopping).resolves.toBeNull();
    await expect(starting).resolves.toBeTruthy();
    await stop("service");
  });

  it("rejects a start requested after stop intent but before stop drains", async () => {
    await start("service");
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    runtimeMocks.stopBrowserRuntime.mockImplementationOnce(async (params) => {
      await stopGate;
      params.clearState();
    });

    const stopping = stop("service");
    const starting = start("service");
    releaseStop();

    await stopping;
    await expect(starting).rejects.toThrow("stopping");
    expect(getBrowserControlState()).toBeNull();
  });

  it("retains a failed stop owner for an exact retry", async () => {
    await start("service");
    runtimeMocks.stopBrowserRuntime.mockImplementationOnce(async (params) => {
      markBrowserRuntimeStopping(params.current);
      throw new Error("cleanup failed");
    });

    await expect(stop("service")).rejects.toThrow("cleanup failed");
    expect(getBrowserControlState()).toBeNull();

    await expect(stop("service")).resolves.toBeTruthy();
    await expect(start("service")).resolves.toBeTruthy();
    await stop("service");
  });

  it("lets a foreground server adopt service state without a second runtime", async () => {
    const serviceState = await start("service");
    const server = {} as Server;
    const serverState = await start("server", server);

    expect(serverState).toBe(serviceState);
    expect(serverState.server).toBe(server);
    await stop("service");
    expect(runtimeMocks.stopBrowserRuntime).not.toHaveBeenCalled();

    await stop("server");
    expect(runtimeMocks.stopBrowserRuntime).toHaveBeenCalledOnce();
  });

  it("allows a start queued after a foreground-owned service stop", async () => {
    await start("service");
    await start("server", {} as Server);
    const stopping = stop("service");
    const starting = start("service");

    await expect(stopping).resolves.toBeNull();
    await expect(starting).resolves.toBeTruthy();
    await stop("server");
  });

  it("orders a queued stop after an in-progress cold start", async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const starting = withBrowserControlStart(async () => {
      await startGate;
      return await ensureBrowserControlRuntime({
        server: null,
        port: 18_791,
        resolved,
        owner: "service",
        onWarn,
      });
    });
    const stopping = stop("service");
    releaseStart();

    await starting;
    await stopping;
    expect(runtimeMocks.stopBrowserRuntime).toHaveBeenCalledOnce();
    expect(getBrowserControlState()).toBeNull();
  });
});
