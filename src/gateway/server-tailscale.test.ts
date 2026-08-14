// Tailscale exposure tests cover serve/funnel enablement, preserve-funnel mode,
// hostname discovery, cleanup handles, and warning paths.
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enableTailscaleServe: vi.fn(async (_target: number | string) => undefined),
  enableTailscaleFunnel: vi.fn(async (_target: number | string) => undefined),
  getTailnetHostname: vi.fn<() => Promise<string | null>>(async () => null),
  getTailnetHostnameAfterServe: vi.fn<() => Promise<string | null>>(async () => null),
  hasTailscaleFunnelRouteForPort: vi.fn(async (_port: number) => false),
}));

vi.mock("../infra/tailscale.js", () => ({
  enableTailscaleServe: mocks.enableTailscaleServe,
  enableTailscaleFunnel: mocks.enableTailscaleFunnel,
  getTailnetHostname: mocks.getTailnetHostname,
  getTailnetHostnameAfterServe: mocks.getTailnetHostnameAfterServe,
  hasTailscaleFunnelRouteForPort: mocks.hasTailscaleFunnelRouteForPort,
}));

import { getMcpAppChannelOrigin, prepareMcpAppChannelOrigin } from "./mcp-app-channel-origin.js";
import { startGatewayTailscaleExposure as startGatewayTailscaleExposureBase } from "./server-tailscale.js";

