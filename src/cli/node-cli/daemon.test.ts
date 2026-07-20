// Node daemon tests cover node daemon command runtime behavior and errors.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service-types.js";
import {
  runNodeDaemonInstall,
  runNodeDaemonRestart,
  runNodeDaemonStart,
  runNodeDaemonStatus,
  runNodeDaemonStop,
  runNodeDaemonUninstall,
} from "./daemon.js";

const mocks = vi.hoisted(() => {
  const service = {
    label: "Node service",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    stage: vi.fn(),
    install: vi.fn(),
    uninstall: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    isLoaded: vi.fn(async () => true),
    readCommand: vi.fn<() => Promise<GatewayServiceCommandConfig | null>>(async () => null),
    readRuntime: vi.fn<() => Promise<GatewayServiceRuntime>>(async () => ({ status: "running" })),
  };
  return {
    runtime: {
      log: vi.fn<(line: string) => void>(),
      error: vi.fn<(line: string) => void>(),
      writeJson: vi.fn(),
      exit: vi.fn(),
    },
    service,
    buildNodeInstallPlan: vi.fn(async () => ({
      programArguments: ["node", "node-host"],
      environment: {},
      environmentValueSources: {},
    })),
    failIfNixDaemonInstallMode: vi.fn(() => false),
    loadNodeHostConfig: vi.fn(),
    runServiceRestart: vi.fn(),
    runServiceStart: vi.fn(),
    runServiceStop: vi.fn(),
    runServiceUninstall: vi.fn(),
  };
});

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

vi.mock("../../daemon/node-service.js", () => ({
  resolveNodeService: () => mocks.service,
}));

vi.mock("../../commands/node-daemon-install-helpers.js", () => ({
  buildNodeInstallPlan: mocks.buildNodeInstallPlan,
}));

vi.mock("../../node-host/config.js", () => ({
  loadNodeHostConfig: mocks.loadNodeHostConfig,
}));

vi.mock("../daemon-cli/lifecycle-core.js", () => ({
  runServiceRestart: mocks.runServiceRestart,
  runServiceStart: mocks.runServiceStart,
  runServiceStop: mocks.runServiceStop,
  runServiceUninstall: mocks.runServiceUninstall,
}));

