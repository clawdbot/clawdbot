import { beforeEach, describe, expect, it, vi } from "vitest";
import { maybeInstallDaemon } from "./configure.daemon.js";

const progressSetLabel = vi.hoisted(() => vi.fn());
const withProgress = vi.hoisted(() =>
  vi.fn(async (_opts, run) => run({ setLabel: progressSetLabel })),
);
const loadConfig = vi.hoisted(() => vi.fn());
const resolveGatewayInstallToken = vi.hoisted(() => vi.fn());
const buildGatewayInstallPlan = vi.hoisted(() => vi.fn());
const note = vi.hoisted(() => vi.fn());
const serviceIsLoaded = vi.hoisted(() => vi.fn(async () => false));
const serviceInstall = vi.hoisted(() => vi.fn(async () => {}));
const serviceRestart = vi.hoisted(() =>
  vi.fn<() => Promise<{ outcome: "completed" } | { outcome: "scheduled" }>>(async () => ({
    outcome: "completed",
  })),
);
const ensureSystemdUserLingerInteractive = vi.hoisted(() => vi.fn(async () => {}));
const select = vi.hoisted(() => vi.fn(async () => "node"));

vi.mock("../cli/progress.js", () => ({
  withProgress,
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: loadConfig,
  loadConfig,
}));

vi.mock("./gateway-install-token.js", () => ({
  resolveGatewayInstallToken,
}));

vi.mock("./daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan,
  gatewayInstallErrorHint: vi.fn(() => "hint"),
}));

vi.mock("../terminal/note.js", () => ({
  note,
}));

vi.mock("./configure.shared.js", () => ({
  confirm: vi.fn(async () => true),
  select,
}));

vi.mock("./daemon-runtime.js", () => ({
  DEFAULT_GATEWAY_DAEMON_RUNTIME: "node",
  GATEWAY_DAEMON_RUNTIME_OPTIONS: [{ value: "node", label: "Node" }],
}));

vi.mock("../daemon/service.js", async () => {
  const actual =
    await vi.importActual<typeof import("../daemon/service.js")>("../daemon/service.js");
  return {
    ...actual,
    resolveGatewayService: vi.fn(() => ({
      isLoaded: serviceIsLoaded,
      install: serviceInstall,
      restart: serviceRestart,
    })),
  };
});

vi.mock("./onboard-helpers.js", () => ({
  guardCancel: (value: unknown) => value,
}));

vi.mock("./systemd-linger.js", () => ({
  ensureSystemdUserLingerInteractive,
}));

describe("maybeInstallDaemon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    progressSetLabel.mockReset();
    serviceIsLoaded.mockResolvedValue(false);
    serviceInstall.mockResolvedValue(undefined);
    serviceRestart.mockResolvedValue({ outcome: "completed" });
    loadConfig.mockReturnValue({});
    resolveGatewayInstallToken.mockResolvedValue({
      token: undefined,
      tokenRefConfigured: true,
      warnings: [],
    });
    buildGatewayInstallPlan.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "run"],
      workingDirectory: "/tmp",
      environment: {},
    });
  });

  it("does not serialize SecretRef token into service environment", async () => {
    await maybeInstallDaemon({
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      port: 18789,
    });

    expect(resolveGatewayInstallToken).toHaveBeenCalledTimes(1);
    expect(buildGatewayInstallPlan).toHaveBeenCalledTimes(1);
    expect("token" in buildGatewayInstallPlan.mock.calls.at(0)?.[0]).toBe(false);
    expect(serviceInstall).toHaveBeenCalledTimes(1);
  });

  it("blocks install when token SecretRef is unresolved", async () => {
    resolveGatewayInstallToken.mockResolvedValue({
      token: undefined,
      tokenRefConfigured: true,
      unavailableReason: "gateway.auth.token SecretRef is configured but unresolved (boom).",
      warnings: [],
    });

    await maybeInstallDaemon({
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      port: 18789,
    });

    expect(note).toHaveBeenCalledWith(
      "Gateway service install failed: Gateway install blocked: gateway.auth.token SecretRef is configured but unresolved (boom). Fix gateway auth config/token input and rerun configure.",
      "Gateway",
    );
    expect(buildGatewayInstallPlan).not.toHaveBeenCalled();
    expect(serviceInstall).not.toHaveBeenCalled();
  });

  it("continues daemon install flow when service status probe throws", async () => {
    serviceIsLoaded.mockRejectedValueOnce(
      new Error("systemctl is-enabled unavailable: Failed to connect to bus"),
    );

    await expect(
      maybeInstallDaemon({
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        port: 18789,
      }),
    ).resolves.toBeUndefined();

    expect(serviceInstall).toHaveBeenCalledTimes(1);
  });

  it("rethrows install probe failures that are not the known non-fatal Linux systemd cases", async () => {
    serviceIsLoaded.mockRejectedValueOnce(
      new Error("systemctl is-enabled unavailable: read-only file system"),
    );

    await expect(
      maybeInstallDaemon({
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        port: 18789,
      }),
    ).rejects.toThrow("systemctl is-enabled unavailable: read-only file system");

    expect(serviceInstall).not.toHaveBeenCalled();
  });

  it("continues the WSL2 daemon install flow when service status probe reports systemd unavailability", async () => {
    serviceIsLoaded.mockRejectedValueOnce(
      new Error("systemctl --user unavailable: Failed to connect to bus: No medium found"),
    );

    await expect(
      maybeInstallDaemon({
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        port: 18789,
      }),
    ).resolves.toBeUndefined();

    expect(serviceInstall).toHaveBeenCalledTimes(1);
  });

  it("shows restart scheduled when a loaded service defers restart handoff", async () => {
    serviceIsLoaded.mockResolvedValue(true);
    select.mockResolvedValueOnce("restart");
    serviceRestart.mockResolvedValueOnce({ outcome: "scheduled" });

    await maybeInstallDaemon({
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      port: 18789,
    });

    expect(serviceRestart).toHaveBeenCalledTimes(1);
    expect(serviceInstall).not.toHaveBeenCalled();
    expect(progressSetLabel).toHaveBeenLastCalledWith("Gateway service restart scheduled.");
  });
});
