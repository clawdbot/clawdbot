import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enableTailscaleServe: vi.fn(async (_port: number) => undefined),
  disableTailscaleServe: vi.fn(async () => undefined),
  enableTailscaleFunnel: vi.fn(async (_port: number) => undefined),
  disableTailscaleFunnel: vi.fn(async () => undefined),
  getTailnetHostname: vi.fn<() => Promise<string | null>>(async () => null),
  hasTailscaleFunnelRouteForPort: vi.fn(async (_port: number) => false),
}));

vi.mock("../infra/tailscale.js", () => ({
  enableTailscaleServe: mocks.enableTailscaleServe,
  disableTailscaleServe: mocks.disableTailscaleServe,
  enableTailscaleFunnel: mocks.enableTailscaleFunnel,
  disableTailscaleFunnel: mocks.disableTailscaleFunnel,
  getTailnetHostname: mocks.getTailnetHostname,
  hasTailscaleFunnelRouteForPort: mocks.hasTailscaleFunnelRouteForPort,
}));

import { startGatewayTailscaleExposure } from "./server-tailscale.js";

function createLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

afterEach(() => {
  for (const fn of Object.values(mocks)) {
    fn.mockReset();
  }
  mocks.enableTailscaleServe.mockResolvedValue(undefined);
  mocks.disableTailscaleServe.mockResolvedValue(undefined);
  mocks.enableTailscaleFunnel.mockResolvedValue(undefined);
  mocks.disableTailscaleFunnel.mockResolvedValue(undefined);
  mocks.getTailnetHostname.mockResolvedValue(null);
  mocks.hasTailscaleFunnelRouteForPort.mockResolvedValue(false);
});

describe("startGatewayTailscaleExposure preserveFunnel", () => {
  it("calls enableTailscaleServe in serve mode when preserveFunnel is unset", async () => {
    const logTailscale = createLogger();

    await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      logTailscale,
    });

    expect(mocks.enableTailscaleServe).toHaveBeenCalledWith(18789);
    expect(mocks.hasTailscaleFunnelRouteForPort).not.toHaveBeenCalled();
  });

  it("skips enableTailscaleServe when preserveFunnel is true and a Funnel route covers the port", async () => {
    const logTailscale = createLogger();
    mocks.hasTailscaleFunnelRouteForPort.mockResolvedValue(true);

    await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      preserveFunnel: true,
      logTailscale,
    });

    expect(mocks.hasTailscaleFunnelRouteForPort).toHaveBeenCalledWith(18789);
    expect(mocks.enableTailscaleServe).not.toHaveBeenCalled();
    expect(logTailscale.info.mock.calls).toEqual([
      ["serve skipped: preserving externally configured Tailscale Funnel for port 18789"],
    ]);
  });

  it("notes resetOnExit is a no-op when preserveFunnel skips Serve", async () => {
    const logTailscale = createLogger();
    mocks.hasTailscaleFunnelRouteForPort.mockResolvedValue(true);

    await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      preserveFunnel: true,
      resetOnExit: true,
      logTailscale,
    });

    expect(mocks.enableTailscaleServe).not.toHaveBeenCalled();
    expect(logTailscale.info.mock.calls).toEqual([
      [
        "serve skipped: preserving externally configured Tailscale Funnel for port 18789; resetOnExit is a no-op because no Serve route was applied this run",
      ],
    ]);
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
    expect(mocks.enableTailscaleServe).toHaveBeenCalledWith(18789);
  });

  it("passes serviceName through to Tailscale Serve setup and cleanup", async () => {
    const logTailscale = createLogger();
    mocks.getTailnetHostname.mockResolvedValue("node.tailnet.ts.net");

    const cleanup = await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      resetOnExit: true,
      serviceName: "svc:openclaw",
      logTailscale,
    });

    expect(mocks.enableTailscaleServe).toHaveBeenCalledWith(18789, undefined, "svc:openclaw");
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

    expect(mocks.enableTailscaleFunnel).toHaveBeenCalledWith(18789);
    expect(mocks.enableTailscaleServe).not.toHaveBeenCalled();
    expect(logTailscale.info).toHaveBeenCalledWith(
      "funnel enabled: https://node.tailnet.ts.net/ (WS via wss://node.tailnet.ts.net)",
    );

    await cleanup?.();

    expect(mocks.disableTailscaleFunnel).toHaveBeenCalledWith();
    expect(mocks.disableTailscaleServe).not.toHaveBeenCalled();
  });

  it("does not derive a Service URL when Tailscale only reports an IP", async () => {
    const logTailscale = createLogger();
    mocks.getTailnetHostname.mockResolvedValue("100.64.0.8");

    await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      serviceName: "svc:openclaw",
      logTailscale,
    });

    expect(mocks.enableTailscaleServe).toHaveBeenCalledWith(18789, undefined, "svc:openclaw");
    expect(logTailscale.info).toHaveBeenCalledWith("serve enabled");
  });

  it("does not derive a Service URL when Tailscale omits the DNS suffix", async () => {
    const logTailscale = createLogger();
    mocks.getTailnetHostname.mockResolvedValue("node");

    await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      serviceName: "svc:openclaw",
      logTailscale,
    });

    expect(mocks.enableTailscaleServe).toHaveBeenCalledWith(18789, undefined, "svc:openclaw");
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
    expect(mocks.enableTailscaleFunnel).toHaveBeenCalledWith(18789);
  });
});
