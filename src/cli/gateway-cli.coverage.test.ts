// Gateway CLI coverage tests cover gateway command branches and output modes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvOverride } from "../config/test-helpers.js";
import { ExpectedCliError } from "./failure-output.js";
import { registerGatewayCli } from "./gateway-cli.js";

type GatewayCliDependencies = Parameters<typeof registerGatewayCli>[1];

type DiscoveredBeacon = Awaited<
  ReturnType<typeof import("../infra/bonjour-discovery.js").discoverGatewayBeacons>
>[number];
const defaultCallGateway = async (): Promise<unknown> => ({ ok: true });
const callGateway = vi.fn<(opts: unknown) => Promise<unknown>>(defaultCallGateway);
const formatGatewayAuthErrorJson = vi.fn();
const formatGatewayClientRequestErrorJson = vi.fn();
const formatGatewayTransportErrorJson = vi.fn();
const setVerbose = vi.fn();
const discoverGatewayBeacons = vi.fn<(opts: unknown) => Promise<DiscoveredBeacon[]>>(
  async () => [],
);
const gatewayStatusCommand = vi.fn<(opts: unknown) => Promise<void>>(async () => {});

const mocks = await vi.hoisted(async () => {
  const { createCliRuntimeMock } = await import("./test-runtime-mock.js");
  return createCliRuntimeMock(vi);
});

const { runtimeLogs, runtimeErrors, defaultRuntime } = mocks;

vi.mock(
  new URL("../../gateway/call.ts", new URL("./gateway-cli/call.ts", import.meta.url)).href,
  () => ({
    buildGatewayConnectionDetails: () => ({
      message: "Gateway mode: local\nGateway target: ws://127.0.0.1:18789",
      url: "ws://127.0.0.1:18789",
    }),
    buildGatewayProbeConnectionDetails: () => ({
      preauthHandshakeTimeoutMs: 1000,
      tlsFingerprint: undefined,
      url: "ws://127.0.0.1:18789",
    }),
    callGateway: (opts: unknown) => callGateway(opts),
    formatGatewayAuthErrorJson: (error: unknown) => formatGatewayAuthErrorJson(error),
    formatGatewayClientRequestErrorJson: (error: unknown) =>
      formatGatewayClientRequestErrorJson(error),
    formatGatewayTransportErrorJson: (error: unknown) => formatGatewayTransportErrorJson(error),
    isGatewayCredentialsRequiredError: () => false,
    randomIdempotencyKey: () => "rk_test",
  }),
);

vi.mock("../globals.js", () => ({
  info: (msg: string) => msg,
  isVerbose: () => false,
  setVerbose: (enabled: boolean) => setVerbose(enabled),
}));

vi.mock("../runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../runtime.js")>("../runtime.js")),
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({
    label: "LaunchAgent",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    stage: vi.fn(),
    install: vi.fn(),
    uninstall: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    isLoaded: vi.fn().mockResolvedValue(true),
    readCommand: vi.fn(),
    readRuntime: vi.fn().mockResolvedValue({ status: "running" }),
  }),
}));

vi.mock("../daemon/program-args.js", () => ({
  resolveGatewayProgramArguments: async () => ({
    programArguments: ["/bin/node", "cli", "gateway", "--port", "18789"],
  }),
}));

vi.mock("../infra/bonjour-discovery.js", async () => ({
  ...(await vi.importActual<typeof import("../infra/bonjour-discovery.js")>(
    "../infra/bonjour-discovery.js",
  )),
  discoverGatewayBeacons: (opts: unknown) => discoverGatewayBeacons(opts),
}));

vi.mock("../commands/gateway-status.js", () => ({
  gatewayStatusCommand: (opts: unknown) => gatewayStatusCommand(opts),
}));

let gatewayProgram: Command;

function createGatewayProgram(deps?: GatewayCliDependencies) {
  const program = new Command();
  program.exitOverride();
  registerGatewayCli(program, deps);
  return program;
}

async function runGatewayCommand(args: string[]) {
  await gatewayProgram.parseAsync(args, { from: "user" });
}

async function expectGatewayExit(args: string[]) {
  await expect(runGatewayCommand(args)).rejects.toThrow("__exit__:1");
}

