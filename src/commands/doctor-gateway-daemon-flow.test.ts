// Doctor gateway daemon flow tests cover managed service inspection, duplicate services, and repair prompts.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { formatCliCommand } from "../cli/command-format.js";
import type { ExtraGatewayService } from "../daemon/inspect.js";
import * as launchd from "../daemon/launchd.js";
import type { GatewayRestartHandoff } from "../infra/restart-handoff.js";
import { withEnvAsync } from "../test-utils/env.js";
import { buildGatewayInstallPlan } from "./daemon-install-helpers.js";
import { createDoctorPrompter } from "./doctor-prompter.js";
import {
  EXTERNAL_SERVICE_REPAIR_NOTE,
  SERVICE_REPAIR_POLICY_ENV,
} from "./doctor-service-repair-policy.js";
import { resolveGatewayInstallToken } from "./gateway-install-token.js";

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
const formatGatewayClosedDiagnostic = vi.hoisted(() => vi.fn((): string | undefined => undefined));
const inspectPortConnections = vi.hoisted(() => vi.fn());
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
const buildGatewayRuntimeHints = vi.hoisted(() => vi.fn((): string[] => []));
const formatGatewayRuntimeSummary = vi.hoisted(() => vi.fn((): string | null => null));
const renderSystemdUnavailableHints = vi.hoisted(() => vi.fn((): string[] => []));
const isDefaultInstallIdentity = vi.hoisted(() => vi.fn(() => true));
const isContainerEnvironment = vi.hoisted(() => vi.fn(() => false));
const findInstalledSystemdGatewayScope = vi.hoisted(() =>
  vi.fn<(typeof import("../daemon/systemd.js"))["findInstalledSystemdGatewayScope"]>(
    async () => null,
  ),
);
const resolveGatewayBindHost = vi.hoisted(() => vi.fn(async () => "127.0.0.1"));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    resolveGatewayPort: vi.fn(() => 18789),
  };
});

vi.mock("../config/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../config/paths.js")>("../config/paths.js");
  return { ...actual, isDefaultInstallIdentity };
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

vi.mock("../daemon/systemd.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/systemd.js")>()),
  findInstalledSystemdGatewayScope,
}));

vi.mock("../daemon/systemd-hints.js", () => ({
  renderSystemdUnavailableHints,
}));

vi.mock("../gateway/net.js", () => ({
  resolveGatewayBindHost,
  resolveGatewayRequiredListenHosts: (bindHost: string) =>
    bindHost === "100.64.0.40" ? [bindHost, "127.0.0.1"] : [bindHost],
}));

vi.mock("../infra/ports-inspect.js", () => ({
  inspectPortConnections,
  inspectPortUsage,
}));

vi.mock("../infra/container-environment.js", () => ({ isContainerEnvironment }));

