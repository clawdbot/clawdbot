// Tailscale exposure tests cover serve/funnel enablement, preserve-funnel mode,
// hostname discovery, cleanup handles, and warning paths.
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enableTailscaleServe: vi.fn(async (_port: number) => undefined),
  disableTailscaleServe: vi.fn(async () => undefined),
  enableTailscaleFunnel: vi.fn(async (_port: number) => undefined),
  disableTailscaleFunnel: vi.fn(async () => undefined),
  getTailnetHostname: vi.fn<() => Promise<string | null>>(async () => null),
  getTailnetHostnameAfterServe: vi.fn<() => Promise<string | null>>(async () => null),
  hasTailscaleFunnelRouteForPort: vi.fn(async (_port: number) => false),
}));

vi.mock("../infra/tailscale.js", () => ({
  enableTailscaleServe: mocks.enableTailscaleServe,
  disableTailscaleServe: mocks.disableTailscaleServe,
  enableTailscaleFunnel: mocks.enableTailscaleFunnel,
  disableTailscaleFunnel: mocks.disableTailscaleFunnel,
  getTailnetHostname: mocks.getTailnetHostname,
  getTailnetHostnameAfterServe: mocks.getTailnetHostnameAfterServe,
  hasTailscaleFunnelRouteForPort: mocks.hasTailscaleFunnelRouteForPort,
}));

import { getMcpAppChannelOrigin, prepareMcpAppChannelOrigin } from "./mcp-app-channel-origin.js";
import { startGatewayTailscaleExposure as startGatewayTailscaleExposureBase } from "./server-tailscale.js";

const MANAGED_BACKEND_PORT = 19_000;
function startGatewayTailscaleExposure(
  params: Omit<Parameters<typeof startGatewayTailscaleExposureBase>[0], "backendPort">,
) {
  return startGatewayTailscaleExposureBase({ ...params, backendPort: MANAGED_BACKEND_PORT });
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
  mocks.disableTailscaleServe.mockResolvedValue(undefined);
  mocks.enableTailscaleFunnel.mockResolvedValue(undefined);
  mocks.disableTailscaleFunnel.mockResolvedValue(undefined);
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

    expect(mocks.enableTailscaleServe).toHaveBeenCalledWith(MANAGED_BACKEND_PORT);
    expect(mocks.getTailnetHostnameAfterServe).toHaveBeenCalledOnce();
    expect(mocks.getTailnetHostname).not.toHaveBeenCalled();
    expect(mocks.hasTailscaleFunnelRouteForPort).not.toHaveBeenCalled();
  });

  it("cleans up the owned Serve route", async () => {
    const cleanup = await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      resetOnExit: true,
      logTailscale: createLogger(),
    });

    await cleanup?.();
    expect(mocks.disableTailscaleServe).toHaveBeenCalledOnce();
  });

  it.each([
    ["serve", mocks.enableTailscaleServe],
    ["funnel", mocks.enableTailscaleFunnel],
  ] as const)(
    "restores a persistent %s route before releasing the private port",
    async (mode, enable) => {
      const cleanup = await startGatewayTailscaleExposure({
        tailscaleMode: mode,
        port: 18789,
        logTailscale: createLogger(),
      });

      await cleanup?.();

      expect(enable).toHaveBeenNthCalledWith(1, MANAGED_BACKEND_PORT);
      expect(enable).toHaveBeenNthCalledWith(2, 18789);
      expect(mocks.disableTailscaleServe).not.toHaveBeenCalled();
      expect(mocks.disableTailscaleFunnel).not.toHaveBeenCalled();
    },
  );

  it("preserves node-wide routes when restoring the stable target fails", async () => {
    const failure = new Error("stable target unavailable");
    const logTailscale = createLogger();
    mocks.enableTailscaleServe.mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure);
    const cleanup = await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      logTailscale,
    });

    await cleanup?.();

    expect(mocks.disableTailscaleServe).not.toHaveBeenCalled();
    expect(mocks.disableTailscaleFunnel).not.toHaveBeenCalled();
    expect(logTailscale.warn).toHaveBeenCalledWith(expect.stringContaining(failure.message));
  });

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

  it("keeps the local Gateway up without changing exposure when Funnel status is unknown", async () => {
    const failure = new Error("tailscale status unavailable");
    const logTailscale = createLogger();
    mocks.hasTailscaleFunnelRouteForPort.mockRejectedValue(failure);

    const cleanup = await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      preserveFunnel: true,
      logTailscale,
    });

    expect(cleanup).toBeNull();
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
    expect(mocks.enableTailscaleServe).toHaveBeenCalledWith(MANAGED_BACKEND_PORT);
  });

  it("passes serviceName through to Tailscale Serve setup and cleanup", async () => {
    const logTailscale = createLogger();
    mocks.getTailnetHostnameAfterServe.mockResolvedValue("node.tailnet.ts.net");

    const cleanup = await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      resetOnExit: true,
      serviceName: "svc:openclaw",
      logTailscale,
    });

    expect(mocks.enableTailscaleServe).toHaveBeenCalledWith(
      MANAGED_BACKEND_PORT,
      undefined,
      "svc:openclaw",
    );
    expect(logTailscale.info).toHaveBeenCalledWith(
      "serve enabled for svc:openclaw: https://openclaw.tailnet.ts.net/ (WS via wss://openclaw.tailnet.ts.net)",
    );

    await cleanup?.();

    expect(mocks.disableTailscaleServe).toHaveBeenCalledWith(undefined, "svc:openclaw");
  });

  it("does not use serviceName in funnel mode", async () => {
    const logTailscale = createLogger();
    mocks.getTailnetHostname.mockResolvedValue("node.tailnet.ts.net");

    const cleanup = await startGatewayTailscaleExposure({
      tailscaleMode: "funnel",
      port: 18789,
      resetOnExit: true,
      serviceName: "svc:openclaw",
      logTailscale,
    });

    expect(mocks.enableTailscaleFunnel).toHaveBeenCalledWith(MANAGED_BACKEND_PORT);
    expect(mocks.enableTailscaleServe).not.toHaveBeenCalled();
    expect(logTailscale.info).toHaveBeenCalledWith(
      "funnel enabled: https://node.tailnet.ts.net/ (WS via wss://node.tailnet.ts.net)",
    );

    await cleanup?.();

    expect(mocks.disableTailscaleFunnel).toHaveBeenCalledWith();
    expect(mocks.disableTailscaleServe).not.toHaveBeenCalled();
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
    expect(mocks.disableTailscaleServe).not.toHaveBeenCalled();
  });

  it("does not publish an origin for an externally preserved Funnel", async () => {
    mocks.getTailnetHostname.mockResolvedValue("node.tailnet.ts.net");
    mocks.hasTailscaleFunnelRouteForPort.mockResolvedValue(true);

    const cleanup = await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      preserveFunnel: true,
      resetOnExit: true,
      logTailscale: createLogger(),
    });

    expect(cleanup).toBeNull();
    expect(getMcpAppChannelOrigin()).toBeUndefined();
    expect(mocks.disableTailscaleServe).not.toHaveBeenCalled();
    expect(mocks.disableTailscaleFunnel).not.toHaveBeenCalled();
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
      MANAGED_BACKEND_PORT,
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
    expect(mocks.enableTailscaleFunnel).toHaveBeenCalledWith(MANAGED_BACKEND_PORT);
  });
});
