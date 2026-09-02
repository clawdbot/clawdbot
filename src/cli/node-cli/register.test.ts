// Node CLI register tests cover node command registration and option wiring.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodePairingSetupCode } from "../../pairing/setup-code.js";
import { registerNodeCli } from "./register.js";

const PAIR_TLS_FINGERPRINT = "ab".repeat(32);
const EXPLICIT_TLS_FINGERPRINT = "cd".repeat(32);
const SAVED_TLS_FINGERPRINT = "ef".repeat(32);

type LoadNodeHostConfig = typeof import("../../node-host/config.js").loadNodeHostConfig;

const daemonMocks = vi.hoisted(() => ({
  defaultRuntime: {
    log: vi.fn(),
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

  it.each([
    ["status", daemonMocks.runNodeDaemonStatus],
    ["uninstall", daemonMocks.runNodeDaemonUninstall],
    ["stop", daemonMocks.runNodeDaemonStop],
    ["start", daemonMocks.runNodeDaemonStart],
    ["restart", daemonMocks.runNodeDaemonRestart],
  ])("registers node %s and forwards --json", async (command, action) => {
    const program = createProgram();

    await program.parseAsync(["node", command, "--json"], { from: "user" });

    expect(action.mock.calls[0]?.[0]?.json).toBe(true);
  });

  it("forwards node install options to the daemon adapter", async () => {
    const program = createProgram();

    await program.parseAsync(
      [
        "node",
        "install",
        "--port",
        "19000",
        "--host",
        "gateway.example",
        "--runtime",
        "bun",
        "--force",
        "--json",
      ],
      { from: "user" },
    );

    expect(daemonMocks.runNodeDaemonInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        port: "19000",
        host: "gateway.example",
        runtime: "bun",
        force: true,
        json: true,
      }),
    );
  });

  it.each(["run", "install"] as const)(
    "accepts exact command allowlists before or after node %s",
    async (leaf) => {
      const action = leaf === "run" ? daemonMocks.runNodeHost : daemonMocks.runNodeDaemonInstall;
      for (const args of [
        ["node", "--commands", "fixture.read,fixture.list", leaf],
        ["node", leaf, "--commands", "fixture.read", "--commands", "fixture.list,fixture.read"],
      ]) {
        await createProgram().parseAsync(args, { from: "user" });
        expect(action).toHaveBeenLastCalledWith(
          expect.objectContaining({
            commands: ["fixture.list", "fixture.read"],
          }),
        );
      }
    },
  );

  it("rejects empty command ids instead of silently widening the surface", async () => {
    await expect(
      createProgram().parseAsync(["node", "run", "--commands", "fixture.list,"], { from: "user" }),
    ).rejects.toThrow("non-empty command ids");
    expect(daemonMocks.runNodeHost).not.toHaveBeenCalled();
  });

  it.each(["run", "install"] as const)(
    "accepts --all-commands before or after node %s",
    async (leaf) => {
      const action = leaf === "run" ? daemonMocks.runNodeHost : daemonMocks.runNodeDaemonInstall;
      for (const args of [
        ["node", "--all-commands", leaf],
        ["node", leaf, "--all-commands"],
      ]) {
        await createProgram().parseAsync(args, { from: "user" });
        expect(action).toHaveBeenLastCalledWith(expect.objectContaining({ allCommands: true }));
      }
    },
  );

  it.each(["run", "install"] as const)(
    "rejects conflicting command selections for node %s",
    async (leaf) => {
      for (const args of [
        ["node", leaf, "--all-commands", "--commands", "fixture.read"],
        ["node", "--all-commands", leaf, "--commands", "fixture.read"],
        ["node", "--commands", "fixture.read", leaf, "--all-commands"],
        ["node", "--commands", "fixture.read", "--all-commands", leaf],
      ]) {
        await expect(createProgram().parseAsync(args, { from: "user" })).rejects.toThrow(
          /--all-commands.*--commands/,
        );
      }
      expect(daemonMocks.runNodeHost).not.toHaveBeenCalled();
      expect(daemonMocks.runNodeDaemonInstall).not.toHaveBeenCalled();
      expect(daemonMocks.loadNodeHostConfig).not.toHaveBeenCalled();
    },
  );

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

  it("hosts worker turns process-locally for an ephemeral node run", async () => {
    const program = createProgram();

    await program.parseAsync(["node", "run", "--ephemeral"], { from: "user" });

    expect(daemonMocks.runNodeHost).toHaveBeenCalledWith(
      expect.objectContaining({ forceWorkerRuns: true, ephemeral: true }),
    );
    const nodeCommand = program.commands.find((command) => command.name() === "node");
    const runCommand = nodeCommand?.commands.find((command) => command.name() === "run");
    expect(runCommand?.helpInformation()).not.toContain("--ephemeral");

    daemonMocks.runNodeHost.mockClear();
    await createProgram().parseAsync(["node", "run"], { from: "user" });
    expect(daemonMocks.runNodeHost.mock.calls[0]?.[0]).not.toHaveProperty("forceWorkerRuns");
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

  it("derives the node endpoint, TLS pin, and bootstrap credential from --pair", async () => {
    const setupCode = encodePairingSetupCode({
      url: "wss://gateway.example:8443/openclaw-gw",
      bootstrapToken: "bootstrap-123",
      tlsFingerprint: `sha256:${PAIR_TLS_FINGERPRINT.toUpperCase()}`,
    });

    await createProgram().parseAsync(["node", "run", "--pair", `oc-pair://${setupCode}`], {
      from: "user",
    });

    expect(daemonMocks.runNodeHost).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayHost: "gateway.example",
        gatewayPort: 8443,
        gatewayContextPath: "/openclaw-gw",
        gatewayTls: true,
        gatewayTlsFingerprint: PAIR_TLS_FINGERPRINT,
        gatewayCandidates: [
          {
            host: "gateway.example",
            port: 8443,
            contextPath: "/openclaw-gw",
            tls: true,
            tlsFingerprint: PAIR_TLS_FINGERPRINT,
          },
        ],
        gatewayBootstrapToken: "bootstrap-123",
        preferGatewayBootstrapToken: true,
      }),
    );
  });

  it("lets explicit gateway flags override --pair values", async () => {
    const setupCode = encodePairingSetupCode({
      url: "wss://paired.example:8443",
      bootstrapToken: "bootstrap-123",
      tlsFingerprint: `sha256:${PAIR_TLS_FINGERPRINT}`,
    });

    await createProgram().parseAsync(
      [
        "node",
        "run",
        "--pair",
        setupCode,
        "--host",
        "explicit.example",
        "--port",
        "19000",
        "--tls-fingerprint",
        `sha256:${EXPLICIT_TLS_FINGERPRINT}`,
      ],
      { from: "user" },
    );

    expect(daemonMocks.runNodeHost).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayHost: "explicit.example",
        gatewayPort: 19000,
        gatewayTls: true,
        gatewayTlsFingerprint: EXPLICIT_TLS_FINGERPRINT,
        gatewayCandidates: undefined,
        gatewayBootstrapToken: "bootstrap-123",
      }),
    );
  });

  it("rejects an invalid --pair value before loading node state", async () => {
    await createProgram().parseAsync(["node", "run", "--pair", "not-a-setup-code"], {
      from: "user",
    });

    expect(daemonMocks.runNodeHost).not.toHaveBeenCalled();
    expect(daemonMocks.loadNodeHostConfig).not.toHaveBeenCalled();
    expect(daemonMocks.defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("Invalid pairing setup"),
    );
  });

  it.each([
    ["host", ["--host", "10.0.0.2"]],
    ["port", ["--port", "19001"]],
  ])("preserves saved gateway settings when the explicit %s is unchanged", async (_name, args) => {
    daemonMocks.loadNodeHostConfig.mockResolvedValue({
      version: 1,
      nodeId: "node-existing",
      gateway: {
        host: "10.0.0.2",
        port: 19001,
        tls: true,
        tlsFingerprint: SAVED_TLS_FINGERPRINT,
        contextPath: "/saved",
      },
    });

    await createProgram().parseAsync(["node", "run", ...args], { from: "user" });

    expect(daemonMocks.runNodeHost).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayHost: "10.0.0.2",
        gatewayPort: 19001,
        gatewayTls: true,
        gatewayTlsFingerprint: SAVED_TLS_FINGERPRINT,
        gatewayContextPath: "/saved",
      }),
    );
  });

  it.each([
    ["host", ["--host", "10.0.0.3"]],
    ["port", ["--port", "19002"]],
  ])("clears saved gateway settings when the explicit %s changes", async (_name, args) => {
    daemonMocks.loadNodeHostConfig.mockResolvedValue({
      version: 1,
      nodeId: "node-existing",
      gateway: {
        host: "10.0.0.2",
        port: 19001,
        tls: true,
        tlsFingerprint: SAVED_TLS_FINGERPRINT,
        contextPath: "/saved",
      },
    });

    await createProgram().parseAsync(["node", "run", ...args], { from: "user" });

    expect(daemonMocks.runNodeHost).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayTls: undefined,
        gatewayTlsFingerprint: undefined,
        gatewayContextPath: undefined,
      }),
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
        tlsFingerprint: SAVED_TLS_FINGERPRINT,
      },
    });

    await createProgram().parseAsync(["node", "run"], { from: "user" });
    expect(daemonMocks.runNodeHost).toHaveBeenLastCalledWith(
      expect.objectContaining({
        gatewayTls: true,
        gatewayTlsFingerprint: SAVED_TLS_FINGERPRINT,
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

  it("passes an explicit plaintext selection to the node host", async () => {
    daemonMocks.loadNodeHostConfig.mockResolvedValue({
      version: 1,
      nodeId: "node-existing",
      gateway: {
        host: "10.0.0.2",
        port: 19001,
        tls: true,
        tlsFingerprint: SAVED_TLS_FINGERPRINT,
      },
    });

    await createProgram().parseAsync(["node", "run", "--no-tls"], { from: "user" });

    expect(daemonMocks.runNodeHost).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayTls: false,
        gatewayTlsFingerprint: undefined,
      }),
    );
  });

  it("rejects a TLS fingerprint with an explicit plaintext selection", async () => {
    await createProgram().parseAsync(
      ["node", "run", "--no-tls", "--tls-fingerprint", PAIR_TLS_FINGERPRINT],
      { from: "user" },
    );

    expect(daemonMocks.runNodeHost).not.toHaveBeenCalled();
    expect(daemonMocks.defaultRuntime.error).toHaveBeenCalledWith(
      "--no-tls cannot be combined with --tls-fingerprint",
    );
    expect(daemonMocks.defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("rejects an invalid --tls-fingerprint before starting the node host", async () => {
    await createProgram().parseAsync(["node", "run", "--tls-fingerprint", "sha256:abc123"], {
      from: "user",
    });

    expect(daemonMocks.runNodeHost).not.toHaveBeenCalled();
    expect(daemonMocks.defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("Invalid TLS fingerprint"),
    );
    expect(daemonMocks.defaultRuntime.exit).toHaveBeenCalledWith(1);
  });
});
