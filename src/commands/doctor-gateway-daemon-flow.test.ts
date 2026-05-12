import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { formatCliCommand } from "../cli/command-format.js";
import type { ExtraGatewayService } from "../daemon/inspect.js";
import * as launchd from "../daemon/launchd.js";
import type { GatewayRestartHandoff } from "../infra/restart-handoff.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createDoctorPrompter } from "./doctor-prompter.js";
import {
  EXTERNAL_SERVICE_REPAIR_NOTE,
  SERVICE_REPAIR_POLICY_ENV,
} from "./doctor-service-repair-policy.js";

const service = vi.hoisted(() => ({
  isLoaded: vi.fn(),
  readRuntime: vi.fn(),
  restart: vi.fn(),
  stage: vi.fn(),
  install: vi.fn(),
  readCommand: vi.fn(),
}));
const note = vi.hoisted(() => vi.fn());
const sleep = vi.hoisted(() => vi.fn(async () => {}));
const healthCommand = vi.hoisted(() => vi.fn(async () => {}));
const inspectPortUsage = vi.hoisted(() => vi.fn());
const formatPortDiagnostics = vi.hoisted(() => vi.fn(() => ["Port 18789 is already in use."]));
const isExpectedGatewayListeners = vi.hoisted(() => vi.fn(() => false));
const readLastGatewayErrorLine = vi.hoisted(() => vi.fn(async () => null));
const readGatewayRestartHandoffSync = vi.hoisted(() =>
  vi.fn<() => GatewayRestartHandoff | null>(() => null),
);
const findSystemGatewayServices = vi.hoisted(() =>
  vi.fn<() => Promise<ExtraGatewayService[]>>(async () => []),
);

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    resolveGatewayPort: vi.fn(() => 18789),
  };
});

vi.mock("../daemon/constants.js", () => ({
  resolveGatewayLaunchAgentLabel: vi.fn(() => "ai.openclaw.gateway"),
  resolveNodeLaunchAgentLabel: vi.fn(() => "ai.openclaw.node"),
}));

vi.mock("../daemon/diagnostics.js", () => ({
  readLastGatewayErrorLine,
}));

vi.mock("../daemon/launchd.js", async () => {
  const actual =
    await vi.importActual<typeof import("../daemon/launchd.js")>("../daemon/launchd.js");
  return {
    ...actual,
    isLaunchAgentListed: vi.fn(async () => false),
    isLaunchAgentLoaded: vi.fn(async () => false),
    launchAgentPlistExists: vi.fn(async () => false),
    repairLaunchAgentBootstrap: vi.fn(async () => ({ ok: true, status: "repaired" })),
  };
});

vi.mock("../daemon/inspect.js", () => ({
  findSystemGatewayServices,
}));

vi.mock("../daemon/service.js", async () => {
  const actual =
    await vi.importActual<typeof import("../daemon/service.js")>("../daemon/service.js");
  return {
    ...actual,
    resolveGatewayService: () => service,
  };
});

vi.mock("../daemon/systemd-hints.js", () => ({
  renderSystemdUnavailableHints: vi.fn(() => []),
}));

vi.mock("../daemon/systemd.js", async () => {
  const actual =
    await vi.importActual<typeof import("../daemon/systemd.js")>("../daemon/systemd.js");
  return {
    ...actual,
    isSystemdUserServiceAvailable: vi.fn(async () => true),
  };
});

vi.mock("../infra/ports.js", () => ({
  inspectPortUsage,
  formatPortDiagnostics,
  isExpectedGatewayListeners,
}));

vi.mock("../infra/restart-handoff.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/restart-handoff.js")>(
    "../infra/restart-handoff.js",
  );
  return {
    ...actual,
    readGatewayRestartHandoffSync,
  };
});

vi.mock("../infra/wsl.js", () => ({
  isWSL: vi.fn(async () => false),
}));

vi.mock("../terminal/note.js", () => ({
  note,
}));

