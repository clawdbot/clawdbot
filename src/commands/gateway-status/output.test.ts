// Gateway-status output tests cover warning construction plus text and JSON rendering.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayProbeResult } from "../../gateway/probe.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { GatewayStatusProbedTarget } from "./probe-run.js";

const mocks = vi.hoisted(() => ({
  writeRuntimeJson: vi.fn(),
}));

vi.mock("../../runtime.js", () => ({
  writeRuntimeJson: (...args: unknown[]) => mocks.writeRuntimeJson(...args),
}));

vi.mock("../../../packages/terminal-core/src/theme.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../packages/terminal-core/src/theme.js")
  >("../../../packages/terminal-core/src/theme.js");
  return {
    ...actual,
    colorize: (_rich: boolean, _theme: unknown, text: string) => text,
  };
});

const { buildGatewayStatusWarnings, writeGatewayStatusJson, writeGatewayStatusText } =
  await import("./output.js");

function createRuntimeCapture(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  } as unknown as RuntimeEnv;
}

function requireRuntimeJsonPayload(runtime: RuntimeEnv, index = 0): unknown {
  const call = mocks.writeRuntimeJson.mock.calls[index];
  if (!call) {
    throw new Error(`expected writeRuntimeJson call ${index}`);
  }
  expect(call[0]).toBe(runtime);
  return call[1];
}

function createProbe(
  capability: GatewayProbeResult["auth"]["capability"],
  params: {
    ok: boolean;
    connectLatencyMs: number | null;
    error?: string | null;
  },
): GatewayProbeResult {
  return {
    ok: params.ok,
    url: "ws://127.0.0.1:18789",
    connectLatencyMs: params.connectLatencyMs,
    error: params.error ?? null,
    close: null,
    auth: {
      role: "operator",
      scopes: capability === "admin_capable" ? ["operator.admin"] : ["operator.read"],
      capability,
    },
    server: {
      version: "2026.4.24",
      connId: "conn-test",
    },
    health: null,
    status: null,
    presence: null,
    configSnapshot: null,
  };
}

function createTarget(id: string, probe: GatewayProbeResult): GatewayStatusProbedTarget {
  return {
    target: {
      id,
      kind: "explicit",
      url: probe.url,
      active: true,
    },
    probe,
    configSummary: null,
    self: null,
    authDiagnostics: [],
  };
}

function createReachableTarget(
  id: string,
  self: GatewayStatusProbedTarget["self"],
  target?: Partial<GatewayStatusProbedTarget["target"]>,
  configPath = "/tmp/openclaw/config.json",
): GatewayStatusProbedTarget {
  const probe = createProbe("admin_capable", {
    ok: true,
    connectLatencyMs: 20,
  });
  if (target?.url) {
    probe.url = target.url;
  }
  const base = createTarget(id, probe);
  return {
    ...base,
    target: {
      ...base.target,
      ...target,
    },
    self,
    configSummary: {
      path: configPath,
      exists: true,
      valid: true,
      issues: [],
      legacyIssues: [],
      gateway: {
        mode: null,
        bind: null,
        port: null,
        controlUiEnabled: null,
        controlUiBasePath: null,
        authMode: null,
        authTokenConfigured: false,
        authPasswordConfigured: false,
        remoteUrl: null,
        remoteTokenConfigured: false,
        remotePasswordConfigured: false,
        tailscaleMode: null,
      },
      discovery: {
        wideAreaEnabled: null,
      },
    },
  };
}

const MULTIPLE_GATEWAYS_WARNING = {
  code: "multiple_gateways",
  message:
    "Unconventional setup: multiple reachable gateway identities detected. Usually one gateway per network is recommended unless you intentionally run isolated profiles, like a rescue bot (see docs: /gateway#multiple-gateways-same-host).",
};

const GATEWAY_SELF = {
  host: "gateway-host",
  ip: "192.0.2.10",
  version: "2026.5.22",
  platform: "linux",
  instanceId: "gateway-instance-1",
};

const GATEWAY_SELF_NO_PROCESS_ID = {
  host: "gateway-host",
  ip: "192.0.2.10",
  version: "2026.5.22",
  platform: "linux",
};

