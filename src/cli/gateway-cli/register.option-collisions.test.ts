// Gateway register option collision tests cover gateway command option registration.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerGatewayCli } from "./register.js";

const mocks = vi.hoisted(() => ({
  callGatewayCli: vi.fn(async (_method: string, _opts: unknown, _params?: unknown) => ({
    ok: true,
  })),
  emitReachableGatewayAuthDiagnostic: vi.fn(async (_params: unknown) => false),
  formatHealthChannelLines: vi.fn(() => []),
  gatewayStatusCommand: vi.fn(async (_opts: unknown, _runtime: unknown) => {}),
  gatewayAuthTokenCommand: vi.fn(async (_runtime: unknown) => {}),
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn(),
  },
}));

const { callGatewayCli, emitReachableGatewayAuthDiagnostic, gatewayStatusCommand, defaultRuntime } =
  mocks;

vi.mock("../cli-utils.js", () => ({
  runCommandWithRuntime: async (
    _runtime: unknown,
    action: () => Promise<void>,
    onError: (err: unknown) => void,
  ) => {
    try {
      await action();
    } catch (err) {
      onError(err);
    }
  },
}));

vi.mock("../../runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../../runtime.js")>("../../runtime.js")),
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("../../commands/gateway-status.js", () => ({
  gatewayStatusCommand: (opts: unknown, runtime: unknown) =>
    mocks.gatewayStatusCommand(opts, runtime),
}));

vi.mock("../../commands/gateway-auth-token.js", () => ({
  gatewayAuthTokenCommand: (runtime: unknown) => mocks.gatewayAuthTokenCommand(runtime),
}));

