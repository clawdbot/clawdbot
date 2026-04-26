import { describe, expect, it } from "vitest";
import {
  buildStatusGatewayJsonPayloadFromSurface,
  buildStatusOverviewRowsFromSurface,
  buildStatusOverviewSurfaceFromOverview,
  buildStatusOverviewSurfaceFromScan,
} from "./status-overview-surface.ts";
import {
  baseStatusCfg,
  baseStatusGatewaySnapshot,
  baseStatusOverviewScanFields,
  baseStatusOverviewSurface,
  baseStatusServices,
  baseStatusUpdate,
} from "./status.test-support.ts";

describe("status-overview-surface", () => {
  it("builds the shared overview surface from a status scan result", () => {
    expect(
      buildStatusOverviewSurfaceFromScan({
        scan: baseStatusOverviewScanFields,
        ...baseStatusServices,
      }),
    ).toEqual(baseStatusOverviewSurface);
  });

  it("builds the shared overview surface from scan overview data", () => {
    expect(
      buildStatusOverviewSurfaceFromOverview({
        overview: {
          cfg: baseStatusCfg,
          update: baseStatusUpdate,
          tailscaleMode: "serve",
          tailscaleDns: "box.tail.ts.net",
          tailscaleHttpsUrl: "https://box.tail.ts.net",
          gatewaySnapshot: baseStatusGatewaySnapshot,
        } as never,
        ...baseStatusServices,
      }),
    ).toEqual(baseStatusOverviewSurface);
  });

  it("builds overview rows from the shared surface bundle", () => {
    expect(
      buildStatusOverviewRowsFromSurface({
        surface: {
          ...baseStatusOverviewSurface,
          cfg: baseStatusCfg,
          update: {
            installKind: "git",
            git: {
              branch: "main",
              tag: "v1.2.3",
              upstream: "origin/main",
              behind: 2,
              ahead: 0,
              dirty: false,
              fetchOk: true,
            },
            registry: { latestVersion: "2026.4.10" },
          } as never,
          tailscaleMode: "off",
          tailscaleHttpsUrl: null,
          gatewayConnection: {
            url: "wss://gateway.example.com",
            urlSource: "config",
          },
        },
        prefixRows: [{ Item: "OS", Value: "macOS · node 22" }],
        suffixRows: [{ Item: "Secrets", Value: "none" }],
        agentsValue: "2 total",
        updateValue: "available · custom update",
        gatewayAuthWarningValue: "warn(warn-text)",
        gatewaySelfFallbackValue: "gateway-self",
        includeBackendStateWhenOff: true,
        includeDnsNameWhenOff: true,
        decorateOk: (value) => `ok(${value})`,
        decorateWarn: (value) => `warn(${value})`,
        decorateTailscaleOff: (value) => `muted(${value})`,
      }),
    ).toEqual([
      { Item: "OS", Value: "macOS · node 22" },
      { Item: "Dashboard", Value: "http://127.0.0.1:18789/" },
      { Item: "Tailscale exposure", Value: "muted(off · box.tail.ts.net)" },
      { Item: "Channel", Value: "stable (config)" },
      { Item: "Git", Value: "main · tag v1.2.3" },
      { Item: "Update", Value: "available · custom update" },
      {
        Item: "Gateway",
        Value:
          "remote · wss://gateway.example.com (config) · ok(reachable 42ms) · auth token · gateway app 1.2.3",
      },
      { Item: "Gateway auth warning", Value: "warn(warn-text)" },
      { Item: "Gateway self", Value: "gateway-self" },
      { Item: "Gateway service", Value: "LaunchAgent installed · loaded · running" },
      { Item: "Node service", Value: "node loaded · running (pid 42)" },
      { Item: "Agents", Value: "2 total" },
      { Item: "Secrets", Value: "none" },
    ]);
  });

  it("builds the shared gateway json payload from the overview surface", () => {
    expect(
      buildStatusGatewayJsonPayloadFromSurface({
        surface: {
          gatewayMode: "remote",
          remoteUrlMissing: false,
          gatewayConnection: {
            url: "wss://gateway.example.com",
            urlSource: "config",
            message: "Gateway target: wss://gateway.example.com",
          },
          gatewayReachable: true,
          gatewayProbe: { connectLatencyMs: 42, error: null } as never,
          gatewayProbeAuthWarning: "warn-text",
          gatewaySelf: { host: "gateway", version: "1.2.3" },
        } as never,
      }),
    ).toEqual({
      mode: "remote",
      url: "wss://gateway.example.com",
      urlSource: "config",
      misconfigured: false,
      reachable: true,
      connectLatencyMs: 42,
      self: { host: "gateway", version: "1.2.3" },
      error: null,
      authWarning: "warn-text",
    });
  });
});
