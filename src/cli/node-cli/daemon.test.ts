// Node daemon tests cover node daemon command runtime behavior and errors.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service-types.js";
import { runNodeDaemonInstall, runNodeDaemonStatus } from "./daemon.js";

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
    loadNodeHostConfig: vi.fn(),
    isSystemdUserServiceAvailable: vi.fn(async () => true),
    resolveSystemdUserServiceAccount: vi.fn(() => "pi"),
    readSystemdUserLingerStatus: vi.fn(
      async (): Promise<{ user: string; linger: "yes" | "no" }> => ({
        user: "pi",
        linger: "no",
      }),
    ),
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

vi.mock("../../daemon/runtime-hints.js", () => ({
  buildPlatformRuntimeLogHints: () => [
    "Logs: node service log",
    "Restart attempts: node restart log",
  ],
  buildPlatformServiceStartHints: () => ["openclaw node install", "openclaw node start"],
}));

vi.mock("../../daemon/systemd.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../daemon/systemd.js")>("../../daemon/systemd.js");
  return {
    ...actual,
    isSystemdUserServiceAvailable: mocks.isSystemdUserServiceAvailable,
    resolveSystemdUserServiceAccount: mocks.resolveSystemdUserServiceAccount,
    readSystemdUserLingerStatus: mocks.readSystemdUserLingerStatus,
  };
});

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
    failIfNixDaemonInstallMode: () => false,
  };
});

describe("runNodeDaemonInstall", () => {
  beforeEach(() => {
    mocks.runtime.log.mockClear();
    mocks.runtime.error.mockClear();
    mocks.runtime.writeJson.mockClear();
    mocks.runtime.exit.mockClear();
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
    mocks.isSystemdUserServiceAvailable.mockReset().mockResolvedValue(true);
    mocks.resolveSystemdUserServiceAccount.mockReset().mockReturnValue("pi");
    mocks.readSystemdUserLingerStatus.mockReset().mockResolvedValue({
      user: "pi",
      linger: "no",
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

  it("warns about disabled systemd lingering after a fresh install (text mode)", async () => {
    // isLoaded=true so the service-load verification passes and the linger
    // diagnostic runs on the verified-success path.
    mocks.service.isLoaded.mockResolvedValue(true);
    await runNodeDaemonInstall({ force: true });

    expect(mocks.readSystemdUserLingerStatus).toHaveBeenCalled();
    expect(mocks.runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("sudo loginctl enable-linger pi"),
    );
  });

  it("checks lingering for the same sudo target user as the systemd service", async () => {
    mocks.service.isLoaded.mockResolvedValue(true);
    mocks.resolveSystemdUserServiceAccount.mockReturnValue("debian");
    mocks.readSystemdUserLingerStatus.mockResolvedValue({ user: "debian", linger: "no" });

    await runNodeDaemonInstall({ force: true });

    expect(mocks.resolveSystemdUserServiceAccount).toHaveBeenCalledWith(process.env);
    expect(mocks.readSystemdUserLingerStatus).toHaveBeenCalledWith({
      env: process.env,
      user: "debian",
    });
    expect(mocks.runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("sudo loginctl enable-linger debian"),
    );
  });

  it("includes the linger warning in JSON warnings after a fresh install", async () => {
    mocks.service.isLoaded.mockResolvedValue(true);
    await runNodeDaemonInstall({ force: true, json: true });

    expect(mocks.runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        warnings: expect.arrayContaining([expect.stringContaining("enable-linger pi")]),
      }),
    );
  });

  it("warns about disabled lingering on the already-installed short-circuit path", async () => {
    mocks.service.isLoaded.mockResolvedValue(true);
    await runNodeDaemonInstall({ force: false });

    expect(mocks.readSystemdUserLingerStatus).toHaveBeenCalled();
    expect(mocks.runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("sudo loginctl enable-linger pi"),
    );
  });

  it("does not warn when systemd lingering is already enabled", async () => {
    mocks.service.isLoaded.mockResolvedValue(true);
    mocks.readSystemdUserLingerStatus.mockResolvedValue({ user: "pi", linger: "yes" });
    await runNodeDaemonInstall({ force: true });

    expect(mocks.runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("enable-linger"));
  });

  it("does not pollute the failure output when service.install throws", async () => {
    mocks.service.isLoaded.mockResolvedValue(true);
    mocks.service.install.mockRejectedValue(new Error("disk full"));
    await runNodeDaemonInstall({ force: true, json: true });

    // install() threw before verification, so onVerified never runs and no
    // linger warning accompanies the install-failure payload.
    const calls = mocks.runtime.writeJson.mock.calls;
    const failurePayload = calls
      .map(([payload]) => payload as { ok?: boolean; error?: string; warnings?: string[] })
      .find((payload) => payload.ok === false);
    expect(failurePayload).toBeDefined();
    expect(failurePayload?.error).toContain("install failed");
    expect(failurePayload?.warnings ?? []).toEqual(
      expect.not.arrayContaining([expect.stringContaining("enable-linger")]),
    );
  });

  it("does not warn when service-load verification fails (regression for #107033 review)", async () => {
    // install() succeeded but the service is not loaded: the linger diagnostic
    // must NOT run, so a failed verification never tells the operator to fix
    // lingering for a service that was not successfully installed.
    mocks.service.isLoaded.mockResolvedValue(false);
    await runNodeDaemonInstall({ force: true, json: true });

    expect(mocks.readSystemdUserLingerStatus).not.toHaveBeenCalled();
    const calls = mocks.runtime.writeJson.mock.calls;
    const failurePayload = calls
      .map(([payload]) => payload as { ok?: boolean; error?: string; warnings?: string[] })
      .find((payload) => payload.ok === false);
    expect(failurePayload).toBeDefined();
    expect(failurePayload?.error).toContain("verification failed");
    expect(failurePayload?.warnings ?? []).toEqual(
      expect.not.arrayContaining([expect.stringContaining("enable-linger")]),
    );
  });

  it("skips the linger check when systemd user services are unavailable", async () => {
    mocks.service.isLoaded.mockResolvedValue(true);
    mocks.isSystemdUserServiceAvailable.mockResolvedValue(false);
    await runNodeDaemonInstall({ force: true });

    expect(mocks.readSystemdUserLingerStatus).not.toHaveBeenCalled();
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