vi.mock("../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../utils.js")>("../utils.js");
  return {
    ...actual,
    sleep,
  };
});

vi.mock("./daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan: vi.fn(),
  gatewayInstallErrorHint: vi.fn(() => "hint"),
}));

vi.mock("./doctor-format.js", () => ({
  buildGatewayRuntimeHints: vi.fn(() => []),
  formatGatewayRuntimeSummary: vi.fn(() => null),
}));

vi.mock("./gateway-install-token.js", () => ({
  resolveGatewayInstallToken: vi.fn(),
}));

vi.mock("./health-format.js", () => ({
  formatHealthCheckFailure: vi.fn(() => "health failed"),
}));

vi.mock("./health.js", () => ({
  healthCommand,
}));

describe("maybeRepairGatewayDaemon", () => {
  let maybeRepairGatewayDaemon: typeof import("./doctor-gateway-daemon-flow.js").maybeRepairGatewayDaemon;
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const originalUpdateInProgress = process.env.OPENCLAW_UPDATE_IN_PROGRESS;

  beforeAll(async () => {
    ({ maybeRepairGatewayDaemon } = await import("./doctor-gateway-daemon-flow.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    service.isLoaded.mockResolvedValue(true);
    service.readRuntime.mockResolvedValue({ status: "running" });
    service.readCommand.mockResolvedValue(null);
    service.restart.mockResolvedValue({ outcome: "completed" });
    readGatewayRestartHandoffSync.mockReturnValue(null);
    findSystemGatewayServices.mockResolvedValue([]);
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "free",
      listeners: [],
      hints: [],
    });
    isExpectedGatewayListeners.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
    if (originalUpdateInProgress === undefined) {
      delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
    } else {
      process.env.OPENCLAW_UPDATE_IN_PROGRESS = originalUpdateInProgress;
    }
  });

  function setPlatform(platform: NodeJS.Platform) {
    if (!originalPlatformDescriptor) {
      return;
    }
    Object.defineProperty(process, "platform", {
      ...originalPlatformDescriptor,
      value: platform,
    });
  }

  function createPrompter(confirmImpl: (message: string) => boolean) {
    return {
      confirm: vi.fn(),
      confirmAutoFix: vi.fn(),
      confirmAggressiveAutoFix: vi.fn(),
      confirmRuntimeRepair: vi.fn(async ({ message }: { message: string }) => confirmImpl(message)),
      select: vi.fn(),
      shouldRepair: false,
      shouldForce: false,
      repairMode: {
        shouldRepair: false,
        shouldForce: false,
        nonInteractive: false,
        canPrompt: true,
        updateInProgress: false,
      },
    };
  }

  async function runNonInteractiveUpdateRepair() {
    process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
    await runNonInteractiveRepair();
  }

  async function runNonInteractiveRepair() {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    await maybeRepairGatewayDaemon({
      cfg: { gateway: {} },
      runtime,
      prompter: createDoctorPrompter({
        runtime,
        options: { repair: true, nonInteractive: true },
      }),
      options: { deep: false, repair: true, nonInteractive: true },
      gatewayDetailsMessage: "details",
      healthOk: false,
    });
  }

  async function runAutoRepair() {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    await maybeRepairGatewayDaemon({
      cfg: { gateway: {} },
      runtime,
      prompter: createDoctorPrompter({
        runtime,
        options: { repair: true },
      }),
      options: { deep: false, repair: true },
      gatewayDetailsMessage: "details",
      healthOk: false,
    });
    return runtime;
  }

  async function runScheduledGatewayRepairAndExpectVerificationSkipped(confirmMessage: string) {
    setPlatform("linux");
    service.restart.mockResolvedValueOnce({ outcome: "scheduled" });

    await maybeRepairGatewayDaemon({
      cfg: { gateway: {} },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      prompter: createPrompter((message) => message === confirmMessage),
      options: { deep: false },
      gatewayDetailsMessage: "details",
      healthOk: false,
    });

    expect(service.restart).toHaveBeenCalledTimes(1);
    expect(note).toHaveBeenCalledWith(
      "restart scheduled, gateway will restart momentarily",
      "Gateway",
    );
    expect(sleep).not.toHaveBeenCalled();
    expect(healthCommand).not.toHaveBeenCalled();
  }

  it("skips restart verification when a running service restart is only scheduled", async () => {
    await runScheduledGatewayRepairAndExpectVerificationSkipped("Restart gateway service now?");
  });

  it("reports recent restart handoffs during deep doctor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(40_000);
    setPlatform("linux");
    service.readCommand.mockResolvedValueOnce({
      programArguments: ["/bin/node", "cli", "gateway"],
      environment: {
        OPENCLAW_STATE_DIR: "/tmp/openclaw-service",
        OPENCLAW_CONFIG_PATH: "/tmp/openclaw-service/openclaw.json",
      },
    });
    readGatewayRestartHandoffSync.mockReturnValueOnce({
      kind: "gateway-supervisor-restart-handoff",
      version: 1,
      intentId: "intent-1",
      pid: 12_345,
      createdAt: 10_000,
      expiresAt: 70_000,
      reason: "plugin source changed",
      source: "plugin-change",
      restartKind: "full-process",
      supervisorMode: "systemd",
    });

    await maybeRepairGatewayDaemon({
      cfg: { gateway: {} },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      prompter: createDoctorPrompter({
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        options: { deep: true, nonInteractive: true },
      }),
      options: { deep: true, nonInteractive: true },
      gatewayDetailsMessage: "details",
      healthOk: false,
    });

    expect(readGatewayRestartHandoffSync).toHaveBeenCalledOnce();
    const [handoffEnv] = readGatewayRestartHandoffSync.mock.calls[0] as unknown as [
      { OPENCLAW_STATE_DIR?: string; OPENCLAW_CONFIG_PATH?: string },
    ];
    expect(handoffEnv?.OPENCLAW_STATE_DIR).toBe("/tmp/openclaw-service");
    expect(handoffEnv?.OPENCLAW_CONFIG_PATH).toBe("/tmp/openclaw-service/openclaw.json");
    expect(note).toHaveBeenCalledWith(
      "Recent restart handoff: full-process via systemd; source=plugin-change; reason=plugin source changed; pid=12345; age=30s; expiresIn=30s",
      "Gateway",
    );
  });

  it("does not read restart handoffs during normal doctor", async () => {
    setPlatform("linux");

    await runNonInteractiveRepair();

    expect(readGatewayRestartHandoffSync).not.toHaveBeenCalled();
  });

  it("suppresses busy-port note for expected Gateway listeners", async () => {
    setPlatform("linux");
    const listeners = [{ pid: 5001, commandLine: "openclaw-gateway", address: "0.0.0.0:18789" }];
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners,
      hints: [],
    });
    isExpectedGatewayListeners.mockReturnValue(true);

    await runNonInteractiveRepair();

    expect(isExpectedGatewayListeners).toHaveBeenCalledWith(listeners, 18789);
    expect(formatPortDiagnostics).not.toHaveBeenCalled();
    expect(note.mock.calls.some(([, label]) => label === "Gateway port")).toBe(false);
  });

  it("keeps busy-port note for unexpected Gateway listeners", async () => {
    setPlatform("linux");
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [
        { pid: 5001, commandLine: "openclaw-gateway", address: "0.0.0.0:18789" },
        { pid: 5002, commandLine: "openclaw-gateway", address: "127.0.0.1:18789" },
      ],
      hints: ["Multiple listeners detected"],
    });

    await runNonInteractiveRepair();

    expect(note).toHaveBeenCalledWith("Port 18789 is already in use.", "Gateway port");
  });

  it("skips start verification when a stopped service start is only scheduled", async () => {
    service.readRuntime.mockResolvedValue({ status: "stopped" });
    await runScheduledGatewayRepairAndExpectVerificationSkipped("Start gateway service now?");
  });

  it("skips gateway install during non-interactive update repairs", async () => {
    setPlatform("linux");
    service.isLoaded.mockResolvedValue(false);

    await runNonInteractiveUpdateRepair();

    expect(service.install).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
  });

  it("skips gateway install during non-interactive doctor repairs", async () => {
    setPlatform("linux");
    service.isLoaded.mockResolvedValue(false);

    await runNonInteractiveRepair();

    expect(service.install).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      `Run ${formatCliCommand("openclaw gateway install")} when you want to install the gateway service.`,
      "Gateway",
    );
  });

  it("skips gateway restart during non-interactive update repairs", async () => {
    setPlatform("linux");

    await runNonInteractiveUpdateRepair();

    expect(service.restart).not.toHaveBeenCalled();
  });

  it("skips gateway service install when service repair policy is external", async () => {
    setPlatform("linux");
    service.isLoaded.mockResolvedValue(false);

    await withEnvAsync({ OPENCLAW_SERVICE_REPAIR_POLICY: "external" }, async () => {
      await runAutoRepair();
    });

    expect(service.install).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(EXTERNAL_SERVICE_REPAIR_NOTE, "Gateway");
  });

  it("skips gateway service install when a system OpenClaw gateway service exists", async () => {
    setPlatform("linux");
    service.isLoaded.mockResolvedValue(false);
    findSystemGatewayServices.mockResolvedValue([
      {
        platform: "linux",
        label: "openclaw-gateway.service",
        detail: "unit: /etc/systemd/system/openclaw-gateway.service",
        scope: "system",
        marker: "openclaw",
        legacy: false,
      },
    ]);

    await runAutoRepair();

    expect(findSystemGatewayServices).toHaveBeenCalledTimes(1);
    expect(service.install).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      [
        "System-level OpenClaw gateway service detected while the user gateway service is not installed.",
        "- openclaw-gateway.service (unit: /etc/systemd/system/openclaw-gateway.service)",
        "OpenClaw will not install a second user-level gateway service automatically.",
        "Run `openclaw gateway status --deep` or `openclaw doctor --deep` to inspect duplicate services.",
        `Set ${SERVICE_REPAIR_POLICY_ENV}=external if a system supervisor owns the gateway lifecycle.`,
      ].join("\n"),
      "Gateway",
    );
  });

  it("skips gateway service start when service repair policy is external", async () => {
    setPlatform("linux");
    service.readRuntime.mockResolvedValue({ status: "stopped" });

    await withEnvAsync({ OPENCLAW_SERVICE_REPAIR_POLICY: "external" }, async () => {
      await runAutoRepair();
    });

    expect(service.restart).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(EXTERNAL_SERVICE_REPAIR_NOTE, "Gateway");
  });

  it("skips gateway service restart when service repair policy is external", async () => {
    setPlatform("linux");

    await withEnvAsync({ OPENCLAW_SERVICE_REPAIR_POLICY: "external" }, async () => {
      await runAutoRepair();
    });

    expect(service.restart).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(EXTERNAL_SERVICE_REPAIR_NOTE, "Gateway");
  });

  it("skips LaunchAgent bootstrap repair when service repair policy is external", async () => {
    setPlatform("darwin");
    service.isLoaded.mockResolvedValue(false);
    vi.mocked(launchd.isLaunchAgentLoaded).mockResolvedValue(false);
    vi.mocked(launchd.launchAgentPlistExists).mockResolvedValue(true);

    await withEnvAsync({ OPENCLAW_SERVICE_REPAIR_POLICY: "external" }, async () => {
      await runAutoRepair();
    });

    expect(launchd.repairLaunchAgentBootstrap).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(EXTERNAL_SERVICE_REPAIR_NOTE, "Gateway LaunchAgent");
  });
});