function firstMockArg(mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }): unknown {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error("expected mock to have at least one call");
  }
  return call[0];
}

describe("gateway-cli coverage", () => {
  beforeEach(() => {
    gatewayProgram = createGatewayProgram();
    callGateway.mockReset();
    callGateway.mockImplementation(defaultCallGateway);
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    defaultRuntime.log.mockClear();
    defaultRuntime.error.mockClear();
    defaultRuntime.writeStdout.mockClear();
    defaultRuntime.writeJson.mockClear();
    defaultRuntime.exit.mockClear();
    formatGatewayAuthErrorJson.mockReset();
    formatGatewayAuthErrorJson.mockReturnValue(null);
    formatGatewayClientRequestErrorJson.mockReset();
    formatGatewayClientRequestErrorJson.mockReturnValue(null);
    formatGatewayTransportErrorJson.mockReset();
    formatGatewayTransportErrorJson.mockReturnValue(null);
  });

  it("registers call/health commands and routes to callGateway", async () => {
    callGateway.mockClear();

    await runGatewayCommand(["gateway", "call", "health", "--params", '{"x":1}', "--json"]);

    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(runtimeLogs.join("\n")).toContain('"ok": true');
  });

  it("rejects invalid gateway call timeout before calling Gateway", async () => {
    callGateway.mockClear();

    await expectGatewayExit(["gateway", "call", "health", "--timeout", "1000ms", "--json"]);

    expect(callGateway).not.toHaveBeenCalled();
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith({
      ok: false,
      error: { type: "cli_error", message: expect.stringContaining("Invalid --timeout") },
    });
    expect(runtimeErrors).toHaveLength(0);
  });

  it("renders gateway request failures without the client error class in human mode", async () => {
    const error = Object.assign(new Error("invalid audit.activity.list params"), {
      name: "GatewayClientRequestError",
      gatewayCode: "INVALID_REQUEST",
    });
    callGateway.mockRejectedValueOnce(error);

    await expectGatewayExit(["gateway", "call", "audit.activity.list"]);

    expect(runtimeErrors.join("\n")).toContain("invalid audit.activity.list params");
    expect(runtimeErrors.join("\n")).not.toContain("GatewayClientRequestError");
  });

  it("registers gateway probe and routes to gatewayStatusCommand", async () => {
    gatewayStatusCommand.mockClear();

    await runGatewayCommand(["gateway", "probe", "--json"]);

    expect(gatewayStatusCommand).toHaveBeenCalledTimes(1);
  });

  it("registers gateway stability and routes to diagnostics RPC", async () => {
    callGateway.mockClear();

    await runGatewayCommand([
      "gateway",
      "stability",
      "--limit",
      "5",
      "--type",
      "payload.large",
      "--json",
    ]);

    expect(callGateway).toHaveBeenCalledTimes(1);
    const stabilityCall = firstMockArg(callGateway) as {
      method?: string;
      params?: unknown;
      localPortOverride?: number;
    };
    expect(stabilityCall?.method).toBe("diagnostics.stability");
    expect(stabilityCall?.localPortOverride).toBeUndefined();
    expect(stabilityCall?.params).toEqual({
      limit: 5,
      type: "payload.large",
    });
  });

  it("scopes usage-cost to a specific agent via --agent", async () => {
    callGateway.mockClear();

    await runGatewayCommand(["gateway", "usage-cost", "--agent", "alpha", "--days", "7", "--json"]);

    expect(callGateway).toHaveBeenCalledTimes(1);
    const costCall = firstMockArg(callGateway) as { method?: string; params?: unknown };
    expect(costCall?.method).toBe("usage.cost");
    expect(costCall?.params).toEqual({ days: 7, agentId: "alpha" });
  });

  it("omits agentId from usage-cost when --agent is absent or blank", async () => {
    callGateway.mockClear();

    await runGatewayCommand(["gateway", "usage-cost", "--agent", "  ", "--days", "7", "--json"]);

    expect(callGateway).toHaveBeenCalledTimes(1);
    const costCall = firstMockArg(callGateway) as { method?: string; params?: unknown };
    expect(costCall?.method).toBe("usage.cost");
    expect(costCall?.params).toEqual({ days: 7 });
  });

  it("aggregates usage-cost across agents via --all-agents", async () => {
    callGateway.mockClear();

    await runGatewayCommand(["gateway", "usage-cost", "--all-agents", "--days", "7", "--json"]);

    expect(callGateway).toHaveBeenCalledTimes(1);
    const costCall = firstMockArg(callGateway) as { method?: string; params?: unknown };
    expect(costCall?.method).toBe("usage.cost");
    expect(costCall?.params).toEqual({ days: 7, agentScope: "all" });
  });

  it("prints the provider/model breakdown for missing costs", async () => {
    callGateway.mockResolvedValue({
      updatedAt: 1,
      days: 7,
      daily: [],
      totals: {
        input: 12,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 12,
        totalCost: 0,
        inputCost: 0,
        outputCost: 0,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        missingCostEntries: 12,
        missingCostByModel: {
          "openai/gpt-5.6-sol": 10,
          "openai-codex/gpt-5.5": 2,
        },
      },
      cacheStatus: {
        status: "fresh",
        cachedFiles: 1,
        pendingFiles: 0,
        staleFiles: 0,
      },
    });

    await runGatewayCommand(["gateway", "usage-cost", "--days", "7"]);

    expect(runtimeLogs.join("\n")).toContain(
      "Missing cost: 12 (openai/gpt-5.6-sol 10, openai-codex/gpt-5.5 2)",
    );
  });

  it.each(["refreshing", "partial", "stale"] as const)(
    "returns the first usage-cost RPC result when the cache is %s",
    async (status) => {
      const summary = {
        totals: { totalTokens: 100, totalCost: 0.1 },
        cacheStatus: { status, cachedFiles: 0, pendingFiles: 2 },
      };
      callGateway.mockResolvedValue(summary);

      await runGatewayCommand(["gateway", "usage-cost", "--all-agents", "--days", "7", "--json"]);

      expect(callGateway).toHaveBeenCalledOnce();
      expect(firstMockArg(callGateway)).toMatchObject({
        method: "usage.cost",
        params: { days: 7, agentScope: "all" },
        timeoutMs: 10_000,
      });
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(summary);
    },
  );

  it("rejects combining --agent with --all-agents for usage-cost", async () => {
    callGateway.mockClear();

    await expectGatewayExit([
      "gateway",
      "usage-cost",
      "--agent",
      "alpha",
      "--all-agents",
      "--json",
    ]);

    expect(callGateway).not.toHaveBeenCalled();
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith({
      ok: false,
      error: { type: "cli_error", message: "Use --agent or --all-agents, not both" },
    });
    expect(runtimeErrors).toHaveLength(0);
  });

  it("preserves expected CLI machine output for ordinary Gateway command failures", async () => {
    callGateway.mockRejectedValueOnce(
      new ExpectedCliError({
        message: "validation failed",
        humanOutput: "human recovery guidance",
        machineOutput: "machine recovery guidance\n",
      }),
    );

    await expectGatewayExit(["gateway", "call", "health", "--json"]);

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith({
      ok: false,
      error: { type: "cli_error", message: "machine recovery guidance" },
    });
    expect(runtimeErrors).toHaveLength(0);
  });

  it.each(["abc", "7d", "1.5", "", "  "])(
    "rejects malformed usage-cost --days %j",
    async (days) => {
      callGateway.mockClear();

      await expectGatewayExit(["gateway", "usage-cost", "--days", days, "--json"]);

      expect(callGateway).not.toHaveBeenCalled();
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith({
        ok: false,
        error: { type: "cli_error", message: expect.stringContaining("Invalid --days") },
      });
      expect(runtimeErrors).toHaveLength(0);
    },
  );

  it("rejects a malformed health --timeout before calling Gateway", async () => {
    callGateway.mockClear();

    await expectGatewayExit(["gateway", "health", "--timeout", "abc", "--json"]);

    expect(callGateway).not.toHaveBeenCalled();
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith({
      ok: false,
      error: { type: "cli_error", message: expect.stringContaining("Invalid --timeout") },
    });
    expect(runtimeErrors).toHaveLength(0);
  });

  it("writes JSON for gateway health transport failures in JSON mode", async () => {
    const error = new Error("gateway closed (1006)");
    const payload = {
      ok: false,
      error: {
        type: "gateway_transport_error",
        kind: "closed",
        message: "gateway closed (1006)",
      },
      gateway: {
        url: "ws://127.0.0.1:18789",
        urlSource: "local loopback",
      },
    };
    callGateway.mockRejectedValueOnce(error);
    formatGatewayTransportErrorJson.mockReturnValueOnce(payload);

    await expectGatewayExit(["gateway", "health", "--json"]);

    expect(formatGatewayTransportErrorJson).toHaveBeenCalledWith(error);
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(payload);
    expect(runtimeErrors.join("\n")).not.toContain("gateway closed");
  });

  it.each([
    ["call", ["gateway", "call", "skills.bins", "--json"]],
    ["usage cost", ["gateway", "usage-cost", "--json"]],
    ["stability", ["gateway", "stability", "--json"]],
  ])("writes JSON for gateway %s request failures in JSON mode", async (_label, args) => {
    const error = Object.assign(new Error("unauthorized role: operator"), {
      name: "GatewayClientRequestError",
      gatewayCode: "INVALID_REQUEST",
    });
    const payload = {
      ok: false,
      error: {
        type: "gateway_request_error",
        code: "INVALID_REQUEST",
        message: "unauthorized role: operator",
        retryable: false,
      },
    };
    callGateway.mockRejectedValueOnce(error);
    formatGatewayClientRequestErrorJson.mockReturnValueOnce(payload);

    await expectGatewayExit(args);

    expect(formatGatewayClientRequestErrorJson).toHaveBeenCalledWith(error);
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(payload);
    expect(runtimeErrors.join("\n")).not.toContain("unauthorized role");
  });

  it("writes JSON for gateway call auth failures in JSON mode", async () => {
    const error = new Error("gateway health requires credentials");
    const payload = {
      ok: false,
      error: {
        type: "gateway_credentials_required",
        message: "gateway health requires credentials",
      },
    };
    callGateway.mockRejectedValueOnce(error);
    formatGatewayAuthErrorJson.mockReturnValueOnce(payload);

    await expectGatewayExit(["gateway", "call", "health", "--json"]);

    expect(formatGatewayAuthErrorJson).toHaveBeenCalledWith(error);
    expect(formatGatewayClientRequestErrorJson).not.toHaveBeenCalled();
    expect(formatGatewayTransportErrorJson).not.toHaveBeenCalled();
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(payload);
    expect(runtimeErrors.join("\n")).not.toContain("gateway health requires credentials");
  });

  it.each([
    {
      name: "probe",
      args: ["gateway", "probe", "--json"],
      reject: (error: Error) => gatewayStatusCommand.mockRejectedValueOnce(error),
    },
    {
      name: "discovery",
      args: ["gateway", "discover", "--json"],
      reject: (error: Error) => discoverGatewayBeacons.mockRejectedValueOnce(error),
    },
  ])("writes JSON for gateway $name transport failures", async ({ args, reject }) => {
    const error = new Error("gateway transport unavailable");
    const payload = {
      ok: false,
      error: {
        type: "gateway_transport_error",
        kind: "closed",
        message: "gateway transport unavailable",
      },
    };
    reject(error);
    formatGatewayTransportErrorJson.mockReturnValueOnce(payload);

    await expectGatewayExit(args);

    expect(formatGatewayTransportErrorJson).toHaveBeenCalledWith(error);
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(payload);
    expect(runtimeErrors).toHaveLength(0);
  });

  it("prints the latest stability bundle without calling Gateway", async () => {
    callGateway.mockClear();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-cli-bundle-"));
    try {
      const bundleDir = path.join(tempDir, "logs", "stability");
      const bundlePath = path.join(
        bundleDir,
        "openclaw-stability-2026-04-22T12-00-00-000Z-123-test.json",
      );
      const bundle = {
        version: 1,
        generatedAt: "2026-04-22T12:00:00.000Z",
        reason: "gateway.restart_startup_failed",
        process: {
          pid: 123,
          platform: process.platform,
          arch: process.arch,
          node: process.versions.node,
          uptimeMs: 2000,
        },
        host: { hostname: "test-host" },
        evidence: {
          memoryPressure: {
            level: "critical",
            reason: "rss_threshold",
            memory: {
              rssBytes: 4096,
              heapTotalBytes: 2048,
              heapUsedBytes: 1536,
              externalBytes: 128,
              arrayBuffersBytes: 64,
            },
            thresholdBytes: 3000,
            heapStatistics: {
              totalHeapSizeBytes: 2048,
              totalHeapSizeExecutableBytes: 256,
              totalPhysicalSizeBytes: 2048,
              totalAvailableSizeBytes: 8192,
              usedHeapSizeBytes: 1536,
              heapSizeLimitBytes: 4096,
              mallocedMemoryBytes: 32,
              externalMemoryBytes: 128,
            },
            activeResources: {
              total: 2,
              byType: { Timeout: 2 },
            },
            topSessionFiles: [
              {
                relativePath: "agents/<agent>/sessions/<session>.jsonl",
                sizeBytes: 4096,
                mtimeMs: Date.parse("2026-04-22T12:00:00.000Z"),
              },
            ],
          },
        },
        snapshot: {
          generatedAt: "2026-04-22T12:00:00.000Z",
          capacity: 1000,
          count: 1,
          dropped: 0,
          firstSeq: 1,
          lastSeq: 1,
          events: [
            {
              seq: 1,
              ts: Date.parse("2026-04-22T12:00:00.000Z"),
              type: "payload.large",
              surface: "gateway.http.json",
              action: "rejected",
              bytes: 2048,
              limitBytes: 1024,
            },
          ],
          summary: {
            byType: { "payload.large": 1 },
            payloadLarge: {
              count: 1,
              rejected: 1,
              truncated: 0,
              chunked: 0,
              bySurface: { "gateway.http.json": 1 },
            },
          },
        },
      };
      fs.mkdirSync(bundleDir, { recursive: true });
      fs.writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

      await withEnvOverride({ OPENCLAW_STATE_DIR: tempDir }, async () => {
        await runGatewayCommand([
          "gateway",
          "--port",
          "19096",
          "stability",
          "--bundle",
          "latest",
          "--url",
          "ws://127.0.0.1:19096",
        ]);
      });

      const output = runtimeLogs.join("\n");
      expect(callGateway).not.toHaveBeenCalled();
      expect(output).toContain("Stability bundle");
      expect(output).toContain("gateway.restart_startup_failed");
      expect(output).toContain("Memory pressure");
      expect(output).toContain("rss_threshold");
      expect(output).toContain("Largest session files");
      expect(output).toContain("agents/<agent>/sessions/<session>.jsonl");
      expect(output).toContain("payload.large");
      expect(output).toContain("gateway.http.json");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "gateway diagnostics",
      args: ["gateway", "diagnostics", "export"],
      timeoutMs: 3000,
    },
    {
      name: "offline stability",
      args: ["gateway", "--port", "19097", "stability", "--bundle", "latest", "--export"],
      timeoutMs: 10_000,
    },
  ])("writes $name export with a service-owned health snapshot", async ({ args, timeoutMs }) => {
    callGateway.mockClear();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-cli-support-"));
    try {
      const outputPath = path.join(tempDir, "diagnostics.zip");
      await withEnvOverride(
        { OPENCLAW_STATE_DIR: tempDir, OPENCLAW_TEST_FILE_LOG: undefined },
        async () => {
          await runGatewayCommand([...args, "--output", outputPath, "--json"]);
        },
      );

      expect(callGateway).toHaveBeenCalledTimes(1);
      const healthCall = firstMockArg(callGateway) as {
        method?: string;
        timeoutMs?: number;
        localPortOverride?: number;
      };
      expect(healthCall?.method).toBe("health");
      expect(healthCall?.timeoutMs).toBe(timeoutMs);
      expect(healthCall?.localPortOverride).toBeUndefined();
      expect(fs.existsSync(outputPath)).toBe(true);
      const output = runtimeLogs.join("\n");
      expect(output).toContain('"path"');
      expect(output).toContain("diagnostics.zip");
      expect(output).toContain('"payloadFree": true');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["--log-lines", "5000x"],
    ["--log-bytes", "1mb"],
  ])("rejects partial gateway diagnostics export %s", async (flag, value) => {
    callGateway.mockClear();

    await expectGatewayExit(["gateway", "diagnostics", "export", flag, value, "--json"]);

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith({
      ok: false,
      error: { type: "cli_error", message: `${flag} must be a positive integer.` },
    });
    expect(runtimeErrors).toHaveLength(0);
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("registers gateway discover and prints json output", async () => {
    discoverGatewayBeacons.mockClear();
    discoverGatewayBeacons.mockResolvedValueOnce([
      {
        instanceName: "Studio (OpenClaw)",
        displayName: "Studio",
        domain: "openclaw.internal.",
        host: "studio.openclaw.internal",
        port: 18789,
        lanHost: "studio.local",
        tailnetDns: "studio.tailnet.ts.net",
        gatewayPort: 18789,
        sshPort: 22,
      },
    ]);

    await runGatewayCommand(["gateway", "discover", "--json"]);

    expect(discoverGatewayBeacons).toHaveBeenCalledTimes(1);
    const out = runtimeLogs.join("\n");
    expect(out).toContain('"beacons"');
    expect(out).toContain("ws://");
  });

  it.each([18789, 29443])(
    "forwards the resolved gateway port %i in discovery SSH tunnel hints",
    async (port) => {
      discoverGatewayBeacons.mockResolvedValueOnce([
        {
          instanceName: "Remote gateway",
          host: "gateway.example",
          port,
          gatewayPort: 41111,
          sshPort: 2222,
        },
      ]);

      await runGatewayCommand(["gateway", "discover"]);

      const output = runtimeLogs.join("\n");
      expect(output).toContain(`ws://gateway.example:${port}`);
      expect(output).toContain(`ssh -N -L 18789:127.0.0.1:${port} <user>@gateway.example -p 2222`);
    },
  );

  it.each([
    {
      name: "uses the secure scheme advertised by a TLS gateway",
      beacon: {
        instanceName: "Secure gateway",
        host: "secure.openclaw.internal",
        port: 18789,
        gatewayTls: true,
      } satisfies DiscoveredBeacon,
      wsUrl: "wss://secure.openclaw.internal:18789",
    },
    {
      name: "does not construct a URL from unresolved TXT hints",
      beacon: {
        instanceName: "Unresolved gateway",
        lanHost: "unresolved.openclaw.internal",
        gatewayPort: 18789,
      } satisfies DiscoveredBeacon,
      wsUrl: null,
    },
  ])("gateway discovery JSON $name", async ({ beacon, wsUrl }) => {
    discoverGatewayBeacons.mockResolvedValueOnce([beacon]);

    await runGatewayCommand(["gateway", "discover", "--json"]);

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 1,
        beacons: [expect.objectContaining({ wsUrl })],
      }),
    );
  });

  it("validates gateway discover timeout", async () => {
    discoverGatewayBeacons.mockClear();
    await expectGatewayExit(["gateway", "discover", "--timeout", "0"]);

    expect(runtimeErrors.join("\n")).toContain("gateway discover failed:");
    expect(discoverGatewayBeacons).not.toHaveBeenCalled();
  });

  it("fails gateway call on invalid params JSON", async () => {
    callGateway.mockClear();
    await expectGatewayExit(["gateway", "call", "status", "--params", "not-json"]);

    expect(callGateway).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("Gateway call failed:");
    expect(runtimeErrors.join("\n")).toContain("--params must be valid JSON.");
  });

  it("renders invalid gateway call params as JSON before calling Gateway", async () => {
    await expectGatewayExit([
      "gateway",
      "call",
      "system-presence",
      "--params",
      "not-json",
      "--json",
    ]);

    expect(callGateway).not.toHaveBeenCalled();
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith({
      ok: false,
      error: { type: "cli_error", message: "--params must be valid JSON." },
    });
    expect(runtimeErrors).toHaveLength(0);
  });

  it("validates gateway call timeout before opening a transport", async () => {
    callGateway.mockClear();
    await expectGatewayExit(["gateway", "call", "health", "--timeout", "nope", "--json"]);

    expect(callGateway).not.toHaveBeenCalled();
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith({
      ok: false,
      error: { type: "cli_error", message: expect.stringContaining("Invalid --timeout") },
    });
    expect(runtimeErrors).toHaveLength(0);
  });
});
