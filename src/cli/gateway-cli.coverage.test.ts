import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

const callGateway = vi.fn(async () => ({ ok: true }));
const startGatewayServer = vi.fn(async () => ({
  close: vi.fn(async () => {}),
}));
const setVerbose = vi.fn();
const forceFreePortAndWait = vi.fn(async () => ({
  killed: [],
  waitedMs: 0,
  escalatedToSigkill: false,
}));
const serviceIsLoaded = vi.fn().mockResolvedValue(true);
const discoverGatewayBeacons = vi.fn(async () => []);
const gatewayStatusCommand = vi.fn(async () => {});

const runtimeLogs: string[] = [];
const runtimeErrors: string[] = [];
const defaultRuntime = {
  log: (msg: string) => runtimeLogs.push(msg),
  error: (msg: string) => runtimeErrors.push(msg),
  exit: (code: number) => {
    throw new Error(`__exit__:${code}`);
  },
};

async function withEnvOverride<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  vi.resetModules();
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.resetModules();
  }
}

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGateway(opts),
  randomIdempotencyKey: () => "rk_test",
}));

vi.mock("../gateway/server.js", () => ({
  startGatewayServer: (port: number, opts?: unknown) => startGatewayServer(port, opts),
}));

vi.mock("../globals.js", () => ({
  info: (msg: string) => msg,
  isVerbose: () => false,
  setVerbose: (enabled: boolean) => setVerbose(enabled),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("./ports.js", () => ({
  forceFreePortAndWait: (port: number) => forceFreePortAndWait(port),
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({
    label: "LaunchAgent",
    loadedText: "loaded",
    notLoadedText: "not loaded",
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

vi.mock("../infra/bonjour-discovery.js", () => ({
  discoverGatewayBeacons: (opts: unknown) => discoverGatewayBeacons(opts),
}));

vi.mock("../commands/gateway-status.js", () => ({
  gatewayStatusCommand: (opts: unknown) => gatewayStatusCommand(opts),
}));

describe("gateway-cli coverage", () => {
  it("registers call/health commands and routes to callGateway", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    callGateway.mockClear();

    const { registerGatewayCli } = await import("./gateway-cli.js");
    const program = new Command();
    program.exitOverride();
    registerGatewayCli(program);

    await program.parseAsync(["gateway", "call", "health", "--params", '{"x":1}', "--json"], {
      from: "user",
    });

    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(runtimeLogs.join("\n")).toContain('"ok": true');
  }, 30_000);

  it("registers gateway probe and routes to gatewayStatusCommand", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    gatewayStatusCommand.mockClear();

    const { registerGatewayCli } = await import("./gateway-cli.js");
    const program = new Command();
    program.exitOverride();
    registerGatewayCli(program);

    await program.parseAsync(["gateway", "probe", "--json"], { from: "user" });

    expect(gatewayStatusCommand).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("registers gateway discover and prints JSON", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    discoverGatewayBeacons.mockReset();
    discoverGatewayBeacons.mockResolvedValueOnce([
      {
        instanceName: "Studio (Clawdbot)",
        displayName: "Studio",
        domain: "local.",
        host: "studio.local",
        lanHost: "studio.local",
        tailnetDns: "studio.tailnet.ts.net",
        gatewayPort: 18789,
        sshPort: 22,
      },
    ]);

    const { registerGatewayCli } = await import("./gateway-cli.js");
    const program = new Command();
    program.exitOverride();
    registerGatewayCli(program);

    await program.parseAsync(["gateway", "discover", "--json"], {
      from: "user",
    });

    expect(discoverGatewayBeacons).toHaveBeenCalledTimes(1);
    expect(runtimeLogs.join("\n")).toContain('"beacons"');
    expect(runtimeLogs.join("\n")).toContain('"wsUrl"');
    expect(runtimeLogs.join("\n")).toContain("ws://");
  });

  it("registers gateway discover and prints human output with details on new lines", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    discoverGatewayBeacons.mockReset();
    discoverGatewayBeacons.mockResolvedValueOnce([
      {
        instanceName: "Studio (Clawdbot)",
        displayName: "Studio",
        domain: "clawdbot.internal.",
        host: "studio.clawdbot.internal",
        lanHost: "studio.local",
        tailnetDns: "studio.tailnet.ts.net",
        gatewayPort: 18789,
        sshPort: 22,
      },
    ]);

    const { registerGatewayCli } = await import("./gateway-cli.js");
    const program = new Command();
    program.exitOverride();
    registerGatewayCli(program);

    await program.parseAsync(["gateway", "discover", "--timeout", "1"], {
      from: "user",
    });

    const out = runtimeLogs.join("\n");
    expect(out).toContain("Gateway Discovery");
    expect(out).toContain("Found 1 gateway(s)");
    expect(out).toContain("- Studio clawdbot.internal.");
    expect(out).toContain("  tailnet: studio.tailnet.ts.net");
    expect(out).toContain("  host: studio.clawdbot.internal");
    expect(out).toContain("  ws: ws://studio.tailnet.ts.net:18789");
  });

  it("validates gateway discover timeout", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    discoverGatewayBeacons.mockReset();

    const { registerGatewayCli } = await import("./gateway-cli.js");
    const program = new Command();
    program.exitOverride();
    registerGatewayCli(program);

    await expect(
      program.parseAsync(["gateway", "discover", "--timeout", "0"], {
        from: "user",
      }),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.join("\n")).toContain("gateway discover failed:");
    expect(discoverGatewayBeacons).not.toHaveBeenCalled();
  });

  it("fails gateway call on invalid params JSON", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    callGateway.mockClear();

    const { registerGatewayCli } = await import("./gateway-cli.js");
    const program = new Command();
    program.exitOverride();
    registerGatewayCli(program);

    await expect(
      program.parseAsync(["gateway", "call", "status", "--params", "not-json"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");

    expect(callGateway).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("Gateway call failed:");
  });

  it("validates gateway ports and handles force/start errors", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;

    const { registerGatewayCli } = await import("./gateway-cli.js");

    // Invalid port
    const programInvalidPort = new Command();
    programInvalidPort.exitOverride();
    registerGatewayCli(programInvalidPort);
    await expect(
      programInvalidPort.parseAsync(["gateway", "--port", "0", "--token", "test-token"], {
        from: "user",
      }),
    ).rejects.toThrow("__exit__:1");

    // Force free failure
    forceFreePortAndWait.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    const programForceFail = new Command();
    programForceFail.exitOverride();
    registerGatewayCli(programForceFail);
    await expect(
      programForceFail.parseAsync(
        ["gateway", "--port", "18789", "--token", "test-token", "--force", "--allow-unconfigured"],
        { from: "user" },
      ),
    ).rejects.toThrow("__exit__:1");

    // Start failure (generic)
    startGatewayServer.mockRejectedValueOnce(new Error("nope"));
    const programStartFail = new Command();
    programStartFail.exitOverride();
    registerGatewayCli(programStartFail);
    const beforeSigterm = new Set(process.listeners("SIGTERM"));
    const beforeSigint = new Set(process.listeners("SIGINT"));
    await expect(
      programStartFail.parseAsync(
        ["gateway", "--port", "18789", "--token", "test-token", "--allow-unconfigured"],
        {
          from: "user",
        },
      ),
    ).rejects.toThrow("__exit__:1");
    for (const listener of process.listeners("SIGTERM")) {
      if (!beforeSigterm.has(listener)) process.removeListener("SIGTERM", listener);
    }
    for (const listener of process.listeners("SIGINT")) {
      if (!beforeSigint.has(listener)) process.removeListener("SIGINT", listener);
    }
  });

  it("prints stop hints on GatewayLockError when service is loaded", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    serviceIsLoaded.mockResolvedValue(true);

    const { GatewayLockError } = await import("../infra/gateway-lock.js");
    startGatewayServer.mockRejectedValueOnce(
      new GatewayLockError("another gateway instance is already listening"),
    );

    const { registerGatewayCli } = await import("./gateway-cli.js");
    const program = new Command();
    program.exitOverride();
    registerGatewayCli(program);

    await expect(
      program.parseAsync(["gateway", "--token", "test-token", "--allow-unconfigured"], {
        from: "user",
      }),
    ).rejects.toThrow("__exit__:1");

    expect(startGatewayServer).toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("Gateway failed to start:");
    expect(runtimeErrors.join("\n")).toContain("clawdbot gateway stop");
  });

  it("uses env/config port when --port is omitted", async () => {
    await withEnvOverride({ CLAWDBOT_GATEWAY_PORT: "19001" }, async () => {
      runtimeLogs.length = 0;
      runtimeErrors.length = 0;
      startGatewayServer.mockClear();

      const { registerGatewayCli } = await import("./gateway-cli.js");
      const program = new Command();
      program.exitOverride();
      registerGatewayCli(program);

      startGatewayServer.mockRejectedValueOnce(new Error("nope"));
      await expect(
        program.parseAsync(["gateway", "--token", "test-token", "--allow-unconfigured"], {
          from: "user",
        }),
      ).rejects.toThrow("__exit__:1");

      expect(startGatewayServer).toHaveBeenCalledWith(19001, expect.anything());
    });
  });
});
