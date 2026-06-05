// Node CLI register tests cover node command registration and option wiring.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerNodeCli } from "./register.js";

type LoadNodeHostConfig = typeof import("../../node-host/config.js").loadNodeHostConfig;

const daemonMocks = vi.hoisted(() => ({
  defaultRuntime: {
    error: vi.fn(),
    exit: vi.fn(),
  },
  loadNodeHostConfig: vi.fn<LoadNodeHostConfig>(async () => null),
  runNodeHost: vi.fn(),
  runNodeDaemonInstall: vi.fn(),
  runNodeDaemonRestart: vi.fn(),
  runNodeDaemonStart: vi.fn(),
  runNodeDaemonStatus: vi.fn(),
  runNodeDaemonStop: vi.fn(),
  runNodeDaemonUninstall: vi.fn(),
}));

vi.mock("./daemon.js", () => daemonMocks);

vi.mock("../../node-host/config.js", () => ({
  loadNodeHostConfig: daemonMocks.loadNodeHostConfig,
}));

vi.mock("../../node-host/runner.js", () => ({
  runNodeHost: daemonMocks.runNodeHost,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: daemonMocks.defaultRuntime,
}));

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeErr: () => undefined,
    writeOut: () => undefined,
  });
  registerNodeCli(program);
  return program;
}

describe("registerNodeCli", () => {
  beforeEach(() => {
    daemonMocks.defaultRuntime.error.mockClear();
    daemonMocks.defaultRuntime.exit.mockClear();
    daemonMocks.loadNodeHostConfig.mockClear();
    daemonMocks.loadNodeHostConfig.mockResolvedValue(null);
    daemonMocks.runNodeHost.mockClear();
    daemonMocks.runNodeDaemonInstall.mockClear();
    daemonMocks.runNodeDaemonRestart.mockClear();
    daemonMocks.runNodeDaemonStart.mockClear();
    daemonMocks.runNodeDaemonStatus.mockClear();
    daemonMocks.runNodeDaemonStop.mockClear();
    daemonMocks.runNodeDaemonUninstall.mockClear();
  });

  it("registers node start for the macOS app node service manager", async () => {
    const program = createProgram();

    await program.parseAsync(["node", "start", "--json"], { from: "user" });

    expect(daemonMocks.runNodeDaemonStart.mock.calls[0]?.[0]?.json).toBe(true);
  });

  it("rejects an explicit invalid node run port", async () => {
    const program = createProgram();

    await program.parseAsync(["node", "run", "--port", "abc"], { from: "user" });

    expect(daemonMocks.runNodeHost).not.toHaveBeenCalled();
    expect(daemonMocks.defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("Invalid --port"),
    );
    expect(daemonMocks.defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("uses an explicit valid node run port", async () => {
    const program = createProgram();

    await program.parseAsync(["node", "run", "--port", "19000"], { from: "user" });

    expect(daemonMocks.runNodeHost).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayPort: 19000 }),
    );
  });

  it("falls back to configured node run port when --port is omitted", async () => {
    daemonMocks.loadNodeHostConfig.mockResolvedValue({
      version: 1,
      nodeId: "node-existing",
      gateway: { host: "10.0.0.2", port: 19001 },
    });
    const program = createProgram();

    await program.parseAsync(["node", "run"], { from: "user" });

    expect(daemonMocks.runNodeHost).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayHost: "10.0.0.2", gatewayPort: 19001 }),
    );
  });

  it("inherits saved TLS settings only when using the saved gateway endpoint", async () => {
    daemonMocks.loadNodeHostConfig.mockResolvedValue({
      version: 1,
      nodeId: "node-existing",
      gateway: {
        host: "10.0.0.2",
        port: 19001,
        tls: true,
        tlsFingerprint: "old-fingerprint",
      },
    });

    await createProgram().parseAsync(["node", "run"], { from: "user" });
    expect(daemonMocks.runNodeHost).toHaveBeenLastCalledWith(
      expect.objectContaining({
        gatewayTls: true,
        gatewayTlsFingerprint: "old-fingerprint",
      }),
    );

    await createProgram().parseAsync(["node", "run", "--host", "10.0.0.3"], { from: "user" });
    expect(daemonMocks.runNodeHost).toHaveBeenLastCalledWith(
      expect.objectContaining({
        gatewayHost: "10.0.0.3",
        gatewayTls: undefined,
        gatewayTlsFingerprint: undefined,
      }),
    );
  });
});
