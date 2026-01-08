import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

const callGateway = vi.fn(async () => ({ ok: true }));
const randomIdempotencyKey = vi.fn(() => "rk_test");
const startGatewayServer = vi.fn(async () => ({
  close: vi.fn(async () => {}),
}));
const setVerbose = vi.fn();
const createDefaultDeps = vi.fn();
const forceFreePortAndWait = vi.fn(async () => ({
  killed: [],
  waitedMs: 0,
  escalatedToSigkill: false,
}));
const serviceInstall = vi.fn().mockResolvedValue(undefined);
const serviceStop = vi.fn().mockResolvedValue(undefined);
const serviceUninstall = vi.fn().mockResolvedValue(undefined);
const serviceRestart = vi.fn().mockResolvedValue(undefined);
const serviceIsLoaded = vi.fn().mockResolvedValue(true);

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
  randomIdempotencyKey: () => randomIdempotencyKey(),
}));

vi.mock("../gateway/server.js", () => ({
  startGatewayServer: (port: number, opts?: unknown) =>
    startGatewayServer(port, opts),
}));

vi.mock("../globals.js", () => ({
  info: (msg: string) => msg,
  isVerbose: () => false,
  setVerbose: (enabled: boolean) => setVerbose(enabled),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("./deps.js", () => ({
  createDefaultDeps: () => createDefaultDeps(),
}));

vi.mock("./ports.js", () => ({
  forceFreePortAndWait: (port: number) => forceFreePortAndWait(port),
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({
    label: "LaunchAgent",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    install: serviceInstall,
    uninstall: serviceUninstall,
    stop: serviceStop,
    restart: serviceRestart,
    isLoaded: serviceIsLoaded,
    readCommand: vi.fn(),
    readRuntime: vi.fn().mockResolvedValue({ status: "running" }),
  }),
}));

vi.mock("../daemon/program-args.js", () => ({
  resolveGatewayProgramArguments: async () => ({
    programArguments: ["/bin/node", "cli", "gateway-daemon", "--port", "18789"],
  }),
}));

describe("gateway-cli coverage", () => {
  it("registers call/health/status/send/agent commands and routes to callGateway", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    callGateway.mockClear();

    const { registerGatewayCli } = await import("./gateway-cli.js");
    const program = new Command();
    program.exitOverride();
    registerGatewayCli(program);

    await program.parseAsync(
      ["gateway", "call", "health", "--params", '{"x":1}'],
      { from: "user" },
    );

    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(runtimeLogs.join("\n")).toContain('"ok": true');
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
      program.parseAsync(
        ["gateway", "call", "status", "--params", "not-json"],
        { from: "user" },
      ),
    ).rejects.toThrow("__exit__:1");

    expect(callGateway).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("Gateway call failed:");
  });

  it("fills idempotency keys for send/agent when missing", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    callGateway.mockClear();
    randomIdempotencyKey.mockClear();

    const { registerGatewayCli } = await import("./gateway-cli.js");
    const program = new Command();
    program.exitOverride();
    registerGatewayCli(program);

    await program.parseAsync(
      ["gateway", "send", "--to", "+1555", "--message", "hi"],
      { from: "user" },
    );

    await program.parseAsync(
      ["gateway", "agent", "--message", "hello", "--deliver"],
      { from: "user" },
    );

    expect(randomIdempotencyKey).toHaveBeenCalled();
    const callArgs = callGateway.mock.calls.map((c) => c[0]) as Array<{
      method: string;
      params?: { idempotencyKey?: string };
      expectFinal?: boolean;
    }>;
    expect(callArgs.some((c) => c.method === "send")).toBe(true);
    expect(
      callArgs.some((c) => c.method === "agent" && c.expectFinal === true),
    ).toBe(true);
    expect(callArgs.every((c) => c.params?.idempotencyKey === "rk_test")).toBe(
      true,
    );
  });

  it("passes gifPlayback for gateway send when flag set", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    callGateway.mockClear();
    randomIdempotencyKey.mockClear();

    const { registerGatewayCli } = await import("./gateway-cli.js");
    const program = new Command();
    program.exitOverride();
    registerGatewayCli(program);

    await program.parseAsync(
      ["gateway", "send", "--to", "+1555", "--message", "hi", "--gif-playback"],
      { from: "user" },
    );

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "send",
        params: expect.objectContaining({ gifPlayback: true }),
      }),
    );
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
      programInvalidPort.parseAsync(["gateway", "--port", "0"], {
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
        ["gateway", "--port", "18789", "--force", "--allow-unconfigured"],
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
        ["gateway", "--port", "18789", "--allow-unconfigured"],
        { from: "user" },
      ),
    ).rejects.toThrow("__exit__:1");
    for (const listener of process.listeners("SIGTERM")) {
      if (!beforeSigterm.has(listener))
        process.removeListener("SIGTERM", listener);
    }
    for (const listener of process.listeners("SIGINT")) {
      if (!beforeSigint.has(listener))
        process.removeListener("SIGINT", listener);
    }
  });

  it("supports gateway stop/restart via service helper", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    serviceStop.mockClear();
    serviceRestart.mockClear();
    serviceIsLoaded.mockResolvedValue(true);

    const { registerGatewayCli } = await import("./gateway-cli.js");
    const program = new Command();
    program.exitOverride();
    registerGatewayCli(program);

    await program.parseAsync(["gateway", "stop"], { from: "user" });
    await program.parseAsync(["gateway", "restart"], { from: "user" });

    expect(serviceStop).toHaveBeenCalledTimes(1);
    expect(serviceRestart).toHaveBeenCalledTimes(1);
  });

  it("supports gateway install/uninstall/start via daemon helpers", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    serviceInstall.mockClear();
    serviceUninstall.mockClear();
    serviceRestart.mockClear();
    serviceIsLoaded.mockResolvedValueOnce(false);

    const { registerGatewayCli } = await import("./gateway-cli.js");
    const program = new Command();
    program.exitOverride();
    registerGatewayCli(program);

    await program.parseAsync(["gateway", "install", "--port", "18789"], {
      from: "user",
    });
    await program.parseAsync(["gateway", "uninstall"], { from: "user" });
    await program.parseAsync(["gateway", "start"], { from: "user" });

    expect(serviceInstall).toHaveBeenCalledTimes(1);
    expect(serviceUninstall).toHaveBeenCalledTimes(1);
    expect(serviceRestart).toHaveBeenCalledTimes(1);
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
      program.parseAsync(["gateway", "--allow-unconfigured"], {
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
        program.parseAsync(["gateway", "--allow-unconfigured"], {
          from: "user",
        }),
      ).rejects.toThrow("__exit__:1");

      expect(startGatewayServer).toHaveBeenCalledWith(19001, expect.anything());
    });
  });
});
