// Tailscale exposure tests cover serve/funnel enablement, preserve-funnel mode,
// hostname discovery, cleanup handles, and warning paths.
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const stopRouteClaim = vi.fn(async () => undefined);
  return {
    stopRouteClaim,
    claimTailscaleRoute: vi.fn(async (_mode: "serve" | "funnel", _target: number | string) => ({
      exited: new Promise<void>(() => {}),
      isActive: (): boolean => true,
      stop: stopRouteClaim,
    })),
    getTailnetHostname: vi.fn<() => Promise<string | null>>(async () => null),
    getTailnetHostnameAfterServe: vi.fn<() => Promise<string | null>>(async () => null),
    hasTailscaleFunnelRouteForPort: vi.fn(async (_port: number) => false),
    reconcileLegacyTailscaleRoute: vi.fn(async () => false),
  };
});

vi.mock("../infra/tailscale.js", () => ({
  claimTailscaleRoute: mocks.claimTailscaleRoute,
  getTailnetHostname: mocks.getTailnetHostname,
  getTailnetHostnameAfterServe: mocks.getTailnetHostnameAfterServe,
  hasTailscaleFunnelRouteForPort: mocks.hasTailscaleFunnelRouteForPort,
  reconcileLegacyTailscaleRoute: mocks.reconcileLegacyTailscaleRoute,
}));

import { getMcpAppChannelOrigin, prepareMcpAppChannelOrigin } from "./mcp-app-channel-origin.js";
import { startGatewayTailscaleExposure as startGatewayTailscaleExposureBase } from "./server-tailscale.js";

const MANAGED_BACKEND_PORT = 19_000;
function startGatewayTailscaleExposure(
  params: Omit<Parameters<typeof startGatewayTailscaleExposureBase>[0], "backend">,
) {
  return startGatewayTailscaleExposureBase({
    ...params,
    backend: { host: "127.0.0.1", port: MANAGED_BACKEND_PORT },
  });
}

function createLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function resetMcpAppChannelOrigin() {
  prepareMcpAppChannelOrigin({ origin: "https://reset.test", reachability: "tailnet" })();
}

afterEach(() => {
  resetMcpAppChannelOrigin();
  for (const fn of Object.values(mocks)) {
    fn.mockReset();
  }
  mocks.claimTailscaleRoute.mockImplementation(async () => ({
    exited: new Promise<void>(() => {}),
    isActive: (): boolean => true,
    stop: mocks.stopRouteClaim,
  }));
  mocks.stopRouteClaim.mockResolvedValue(undefined);
  mocks.getTailnetHostname.mockResolvedValue(null);
  mocks.getTailnetHostnameAfterServe.mockResolvedValue(null);
  mocks.hasTailscaleFunnelRouteForPort.mockResolvedValue(false);
  mocks.reconcileLegacyTailscaleRoute.mockResolvedValue(false);
});