const MANAGED_BACKEND_PORT = 19_000;
const MANAGED_BACKEND_TARGET = `http://[::1]:${MANAGED_BACKEND_PORT}`;
function startGatewayTailscaleExposure(
  params: Omit<Parameters<typeof startGatewayTailscaleExposureBase>[0], "backend">,
) {
  return startGatewayTailscaleExposureBase({
    ...params,
    backend: { host: "::1", port: MANAGED_BACKEND_PORT },
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
  mocks.enableTailscaleServe.mockResolvedValue(undefined);
  mocks.enableTailscaleFunnel.mockResolvedValue(undefined);
  mocks.getTailnetHostname.mockResolvedValue(null);
  mocks.getTailnetHostnameAfterServe.mockResolvedValue(null);
  mocks.hasTailscaleFunnelRouteForPort.mockResolvedValue(false);
});

describe("startGatewayTailscaleExposure", () => {
  it("does not change Tailscale state before the private backend is bound", async () => {
    await expect(
      startGatewayTailscaleExposureBase({
        tailscaleMode: "serve",
        port: 18789,
        logTailscale: createLogger(),
      }),
    ).rejects.toThrow("Managed Tailscale ingress failed to start");

    expect(mocks.enableTailscaleServe).not.toHaveBeenCalled();
    expect(mocks.enableTailscaleFunnel).not.toHaveBeenCalled();
  });

  it("calls enableTailscaleServe in serve mode when preserveFunnel is unset", async () => {
    const logTailscale = createLogger();

    await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      logTailscale,
    });

    expect(mocks.enableTailscaleServe).toHaveBeenCalledWith(MANAGED_BACKEND_TARGET);
    expect(mocks.getTailnetHostnameAfterServe).toHaveBeenCalledOnce();
    expect(mocks.getTailnetHostname).not.toHaveBeenCalled();
    expect(mocks.hasTailscaleFunnelRouteForPort).not.toHaveBeenCalled();
  });

  it("fails startup when the managed route cannot be claimed", async () => {
    const failure = new Error("tailscale unavailable");
    mocks.enableTailscaleServe.mockRejectedValue(failure);

    await expect(
      startGatewayTailscaleExposure({
        tailscaleMode: "serve",
        port: 18789,
        logTailscale: createLogger(),
      }),
    ).rejects.toBe(failure);
  });

  it("rejects resetOnExit before publishing a route", async () => {
    await expect(
      startGatewayTailscaleExposure({
        tailscaleMode: "funnel",
        port: 18789,
        resetOnExit: true,
        logTailscale: createLogger(),
      }),
    ).rejects.toThrow(/resetOnExit=true is unsupported.*doctor --fix/);

    expect(mocks.enableTailscaleServe).not.toHaveBeenCalled();
    expect(mocks.enableTailscaleFunnel).not.toHaveBeenCalled();
  });

  it.each([
    ["serve", mocks.enableTailscaleServe],
    ["funnel", mocks.enableTailscaleFunnel],
  ] as const)(
    "keeps the persistent %s route on the stable managed endpoint during cleanup",
    async (mode, enable) => {
      const cleanup = await startGatewayTailscaleExposure({
        tailscaleMode: mode,
        port: 18789,
        logTailscale: createLogger(),
      });

      await cleanup?.();

      expect(enable).toHaveBeenCalledOnce();
      expect(enable).toHaveBeenCalledWith(MANAGED_BACKEND_TARGET);
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
    expect(mocks.enableTailscaleServe).not.toHaveBeenCalled();
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
    expect(mocks.enableTailscaleServe).not.toHaveBeenCalled();
    expect(logTailscale.warn).toHaveBeenCalledWith(expect.stringContaining(failure.message));
  });

  it("falls back to enableTailscaleServe when preserveFunnel is true but no Funnel route exists for the port", async () => {
    const logTailscale = createLogger();
    mocks.hasTailscaleFunnelRouteForPort.mockResolvedValue(false);

    await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      preserveFunnel: true,
      logTailscale,
    });

    expect(mocks.hasTailscaleFunnelRouteForPort).toHaveBeenCalledWith(18789);
    expect(mocks.enableTailscaleServe).toHaveBeenCalledWith(MANAGED_BACKEND_TARGET);
  });

  it("passes serviceName through to Tailscale Serve setup without deleting the Service", async () => {
    const logTailscale = createLogger();
    mocks.getTailnetHostnameAfterServe.mockResolvedValue("node.tailnet.ts.net");

    const cleanup = await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      serviceName: "svc:openclaw",
      logTailscale,
    });

    expect(mocks.enableTailscaleServe).toHaveBeenCalledWith(
      MANAGED_BACKEND_TARGET,
      undefined,
      "svc:openclaw",
    );
    expect(logTailscale.info).toHaveBeenCalledWith(
      "serve enabled for svc:openclaw: https://openclaw.tailnet.ts.net/ (WS via wss://openclaw.tailnet.ts.net)",
    );

    await cleanup?.();
  });

  it("does not use serviceName in funnel mode", async () => {
    const logTailscale = createLogger();
    mocks.getTailnetHostname.mockResolvedValue("node.tailnet.ts.net");

    const cleanup = await startGatewayTailscaleExposure({
      tailscaleMode: "funnel",
      port: 18789,
      serviceName: "svc:openclaw",
      logTailscale,
    });

    expect(mocks.enableTailscaleFunnel).toHaveBeenCalledWith(MANAGED_BACKEND_TARGET);
    expect(mocks.enableTailscaleServe).not.toHaveBeenCalled();
    expect(logTailscale.info).toHaveBeenCalledWith(
      "funnel enabled: https://node.tailnet.ts.net/ (WS via wss://node.tailnet.ts.net)",
    );

    await cleanup?.();
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

  it.each([
    ["only reports an IP", "100.64.0.8"],
    ["omits the DNS suffix", "node"],
  ])("does not derive a Service URL when Tailscale %s", async (_name, hostname) => {
    const logTailscale = createLogger();
    mocks.getTailnetHostnameAfterServe.mockResolvedValue(hostname);

    await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      serviceName: "svc:openclaw",
      logTailscale,
    });

    expect(mocks.enableTailscaleServe).toHaveBeenCalledWith(
      MANAGED_BACKEND_TARGET,
      undefined,
      "svc:openclaw",
    );
    expect(logTailscale.info).toHaveBeenCalledWith("serve enabled");
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
    expect(mocks.enableTailscaleFunnel).toHaveBeenCalledWith(MANAGED_BACKEND_TARGET);
  });
});
