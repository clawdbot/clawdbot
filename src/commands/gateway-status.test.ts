import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayProbeResult } from "../gateway/probe.js";
import type { GatewayBonjourBeacon } from "../infra/bonjour-discovery.js";
import type { GatewayTlsRuntime } from "../infra/tls/gateway.js";
import type { RuntimeEnv } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { gatewayStatusCommand } from "./gateway-status.js";
import { createSecretRefGatewayConfig } from "./gateway-status/test-support.js";

const mocks = vi.hoisted(() => {
  const sshStop = vi.fn(async () => {});
  return {
    readBestEffortConfig: vi.fn(async () => ({
      gateway: {
        mode: "remote",
        remote: { url: "wss://remote.example:18789", token: "rtok" },
        auth: { token: "ltok" },
      },
    })),
    resolveGatewayPort: vi.fn((_cfg?: unknown) => 18789),
    discoverGatewayBeacons: vi.fn(async (_opts?: unknown): Promise<GatewayBonjourBeacon[]> => []),
    pickPrimaryTailnetIPv4: vi.fn(() => "100.64.0.10"),
    sshStop,
    resolveSshConfig: vi.fn(
      async (
        _opts?: unknown,
      ): Promise<{
        user: string;
        host: string;
        port: number;
        identityFiles: string[];
      } | null> => null,
    ),
    startSshPortForward: vi.fn(async (_opts?: unknown) => ({
      parsedTarget: { user: "me", host: "studio", port: 22 },
      localPort: 18789,
      remotePort: 18789,
      pid: 123,
      stderr: [],
      stop: sshStop,
    })),
    loadGatewayTlsRuntime: vi.fn(
      async (): Promise<GatewayTlsRuntime> => ({
        enabled: true,
        required: true,
        fingerprintSha256: "sha256:local-fingerprint",
      }),
    ),
    probeGateway: vi.fn(async (opts: { url: string }): Promise<GatewayProbeResult> => {
      const { url } = opts;
      if (url.includes("127.0.0.1")) {
        return {
          ok: true,
          url,
          connectLatencyMs: 12,
          error: null,
          close: null,
          auth: {
            role: "operator",
            scopes: ["operator.read"],
            capability: "read_only",
          },
          server: {
            version: "2026.4.24",
            connId: "local",
          },
          health: { ok: true },
          status: {
            linkChannel: {
              id: "whatsapp",
              label: "WhatsApp",
              linked: false,
              authAgeMs: null,
            },
            sessions: { count: 0 },
          },
          presence: [
            {
              mode: "gateway",
              reason: "self",
              host: "local",
              ip: "127.0.0.1",
              text: "Gateway: local (127.0.0.1) · app test · mode gateway · reason self",
              ts: Date.now(),
            },
          ],
          configSnapshot: {
            path: "/tmp/cfg.json",
            exists: true,
            valid: true,
            config: {
              gateway: { mode: "local" },
            },
            issues: [],
            legacyIssues: [],
          },
        };
      }
      return {
        ok: true,
        url,
        connectLatencyMs: 34,
        error: null,
        close: null,
        auth: {
          role: "operator",
          scopes: ["operator.admin"],
          capability: "admin_capable",
        },
        server: {
          version: "2026.4.24",
          connId: "remote",
        },
        health: { ok: true },
        status: {
          linkChannel: {
            id: "whatsapp",
            label: "WhatsApp",
            linked: true,
            authAgeMs: 5_000,
          },
          sessions: { count: 2 },
        },
        presence: [
          {
            mode: "gateway",
            reason: "self",
            host: "remote",
            ip: "100.64.0.2",
            text: "Gateway: remote (100.64.0.2) · app test · mode gateway · reason self",
            ts: Date.now(),
          },
        ],
        configSnapshot: {
          path: "/tmp/remote.json",
          exists: true,
          valid: true,
          config: { gateway: { mode: "remote" } },
          issues: [],
          legacyIssues: [],
        },
      };
    }),
  };
});

const {
  readBestEffortConfig,
  discoverGatewayBeacons,
  pickPrimaryTailnetIPv4,
  sshStop,
  resolveSshConfig,
  startSshPortForward,
  loadGatewayTlsRuntime,
  probeGateway,
} = mocks;