vi.mock("../gateway-rpc.js", async () => ({
  ...(await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js")),
  callGatewayFromCliWithTransport: (method: string, opts: unknown, params?: unknown) =>
    mocks.callGatewayCli(method, opts, params),
}));

vi.mock("./run-command.js", () => ({
  addGatewayRunCommand: (cmd: Command) =>
    cmd
      .option("--port <port>", "Port for the gateway WebSocket")
      .option("--token <token>", "Gateway token")
      .option("--password <password>", "Gateway password"),
}));

vi.mock("../daemon-cli/register-service-commands.js", () => ({
  addGatewayServiceCommands: () => undefined,
}));

vi.mock("../../commands/health.js", () => ({
  emitReachableGatewayAuthDiagnostic: (params: unknown) =>
    mocks.emitReachableGatewayAuthDiagnostic(params),
  formatHealthChannelLines: () => mocks.formatHealthChannelLines(),
}));

vi.mock("../../config/read-best-effort-config.runtime.js", () => ({
  readBestEffortConfig: async () => ({}),
  readSourceConfigBestEffort: async () => ({}),
}));

vi.mock("../../infra/bonjour-discovery.js", () => ({
  discoverGatewayBeacons: async () => [],
}));

vi.mock("../../infra/widearea-dns.js", () => ({
  resolveWideAreaDiscoveryDomain: () => undefined,
}));

vi.mock("../../../packages/terminal-core/src/health-style.js", () => ({
  styleHealthChannelLine: (line: string) => line,
}));

vi.mock("../../../packages/terminal-core/src/links.js", () => ({
  formatDocsLink: () => "docs.openclaw.ai/cli/gateway",
}));

vi.mock("../../../packages/terminal-core/src/theme.js", () => ({
  colorize: (_rich: boolean, _fn: (value: string) => string, value: string) => value,
  isRich: () => false,
  theme: {
    heading: (value: string) => value,
    muted: (value: string) => value,
    success: (value: string) => value,
  },
}));

vi.mock("../../utils/usage-format.js", () => ({
  formatTokenCount: () => "0",
  formatUsd: () => "$0.00",
}));

vi.mock("../help-format.js", () => ({
  formatHelpExamples: () => "",
}));

vi.mock("../progress.js", () => ({
  withProgress: async (_opts: unknown, fn: () => Promise<unknown>) => await fn(),
}));

vi.mock("./discover.js", () => ({
  dedupeBeacons: (beacons: unknown[]) => beacons,
  parseDiscoverTimeoutMs: () => 2000,
  pickBeaconHost: () => null,
  pickGatewayPort: () => 18789,
  renderBeaconLines: () => [],
}));

function firstGatewayCall() {
  return callGatewayCli.mock.calls[0] ?? [];
}

function firstGatewayStatusCall() {
  return gatewayStatusCommand.mock.calls[0] ?? [];
}

function expectLocalGatewayCall(method: string, port: number, params?: unknown) {
  expect(defaultRuntime.error.mock.calls).toEqual([]);
  expect(callGatewayCli).toHaveBeenCalledTimes(1);
  const [actualMethod, opts, actualParams] = firstGatewayCall();
  expect(actualMethod).toBe(method);
  if (params !== undefined) {
    expect(actualParams).toEqual(params);
  }
  const gatewayOpts = opts as
    | { config?: { gateway?: { port?: number } }; localPortOverride?: number }
    | undefined;
  expect(gatewayOpts?.localPortOverride).toBe(port);
  expect(gatewayOpts?.config).toEqual({
    gateway: { mode: "local", port },
  });
}

describe("gateway register option collisions", () => {
  const sharedProgram: Command = new Command();

  if (sharedProgram.commands.length === 0) {
    sharedProgram.exitOverride();
    registerGatewayCli(sharedProgram);
  }

  beforeEach(() => {
    callGatewayCli.mockClear();
    emitReachableGatewayAuthDiagnostic.mockClear();
    mocks.formatHealthChannelLines.mockClear();
    gatewayStatusCommand.mockClear();
    mocks.gatewayAuthTokenCommand.mockClear();
    defaultRuntime.log.mockClear();
    defaultRuntime.error.mockClear();
    defaultRuntime.writeStdout.mockClear();
    defaultRuntime.writeJson.mockClear();
    defaultRuntime.exit.mockClear();
  });

  it("requires explicit confirmation before revealing the Gateway token", async () => {
    await sharedProgram.parseAsync(["gateway", "auth-token"], { from: "user" });

    expect(mocks.gatewayAuthTokenCommand).not.toHaveBeenCalled();
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("Pass --show to confirm"),
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("routes an explicitly confirmed token reveal through the output runtime", async () => {
    await sharedProgram.parseAsync(["gateway", "auth-token", "--show"], { from: "user" });

    expect(mocks.gatewayAuthTokenCommand).toHaveBeenCalledWith(defaultRuntime);
    expect(defaultRuntime.error).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "forwards --token to gateway call when parent and child option names collide",
      argv: ["gateway", "call", "health", "--token", "tok_call", "--json"],
      assert: () => {
        expect(callGatewayCli).toHaveBeenCalledTimes(1);
        const [method, opts, params] = firstGatewayCall();
        expect(method).toBe("health");
        expect((opts as { token?: string } | undefined)?.token).toBe("tok_call");
        expect(params).toEqual({});
      },
    },
    {
      name: "projects gateway call --port into local config",
      argv: ["gateway", "call", "health", "--port", "19084", "--json"],
      assert: () => {
        expectLocalGatewayCall("health", 19084, {});
      },
    },
    {
      name: "inherits parent --port for gateway call",
      argv: ["gateway", "--port", "19085", "call", "health", "--json"],
      assert: () => {
        expectLocalGatewayCall("health", 19085);
      },
    },
    {
      name: "forwards --token to gateway probe when parent and child option names collide",
      argv: ["gateway", "probe", "--token", "tok_probe", "--json"],
      assert: () => {
        expect(gatewayStatusCommand).toHaveBeenCalledTimes(1);
        const [opts, runtime] = firstGatewayStatusCall();
        expect((opts as { token?: string } | undefined)?.token).toBe("tok_probe");
        expect(runtime).toBe(defaultRuntime);
      },
    },
    {
      name: "forwards --port to gateway probe",
      argv: ["gateway", "probe", "--port", "19080", "--json"],
      assert: () => {
        expect(gatewayStatusCommand).toHaveBeenCalledTimes(1);
        const [opts] = firstGatewayStatusCall();
        expect((opts as { port?: string } | undefined)?.port).toBe("19080");
      },
    },
    {
      name: "inherits parent --port for gateway probe",
      argv: ["gateway", "--port", "19082", "probe", "--json"],
      assert: () => {
        expect(gatewayStatusCommand).toHaveBeenCalledTimes(1);
        const [opts] = firstGatewayStatusCall();
        expect((opts as { port?: string } | undefined)?.port).toBe("19082");
      },
    },
    {
      name: "projects gateway health --port into local config",
      argv: ["gateway", "health", "--port", "19081", "--json"],
      assert: () => {
        expectLocalGatewayCall("health", 19081);
      },
    },
    {
      name: "inherits parent --port for gateway health",
      argv: ["gateway", "--port", "19083", "health", "--json"],
      assert: () => {
        expectLocalGatewayCall("health", 19083);
      },
    },
    {
      name: "passes decimal usage-cost --days values",
      argv: ["gateway", "usage-cost", "--days", "7", "--json"],
      assert: () => {
        expect(callGatewayCli).toHaveBeenCalledTimes(1);
        const [method, _opts, params] = firstGatewayCall();
        expect(method).toBe("usage.cost");
        expect(params).toEqual({ days: 7 });
      },
    },
    {
      name: "falls back for non-decimal usage-cost --days values",
      argv: ["gateway", "usage-cost", "--days", "1e3", "--json"],
      assert: () => {
        expect(callGatewayCli).toHaveBeenCalledTimes(1);
        const [method, _opts, params] = firstGatewayCall();
        expect(method).toBe("usage.cost");
        expect(params).toEqual({ days: 30 });
      },
    },
  ])("$name", async ({ argv, assert }) => {
    await sharedProgram.parseAsync(argv, { from: "user" });
    assert();
  });

  it("rejects combining --url and --port for gateway call", async () => {
    await sharedProgram.parseAsync(
      ["gateway", "call", "health", "--url", "ws://127.0.0.1:19084", "--port", "19084", "--json"],
      { from: "user" },
    );

    expect(callGatewayCli).not.toHaveBeenCalled();
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      "Gateway call failed: Error: Use either --url or --port, not both.",
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("uses the effective local port config for gateway health auth diagnostics", async () => {
    const authError = new Error("gateway auth required");
    callGatewayCli.mockRejectedValueOnce(authError);
    emitReachableGatewayAuthDiagnostic.mockResolvedValueOnce(true);

    await sharedProgram.parseAsync(["gateway", "health", "--port", "19081", "--json"], {
      from: "user",
    });

    expect(emitReachableGatewayAuthDiagnostic).toHaveBeenCalledTimes(1);
    expect(emitReachableGatewayAuthDiagnostic).toHaveBeenCalledWith({
      error: authError,
      config: {
        gateway: { mode: "local", port: 19081 },
      },
      runtime: defaultRuntime,
      timeoutMs: 10000,
      token: undefined,
      password: undefined,
      localPortOverride: 19081,
      json: true,
    });
  });

  it("defers health presentation imports for successful JSON output", async () => {
    const program = new Command();
    program.exitOverride();
    const loadGatewayHealthModule = vi.fn(async () => ({
      emitReachableGatewayAuthDiagnostic: mocks.emitReachableGatewayAuthDiagnostic,
      formatHealthChannelLines: mocks.formatHealthChannelLines,
    }));
    const loadHealthStyleModule = vi.fn(async () => ({
      styleHealthChannelLine: (line: string) => line,
    }));
    registerGatewayCli(program, {
      loadGatewayHealthModule: loadGatewayHealthModule as never,
      loadHealthStyleModule: loadHealthStyleModule as never,
    });

    await program.parseAsync(["node", "openclaw", "gateway", "health", "--json"]);

    expect(callGatewayCli).toHaveBeenCalledWith(
      "health",
      expect.objectContaining({ json: true }),
      undefined,
    );
    expect(loadGatewayHealthModule).not.toHaveBeenCalled();
    expect(loadHealthStyleModule).not.toHaveBeenCalled();
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith({ ok: true });
  });
});