describe("gateway status output", () => {
  beforeEach(() => {
    mocks.writeRuntimeJson.mockReset();
  });

  it("warns with diagnostic next steps when no probes or Bonjour discovery find a gateway", () => {
    const warnings = buildGatewayStatusWarnings({
      probed: [
        createTarget(
          "localLoopback",
          createProbe("unknown", {
            ok: false,
            connectLatencyMs: null,
            error: "connection refused",
          }),
        ),
      ],
      sshTarget: null,
      sshTunnelStarted: false,
      sshTunnelError: null,
      discoveryCount: 0,
    });

    expect(warnings.find((entry) => entry.code === "no_gateway_reachable")).toStrictEqual({
      code: "no_gateway_reachable",
      message:
        "No gateway answered any probe and Bonjour discovery returned no local gateways. Run `openclaw gateway status --deep --require-rpc` to inspect service state, config paths, listener owners, and logs; include `ss -ltnp` or `lsof -nP -iTCP:<port> -sTCP:LISTEN` for the configured port when filing a report.",
      targetIds: ["localLoopback"],
    });
  });

  it.each([
    {
      name: "suppresses warning for SSH tunnel and configured remote with the same self identity",
      probed: [
        createReachableTarget("sshTunnel", GATEWAY_SELF, {
          kind: "sshTunnel",
          url: "ws://127.0.0.1:18789",
          tunnel: {
            kind: "ssh",
            target: "user@gateway-host",
            localPort: 18789,
            remotePort: 18789,
            pid: 1234,
          },
        }),
        createReachableTarget(
          "configRemote",
          {
            ...GATEWAY_SELF,
            host: GATEWAY_SELF.host.toUpperCase(),
          },
          { kind: "configRemote", url: "ws://gateway-host:18789" },
        ),
      ],
      sshTarget: "user@gateway-host",
      expectedTargetIds: null,
    },
    {
      name: "suppresses warning for the same self identity on different transport ports",
      probed: [
        createReachableTarget("localLoopback", GATEWAY_SELF, {
          kind: "localLoopback",
          url: "ws://127.0.0.1:18789",
        }),
        createReachableTarget("explicit", GATEWAY_SELF, {
          kind: "explicit",
          url: "ws://gateway-host:28789",
        }),
      ],
      sshTarget: null,
      expectedTargetIds: null,
    },
    {
      name: "warns when same-host probes do not report process identity",
      probed: [
        createReachableTarget("localLoopback", GATEWAY_SELF_NO_PROCESS_ID, {
          kind: "localLoopback",
          url: "ws://127.0.0.1:18789",
        }),
        createReachableTarget("explicit", GATEWAY_SELF_NO_PROCESS_ID, {
          kind: "explicit",
          url: "ws://gateway-host:28789",
        }),
      ],
      sshTarget: null,
      expectedTargetIds: ["localLoopback", "explicit"],
    },
    {
      name: "warns when probes report distinct identities",
      probed: [
        createReachableTarget("sshTunnel", {
          host: "gateway-a",
          ip: "192.0.2.10",
          version: "2026.5.22",
          platform: "linux",
          instanceId: "gateway-instance-a",
        }),
        createReachableTarget("configRemote", {
          host: "gateway-b",
          ip: "192.0.2.11",
          version: "2026.5.22",
          platform: "linux",
          instanceId: "gateway-instance-b",
        }),
      ],
      sshTarget: "user@gateway-a",
      expectedTargetIds: ["sshTunnel", "configRemote"],
    },
    {
      name: "warns when probe identity is unknown",
      probed: [
        createReachableTarget("sshTunnel", null),
        createReachableTarget("configRemote", null),
      ],
      sshTarget: "user@gateway-host",
      expectedTargetIds: ["sshTunnel", "configRemote"],
    },
  ])("$name", ({ probed, sshTarget, expectedTargetIds }) => {
    const warnings = buildGatewayStatusWarnings({
      probed,
      sshTarget,
      sshTunnelStarted: sshTarget !== null,
      sshTunnelError: null,
      discoveryCount: 0,
    });
    const warning = warnings.find((entry) => entry.code === "multiple_gateways");

    if (expectedTargetIds === null) {
      expect(warning).toBeUndefined();
    } else {
      expect(warning).toStrictEqual({
        ...MULTIPLE_GATEWAYS_WARNING,
        targetIds: expectedTargetIds,
      });
    }
  });

  it("derives summary capability from reachable probes only in json output", () => {
    const runtime = createRuntimeCapture();
    writeGatewayStatusJson({
      runtime,
      startedAt: Date.now() - 50,
      overallTimeoutMs: 5_000,
      discoveryTimeoutMs: 500,
      network: {
        localLoopbackUrl: "ws://127.0.0.1:18789",
        localTailnetUrl: null,
        tailnetIPv4: null,
      },
      discovery: [],
      probed: [
        createTarget(
          "unreachable-before-connect",
          createProbe("admin_capable", {
            ok: false,
            connectLatencyMs: null,
            error: "timeout",
          }),
        ),
        createTarget(
          "reachable-read",
          createProbe("read_only", {
            ok: true,
            connectLatencyMs: 20,
          }),
        ),
      ],
      warnings: [],
      primaryTargetId: "reachable-read",
    });

    expect(mocks.writeRuntimeJson).toHaveBeenCalledOnce();
    const payload = requireRuntimeJsonPayload(runtime) as { ok?: unknown; capability?: unknown };
    expect(payload?.ok).toBe(true);
    expect(payload?.capability).toBe("read_only");
  });

  it("derives summary capability from reachable probes only in text output", () => {
    const runtime = createRuntimeCapture();
    writeGatewayStatusText({
      runtime,
      rich: false,
      overallTimeoutMs: 5_000,
      discovery: [],
      probed: [
        createTarget(
          "unreachable-before-connect",
          createProbe("admin_capable", {
            ok: false,
            connectLatencyMs: null,
            error: "timeout",
          }),
        ),
        createTarget(
          "reachable-read",
          createProbe("read_only", {
            ok: false,
            connectLatencyMs: 20,
            error: "missing scope: operator.read",
          }),
        ),
      ],
      warnings: [],
    });

    expect(runtime.log).toHaveBeenCalledWith("Capability: read-only");
  });

  it("reports post-connect detail failures as reachable but degraded in json output", () => {
    const runtime = createRuntimeCapture();
    writeGatewayStatusJson({
      runtime,
      startedAt: Date.now() - 50,
      overallTimeoutMs: 5_000,
      discoveryTimeoutMs: 500,
      network: {
        localLoopbackUrl: "ws://127.0.0.1:18789",
        localTailnetUrl: null,
        tailnetIPv4: null,
      },
      discovery: [],
      probed: [
        createTarget(
          "detail-timeout",
          createProbe("read_only", {
            ok: false,
            connectLatencyMs: 40,
            error: "timeout",
          }),
        ),
      ],
      warnings: [
        {
          code: "probe_detail_failed",
          message:
            "Gateway accepted the WebSocket connection, but follow-up read diagnostics failed: timeout",
          targetIds: ["detail-timeout"],
        },
      ],
      primaryTargetId: "detail-timeout",
    });

    expect(mocks.writeRuntimeJson).toHaveBeenCalledOnce();
    const payload = requireRuntimeJsonPayload(runtime);
    expect(payload).toStrictEqual({
      ok: true,
      degraded: true,
      capability: "read_only",
      ts: expect.any(Number),
      durationMs: expect.any(Number),
      timeoutMs: 5_000,
      primaryTargetId: "detail-timeout",
      warnings: [
        {
          code: "probe_detail_failed",
          message:
            "Gateway accepted the WebSocket connection, but follow-up read diagnostics failed: timeout",
          targetIds: ["detail-timeout"],
        },
      ],
      network: {
        localLoopbackUrl: "ws://127.0.0.1:18789",
        localTailnetUrl: null,
        tailnetIPv4: null,
      },
      discovery: {
        timeoutMs: 500,
        count: 0,
        beacons: [],
      },
      targets: [
        {
          id: "detail-timeout",
          kind: "explicit",
          url: "ws://127.0.0.1:18789",
          active: true,
          tunnel: null,
          connect: {
            ok: true,
            rpcOk: false,
            scopeLimited: false,
            latencyMs: 40,
            error: "timeout",
            close: null,
          },
          auth: {
            role: "operator",
            scopes: ["operator.read"],
            capability: "read_only",
          },
          self: null,
          config: null,
          health: null,
          summary: null,
          presence: null,
        },
      ],
    });
  });
});
