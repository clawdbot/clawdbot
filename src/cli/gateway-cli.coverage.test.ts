// Gateway CLI coverage tests cover gateway command branches and output modes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvOverride } from "../config/test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { testApi as usageTestApi, usageHandlers } from "../gateway/server-methods/usage.js";
import { GatewayLockError } from "../infra/gateway-lock.js";
import { registerGatewayCli } from "./gateway-cli.js";

type DiscoveredBeacon = Awaited<
  ReturnType<typeof import("../infra/bonjour-discovery.js").discoverGatewayBeacons>
>[number];
type UsageCostHandlerArgs = Parameters<(typeof usageHandlers)["usage.cost"]>[0];

const defaultCallGateway = async (): Promise<unknown> => ({ ok: true });
const callGateway = vi.fn<(opts: unknown) => Promise<unknown>>(defaultCallGateway);
const formatGatewayClientRequestErrorJson = vi.fn();
const formatGatewayTransportErrorJson = vi.fn();
const startGatewayServer = vi.fn<
  (port: number, opts?: unknown) => Promise<{ close: () => Promise<void> }>
>(async () => ({
  close: vi.fn(async () => {}),
}));
const setVerbose = vi.fn();
const forceFreePortAndWait = vi.fn<
  (port: number) => Promise<{ killed: unknown[]; waitedMs: number; escalatedToSigkill: boolean }>
>(async () => ({
  killed: [],
  waitedMs: 0,
  escalatedToSigkill: false,
}));
const serviceIsLoaded = vi.fn().mockResolvedValue(true);
const discoverGatewayBeacons = vi.fn<(opts: unknown) => Promise<DiscoveredBeacon[]>>(
  async () => [],
);
const gatewayStatusCommand = vi.fn<(opts: unknown) => Promise<void>>(async () => {});
const inspectPortUsage = vi.fn(async (_port: number) => ({ status: "free" as const }));
const formatPortDiagnostics = vi.fn((_diagnostics: unknown) => [] as string[]);

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
    formatGatewayClientRequestErrorJson: (error: unknown) =>
      formatGatewayClientRequestErrorJson(error),
    formatGatewayTransportErrorJson: (error: unknown) => formatGatewayTransportErrorJson(error),
    isGatewayCredentialsRequiredError: () => false,
    randomIdempotencyKey: () => "rk_test",
  }),
);

vi.mock("../gateway/server.js", () => ({
  startGatewayServer: (port: number, opts?: unknown) => startGatewayServer(port, opts),
}));

vi.mock("../globals.js", () => ({
  info: (msg: string) => msg,
  isVerbose: () => false,
  setVerbose: (enabled: boolean) => setVerbose(enabled),
}));

