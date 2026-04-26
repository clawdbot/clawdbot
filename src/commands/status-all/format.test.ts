import { describe, expect, it } from "vitest";
import {
  buildStatusGatewaySurfaceValues,
  buildStatusOverviewRows,
  buildStatusOverviewSurfaceRows,
  buildStatusUpdateSurface,
  buildGatewayStatusJsonPayload,
  buildGatewayStatusSummaryParts,
  formatGatewaySelfSummary,
  resolveStatusDashboardUrl,
  formatStatusDashboardValue,
  formatStatusServiceValue,
  formatStatusTailscaleValue,
} from "./format.js";

describe("status-all format", () => {
  it("formats gateway self summary consistently", () => {
    expect(
      formatGatewaySelfSummary({
        host: "gateway-host",
        ip: "100.64.0.1",
        version: "1.2.3",
        platform: "linux",
      }),
    ).toBe("gateway-host (100.64.0.1) app 1.2.3 linux");
    expect(formatGatewaySelfSummary(null)).toBeNull();
  });

  it("builds gateway summary parts for fallback remote targets", () => {
    expect(
      buildGatewayStatusSummaryParts({
        gatewayMode: "remote",
        remoteUrlMissing: true,
        gatewayConnection: {
          url: "ws://127.0.0.1:18789",
          urlSource: "missing gateway.remote.url (fallback local)",
        },
        gatewayReachable: false,
        gatewayProbe: null,
        gatewayProbeAuth: { token: "tok" },
      }),
    ).toEqual({
      targetText: "fallback ws://127.0.0.1:18789",
      targetTextWithSource:
        "fallback ws://127.0.0.1:18789 (missing gateway.remote.url (fallback local))",
      reachText: "misconfigured (remote.url missing)",
      authText: "",
      modeLabel: "remote (remote.url missing)",
    });
  });

  it("formats dashboard values consistently", () => {
    expect(formatStatusDashboardValue("https://openclaw.local")).toBe("https://openclaw.local");
    expect(formatStatusDashboardValue("")).toBe("disabled");
    expect(formatStatusDashboardValue(null)).toBe("disabled");
  });

  it("builds shared update surface values", () => {
    const newerRegistryVersion = "9999.0.0";

    expect(
      buildStatusUpdateSurface({
        updateConfigChannel: "stable",
        update: {
          installKind: "git",
          git: {
            branch: "main",
            tag: "v1.2.3",
            upstream: "origin/main",
            dirty: false,
            behind: 2,
            ahead: 0,
            fetchOk: true,
          },
          registry: {
            latestVersion: newerRegistryVersion,
          },
        } as never,
      }),
    ).toEqual({
      channelInfo: {
        channel: "stable",
        source: "config",
        label: "stable (config)",
      },
      channelLabel: "stable (config)",
      gitLabel: "main · tag v1.2.3",
      updateLine: `git main · ↔ origin/main · behind 2 · npm update ${newerRegistryVersion}`,
      updateAvailable: true,
    });
  });

  it("resolves dashboard urls from gateway config", () => {
    expect(
      resolveStatusDashboardUrl({
        cfg: {
          gateway: {
            bind: "loopback",
            controlUi: { enabled: true, basePath: "/ui" },
          },
        },
      }),
    ).toBe("http://127.0.0.1:18789/ui/");
    expect(
      resolveStatusDashboardUrl({
        cfg: {
          gateway: {
            bind: "loopback",
            tls: { enabled: true },
          },
        },
      }),
    ).toBe("https://127.0.0.1:18789/");
    expect(
      resolveStatusDashboardUrl({
        cfg: {
          gateway: {
            controlUi: { enabled: false },
          },
        },
      }),
    ).toBeNull();
  });

  it("formats tailscale values for terse and detailed views", () => {
    expect(
      formatStatusTailscaleValue({
        tailscaleMode: "serve",
        dnsName: "box.tail.ts.net",
        httpsUrl: "https://box.tail.ts.net",
      }),
    ).toBe("serve · box.tail.ts.net · https://box.tail.ts.net");
    expect(
      formatStatusTailscaleValue({
        tailscaleMode: "funnel",
        backendState: "Running",
        includeBackendStateWhenOn: true,
      }),
    ).toBe("funnel · Running · magicdns unknown");
    expect(
      formatStatusTailscaleValue({
        tailscaleMode: "off",
        backendState: "Stopped",
        dnsName: "box.tail.ts.net",
        includeBackendStateWhenOff: true,
        includeDnsNameWhenOff: true,
      }),
    ).toBe("off · daemon Stopped · box.tail.ts.net");
  });

  it("formats service values across short and detailed runtime surfaces", () => {
    expect(
      formatStatusServiceValue({
        label: "LaunchAgent",
        installed: false,
        loadedText: "loaded",
      }),
    ).toBe("LaunchAgent not installed");
    expect(
      formatStatusServiceValue({
        label: "LaunchAgent",
        installed: true,
        managedByOpenClaw: true,
        loadedText: "loaded",
        runtimeShort: "running",
      }),
    ).toBe("LaunchAgent installed · loaded · running");
    expect(
      formatStatusServiceValue({
        label: "systemd",
        installed: true,
        loadedText: "not loaded",
        runtimeStatus: "failed",
        runtimePid: 42,
      }),
    ).toBe("systemd not loaded · failed (pid 42)");
  });

  it("builds gateway json payloads consistently", () => {
    expect(
      buildGatewayStatusJsonPayload({
        gatewayMode: "remote",
        gatewayConnection: {
          url: "wss://gateway.example.com",
          urlSource: "config",
        },
        remoteUrlMissing: false,
        gatewayReachable: true,
        gatewayProbe: { connectLatencyMs: 123, error: null },
        gatewaySelf: { host: "gateway", version: "1.2.3" },
        gatewayProbeAuthWarning: "warn",
      }),
    ).toEqual({
      mode: "remote",
      url: "wss://gateway.example.com",
      urlSource: "config",
      misconfigured: false,
      reachable: true,
      connectLatencyMs: 123,
      self: { host: "gateway", version: "1.2.3" },
      error: null,
      authWarning: "warn",
    });
  });

  it("builds shared gateway surface values for node and gateway views", () => {
    expect(
      buildStatusGatewaySurfaceValues({
        cfg: { gateway: { bind: "loopback" } },
        gatewayMode: "remote",
        remoteUrlMissing: false,
        gatewayConnection: {
          url: "wss://gateway.example.com",
          urlSource: "config",
        },
        gatewayReachable: true,
        gatewayProbe: { connectLatencyMs: 123, error: null },
        gatewayProbeAuth: { token: "tok" },
        gatewaySelf: { host: "gateway", version: "1.2.3" },
        gatewayService: {
          label: "LaunchAgent",
          installed: true,
          managedByOpenClaw: true,
          loadedText: "loaded",
          runtimeShort: "running",
        },
        nodeService: {
          label: "node",
          installed: true,
          loadedText: "loaded",
          runtime: { status: "running", pid: 42 },
        },
        decorateOk: (value) => `ok(${value})`,
        decorateWarn: (value) => `warn(${value})`,
      }),
    ).toEqual({
      dashboardUrl: "http://127.0.0.1:18789/",
      gatewayValue:
        "remote · wss://gateway.example.com (config) · ok(reachable 123ms) · auth token · gateway app 1.2.3",
      gatewaySelfValue: "gateway app 1.2.3",
      gatewayServiceValue: "LaunchAgent installed · loaded · running",
      nodeServiceValue: "node loaded · running (pid 42)",
    });
  });

  it("prefers node-only gateway values when present", () => {
    expect(
      buildStatusGatewaySurfaceValues({
        cfg: { gateway: { controlUi: { enabled: false } } },
        gatewayMode: "local",
        remoteUrlMissing: false,
        gatewayConnection: {
          url: "ws://127.0.0.1:18789",
        },
        gatewayReachable: false,
        gatewayProbe: null,
        gatewayProbeAuth: null,
        gatewaySelf: null,
        gatewayService: {
          label: "LaunchAgent",
          installed: false,
          loadedText: "not loaded",
        },
        nodeService: {
          label: "node",
          installed: true,
          loadedText: "loaded",
          runtimeShort: "running",
        },
        nodeOnlyGateway: {
          gatewayValue: "node → remote.example:18789 · no local gateway",
        },
      }),
    ).toEqual({
      dashboardUrl: null,
      gatewayValue: "node → remote.example:18789 · no local gateway",
      gatewaySelfValue: null,
      gatewayServiceValue: "LaunchAgent not installed",
      nodeServiceValue: "node loaded · running",
    });
  });

  it("builds overview rows with shared ordering", () => {
    expect(
      buildStatusOverviewRows({
        prefixRows: [{ Item: "Version", Value: "1.0.0" }],
        dashboardValue: "https://openclaw.local",
        tailscaleValue: "serve · https://tail.example",
        channelLabel: "stable",
        gitLabel: "main @ v1.0.0",
        updateValue: "up to date",
        gatewayValue: "local · reachable",
        gatewayAuthWarning: "warning",
        middleRows: [{ Item: "Security", Value: "Run: openclaw security audit --deep" }],
        gatewaySelfValue: "gateway-host",
        gatewayServiceValue: "launchd loaded",
        nodeServiceValue: "node loaded",
        agentsValue: "2 total",
        suffixRows: [{ Item: "Secrets", Value: "none" }],
      }),
    ).toEqual([
      { Item: "Version", Value: "1.0.0" },
      { Item: "Dashboard", Value: "https://openclaw.local" },
      { Item: "Tailscale exposure", Value: "serve · https://tail.example" },
      { Item: "Channel", Value: "stable" },
      { Item: "Git", Value: "main @ v1.0.0" },
      { Item: "Update", Value: "up to date" },
      { Item: "Gateway", Value: "local · reachable" },
      { Item: "Gateway auth warning", Value: "warning" },
      { Item: "Security", Value: "Run: openclaw security audit --deep" },
      { Item: "Gateway self", Value: "gateway-host" },
      { Item: "Gateway service", Value: "launchd loaded" },
      { Item: "Node service", Value: "node loaded" },
      { Item: "Agents", Value: "2 total" },
      { Item: "Secrets", Value: "none" },
    ]);
  });

  it("builds overview surface rows from shared gateway and update inputs", () => {
    expect(
      buildStatusOverviewSurfaceRows({
        cfg: {
          update: { channel: "stable" },
          gateway: { bind: "loopback" },
        },
        update: {
          installKind: "git",
          git: {
            branch: "main",
            tag: "v1.2.3",
            upstream: "origin/main",
            dirty: false,
            behind: 2,
            ahead: 0,
            fetchOk: true,
          },
          registry: { latestVersion: "2026.4.10" },
        } as never,
        tailscaleMode: "serve",
        tailscaleDns: "box.tail.ts.net",
        tailscaleHttpsUrl: "https://box.tail.ts.net",
        gatewayMode: "remote",
        remoteUrlMissing: false,
        gatewayConnection: {
          url: "wss://gateway.example.com",
          urlSource: "config",
        },
        gatewayReachable: true,
        gatewayProbe: { connectLatencyMs: 123, error: null },
        gatewayProbeAuth: { token: "tok" },
        gatewayProbeAuthWarning: "warn-text",
        gatewaySelf: { host: "gateway", version: "1.2.3" },
        gatewayService: {
          label: "LaunchAgent",
          installed: true,
          managedByOpenClaw: true,
          loadedText: "loaded",
          runtimeShort: "running",
        },
        nodeService: {
          label: "node",
          installed: true,
          loadedText: "loaded",
          runtime: { status: "running", pid: 42 },
        },
        prefixRows: [{ Item: "Version", Value: "1.0.0" }],
        middleRows: [{ Item: "Security", Value: "Run audit" }],
        suffixRows: [{ Item: "Secrets", Value: "none" }],
        agentsValue: "2 total",
        updateValue: "available · custom update",
        gatewayAuthWarningValue: "warn(warn-text)",
      }),
    ).toEqual([
      { Item: "Version", Value: "1.0.0" },
      { Item: "Dashboard", Value: "http://127.0.0.1:18789/" },
      { Item: "Tailscale exposure", Value: "serve · box.tail.ts.net · https://box.tail.ts.net" },
      { Item: "Channel", Value: "stable (config)" },
      { Item: "Git", Value: "main · tag v1.2.3" },
      { Item: "Update", Value: "available · custom update" },
      {
        Item: "Gateway",
        Value:
          "remote · wss://gateway.example.com (config) · reachable 123ms · auth token · gateway app 1.2.3",
      },
      { Item: "Gateway auth warning", Value: "warn(warn-text)" },
      { Item: "Security", Value: "Run audit" },
      { Item: "Gateway self", Value: "gateway app 1.2.3" },
      { Item: "Gateway service", Value: "LaunchAgent installed · loaded · running" },
      { Item: "Node service", Value: "node loaded · running (pid 42)" },
      { Item: "Agents", Value: "2 total" },
      { Item: "Secrets", Value: "none" },
    ]);
  });
});