vi.mock("../config/config.js", () => ({
  readBestEffortConfig: mocks.readBestEffortConfig,
  resolveGatewayPort: mocks.resolveGatewayPort,
}));

vi.mock("../infra/bonjour-discovery.js", () => ({
  discoverGatewayBeacons: mocks.discoverGatewayBeacons,
  resolveGatewayDiscoveryEndpoint: (beacon: GatewayBonjourBeacon) => {
    const host = beacon.host?.trim();
    const port = beacon.port;
    if (!host || typeof port !== "number" || !Number.isFinite(port) || port <= 0) {
      return null;
    }
    const scheme = beacon.gatewayTls === true ? "wss" : "ws";
    return {
      host,
      port,
      gatewayTls: beacon.gatewayTls === true,
      gatewayTlsFingerprintSha256: beacon.gatewayTlsFingerprintSha256,
      scheme,
      wsUrl: `${scheme}://${host}:${port}`,
    };
  },
}));

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: mocks.pickPrimaryTailnetIPv4,
}));

vi.mock("../infra/ssh-tunnel.js", () => ({
  parseSshTarget: (rawTarget: string) => {
    const trimmed = rawTarget.trim();
    if (!trimmed || trimmed.startsWith("-")) {
      return null;
    }
    const [userHost, rawPort] = trimmed.split(":");
    const [maybeUser, maybeHost] = userHost.includes("@")
      ? userHost.split("@", 2)
      : [undefined, userHost];
    if (!maybeHost) {
      return null;
    }
    return {
      user: maybeUser,
      host: maybeHost,
      port: rawPort ? Number(rawPort) : 22,
    };
  },
  startSshPortForward: mocks.startSshPortForward,
}));

vi.mock("../infra/ssh-config.js", () => ({
  resolveSshConfig: mocks.resolveSshConfig,
}));

vi.mock("../infra/tls/gateway.js", () => ({
  loadGatewayTlsRuntime: mocks.loadGatewayTlsRuntime,
}));

vi.mock("../gateway/probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/probe.js")>()),
  probeGateway: mocks.probeGateway,
}));

function createRuntimeCapture() {
  const runtimeLogs: string[] = [];
  const runtimeErrors: string[] = [];
  const runtime = {
    log: (msg: string) => runtimeLogs.push(msg),
    error: (msg: string) => runtimeErrors.push(msg),
    exit: (code: number) => {
      throw new Error(`__exit__:${code}`);
    },
  };
  return { runtime, runtimeLogs, runtimeErrors };
}

function asRuntimeEnv(runtime: ReturnType<typeof createRuntimeCapture>["runtime"]): RuntimeEnv {
  return runtime as unknown as RuntimeEnv;
}

type ProbeGatewayCall = {
  auth?: {
    password?: string;
    token?: string;
  };
  preauthHandshakeTimeoutMs?: number;
  timeoutMs?: number;
  tlsFingerprint?: string;
  url?: string;
};

function readProbeCalls(): ProbeGatewayCall[] {
  return probeGateway.mock.calls.map(([call]) => call as ProbeGatewayCall);
}

function requireProbeCall(url: string): ProbeGatewayCall {
  const call = readProbeCalls().find((candidate) => candidate.url === url);
  if (!call) {
    throw new Error(`Expected gateway probe call for ${url}`);
  }
  return call;
}

function makeRemoteGatewayConfig(url: string, token = "rtok", localToken = "ltok") {
  return {
    gateway: {
      mode: "remote",
      remote: { url, token },
      auth: { token: localToken },
    },
  };
}

function mockLocalTokenEnvRefConfig(envTokenId = "MISSING_GATEWAY_TOKEN") {
  readBestEffortConfig.mockResolvedValueOnce({
    secrets: {
      providers: {
        default: { source: "env" },
      },
    },
    gateway: {
      mode: "local",
      auth: {
        mode: "token",
        token: { source: "env", provider: "default", id: envTokenId },
      },
    },
  } as never);
}

async function runGatewayStatus(
  runtime: ReturnType<typeof createRuntimeCapture>["runtime"],
  opts: { timeout: string; json?: boolean; ssh?: string; sshAuto?: boolean; sshIdentity?: string },
) {
  await gatewayStatusCommand(opts, asRuntimeEnv(runtime));
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireRecordArray(value: unknown, label: string): Array<Record<string, unknown>> {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "object" && entry !== null)
  ) {
    throw new Error(`expected ${label}`);
  }
  return value as Array<Record<string, unknown>>;
}