vi.mock("../../daemon/runtime-hints.js", () => ({
  buildPlatformRuntimeLogHints: () => [
    "Logs: node service log",
    "Restart attempts: node restart log",
  ],
  buildPlatformServiceStartHints: () => ["openclaw node install", "openclaw node start"],
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

vi.mock("../daemon-cli/shared.js", async () => {
  const actual =
    await vi.importActual<typeof import("../daemon-cli/shared.js")>("../daemon-cli/shared.js");
  return {
    ...actual,
    createCliStatusTextStyles: () => ({
      rich: false,
      label: (text: string) => text,
      accent: (text: string) => text,
      infoText: (text: string) => text,
      okText: (text: string) => text,
      warnText: (text: string) => text,
      errorText: (text: string) => text,
    }),
    formatRuntimeStatus: (runtime: GatewayServiceRuntime | undefined) => runtime?.status ?? "",
    resolveRuntimeStatusColor: () => "",
    failIfNixDaemonInstallMode: mocks.failIfNixDaemonInstallMode,
  };
});

describe("runNodeDaemonInstall", () => {
  beforeEach(() => {
    mocks.runtime.log.mockClear();
    mocks.runtime.error.mockClear();
    mocks.runtime.writeJson.mockClear();
    mocks.runtime.exit.mockClear();
    mocks.failIfNixDaemonInstallMode.mockReset().mockReturnValue(false);
    mocks.service.install.mockReset().mockResolvedValue(undefined);
    mocks.service.isLoaded.mockReset().mockResolvedValue(false);
    mocks.buildNodeInstallPlan.mockReset().mockResolvedValue({
      programArguments: ["node", "node-host"],
      environment: {},
      environmentValueSources: {},
    });
    mocks.loadNodeHostConfig.mockReset().mockResolvedValue({
      gateway: {
        host: "saved-gateway.local",
        port: 18789,
        contextPath: "/saved",
        tls: true,
        tlsFingerprint: "saved-fingerprint",
      },
    });
  });

  it.each([
    ["host", { host: "new-gateway.local" }],
    ["port", { port: 19_001 }],
  ])("does not inherit saved TLS when %s explicitly retargets the gateway", async (_name, opts) => {
    await runNodeDaemonInstall({ ...opts, force: true });

    expect(mocks.buildNodeInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        contextPath: undefined,
        tls: false,
        tlsFingerprint: undefined,
      }),
    );
  });

  it("inherits saved TLS when the gateway endpoint is unchanged", async () => {
    await runNodeDaemonInstall({ force: true });

    expect(mocks.buildNodeInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "saved-gateway.local",
        port: 18789,
        contextPath: "/saved",
        tls: true,
        tlsFingerprint: "saved-fingerprint",
      }),
    );
  });

  it.each([
    ["host", { host: "saved-gateway.local" }],
    ["port", { port: 18_789 }],
  ])("keeps saved TLS when explicit %s resolves to the saved endpoint", async (_name, opts) => {
    await runNodeDaemonInstall({ ...opts, force: true });

    expect(mocks.buildNodeInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        contextPath: "/saved",
        tls: true,
        tlsFingerprint: "saved-fingerprint",
      }),
    );
  });

  it("installs an explicitly plaintext node for a saved TLS gateway", async () => {
    await runNodeDaemonInstall({ force: true, tls: false });

    expect(mocks.buildNodeInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "saved-gateway.local",
        port: 18789,
        contextPath: "/saved",
        tls: false,
        tlsFingerprint: undefined,
      }),
    );
  });

  it("rejects a TLS fingerprint when installing an explicitly plaintext node", async () => {
    await runNodeDaemonInstall({ force: true, tls: false, tlsFingerprint: "new-fingerprint" });

    expect(mocks.buildNodeInstallPlan).not.toHaveBeenCalled();
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("--no-tls cannot be combined with --tls-fingerprint"),
    );
  });

  it("rejects an invalid explicit port", async () => {
    await runNodeDaemonInstall({ port: "abc" });

    expect(mocks.runtime.error).toHaveBeenCalledWith(expect.stringContaining("Invalid --port"));
    expect(mocks.service.install).not.toHaveBeenCalled();
  });

  it("rejects an invalid saved gateway port", async () => {
    mocks.loadNodeHostConfig.mockResolvedValue({
      gateway: { host: "127.0.0.1", port: 0 },
    });

    await runNodeDaemonInstall({});

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Invalid node.gateway.port"),
    );
    expect(mocks.service.install).not.toHaveBeenCalled();
  });

  it("rejects an unsupported service runtime", async () => {
    await runNodeDaemonInstall({ runtime: "deno" });

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining('Invalid --runtime (use "node"'),
    );
    expect(mocks.service.install).not.toHaveBeenCalled();
  });

  it("returns already-installed without replacing a loaded service", async () => {
    mocks.service.isLoaded.mockResolvedValue(true);

    await runNodeDaemonInstall({ json: true });

    expect(mocks.runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, result: "already-installed" }),
    );
    expect(mocks.buildNodeInstallPlan).not.toHaveBeenCalled();
    expect(mocks.service.install).not.toHaveBeenCalled();
  });

  it("replaces a loaded service when force is set", async () => {
    mocks.service.isLoaded.mockResolvedValue(true);

    await runNodeDaemonInstall({ force: true });

    expect(mocks.buildNodeInstallPlan).toHaveBeenCalledTimes(1);
    expect(mocks.service.install).toHaveBeenCalledTimes(1);
  });

  it("uses the default gateway endpoint when no saved config exists", async () => {
    mocks.loadNodeHostConfig.mockResolvedValue(null);

    await runNodeDaemonInstall({ force: true });

    expect(mocks.buildNodeInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({ host: "127.0.0.1", port: 18789 }),
    );
  });

  it("does not build or install a service in Nix daemon mode", async () => {
    mocks.failIfNixDaemonInstallMode.mockReturnValue(true);

    await runNodeDaemonInstall({});

    expect(mocks.buildNodeInstallPlan).not.toHaveBeenCalled();
    expect(mocks.service.install).not.toHaveBeenCalled();
  });
});

describe("node daemon lifecycle commands", () => {
  beforeEach(() => {
    mocks.runServiceRestart.mockReset();
    mocks.runServiceStart.mockReset();
    mocks.runServiceStop.mockReset();
    mocks.runServiceUninstall.mockReset();
  });

  it("delegates start with node service hints", async () => {
    await runNodeDaemonStart({ json: true });

    expect(mocks.runServiceStart).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceNoun: "Node",
        renderStartHints: expect.any(Function),
        opts: { json: true },
      }),
    );
  });

  it("delegates stop to the node service", async () => {
    await runNodeDaemonStop({ json: true });

    expect(mocks.runServiceStop).toHaveBeenCalledWith(
      expect.objectContaining({ serviceNoun: "Node", opts: { json: true } }),
    );
  });

  it("delegates restart with node service hints", async () => {
    await runNodeDaemonRestart({ json: true });

    expect(mocks.runServiceRestart).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceNoun: "Node",
        renderStartHints: expect.any(Function),
        opts: { json: true },
      }),
    );
  });

  it("delegates uninstall without gateway-specific postconditions", async () => {
    await runNodeDaemonUninstall({ json: true });

    expect(mocks.runServiceUninstall).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceNoun: "Node",
        opts: { json: true },
        stopBeforeUninstall: false,
        assertNotLoadedAfterUninstall: false,
      }),
    );
  });
});