vi.mock("../runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../runtime.js")>("../runtime.js")),
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("./ports.js", () => ({
  forceFreePortAndWait: (port: number) => forceFreePortAndWait(port),
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
    isLoaded: serviceIsLoaded,
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

vi.mock("../infra/ports.js", () => ({
  inspectPortUsage: (port: number) => inspectPortUsage(port),
  formatPortDiagnostics: (diagnostics: unknown) => formatPortDiagnostics(diagnostics),
}));

let gatewayProgram: Command;

function createGatewayProgram() {
  const program = new Command();
  program.exitOverride();
  registerGatewayCli(program);
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
  beforeAll(async () => {
    // Gateway startup intentionally primes this large graph before installing
    // signal handlers. Load it as suite setup so failure-path timings measure
    // the lifecycle behavior rather than the one-time module parse.
    await import("./gateway-cli/lifecycle.runtime.js");
  });

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
    startGatewayServer.mockClear();
    inspectPortUsage.mockClear();
    formatPortDiagnostics.mockClear();
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
    expect(runtimeErrors.join("\n")).toContain("Gateway call failed: Error: Invalid --timeout");
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
    const stabilityCall = firstMockArg(callGateway) as { method?: string; params?: unknown };
    expect(stabilityCall?.method).toBe("diagnostics.stability");
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

  it("waits for real all-agent usage caches before printing totals", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-usage-cost-cli-"));
    const config = {
      agents: {
        list: [{ id: "main", default: true }, { id: "dev" }],
      },
      session: {},
    } as OpenClawConfig;
    const seedUsage = (agentId: string, totalTokens: number, totalCost: number) => {
      const sessionsDir = path.join(stateDir, "agents", agentId, "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      const session = SessionManager.create(sessionsDir, sessionsDir);
      session.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.4",
        usage: {
          input: totalTokens,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens,
          cost: {
            input: totalCost,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: totalCost,
          },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
    };

    try {
      await withEnvOverride({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        seedUsage("main", 30, 0.03);
        seedUsage("dev", 70, 0.07);
        usageTestApi.costUsageCache.clear();
        const observedStatuses: Array<string | undefined> = [];
        callGateway.mockImplementation(async (raw) => {
          const request = raw as { method?: string; params?: Record<string, unknown> };
          if (request.method !== "usage.cost") {
            return { ok: true };
          }
          return await new Promise((resolve, reject) => {
            const respond: UsageCostHandlerArgs["respond"] = (ok, payload, error) => {
              if (!ok) {
                reject(new Error(error?.message ?? "usage.cost failed"));
                return;
              }
              const summary = payload as { cacheStatus?: { status?: string } };
              observedStatuses.push(summary.cacheStatus?.status);
              resolve(payload);
            };
            const result = usageHandlers["usage.cost"]({
              respond,
              params: request.params ?? {},
              context: { getRuntimeConfig: () => config },
            } as unknown as UsageCostHandlerArgs);
            Promise.resolve(result).catch(reject);
          });
        });

        await runGatewayCommand(["gateway", "usage-cost", "--all-agents", "--days", "7", "--json"]);

        expect(observedStatuses[0]).toBe("refreshing");
        expect(observedStatuses.at(-1)).toBe("fresh");
        expect(callGateway.mock.calls.length).toBeGreaterThanOrEqual(2);
        const costCalls = callGateway.mock.calls.map(
          ([raw]) => raw as { method?: string; timeoutMs?: number },
        );
        expect(costCalls.every((call) => call.method === "usage.cost")).toBe(true);
        expect(costCalls.every((call) => (call.timeoutMs ?? 0) > 0)).toBe(true);
        expect(costCalls.every((call) => (call.timeoutMs ?? 0) <= 10_000)).toBe(true);
        expect(costCalls[0]?.timeoutMs).toBe(10_000);
        expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
          expect.objectContaining({
            totals: expect.objectContaining({ totalTokens: 100, totalCost: 0.1 }),
            cacheStatus: expect.objectContaining({ status: "fresh" }),
          }),
        );
      });
    } finally {
      usageTestApi.costUsageCache.clear();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it.each(["refreshing", "partial", "stale"] as const)(
    "uses --timeout as the command-wide usage-cost settle budget for %s caches",
    async (status) => {
      callGateway.mockResolvedValue({
        cacheStatus: { status, cachedFiles: 0, pendingFiles: 1 },
      });

      await expectGatewayExit([
        "gateway",
        "usage-cost",
        "--all-agents",
        "--timeout",
        "50",
        "--json",
      ]);

      expect(callGateway).toHaveBeenCalledTimes(1);
      const costCall = firstMockArg(callGateway) as { method?: string; timeoutMs?: number };
      expect(costCall.method).toBe("usage.cost");
      expect(costCall.timeoutMs).toBeGreaterThan(0);
      expect(costCall.timeoutMs).toBeLessThanOrEqual(50);
      expect(runtimeErrors.join("\n")).toContain("Timed out waiting for usage cost cache refresh");
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
    expect(runtimeErrors.join("\n")).toContain("Use --agent or --all-agents, not both");
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
        await runGatewayCommand(["gateway", "stability", "--bundle", "latest"]);
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

  it("writes gateway diagnostics export with a best-effort health snapshot", async () => {
    callGateway.mockClear();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-cli-support-"));
    try {
      const outputPath = path.join(tempDir, "diagnostics.zip");
      await withEnvOverride(
        { OPENCLAW_STATE_DIR: tempDir, OPENCLAW_TEST_FILE_LOG: undefined },
        async () => {
          await runGatewayCommand([
            "gateway",
            "diagnostics",
            "export",
            "--output",
            outputPath,
            "--json",
          ]);
        },
      );

      expect(callGateway).toHaveBeenCalledTimes(1);
      const healthCall = firstMockArg(callGateway) as { method?: string; timeoutMs?: number };
      expect(healthCall?.method).toBe("health");
      expect(healthCall?.timeoutMs).toBe(3000);
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

    expect(runtimeErrors.join("\n")).toContain(`${flag} must be a positive integer`);
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
  });

  it("validates gateway call timeout before opening a transport", async () => {
    callGateway.mockClear();
    await expectGatewayExit(["gateway", "call", "health", "--timeout", "nope", "--json"]);

    expect(callGateway).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("Invalid --timeout");
  });

  it("validates gateway ports before starting", async () => {
    await expectGatewayExit(["gateway", "--port", "0", "--token", "test-token"]);
  });

  it("reports force-free port failures", async () => {
    forceFreePortAndWait.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    await expectGatewayExit([
      "gateway",
      "--port",
      "18789",
      "--token",
      "test-token",
      "--force",
      "--allow-unconfigured",
    ]);
  });

  it("reports gateway start failures without leaking signal listeners", async () => {
    startGatewayServer.mockRejectedValueOnce(new Error("nope"));
    const beforeSigterm = new Set(process.listeners("SIGTERM"));
    const beforeSigint = new Set(process.listeners("SIGINT"));
    await expectGatewayExit([
      "gateway",
      "--port",
      "18789",
      "--token",
      "test-token",
      "--allow-unconfigured",
    ]);
    for (const listener of process.listeners("SIGTERM")) {
      if (!beforeSigterm.has(listener)) {
        process.removeListener("SIGTERM", listener);
      }
    }
    for (const listener of process.listeners("SIGINT")) {
      if (!beforeSigint.has(listener)) {
        process.removeListener("SIGINT", listener);
      }
    }
  });

  it("prints stop hints on GatewayLockError when service is loaded", async () => {
    await withEnvOverride(
      {
        LAUNCH_JOB_LABEL: undefined,
        LAUNCH_JOB_NAME: undefined,
        XPC_SERVICE_NAME: undefined,
        OPENCLAW_LAUNCHD_LABEL: undefined,
        OPENCLAW_SYSTEMD_UNIT: undefined,
        INVOCATION_ID: undefined,
        SYSTEMD_EXEC_PID: undefined,
        JOURNAL_STREAM: undefined,
        OPENCLAW_WINDOWS_TASK_NAME: undefined,
        OPENCLAW_SERVICE_MARKER: undefined,
        OPENCLAW_SERVICE_KIND: undefined,
      },
      async () => {
        serviceIsLoaded.mockResolvedValue(true);
        startGatewayServer.mockRejectedValueOnce(
          new GatewayLockError("another gateway instance is already listening"),
        );
        await expect(
          runGatewayCommand(["gateway", "--token", "test-token", "--allow-unconfigured"]),
        ).rejects.toThrow("__exit__:0");

        expect(startGatewayServer).toHaveBeenCalledTimes(1);
        expect(runtimeErrors.join("\n")).toContain("Gateway failed to start:");
        expect(runtimeErrors.join("\n")).toContain("gateway stop");
      },
    );
  });

  it("keeps exit 1 for gateway bind failures wrapped as GatewayLockError", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    serviceIsLoaded.mockResolvedValue(true);
    startGatewayServer.mockRejectedValueOnce(
      new GatewayLockError("failed to bind gateway socket on ws://127.0.0.1:18789: Error: boom"),
    );

    await expectGatewayExit(["gateway", "--token", "test-token", "--allow-unconfigured"]);

    expect(runtimeErrors.join("\n")).toContain("failed to bind gateway socket");
  });

  it("keeps exit 1 for gateway lock acquisition failures", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    serviceIsLoaded.mockResolvedValue(true);
    startGatewayServer.mockRejectedValueOnce(
      new GatewayLockError("failed to acquire gateway lock at /tmp/openclaw/gateway.lock"),
    );

    await expectGatewayExit(["gateway", "--token", "test-token", "--allow-unconfigured"]);

    expect(runtimeErrors.join("\n")).toContain("failed to acquire gateway lock");
  });

  it("uses env/config port when --port is omitted", async () => {
    await withEnvOverride({ OPENCLAW_GATEWAY_PORT: "19001" }, async () => {
      runtimeLogs.length = 0;
      runtimeErrors.length = 0;
      startGatewayServer.mockClear();

      startGatewayServer.mockRejectedValueOnce(new Error("nope"));
      await expectGatewayExit(["gateway", "--token", "test-token", "--allow-unconfigured"]);

      expect(startGatewayServer).toHaveBeenCalledTimes(1);
      const startCall = startGatewayServer.mock.calls[0];
      expect(startCall?.[0]).toBe(19001);
      expect(typeof startCall?.[1]).toBe("object");
    });
  });
});