function findUnresolvedSecretRefWarning(runtimeLogs: string[]) {
  const parsed = JSON.parse(runtimeLogs.join("\n")) as {
    warnings?: Array<{ code?: string; message?: string; targetIds?: string[] }>;
  };
  return parsed.warnings?.find(
    (warning) =>
      warning.code === "auth_secretref_unresolved" &&
      warning.message?.includes("gateway.auth.token SecretRef is unresolved"),
  );
}

function requireUnresolvedSecretRefWarning(runtimeLogs: string[]) {
  const warning = findUnresolvedSecretRefWarning(runtimeLogs);
  if (!warning) {
    throw new Error("expected unresolved gateway auth token SecretRef warning");
  }
  return warning;
}

describe("gateway-status command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prints human output by default", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();

    await runGatewayStatus(runtime, { timeout: "1000" });

    expect(runtimeErrors).toHaveLength(0);
    expect(runtimeLogs.join("\n")).toContain("Gateway Status");
    expect(runtimeLogs.join("\n")).toContain("Discovery (this machine)");
    expect(runtimeLogs.join("\n")).toContain("Targets");
  });

  it("prints a structured JSON envelope when --json is set", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();

    await runGatewayStatus(runtime, { timeout: "1000", json: true });

    expect(runtimeErrors).toHaveLength(0);
    const parsed = JSON.parse(runtimeLogs.join("\n")) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    const targets = requireRecordArray(parsed.targets, "gateway status targets");
    expect(targets.length).toBeGreaterThanOrEqual(2);
    const firstTarget = requireRecord(targets[0], "first gateway target");
    requireRecord(firstTarget.health, "first target health");
    requireRecord(firstTarget.summary, "first target summary");
  });

  it("surfaces degraded model-pricing health as a warning", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
    const defaultProbeGateway = probeGateway.getMockImplementation();
    try {
      probeGateway.mockImplementation(async (opts: { url: string }) => {
        const result = defaultProbeGateway
          ? await defaultProbeGateway(opts)
          : await mocks.probeGateway(opts);
        return {
          ...result,
          health: {
            ok: true,
            modelPricing: {
              state: "degraded",
              detail: "OpenRouter pricing fetch failed: TypeError: fetch failed",
              sources: [
                {
                  source: "openrouter",
                  state: "degraded",
                  detail: "OpenRouter pricing fetch failed: TypeError: fetch failed",
                },
              ],
            },
          },
        };
      });

      await runGatewayStatus(runtime, { timeout: "1000", json: true });
    } finally {
      probeGateway.mockReset();
      if (defaultProbeGateway) {
        probeGateway.mockImplementation(defaultProbeGateway);
      }
    }

    expect(runtimeErrors).toHaveLength(0);
    const parsed = JSON.parse(runtimeLogs.join("\n")) as {
      degraded?: boolean;
      warnings?: Array<{ code?: string; message?: string; targetIds?: string[] }>;
    };
    expect(parsed.degraded).toBe(false);
    const pricingWarnings =
      parsed.warnings?.filter((warning) => warning.code === "model_pricing_degraded") ?? [];
    expect(pricingWarnings).toHaveLength(2);
    expect(pricingWarnings.map((warning) => warning.message)).toEqual([
      "Model pricing warning: optional pricing refresh degraded: OpenRouter pricing fetch failed: TypeError: fetch failed",
      "Model pricing warning: optional pricing refresh degraded: OpenRouter pricing fetch failed: TypeError: fetch failed",
    ]);
    expect(pricingWarnings.map((warning) => warning.targetIds)).toEqual([
      ["sshTunnel"],
      ["configRemote"],
    ]);
  });

  it("includes diagnostic next steps when no gateway is reachable or discoverable", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
    const defaultProbeGateway = probeGateway.getMockImplementation();
    try {
      probeGateway.mockImplementation(async (opts: { url: string }) => ({
        ok: false,
        url: opts.url,
        connectLatencyMs: null,
        error: "connection refused",
        close: null,
        auth: {
          role: null,
          scopes: [],
          capability: "unknown",
        },
        health: null,
        status: null,
        presence: null,
        configSnapshot: null,
      }));

      await expect(runGatewayStatus(runtime, { timeout: "1000", json: true })).rejects.toThrow(
        "__exit__:1",
      );
    } finally {
      probeGateway.mockReset();
      if (defaultProbeGateway) {
        probeGateway.mockImplementation(defaultProbeGateway);
      }
    }

    expect(runtimeErrors).toHaveLength(0);
    const parsed = JSON.parse(runtimeLogs.join("\n")) as {
      warnings?: Array<{ code?: string; message?: string }>;
    };
    const warning = parsed.warnings?.find((entry) => entry.code === "no_gateway_reachable");
    expect(warning?.message).toContain("openclaw gateway status --deep --require-rpc");
    expect(warning?.message).toContain("ss -ltnp");
  });

  it("omits discovery wsUrl when only TXT hints are present", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
    discoverGatewayBeacons.mockResolvedValueOnce([
      {
        instanceName: "gateway",
        displayName: "Gateway",
        tailnetDns: "attacker.tailnet.ts.net",
        lanHost: "attacker.example.com",
        gatewayPort: 19443,
      },
    ]);

    await runGatewayStatus(runtime, { timeout: "1000", json: true });

    expect(runtimeErrors).toHaveLength(0);
    const parsed = JSON.parse(runtimeLogs.join("\n")) as {
      discovery?: { beacons?: Array<{ wsUrl?: string | null }> };
    };
    expect(parsed.discovery?.beacons?.[0]?.wsUrl).toBeNull();
  });

  it("keeps status output working when tailnet discovery throws", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
    pickPrimaryTailnetIPv4.mockImplementationOnce(() => {
      throw new Error("uv_interface_addresses failed");
    });

    await runGatewayStatus(runtime, { timeout: "1000", json: true });

    expect(runtimeErrors).toHaveLength(0);
    const parsed = JSON.parse(runtimeLogs.join("\n")) as {
      network?: { tailnetIPv4?: string | null; localTailnetUrl?: string | null };
    };
    expect(parsed.network?.tailnetIPv4).toBeNull();
    expect(parsed.network?.localTailnetUrl).toBeNull();
  });

  it("treats missing-scope RPC probe failures as degraded but reachable", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
    readBestEffortConfig.mockResolvedValueOnce({
      gateway: {
        mode: "local",
        auth: { mode: "token", token: "ltok" },
      },
    } as never);
    probeGateway.mockResolvedValueOnce({
      ok: false,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: 51,
      error: "missing scope: operator.read",
      close: null,
      auth: {
        role: "operator",
        scopes: ["operator.write"],
        capability: "write_capable",
      },
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    });

    await runGatewayStatus(runtime, { timeout: "1000", json: true });

    expect(runtimeErrors).toHaveLength(0);
    const parsed = JSON.parse(runtimeLogs.join("\n")) as {
      ok?: boolean;
      degraded?: boolean;
      capability?: string;
      warnings?: Array<{ code?: string; targetIds?: string[] }>;
      targets?: Array<{
        connect?: {
          ok?: boolean;
          rpcOk?: boolean;
          scopeLimited?: boolean;
        };
        auth?: {
          capability?: string;
        };
      }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.degraded).toBe(true);
    expect(parsed.capability).toBe("write_capable");
    expect(parsed.targets?.[0]?.connect?.ok).toBe(true);
    expect(parsed.targets?.[0]?.connect?.rpcOk).toBe(false);
    expect(parsed.targets?.[0]?.connect?.scopeLimited).toBe(true);
    expect(parsed.targets?.[0]?.auth?.capability).toBe("write_capable");
    const scopeLimitedWarning = parsed.warnings?.find(
      (warning) => warning.code === "probe_scope_limited",
    );
    expect(scopeLimitedWarning?.targetIds).toContain("localLoopback");
  });

  it("suppresses unresolved SecretRef auth warnings when probe is reachable", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
    await withEnvAsync(
      { MISSING_GATEWAY_TOKEN: undefined, OPENCLAW_GATEWAY_TOKEN: undefined },
      async () => {
        mockLocalTokenEnvRefConfig();

        await runGatewayStatus(runtime, { timeout: "1000", json: true });
      },
    );

    expect(runtimeErrors).toHaveLength(0);
    const unresolvedWarning = findUnresolvedSecretRefWarning(runtimeLogs);
    expect(unresolvedWarning).toBeUndefined();
  });

  it("surfaces unresolved SecretRef auth diagnostics when probe fails", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
    const defaultReadBestEffortConfig = readBestEffortConfig.getMockImplementation();
    const defaultProbeGateway = probeGateway.getMockImplementation();
    try {
      await withEnvAsync(
        { MISSING_GATEWAY_TOKEN: undefined, OPENCLAW_GATEWAY_TOKEN: undefined },
        async () => {
          readBestEffortConfig.mockReset();
          probeGateway.mockReset();
          mockLocalTokenEnvRefConfig();
          probeGateway.mockImplementation(async (opts: { url: string }) => {
            const { url } = opts;
            return {
              ok: false,
              url,
              connectLatencyMs: null,
              error: "connection refused",
              close: null,
              auth: {
                role: null,
                scopes: [],
                capability: "unknown",
              },
              health: null,
              status: null,
              presence: null,
              configSnapshot: null,
            };
          });
          await expect(runGatewayStatus(runtime, { timeout: "1000", json: true })).rejects.toThrow(
            "__exit__:1",
          );
        },
      );
    } finally {
      readBestEffortConfig.mockReset();
      if (defaultReadBestEffortConfig) {
        readBestEffortConfig.mockImplementation(defaultReadBestEffortConfig);
      }
      probeGateway.mockReset();
      if (defaultProbeGateway) {
        probeGateway.mockImplementation(defaultProbeGateway);
      }
    }

    expect(runtimeErrors).toHaveLength(0);
    const unresolvedWarning = requireUnresolvedSecretRefWarning(runtimeLogs);
    expect(unresolvedWarning.targetIds).toContain("localLoopback");
    expect(unresolvedWarning.message).toContain("env:default:MISSING_GATEWAY_TOKEN");
    expect(unresolvedWarning.message).not.toContain("missing or empty");
  });

  it("does not resolve local token SecretRef when OPENCLAW_GATEWAY_TOKEN is set", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
        MISSING_GATEWAY_TOKEN: undefined,
      },
      async () => {
        mockLocalTokenEnvRefConfig();

        await runGatewayStatus(runtime, { timeout: "1000", json: true });
      },
    );

    expect(runtimeErrors).toHaveLength(0);
    const localProbeCall = requireProbeCall("ws://127.0.0.1:18789");
    expect(localProbeCall.auth?.token).toBe("env-token");
    const parsed = JSON.parse(runtimeLogs.join("\n")) as {
      warnings?: Array<{ code?: string; message?: string }>;
    };
    const unresolvedWarning = parsed.warnings?.find(
      (warning) =>
        warning.code === "auth_secretref_unresolved" &&
        warning.message?.includes("gateway.auth.token SecretRef is unresolved"),
    );
    expect(unresolvedWarning).toBeUndefined();
  });

  it("does not resolve local password SecretRef in token mode", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
        MISSING_GATEWAY_PASSWORD: undefined,
      },
      async () => {
        readBestEffortConfig.mockResolvedValueOnce({
          secrets: {
            providers: {
              default: { source: "env" },
            },
          },
          gateway: {
            mode: "local",
            auth: {
              mode: "token",
              token: "config-token",
              password: { source: "env", provider: "default", id: "MISSING_GATEWAY_PASSWORD" },
            },
          },
        } as never);

        await runGatewayStatus(runtime, { timeout: "1000", json: true });
      },
    );

    expect(runtimeErrors).toHaveLength(0);
    const parsed = JSON.parse(runtimeLogs.join("\n")) as {
      warnings?: Array<{ code?: string; message?: string }>;
    };
    const unresolvedPasswordWarning = parsed.warnings?.find(
      (warning) =>
        warning.code === "auth_secretref_unresolved" &&
        warning.message?.includes("gateway.auth.password SecretRef is unresolved"),
    );
    expect(unresolvedPasswordWarning).toBeUndefined();
  });

  it("resolves env-template gateway.auth.token before probing targets", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
    await withEnvAsync(
      {
        CUSTOM_GATEWAY_TOKEN: "resolved-gateway-token",
        OPENCLAW_GATEWAY_TOKEN: undefined,
      },
      async () => {
        readBestEffortConfig.mockResolvedValueOnce({
          secrets: {
            providers: {
              default: { source: "env" },
            },
          },
          gateway: {
            mode: "local",
            auth: {
              mode: "token",
              token: "${CUSTOM_GATEWAY_TOKEN}",
            },
          },
        } as never);

        await runGatewayStatus(runtime, { timeout: "1000", json: true });
      },
    );

    expect(runtimeErrors).toHaveLength(0);
    const localProbeCall = requireProbeCall("ws://127.0.0.1:18789");
    expect(localProbeCall.auth?.token).toBe("resolved-gateway-token");
    const parsed = JSON.parse(runtimeLogs.join("\n")) as {
      warnings?: Array<{ code?: string }>;
    };
    const unresolvedWarning = parsed.warnings?.find(
      (warning) => warning.code === "auth_secretref_unresolved",
    );
    expect(unresolvedWarning).toBeUndefined();
  });

  it("emits stable SecretRef auth configuration booleans in --json output", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
    const previousProbeImpl = probeGateway.getMockImplementation();
    probeGateway.mockImplementation(async (opts: { url: string }) => ({
      ok: true,
      url: opts.url,
      connectLatencyMs: 20,
      error: null,
      close: null,
      auth: {
        role: "operator",
        scopes: ["operator.read"],
        capability: "read_only",
      },
      health: { ok: true },
      status: {
        linkChannel: {
          id: "whatsapp",
          label: "WhatsApp",
          linked: true,
          authAgeMs: 1_000,
        },
        sessions: { count: 1 },
      },
      presence: [
        {
          mode: "gateway",
          reason: "self",
          host: "remote",
          ip: "100.64.0.2",
          text: "Gateway: remote (100.64.0.2) · app test · mode gateway · reason self",
          ts: Date.now(),
        },
      ],
      configSnapshot: {
        path: "/tmp/secretref-config.json",
        exists: true,
        valid: true,
        config: {
          ...createSecretRefGatewayConfig({ gatewayMode: "remote" }),
          discovery: {
            wideArea: { enabled: true },
          },
        },
        issues: [],
        legacyIssues: [],
      },
    }));

    try {
      await runGatewayStatus(runtime, { timeout: "1000", json: true });
    } finally {
      if (previousProbeImpl) {
        probeGateway.mockImplementation(previousProbeImpl);
      } else {
        probeGateway.mockReset();
      }
    }

    expect(runtimeErrors).toHaveLength(0);
    const parsed = JSON.parse(runtimeLogs.join("\n")) as {
      targets?: Array<Record<string, unknown>>;
    };
    const configRemoteTarget = parsed.targets?.find((target) => target.kind === "configRemote");
    expect(configRemoteTarget?.config).toMatchInlineSnapshot(`
      {
        "discovery": {
          "wideAreaEnabled": true,
        },
        "exists": true,
        "gateway": {
          "authMode": "token",
          "authPasswordConfigured": true,
          "authTokenConfigured": true,
          "bind": null,
          "controlUiBasePath": null,
          "controlUiEnabled": null,
          "mode": "remote",
          "port": null,
          "remotePasswordConfigured": true,
          "remoteTokenConfigured": true,
          "remoteUrl": "wss://remote.example:18789",
          "tailscaleMode": null,
        },
        "issues": [],
        "legacyIssues": [],
        "path": "/tmp/secretref-config.json",
        "valid": true,
      }
    `);
  });

  it("supports SSH tunnel targets", async () => {
    const { runtime, runtimeLogs } = createRuntimeCapture();

    startSshPortForward.mockClear();
    sshStop.mockClear();
    probeGateway.mockClear();

    await runGatewayStatus(runtime, { timeout: "1000", json: true, ssh: "me@studio" });

    expect(startSshPortForward).toHaveBeenCalledTimes(1);
    expect(probeGateway).toHaveBeenCalled();
    const tunnelCall = probeGateway.mock.calls.find(
      (call) => typeof call?.[0]?.url === "string" && call[0].url.startsWith("ws://127.0.0.1:"),
    )?.[0] as { auth?: { token?: string } } | undefined;
    expect(tunnelCall?.auth?.token).toBe("rtok");
    expect(sshStop).toHaveBeenCalledTimes(1);

    const parsed = JSON.parse(runtimeLogs.join("\n")) as Record<string, unknown>;
    const targets = parsed.targets as Array<Record<string, unknown>>;
    const targetKinds = targets.map((target) => target.kind);
    expect(targetKinds).toContain("sshTunnel");
  });

  it("uses local TLS target strategy and fingerprint for local loopback probes", async () => {
    const { runtime } = createRuntimeCapture();
    probeGateway.mockClear();
    loadGatewayTlsRuntime.mockClear();
    readBestEffortConfig.mockResolvedValueOnce({
      gateway: {
        mode: "local",
        tls: { enabled: true },
        auth: { mode: "token", token: "ltok" },
      },
    } as never);

    await runGatewayStatus(runtime, { timeout: "15000", json: true });

    expect(loadGatewayTlsRuntime).toHaveBeenCalledTimes(1);
    const localProbeCall = requireProbeCall("wss://127.0.0.1:18789");
    expect(localProbeCall.tlsFingerprint).toBe("sha256:local-fingerprint");
    expect(localProbeCall.timeoutMs).toBe(15_000);
  });

  it("warns when local TLS is enabled but the certificate fingerprint cannot be loaded", async () => {
    const { runtime, runtimeLogs } = createRuntimeCapture();
    probeGateway.mockClear();
    loadGatewayTlsRuntime.mockResolvedValueOnce({
      enabled: false,
      required: true,
      error: "gateway tls: cert/key missing",
    });
    readBestEffortConfig.mockResolvedValueOnce({
      gateway: {
        mode: "local",
        tls: { enabled: true },
        auth: { mode: "token", token: "ltok" },
      },
    } as never);

    await runGatewayStatus(runtime, { timeout: "15000", json: true });

    const localProbeCall = requireProbeCall("wss://127.0.0.1:18789");
    expect(localProbeCall.tlsFingerprint).toBeUndefined();

    const parsed = JSON.parse(runtimeLogs.join("\n")) as {
      warnings?: Array<{ code?: string; message?: string; targetIds?: string[] }>;
    };
    const tlsWarning = parsed.warnings?.find(
      (warning) => warning.code === "local_tls_runtime_unavailable",
    );
    expect(tlsWarning?.targetIds).toEqual(["localLoopback"]);
    expect(tlsWarning?.message).toContain("gateway tls: cert/key missing");
  });

  it("passes the full caller timeout through to local loopback probes", async () => {
    const { runtime } = createRuntimeCapture();
    probeGateway.mockClear();
    readBestEffortConfig.mockResolvedValueOnce({
      gateway: {
        mode: "local",
        auth: { mode: "token", token: "ltok" },
      },
    } as never);

    await runGatewayStatus(runtime, { timeout: "15000", json: true });

    expect(requireProbeCall("ws://127.0.0.1:18789").timeoutMs).toBe(15_000);
  });

  it("uses configured handshake timeout as the default local probe budget", async () => {
    const { runtime } = createRuntimeCapture();
    probeGateway.mockClear();
    readBestEffortConfig.mockResolvedValueOnce({
      gateway: {
        mode: "local",
        handshakeTimeoutMs: 30_000,
        auth: { mode: "token", token: "ltok" },
      },
    } as never);

    await gatewayStatusCommand({ json: true }, asRuntimeEnv(runtime));

    const localProbeCall = requireProbeCall("ws://127.0.0.1:18789");
    expect(localProbeCall.preauthHandshakeTimeoutMs).toBe(30_000);
    expect(localProbeCall.timeoutMs).toBe(30_000);
  });

  it("keeps inactive local loopback probes on the short timeout in remote mode", async () => {
    const { runtime } = createRuntimeCapture();
    probeGateway.mockClear();
    readBestEffortConfig.mockResolvedValueOnce({
      gateway: {
        mode: "remote",
        auth: { mode: "token", token: "ltok" },
        remote: {},
      },
    } as never);

    await runGatewayStatus(runtime, { timeout: "15000", json: true });

    expect(requireProbeCall("ws://127.0.0.1:18789").timeoutMs).toBe(800);
  });

  it("does not infer ssh-auto targets from TXT-only discovery metadata", async () => {
    const { runtime } = createRuntimeCapture();
    await withEnvAsync({ USER: "steipete" }, async () => {
      readBestEffortConfig.mockResolvedValueOnce(makeRemoteGatewayConfig("", "", "ltok"));
      discoverGatewayBeacons.mockResolvedValueOnce([
        { instanceName: "bad", tailnetDns: "-V" },
        { instanceName: "txt-only", tailnetDns: "goodhost" },
      ]);

      startSshPortForward.mockClear();
      await runGatewayStatus(runtime, { timeout: "1000", json: true, sshAuto: true });

      expect(startSshPortForward).not.toHaveBeenCalled();
    });
  });

  it("infers ssh-auto targets from resolved discovery hosts", async () => {
    const { runtime } = createRuntimeCapture();
    await withEnvAsync({ USER: "steipete" }, async () => {
      readBestEffortConfig.mockResolvedValueOnce(makeRemoteGatewayConfig("", "", "ltok"));
      discoverGatewayBeacons.mockResolvedValueOnce([
        { instanceName: "bad", tailnetDns: "-V" },
        { host: "goodhost", sshPort: 2222, port: 18789, instanceName: "Gateway" },
      ]);

      startSshPortForward.mockClear();
      await runGatewayStatus(runtime, { timeout: "1000", json: true, sshAuto: true });

      expect(startSshPortForward).toHaveBeenCalledTimes(1);
      const call = startSshPortForward.mock.calls[0]?.[0] as { target: string };
      expect(call.target).toBe("steipete@goodhost:2222");
    });
  });

  it("infers SSH target from gateway.remote.url and ssh config", async () => {
    const { runtime } = createRuntimeCapture();
    await withEnvAsync({ USER: "steipete" }, async () => {
      readBestEffortConfig.mockResolvedValueOnce(
        makeRemoteGatewayConfig("ws://peters-mac-studio-1.sheep-coho.ts.net:18789"),
      );
      resolveSshConfig.mockResolvedValueOnce({
        user: "steipete",
        host: "peters-mac-studio-1.sheep-coho.ts.net",
        port: 2222,
        identityFiles: ["/tmp/id_ed25519"],
      });

      startSshPortForward.mockClear();
      await runGatewayStatus(runtime, { timeout: "1000", json: true });

      expect(startSshPortForward).toHaveBeenCalledTimes(1);
      const call = startSshPortForward.mock.calls[0]?.[0] as {
        target: string;
        identity?: string;
      };
      expect(call.target).toBe("steipete@peters-mac-studio-1.sheep-coho.ts.net:2222");
      expect(call.identity).toBe("/tmp/id_ed25519");
    });
  });

  it("falls back to host-only when USER is missing and ssh config is unavailable", async () => {
    const { runtime } = createRuntimeCapture();
    await withEnvAsync({ USER: "" }, async () => {
      readBestEffortConfig.mockResolvedValueOnce(
        makeRemoteGatewayConfig("wss://studio.example:18789"),
      );
      resolveSshConfig.mockResolvedValueOnce(null);

      startSshPortForward.mockClear();
      await runGatewayStatus(runtime, { timeout: "1000", json: true });

      const call = startSshPortForward.mock.calls[0]?.[0] as {
        target: string;
      };
      expect(call.target).toBe("studio.example");
    });
  });

  it("keeps explicit SSH identity even when ssh config provides one", async () => {
    const { runtime } = createRuntimeCapture();

    readBestEffortConfig.mockResolvedValueOnce(
      makeRemoteGatewayConfig("wss://studio.example:18789"),
    );
    resolveSshConfig.mockResolvedValueOnce({
      user: "me",
      host: "studio.example",
      port: 22,
      identityFiles: ["/tmp/id_from_config"],
    });

    startSshPortForward.mockClear();
    await runGatewayStatus(runtime, {
      timeout: "1000",
      json: true,
      sshIdentity: "/tmp/explicit_id",
    });

    const call = startSshPortForward.mock.calls[0]?.[0] as {
      identity?: string;
    };
    expect(call.identity).toBe("/tmp/explicit_id");
  });
});