describe("startGatewayTailscaleExposure", () => {
  it("does not require a backend or mutate Tailscale in off mode", async () => {
    await expect(
      startGatewayTailscaleExposureBase({
        tailscaleMode: "off",
        port: 18789,
        logTailscale: createLogger(),
      }),
    ).resolves.toBeNull();

    expect(mocks.claimTailscaleRoute).not.toHaveBeenCalled();
  });

  it("does not change Tailscale state before the private backend is bound", async () => {
    await expect(
      startGatewayTailscaleExposureBase({
        tailscaleMode: "serve",
        port: 18789,
        logTailscale: createLogger(),
      }),
    ).rejects.toThrow("Managed Tailscale ingress failed to start");

    expect(mocks.claimTailscaleRoute).not.toHaveBeenCalled();
  });

  it("claims a foreground Serve route when preserveFunnel is unset", async () => {
    const logTailscale = createLogger();

    await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      logTailscale,
    });

    expect(mocks.claimTailscaleRoute).toHaveBeenCalledWith("serve", MANAGED_BACKEND_PORT);
    expect(mocks.reconcileLegacyTailscaleRoute).toHaveBeenCalledWith("serve", 18789);
    expect(mocks.getTailnetHostnameAfterServe).toHaveBeenCalledOnce();
    expect(mocks.getTailnetHostname).not.toHaveBeenCalled();
    expect(mocks.hasTailscaleFunnelRouteForPort).not.toHaveBeenCalled();
  });

  it("reports an automatically migrated legacy route", async () => {
    const logTailscale = createLogger();
    mocks.reconcileLegacyTailscaleRoute.mockResolvedValue(true);

    await startGatewayTailscaleExposure({
      tailscaleMode: "funnel",
      port: 18789,
      logTailscale,
    });

    expect(logTailscale.info).toHaveBeenCalledWith(
      expect.stringContaining("removed legacy persistent Tailscale funnel route"),
    );
    expect(mocks.claimTailscaleRoute).toHaveBeenCalledWith("funnel", MANAGED_BACKEND_PORT);
  });

  it("fails startup when the managed route cannot be claimed", async () => {
    const failure = new Error("tailscale unavailable");
    mocks.claimTailscaleRoute.mockRejectedValue(failure);

    await expect(
      startGatewayTailscaleExposure({
        tailscaleMode: "serve",
        port: 18789,
        logTailscale: createLogger(),
      }),
    ).rejects.toBe(failure);
  });

  it("fails startup when the route owner exits after reporting readiness", async () => {
    mocks.claimTailscaleRoute.mockResolvedValue({
      exited: Promise.resolve(),
      isActive: () => false,
      stop: mocks.stopRouteClaim,
    });

    await expect(
      startGatewayTailscaleExposure({
        tailscaleMode: "serve",
        port: 18789,
        logTailscale: createLogger(),
      }),
    ).rejects.toThrow("claim exited during startup");
    expect(mocks.stopRouteClaim).toHaveBeenCalledOnce();
  });

  it.each(["serve", "funnel"] as const)(
    "releases the foreground %s claim during cleanup",
    async (mode) => {
      const cleanup = await startGatewayTailscaleExposure({
        tailscaleMode: mode,
        port: 18789,
        logTailscale: createLogger(),
      });

      await cleanup?.();

      expect(mocks.claimTailscaleRoute).toHaveBeenCalledWith(mode, MANAGED_BACKEND_PORT);
      expect(mocks.stopRouteClaim).toHaveBeenCalledOnce();
    },
  );

  it("keeps the Gateway up with complete migration guidance for an external Funnel", async () => {
    const logTailscale = createLogger();
    mocks.hasTailscaleFunnelRouteForPort.mockResolvedValue(true);

    const cleanup = await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      preserveFunnel: true,
      logTailscale,
    });

    expect(cleanup).toBeNull();
    expect(mocks.hasTailscaleFunnelRouteForPort).toHaveBeenCalledWith(18789);
    expect(mocks.claimTailscaleRoute).not.toHaveBeenCalled();
    expect(logTailscale.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /plugin-authenticated.*gateway\.auth\.password.*gateway\.auth\.mode=password.*mode funnel.*unset/s,
      ),
    );
  });

  it("fails closed when preserved Funnel status cannot be inspected", async () => {
    const failure = new Error("tailscale status unavailable");
    const logTailscale = createLogger();
    mocks.hasTailscaleFunnelRouteForPort.mockRejectedValue(failure);

    await expect(
      startGatewayTailscaleExposure({
        tailscaleMode: "serve",
        port: 18789,
        preserveFunnel: true,
        logTailscale,
      }),
    ).rejects.toBe(failure);
    expect(mocks.claimTailscaleRoute).not.toHaveBeenCalled();
    expect(logTailscale.warn).toHaveBeenCalledWith(expect.stringContaining(failure.message));
  });

  it("claims Serve when preserveFunnel is true but no Funnel route exists for the port", async () => {
    const logTailscale = createLogger();
    mocks.hasTailscaleFunnelRouteForPort.mockResolvedValue(false);

    await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      preserveFunnel: true,
      logTailscale,
    });

    expect(mocks.hasTailscaleFunnelRouteForPort).toHaveBeenCalledWith(18789);
    expect(mocks.claimTailscaleRoute).toHaveBeenCalledWith("serve", MANAGED_BACKEND_PORT);
  });

  it("prepares one tailnet-only Serve origin for the Gateway lifecycle", async () => {
    mocks.getTailnetHostnameAfterServe.mockResolvedValue("node.tailnet.ts.net");

    const cleanup = await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      logTailscale: createLogger(),
    });

    expect(getMcpAppChannelOrigin()).toEqual({
      origin: "https://node.tailnet.ts.net",
      reachability: "tailnet",
    });
    await cleanup?.();
    expect(getMcpAppChannelOrigin()).toBeUndefined();
  });

  it("clears the published origin and warns when the foreground claim exits", async () => {
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    mocks.claimTailscaleRoute.mockResolvedValue({
      exited,
      isActive: () => true,
      stop: mocks.stopRouteClaim,
    });
    mocks.getTailnetHostnameAfterServe.mockResolvedValue("node.tailnet.ts.net");
    const logTailscale = createLogger();

    await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      logTailscale,
    });
    resolveExit();

    await vi.waitFor(() => {
      expect(logTailscale.warn).toHaveBeenCalledWith(expect.stringContaining("claim exited"));
    });
    expect(getMcpAppChannelOrigin()).toBeUndefined();
  });

  it("does not publish an origin for an externally preserved Funnel", async () => {
    mocks.getTailnetHostname.mockResolvedValue("node.tailnet.ts.net");
    mocks.hasTailscaleFunnelRouteForPort.mockResolvedValue(true);

    const cleanup = await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      preserveFunnel: true,
      logTailscale: createLogger(),
    });

    expect(cleanup).toBeNull();
    expect(getMcpAppChannelOrigin()).toBeUndefined();
  });

  it("never consults the Funnel route helper when running in funnel mode", async () => {
    const logTailscale = createLogger();

    await startGatewayTailscaleExposure({
      tailscaleMode: "funnel",
      port: 18789,
      preserveFunnel: true,
      logTailscale,
    });

    expect(mocks.hasTailscaleFunnelRouteForPort).not.toHaveBeenCalled();
    expect(mocks.claimTailscaleRoute).toHaveBeenCalledWith("funnel", MANAGED_BACKEND_PORT);
  });
});