vi.mock("../infra/ports-format.js", () => ({
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

vi.mock("../../packages/terminal-core/src/note.js", () => ({
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
  buildGatewayRuntimeHints,
  formatGatewayRuntimeSummary,
}));

vi.mock("./gateway-install-token.js", () => ({
  resolveGatewayInstallToken: vi.fn(),
}));

vi.mock("./health-format.js", () => ({
  formatGatewayClosedDiagnostic,
  formatHealthCheckFailure: vi.fn(() => "health failed"),
}));

vi.mock("./health.js", () => ({
  healthCommandNonExiting: healthCommand,
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
    formatGatewayClosedDiagnostic.mockReset();
    formatGatewayClosedDiagnostic.mockReturnValue(undefined);
    findInstalledSystemdGatewayScope.mockReset().mockResolvedValue(null);
    service.isLoaded.mockResolvedValue(true);
    service.readRuntime.mockResolvedValue({ status: "running" });
    service.readCommand.mockResolvedValue(null);
    service.restart.mockResolvedValue({ outcome: "completed" });
    isDefaultInstallIdentity.mockReturnValue(true);
    isContainerEnvironment.mockReturnValue(false);
    readGatewayRestartHandoffSync.mockReturnValue(null);
    findSystemGatewayServices.mockResolvedValue([]);
    resolveGatewayBindHost.mockResolvedValue("127.0.0.1");
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "free",
      listeners: [],
      hints: [],
    });
    inspectPortConnections.mockResolvedValue({
      port: 18789,
      connections: [],
    });
    isExpectedGatewayListeners.mockReturnValue(false);
    vi.mocked(launchd.isLaunchAgentLoaded).mockResolvedValue(false);
    vi.mocked(launchd.launchAgentPlistExists).mockResolvedValue(false);
    vi.mocked(launchd.repairLaunchAgentBootstrap).mockResolvedValue({
      ok: true,
      status: "repaired",
    });
    buildGatewayRuntimeHints.mockReturnValue([]);
    formatGatewayRuntimeSummary.mockReturnValue(null);
    renderSystemdUnavailableHints.mockReset().mockReturnValue([]);
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

  async function runAutoRepair(options: { repair?: boolean; yes?: boolean } = { repair: true }) {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    await maybeRepairGatewayDaemon({
      cfg: { gateway: {} },
      runtime,
      prompter: createDoctorPrompter({
        runtime,
        options,
      }),
      options: { deep: false, ...options },
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

  it("skips every service-manager seam for a non-default install identity", async () => {
    await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: "/tmp/openclaw-copied-state",
        OPENCLAW_CONFIG_PATH: "/tmp/openclaw-copied-state/openclaw.json",
      },
      async () => {
        isDefaultInstallIdentity.mockReturnValue(false);
        await runNonInteractiveRepair();
      },
    );

    expect(service.isLoaded).not.toHaveBeenCalled();
    expect(service.readRuntime).not.toHaveBeenCalled();
    expect(service.readCommand).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
    expect(launchd.repairLaunchAgentBootstrap).not.toHaveBeenCalled();
    expect(findSystemGatewayServices).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      "service management skipped: non-default state dir or config path",
      "Gateway",
    );
  });

  it("still inspects the managed service for the default install identity", async () => {
    await withEnvAsync(
      { OPENCLAW_STATE_DIR: undefined, OPENCLAW_CONFIG_PATH: undefined },
      runNonInteractiveRepair,
    );

    expect(service.isLoaded).toHaveBeenCalledTimes(1);
    expect(service.readRuntime).toHaveBeenCalledTimes(1);
  });

  it.each([
    { environment: "container without an OpenClaw service", detected: true },
    { environment: "Kubernetes pod without container markers", kubernetes: true },
    { environment: "globally external supervisor", external: true },
  ])(
    "keeps port diagnostics but never probes host services in a $environment",
    async (scenario) => {
      setPlatform("linux");
      isContainerEnvironment.mockReturnValue(scenario.detected === true);
      inspectPortUsage.mockResolvedValueOnce({
        port: 18789,
        status: "busy",
        listeners: [{ pid: 1234, command: "other-process" }],
        hints: [],
      });

      await withEnvAsync(
        {
          KUBERNETES_SERVICE_HOST: scenario.kubernetes ? "10.96.0.1" : undefined,
          KUBERNETES_SERVICE_PORT: scenario.kubernetes ? "443" : undefined,
          OPENCLAW_SUPERVISOR_MODE: scenario.external ? "external" : undefined,
        },
        runNonInteractiveRepair,
      );

      expect(inspectPortUsage).toHaveBeenCalledOnce();
      expect(note).toHaveBeenCalledWith("Port 18789 is already in use.", "Gateway port");
      expect(note).toHaveBeenCalledWith(EXTERNAL_SERVICE_REPAIR_NOTE, "Gateway");
      expect(findInstalledSystemdGatewayScope).toHaveBeenCalledTimes(scenario.detected ? 1 : 0);
      expect(service.isLoaded).not.toHaveBeenCalled();
      expect(service.readRuntime).not.toHaveBeenCalled();
      expect(service.readCommand).not.toHaveBeenCalled();
      expect(service.install).not.toHaveBeenCalled();
      expect(service.restart).not.toHaveBeenCalled();
      expect(findSystemGatewayServices).not.toHaveBeenCalled();
    },
  );

  it("inspects an installed OpenClaw service through a reachable Docker systemd manager", async () => {
    setPlatform("linux");
    isContainerEnvironment.mockReturnValue(true);
    findInstalledSystemdGatewayScope.mockResolvedValue({
      scope: "user",
      unitName: "openclaw-gateway.service",
      unitPath: "/home/alice/.config/systemd/user/openclaw-gateway.service",
    });

    await runNonInteractiveRepair();

    expect(service.isLoaded).toHaveBeenCalledWith({ env: process.env, timeoutMs: 5_000 });
    expect(service.readRuntime).toHaveBeenCalledOnce();
    expect(note).not.toHaveBeenCalledWith(EXTERNAL_SERVICE_REPAIR_NOTE, "Gateway");
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

    expect(readGatewayRestartHandoffSync).toHaveBeenCalledTimes(2);
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

  it("does not inspect port connections during normal doctor", async () => {
    setPlatform("linux");

    await runNonInteractiveRepair();

    expect(readGatewayRestartHandoffSync).toHaveBeenCalled();
    expect(inspectPortConnections).not.toHaveBeenCalled();
  });

  it("still audits missing service when gateway health was skipped", async () => {
    setPlatform("linux");
    service.isLoaded.mockResolvedValueOnce(false);
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await maybeRepairGatewayDaemon({
      cfg: { gateway: {} },
      runtime,
      prompter: createDoctorPrompter({
        runtime,
        options: { nonInteractive: true },
      }),
      options: { deep: false, nonInteractive: true },
      gatewayDetailsMessage: "details",
      healthOk: false,
      healthSkipped: true,
    });

    expect(note).toHaveBeenCalledWith("Gateway service not installed.", "Gateway");
  });

  it("reports unknown service inspection without offering or executing repair", async () => {
    setPlatform("linux");
    service.isLoaded.mockRejectedValueOnce(
      new Error("systemctl is-enabled unavailable: Failed to connect to bus: No medium found"),
    );
    renderSystemdUnavailableHints.mockReturnValueOnce(["restore the systemd user bus"]);
    const prompter = createPrompter(() => true);

    await maybeRepairGatewayDaemon({
      cfg: { gateway: {} },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      prompter,
      options: { deep: false },
      gatewayDetailsMessage: "details",
      healthOk: false,
    });

    expect(renderSystemdUnavailableHints).toHaveBeenCalledWith({
      wsl: false,
      kind: "user_bus_unavailable",
    });
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Gateway service status could not be determined"),
      "Gateway",
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("restore the systemd user bus"),
      "Gateway",
    );
    expect(prompter.confirmRuntimeRepair).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
    expect(findSystemGatewayServices).not.toHaveBeenCalled();
  });

  it("does not audit local services when skipped gateway health is remote", async () => {
    setPlatform("linux");

    await maybeRepairGatewayDaemon({
      cfg: { gateway: { mode: "remote" } },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      prompter: createDoctorPrompter({
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        options: { nonInteractive: true },
      }),
      options: { deep: false, nonInteractive: true },
      gatewayDetailsMessage: "details",
      healthOk: false,
      healthSkipped: true,
    });

    expect(service.isLoaded).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalledWith("Gateway service not installed.", "Gateway");
  });

  it("does not start loaded services with unknown runtime when health was skipped", async () => {
    setPlatform("linux");
    service.readRuntime.mockResolvedValueOnce({ status: "unknown" });

    await maybeRepairGatewayDaemon({
      cfg: { gateway: {} },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      prompter: createDoctorPrompter({
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        options: { repair: true, nonInteractive: true },
      }),
      options: { deep: false, repair: true, nonInteractive: true },
      gatewayDetailsMessage: "details",
      healthOk: false,
      healthSkipped: true,
    });

    expect(service.restart).not.toHaveBeenCalled();
  });

  it("reports established gateway clients during deep doctor", async () => {
    setPlatform("linux");
    inspectPortConnections.mockResolvedValueOnce({
      port: 18789,
      connections: [
        {
          pid: 4242,
          command: "node",
          commandLine: "/tmp/newer-openclaw/bin/openclaw logs --follow",
          address: "TCP 127.0.0.1:50123->127.0.0.1:18789 (ESTABLISHED)",
          direction: "client",
        },
      ],
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

    const gatewayClientNote = note.mock.calls.find(([, label]) => label === "Gateway clients");
    expect(gatewayClientNote?.[0]).toContain("pid=4242");
    expect(gatewayClientNote?.[0]).toContain("protocol mismatch after rollback");
  });

  it("reports established gateway clients during healthy deep doctor", async () => {
    setPlatform("linux");
    inspectPortConnections.mockResolvedValueOnce({
      port: 18789,
      connections: [
        {
          pid: 5151,
          command: "node",
          commandLine: "/tmp/newer-openclaw/bin/openclaw logs --follow",
          address: "TCP 127.0.0.1:50123->127.0.0.1:18789 (ESTABLISHED)",
          direction: "client",
        },
      ],
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
      healthOk: true,
    });

    expect(inspectPortUsage).not.toHaveBeenCalled();
    const gatewayClientNote = note.mock.calls.find(([, label]) => label === "Gateway clients");
    expect(gatewayClientNote?.[0]).toContain("pid=5151");
    expect(gatewayClientNote?.[0]).toContain("protocol mismatch after rollback");
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

    expect(resolveGatewayBindHost).toHaveBeenCalledWith("loopback", undefined);
    expect(inspectPortUsage).toHaveBeenCalledWith(18789, {
      probeHosts: ["127.0.0.1"],
    });
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

  it("retains operator heap ownership when reinstalling a disabled service", async () => {
    setPlatform("linux");
    service.isLoaded.mockResolvedValue(false);
    service.readRuntime.mockResolvedValue({ status: "stopped" });
    const managedDefinition = {
      programArguments: ["node", "/opt/openclaw/dist/index.js", "gateway"],
      environment: { NODE_OPTIONS: "", UNRELATED: "not-persisted" },
    };
    const existingCommand = {
      ...managedDefinition,
      environment: { NODE_OPTIONS: "--max-old-space-size=512" },
      managedDefinition,
      managedOverrides: { environment: { keys: ["NODE_OPTIONS"] } },
    };
    service.readCommand.mockResolvedValue(existingCommand);
    vi.mocked(resolveGatewayInstallToken).mockResolvedValueOnce({
      tokenRefConfigured: false,
      warnings: [],
    });
    vi.mocked(buildGatewayInstallPlan).mockResolvedValueOnce({
      programArguments: managedDefinition.programArguments,
      environment: { NODE_OPTIONS: "" },
    });
    const prompter = createPrompter(() => true);
    prompter.select.mockResolvedValue("node");

    await maybeRepairGatewayDaemon({
      cfg: { gateway: {} },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      prompter,
      options: { deep: false },
      gatewayDetailsMessage: "details",
      healthOk: false,
    });

    expect(buildGatewayInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({ existingCommand }),
    );
    expect(vi.mocked(buildGatewayInstallPlan).mock.calls[0]?.[0]).not.toHaveProperty(
      "existingEnvironment",
    );
    expect(service.install).toHaveBeenCalledOnce();
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

  it("skips running service restart during non-interactive repairs", async () => {
    setPlatform("linux");

    await runNonInteractiveRepair();

    expect(service.restart).not.toHaveBeenCalled();
  });

  it("starts stopped service during non-interactive repairs", async () => {
    setPlatform("linux");
    service.readRuntime.mockResolvedValue({ status: "stopped" });

    await runNonInteractiveRepair();

    expect(service.restart).toHaveBeenCalledTimes(1);
  });

  it("restarts running service when repair is explicitly approved", async () => {
    setPlatform("linux");

    await runAutoRepair();

    expect(service.restart).toHaveBeenCalledTimes(1);
  });

  it("reports a typed close after restart without depending on error wording", async () => {
    setPlatform("linux");
    const error = new Error("transport closed after restart");
    healthCommand.mockRejectedValueOnce(error);
    formatGatewayClosedDiagnostic.mockReturnValueOnce(
      "Gateway connect failed: transport closed after restart",
    );

    const runtime = await runAutoRepair();

    expect(formatGatewayClosedDiagnostic).toHaveBeenCalledWith(error);
    expect(note).toHaveBeenCalledWith(
      "Gateway connect failed: transport closed after restart",
      "Gateway",
    );
    expect(note).toHaveBeenCalledWith("details", "Gateway connection");
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("restarts running service when --yes explicitly approves repairs", async () => {
    setPlatform("linux");

    await runAutoRepair({ yes: true });

    expect(service.restart).toHaveBeenCalledTimes(1);
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
    service.readRuntime.mockResolvedValue({ status: "stopped" });
    vi.mocked(launchd.isLaunchAgentLoaded).mockResolvedValue(false);
    vi.mocked(launchd.launchAgentPlistExists).mockResolvedValueOnce(true).mockResolvedValue(false);

    await withEnvAsync({ OPENCLAW_SERVICE_REPAIR_POLICY: "external" }, async () => {
      await runAutoRepair();
    });

    expect(launchd.repairLaunchAgentBootstrap).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(EXTERNAL_SERVICE_REPAIR_NOTE, "Gateway LaunchAgent");
    expect(note).not.toHaveBeenCalledWith("Gateway service not installed.", "Gateway");
    expect(buildGatewayRuntimeHints).not.toHaveBeenCalled();
  });

  it("re-enables and bootstraps a parked LaunchAgent during non-interactive repair", async () => {
    setPlatform("darwin");
    service.isLoaded.mockResolvedValueOnce(false).mockResolvedValue(true);
    service.readRuntime
      .mockResolvedValueOnce({ status: "unknown", missingSupervision: true })
      .mockResolvedValue({ status: "running" });
    vi.mocked(launchd.launchAgentPlistExists).mockResolvedValueOnce(true).mockResolvedValue(false);
    vi.mocked(launchd.isLaunchAgentLoaded).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await runNonInteractiveRepair();

    expect(launchd.repairLaunchAgentBootstrap).toHaveBeenCalledWith({
      env: process.env,
    });
    expect(service.install).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith("Gateway LaunchAgent repaired.", "Gateway LaunchAgent");
  });

  it("reports macOS GUI-session runtime instead of install guidance for a not-loaded LaunchAgent", async () => {
    setPlatform("darwin");
    service.isLoaded.mockResolvedValue(false);
    service.readRuntime.mockResolvedValue({
      status: "unknown",
      detail: "Bootstrap failed: 125: Domain does not support specified action",
      missingSupervision: true,
      missingGuiSession: true,
    });
    buildGatewayRuntimeHints.mockReturnValue([
      "LaunchAgent requires a logged-in macOS GUI session; SSH/headless/sudo shells cannot bootstrap gui/$UID.",
    ]);

    await runAutoRepair();

    expect(launchd.repairLaunchAgentBootstrap).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
    expect(buildGatewayRuntimeHints).toHaveBeenCalledWith(
      {
        status: "unknown",
        detail: "Bootstrap failed: 125: Domain does not support specified action",
        missingGuiSession: true,
      },
      { platform: "darwin", env: process.env },
    );
    expect(note).toHaveBeenCalledWith(
      "LaunchAgent requires a logged-in macOS GUI session; SSH/headless/sudo shells cannot bootstrap gui/$UID.",
      "Gateway",
    );
    expect(note).not.toHaveBeenCalledWith("Gateway service not installed.", "Gateway");
  });

  it("reports concurrent system ownership without offering user service repair", async () => {
    setPlatform("darwin");
    service.readRuntime.mockResolvedValue({
      status: "unknown",
      detail: "System LaunchDaemon system/ai.openclaw.gateway owns this gateway label.",
      systemLaunchDaemon: {
        status: "loaded",
        serviceTarget: "system/ai.openclaw.gateway",
      },
    });
    formatGatewayRuntimeSummary.mockReturnValue(
      "unknown (System LaunchDaemon system/ai.openclaw.gateway owns this gateway label.)",
    );

    await runAutoRepair();

    expect(service.install).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      "Runtime: unknown (System LaunchDaemon system/ai.openclaw.gateway owns this gateway label.)",
      "Gateway",
    );
    expect(note).not.toHaveBeenCalledWith("Gateway service not installed.", "Gateway");
  });

  it("surfaces typed system ownership from bootstrap repair and stops recovery", async () => {
    setPlatform("darwin");
    service.isLoaded.mockResolvedValue(false);
    service.readRuntime.mockResolvedValue({ status: "unknown", missingSupervision: true });
    vi.mocked(launchd.launchAgentPlistExists).mockResolvedValueOnce(true).mockResolvedValue(false);
    vi.mocked(launchd.isLaunchAgentLoaded).mockResolvedValue(false);
    vi.mocked(launchd.repairLaunchAgentBootstrap).mockResolvedValueOnce({
      ok: false,
      status: "system-launchdaemon-conflict",
      detail: "System LaunchDaemon system/ai.openclaw.gateway owns this gateway label.",
    });

    await runAutoRepair();

    expect(note).toHaveBeenCalledWith(
      "System LaunchDaemon system/ai.openclaw.gateway owns this gateway label.",
      "Gateway",
    );
    expect(service.install).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
  });

  it("reports restart ownership failures instead of aborting doctor", async () => {
    setPlatform("darwin");
    service.readRuntime.mockResolvedValue({ status: "stopped" });
    service.restart.mockRejectedValue(
      new Error("System LaunchDaemon system/ai.openclaw.gateway owns this gateway label."),
    );

    await expect(runAutoRepair()).resolves.toBeDefined();

    expect(note).toHaveBeenCalledWith(
      "Gateway service restart failed: System LaunchDaemon system/ai.openclaw.gateway owns this gateway label.",
      "Gateway",
    );
  });

  it("routes GUI-session bootstrap failures through the doctor runtime hint", async () => {
    setPlatform("darwin");
    service.isLoaded.mockResolvedValue(false);
    service.readRuntime.mockResolvedValue({
      status: "unknown",
      missingSupervision: true,
    });
    vi.mocked(launchd.isLaunchAgentLoaded).mockResolvedValue(false);
    vi.mocked(launchd.launchAgentPlistExists).mockResolvedValueOnce(true).mockResolvedValue(false);
    vi.mocked(launchd.repairLaunchAgentBootstrap).mockResolvedValueOnce({
      ok: false,
      status: "gui-session-unavailable",
      detail: "Bootstrap failed: 125: Domain does not support specified action",
      domain: "gui/501",
    });
    buildGatewayRuntimeHints.mockReturnValue([
      "LaunchAgent requires a logged-in macOS GUI session; SSH/headless/sudo shells cannot bootstrap gui/$UID.",
    ]);

    const runtime = await runAutoRepair();

    expect(runtime.error).not.toHaveBeenCalledWith(
      expect.stringContaining("LaunchAgent bootstrap failed"),
    );
    expect(service.install).not.toHaveBeenCalled();
    expect(buildGatewayRuntimeHints).toHaveBeenCalledWith(
      {
        status: "unknown",
        detail: "Bootstrap failed: 125: Domain does not support specified action",
        missingGuiSession: true,
      },
      { platform: "darwin", env: process.env },
    );
    expect(note).toHaveBeenCalledWith(
      "LaunchAgent requires a logged-in macOS GUI session; SSH/headless/sudo shells cannot bootstrap gui/$UID.",
      "Gateway",
    );
  });

  it("skips restart prompt when gateway is healthy after recent restart handoff in normal doctor flow", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(40_000);
    setPlatform("linux");
    const handoff = {
      kind: "gateway-supervisor-restart-handoff" as const,
      version: 1 as const,
      intentId: "intent-healthy",
      pid: 99_999,
      createdAt: 35_000,
      expiresAt: 95_000,
      reason: "update.run",
      source: "gateway-update" as const,
      restartKind: "update-process" as const,
      supervisorMode: "systemd" as const,
    } satisfies GatewayRestartHandoff;
    readGatewayRestartHandoffSync.mockReturnValue(handoff);

    await maybeRepairGatewayDaemon({
      cfg: { gateway: {} },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      prompter: createPrompter(() => true),
      options: { deep: false },
      gatewayDetailsMessage: "details",
      healthOk: false,
    });

    expect(readGatewayRestartHandoffSync).toHaveBeenCalled();
    expect(healthCommand).toHaveBeenCalledOnce();
    expect(service.restart).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      "Gateway is healthy after recent restart; skipping restart prompt.",
      "Gateway",
    );
  });

  it("prompts for restart when health probe fails despite recent restart handoff in normal doctor flow", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(40_000);
    setPlatform("linux");
    const handoff = {
      kind: "gateway-supervisor-restart-handoff" as const,
      version: 1 as const,
      intentId: "intent-unhealthy",
      pid: 88_888,
      createdAt: 35_000,
      expiresAt: 95_000,
      reason: "gateway.restart",
      source: "operator-restart" as const,
      restartKind: "full-process" as const,
      supervisorMode: "systemd" as const,
    } satisfies GatewayRestartHandoff;
    readGatewayRestartHandoffSync.mockReturnValue(handoff);
    healthCommand.mockRejectedValueOnce(new Error("gateway closed"));

    await maybeRepairGatewayDaemon({
      cfg: { gateway: {} },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      prompter: createPrompter(() => false),
      options: { deep: false },
      gatewayDetailsMessage: "details",
      healthOk: false,
    });

    expect(readGatewayRestartHandoffSync).toHaveBeenCalled();
    expect(healthCommand).toHaveBeenCalledOnce();
    expect(service.restart).not.toHaveBeenCalled();
    // The restart prompt was shown but user declined (createPrompter returned false for it).
  });
});
