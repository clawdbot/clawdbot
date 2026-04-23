import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvOverride } from "../config/test-helpers.js";
import { GatewayLockError } from "../infra/gateway-lock.js";
import { registerGatewayCli } from "./gateway-cli.js";

type DiscoveredBeacon = Awaited<
  ReturnType<typeof import("../infra/bonjour-discovery.js").discoverGatewayBeacons>
>[number];

const callGateway = vi.fn<(opts: unknown) => Promise<{ ok: true }>>(async () => ({ ok: true }));
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
    callGateway: (opts: unknown) => callGateway(opts),
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

describe("gateway-cli coverage", () => {
  beforeEach(() => {
    gatewayProgram = createGatewayProgram();
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    defaultRuntime.log.mockClear();
    defaultRuntime.error.mockClear();
    defaultRuntime.writeStdout.mockClear();
    defaultRuntime.writeJson.mockClear();
    defaultRuntime.exit.mockClear();
    inspectPortUsage.mockClear();
    formatPortDiagnostics.mockClear();
  });

  it("registers call/health commands and routes to callGateway", async () => {
    callGateway.mockClear();

    await runGatewayCommand(["gateway", "call", "health", "--params", '{"x":1}', "--json"]);

    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(runtimeLogs.join("\n")).toContain('"ok": true');
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

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "diagnostics.stability",
        params: {
          limit: 5,
          type: "payload.large",
        },
      }),
    );
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
      expect(callGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "health",
          timeoutMs: 3000,
        }),
      );
      expect(fs.existsSync(outputPath)).toBe(true);
      const output = runtimeLogs.join("\n");
      expect(output).toContain('"path"');
      expect(output).toContain("diagnostics.zip");
      expect(output).toContain('"payloadFree": true');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
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

  it("validates gateway ports and handles force/start errors", async () => {
    // Invalid port
    await expectGatewayExit(["gateway", "--port", "0", "--token", "test-token"]);

    // Force free failure
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

    // Start failure (generic)
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

        expect(startGatewayServer).toHaveBeenCalled();
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

      expect(startGatewayServer).toHaveBeenCalledWith(19001, expect.anything());
    });
  });
});