describe("runNodeDaemonStatus", () => {
  function stdout(): string {
    return mocks.runtime.log.mock.calls.map(([line]) => line).join("\n");
  }

  function stderr(): string {
    return mocks.runtime.error.mock.calls.map(([line]) => line).join("\n");
  }

  beforeEach(() => {
    mocks.runtime.log.mockClear();
    mocks.runtime.error.mockClear();
    mocks.runtime.writeJson.mockClear();
    mocks.runtime.exit.mockClear();
    mocks.service.isLoaded.mockReset().mockResolvedValue(true);
    mocks.service.readCommand.mockReset().mockResolvedValue(null);
    mocks.service.readRuntime.mockReset().mockResolvedValue({ status: "running" });
  });

  it("reports a failed service check instead of claiming the node is not installed", async () => {
    mocks.service.isLoaded.mockRejectedValue(new Error("systemd unavailable"));

    await runNodeDaemonStatus();

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      "Node service check failed: Error: systemd unavailable",
    );
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
    expect(stdout()).not.toContain("not loaded");
    expect(stdout()).not.toContain("openclaw node install");
  });

  it("includes command and runtime details in JSON output", async () => {
    mocks.service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "node", "run"],
      sourcePath: "/tmp/ai.openclaw.node.plist",
    });
    mocks.service.readRuntime.mockResolvedValue({ status: "running" });

    await runNodeDaemonStatus({ json: true });

    expect(mocks.runtime.writeJson).toHaveBeenCalledWith({
      service: expect.objectContaining({
        loaded: true,
        command: expect.objectContaining({
          programArguments: ["openclaw", "node", "run"],
          sourcePath: "/tmp/ai.openclaw.node.plist",
        }),
        runtime: { status: "running" },
      }),
    });
  });

  it("prints start hints when the service is not loaded", async () => {
    mocks.service.isLoaded.mockResolvedValue(false);

    await runNodeDaemonStatus();

    expect(stdout()).toContain("openclaw node start");
  });

  it("reports an unknown runtime when runtime inspection fails", async () => {
    mocks.service.readRuntime.mockRejectedValue(new Error("permission denied"));

    await runNodeDaemonStatus({ json: true });

    expect(mocks.runtime.writeJson).toHaveBeenCalledWith({
      service: expect.objectContaining({
        runtime: { status: "unknown", detail: "Error: permission denied" },
      }),
    });
  });

  it("reports a failed service check as JSON without inventing node status", async () => {
    mocks.service.isLoaded.mockRejectedValue(new Error("systemd unavailable"));

    await runNodeDaemonStatus({ json: true });

    expect(mocks.runtime.writeJson).toHaveBeenCalledWith({
      error: "Node service check failed: Error: systemd unavailable",
    });
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.runtime.error).not.toHaveBeenCalled();
  });

  it("keeps missing service-unit status on stderr and prints recovery hints on stdout", async () => {
    mocks.service.readRuntime.mockResolvedValue({ status: "stopped", missingUnit: true });

    await runNodeDaemonStatus();

    expect(stderr()).toContain("Service unit not found.");
    expect(stdout()).toContain("Logs: node service log");
    expect(stdout()).toContain("Restart attempts: node restart log");
    expect(stderr()).not.toContain("Logs: node service log");
    expect(stderr()).not.toContain("Restart attempts: node restart log");
  });

  it("keeps stopped status on stderr and prints recovery hints on stdout", async () => {
    mocks.service.readRuntime.mockResolvedValue({ status: "stopped" });

    await runNodeDaemonStatus();

    expect(stderr()).toContain("Service is loaded but not running.");
    expect(stdout()).toContain("Logs: node service log");
    expect(stdout()).toContain("Restart attempts: node restart log");
    expect(stderr()).not.toContain("Logs: node service log");
    expect(stderr()).not.toContain("Restart attempts: node restart log");
  });

  it("redacts service credentials from JSON status output", async () => {
    mocks.service.readCommand.mockResolvedValue({
      programArguments: ["node", "node-host"],
      environment: {
        OPENCLAW_PROFILE: "work",
        OPENCLAW_GATEWAY_TOKEN: "gateway-token",
        OPENCLAW_GATEWAY_PASSWORD: "gateway-password",
      },
    });

    await runNodeDaemonStatus({ json: true });

    expect(mocks.runtime.writeJson).toHaveBeenCalledWith({
      service: expect.objectContaining({
        command: expect.objectContaining({
          environment: { OPENCLAW_PROFILE: "work" },
        }),
      }),
    });
    const payload = JSON.stringify(mocks.runtime.writeJson.mock.calls[0]?.[0]);
    expect(payload).not.toContain("gateway-token");
    expect(payload).not.toContain("gateway-password");
  });
});
