// Status-all format tests cover dashboard URLs, gateway summaries, overview rows, and JSON payload shapes.
import { describe, expect, it } from "vitest";
import {
  baseStatusExpectedUpdateChannelInfo,
  baseStatusExpectedUpdateChannelLabel,
  baseStatusOverviewSurface,
  getStatusOverviewRowValue,
} from "../status.test-support.ts";
import {
  buildStatusOverviewSurfaceRows,
  buildStatusUpdateSurface,
  buildGatewayStatusJsonPayload,
} from "./format.js";

describe("status-all format", () => {
  it("formats gateway self summary consistently", () => {
    expect(
      getStatusOverviewRowValue("Gateway self", {
        gatewaySelf: {
          host: "gateway-host",
          ip: "100.64.0.1",
          version: "1.2.3",
          platform: "linux",
        },
      }),
    ).toBe("gateway-host (100.64.0.1) app 1.2.3 linux");
    expect(getStatusOverviewRowValue("Gateway self", { gatewaySelf: null })).toBeUndefined();
  });

  it("builds gateway summary parts for fallback remote targets", () => {
    expect(
      getStatusOverviewRowValue("Gateway", {
        gatewaySelf: null,
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
    ).toBe(
      "remote (remote.url missing) · fallback ws://127.0.0.1:18789 (missing gateway.remote.url (fallback local)) · misconfigured (remote.url missing)",
    );
  });

  it("formats dashboard values consistently", () => {
    expect(
      getStatusOverviewRowValue("Dashboard", {
        advertisedControlUiLinks: { httpUrl: "https://openclaw.local", wsUrl: "" },
      }),
    ).toBe("https://openclaw.local");
    expect(
      getStatusOverviewRowValue("Dashboard", {
        advertisedControlUiLinks: { httpUrl: "", wsUrl: "" },
      }),
    ).toBe("disabled");
    expect(
      getStatusOverviewRowValue("Dashboard", {
        cfg: { gateway: { controlUi: { enabled: false } } },
      }),
    ).toBe("disabled");
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
      channelInfo: baseStatusExpectedUpdateChannelInfo,
      channelLabel: baseStatusExpectedUpdateChannelLabel,
      gitLabel: "main · tag v1.2.3",
      updateLine: `git main · ↔ origin/main · behind 2 · npm update ${newerRegistryVersion}`,
      updateAvailable: true,
    });
  });

  it("resolves dashboard urls from gateway config", () => {
    expect(
      getStatusOverviewRowValue("Dashboard", {
        cfg: {
          gateway: {
            bind: "loopback",
            controlUi: { enabled: true, basePath: "/ui" },
          },
        },
      }),
    ).toBe("http://127.0.0.1:18789/ui/");
    expect(
      getStatusOverviewRowValue("Dashboard", {
        cfg: {
          gateway: {
            bind: "loopback",
            tls: { enabled: true },
          },
        },
      }),
    ).toBe("https://127.0.0.1:18789/");
    expect(
      getStatusOverviewRowValue("Dashboard", {
        cfg: {
          gateway: {
            controlUi: { enabled: false },
          },
        },
      }),
    ).toBe("disabled");
  });

  it("formats tailscale values for terse and detailed views", () => {
    expect(
      getStatusOverviewRowValue("Tailscale exposure", {
        tailscaleMode: "serve",
        tailscaleDns: "box.tail.ts.net",
        tailscaleHttpsUrl: "https://box.tail.ts.net",
      }),
    ).toBe("serve · box.tail.ts.net · https://box.tail.ts.net");
    expect(
      getStatusOverviewRowValue("Tailscale exposure", {
        tailscaleMode: "funnel",
        tailscaleDns: null,
        tailscaleHttpsUrl: null,
        tailscaleBackendState: "Running",
        includeBackendStateWhenOn: true,
      }),
    ).toBe("funnel · Running · magicdns unknown");
    expect(
      getStatusOverviewRowValue("Tailscale exposure", {
        tailscaleMode: "off",
        tailscaleBackendState: "Stopped",
        tailscaleDns: "box.tail.ts.net",
        includeBackendStateWhenOff: true,
        includeDnsNameWhenOff: true,
      }),
    ).toBe("off · daemon Stopped · box.tail.ts.net");
  });

  it("formats service values across short and detailed runtime surfaces", () => {
    expect(
      getStatusOverviewRowValue("Gateway service", {
        gatewayService: {
          label: "LaunchAgent",
          installed: false,
          loadedText: "loaded",
        },
      }),
    ).toBe("LaunchAgent not installed");
    expect(
      getStatusOverviewRowValue("Gateway service", {
        gatewayService: {
          label: "LaunchAgent",
          installed: true,
          managedByOpenClaw: true,
          loadedText: "loaded",
          runtimeShort: "running",
        },
      }),
    ).toBe("LaunchAgent installed · loaded · running");
    expect(
      getStatusOverviewRowValue("Gateway service", {
        gatewayService: {
          label: "systemd",
          installed: true,
          loadedText: "not loaded",
          runtime: { status: "failed", pid: 42 },
        },
      }),
    ).toBe("systemd not loaded · failed (pid 42)");
  });

  it.each([
    {
      installed: false,
      loadedText: "unknown",
      expected: "LaunchAgent unknown (inspection failed: permission denied)",
    },
    {
      installed: null,
      loadedText: "unknown",
      expected: "LaunchAgent unknown (inspection failed: permission denied)",
    },
    {
      installed: true,
      managedByOpenClaw: true,
      loadedText: "unknown",
      runtimeShort: "running (pid 42)",
      expected:
        "LaunchAgent installed · unknown (inspection failed: permission denied) · running (pid 42)",
    },
    {
      installed: true,
      managedByOpenClaw: false,
      loadedText: "running (externally managed)",
      runtime: { status: "running", pid: 42 },
      expected:
        "LaunchAgent running (externally managed) (inspection failed: permission denied) · running (pid 42)",
    },
  ])("keeps inspection errors visible: $expected", ({ expected, ...service }) => {
    expect(
      getStatusOverviewRowValue("Gateway service", {
        gatewayService: {
          ...service,
          label: "LaunchAgent",
          loadState: { status: "unknown", detail: "permission denied" },
        },
      }),
    ).toBe(expected);
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

  it("redacts credential-bearing Gateway URLs from text and JSON status", () => {
    const gatewayConnection = {
      url: "wss://user:password@gateway.example/ws?token=secret&key=api-key&X-Amz-Signature=signed",
      urlSource: "cli --url",
    };

    const summary = getStatusOverviewRowValue("Gateway", {
      gatewayMode: "remote",
      remoteUrlMissing: false,
      gatewayConnection,
      gatewayReachable: false,
      gatewayProbe: { error: "unreachable" },
      gatewayProbeAuth: null,
    });
    const json = buildGatewayStatusJsonPayload({
      gatewayMode: "remote",
      gatewayConnection,
      remoteUrlMissing: false,
      gatewayReachable: false,
      gatewayProbe: { error: "unreachable" },
      gatewaySelf: null,
    });
    const output = JSON.stringify({ summary, json });

    expect(summary).toContain("gateway.example/ws");
    expect(output).toContain("gateway.example/ws");
    expect(output).not.toContain("password");
    expect(output).not.toContain("secret");
    expect(output).not.toContain("api-key");
    expect(output).not.toContain("signed");
  });

  it("builds shared gateway surface values for node and gateway views", () => {
    expect(
      buildStatusOverviewSurfaceRows({
        ...baseStatusOverviewSurface,
        agentsValue: "2 total",
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
      }).filter((row) =>
        ["Dashboard", "Gateway", "Gateway self", "Gateway service", "Node service"].includes(
          row.Item,
        ),
      ),
    ).toEqual([
      { Item: "Dashboard", Value: "http://127.0.0.1:18789/" },
      {
        Item: "Gateway",
        Value:
          "remote · wss://gateway.example.com (config) · ok(reachable 123ms) · auth token · gateway app 1.2.3",
      },
      { Item: "Gateway self", Value: "gateway app 1.2.3" },
      { Item: "Gateway service", Value: "LaunchAgent installed · loaded · running" },
      { Item: "Node service", Value: "node loaded · running (pid 42)" },
    ]);
  });

  it("prefers advertised Control UI links for dashboard values", () => {
    expect(
      buildStatusOverviewSurfaceRows({
        ...baseStatusOverviewSurface,
        agentsValue: "2 total",
        cfg: { gateway: { bind: "lan" } },
        advertisedControlUiLinks: {
          httpUrl: "http://10.211.55.3:18789/",
          wsUrl: "ws://10.211.55.3:18789",
        },
        gatewayMode: "local",
        remoteUrlMissing: false,
        gatewayConnection: {
          url: "ws://127.0.0.1:18789",
          urlSource: "local loopback",
        },
        gatewayReachable: true,
        gatewayProbe: { connectLatencyMs: 12, error: null },
        gatewayProbeAuth: { token: "tok" },
        gatewaySelf: null,
        gatewayService: {
          label: "LaunchAgent",
          installed: true,
          loadedText: "loaded",
        },
        nodeService: {
          label: "node",
          installed: true,
          loadedText: "loaded",
        },
      }).find((row) => row.Item === "Dashboard")?.Value,
    ).toBe("http://10.211.55.3:18789/");
  });

  it("prefers node-only gateway values when present", () => {
    expect(
      buildStatusOverviewSurfaceRows({
        ...baseStatusOverviewSurface,
        agentsValue: "2 total",
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
      }).filter((row) =>
        ["Dashboard", "Gateway", "Gateway self", "Gateway service", "Node service"].includes(
          row.Item,
        ),
      ),
    ).toEqual([
      { Item: "Dashboard", Value: "disabled" },
      { Item: "Gateway", Value: "node → remote.example:18789 · no local gateway" },
      { Item: "Gateway service", Value: "LaunchAgent not installed" },
      { Item: "Node service", Value: "node loaded · running" },
    ]);
  });

  it("builds overview rows with shared ordering", () => {
    expect(
      buildStatusOverviewSurfaceRows({
        ...baseStatusOverviewSurface,
        prefixRows: [{ Item: "Version", Value: "1.0.0" }],
        advertisedControlUiLinks: { httpUrl: "https://openclaw.local", wsUrl: "" },
        gatewayMode: "local",
        gatewayConnection: { url: "ws://127.0.0.1:18789" },
        gatewayProbe: { connectLatencyMs: 12 },
        gatewaySelf: { host: "gateway-host" },
        gatewayService: { label: "launchd", installed: true, loadedText: "loaded" },
        nodeService: { label: "node", installed: true, loadedText: "loaded" },
        updateValue: "up to date",
        gatewayAuthWarningValue: "warning",
        middleRows: [{ Item: "Security", Value: "Run: openclaw security audit --deep" }],
        agentsValue: "2 total",
        suffixRows: [{ Item: "Secrets", Value: "none" }],
      }),
    ).toEqual([
      { Item: "Version", Value: "1.0.0" },
      { Item: "Dashboard", Value: "https://openclaw.local" },
      { Item: "Tailscale exposure", Value: "serve · box.tail.ts.net · https://box.tail.ts.net" },
      { Item: "Channel", Value: baseStatusExpectedUpdateChannelLabel },
      { Item: "Git", Value: "main · tag v1.2.3" },
      { Item: "Update", Value: "up to date" },
      {
        Item: "Gateway",
        Value: "local · ws://127.0.0.1:18789 · reachable 12ms · auth token · gateway-host",
      },
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
      { Item: "Channel", Value: baseStatusExpectedUpdateChannelLabel },
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
