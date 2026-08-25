// Daemon lifecycle core tests cover service lifecycle transitions and platform adapters.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { GatewayServiceControlArgs } from "../../daemon/service-types.js";
import type { GatewayService } from "../../daemon/service.js";
import {
  createGatewayServiceRunArgs as createServiceRunArgs,
  createGatewayUninstallArgs,
  lifecycleTestRuntime,
  resetLifecycleRuntimeLogs,
  resetLifecycleServiceMocks,
  lifecycleRuntimeLogs,
  service,
  stubEmptyGatewayEnv,
} from "./test-helpers/lifecycle-core-harness.js";

const loadConfig = vi.fn<() => OpenClawConfig>(() => ({
  gateway: {
    auth: {
      token: "config-token",
    },
  },
}));
const writeGatewayRestartIntentSync = vi.fn();
const clearGatewayRestartIntentSync = vi.fn();
const appendGatewayLifecycleAudit = vi.fn();
const SERVICE_REPAIR_COMMAND_CASES = [
  ["Gateway", "", "", "openclaw gateway"],
  ["Node", "", "", "openclaw node"],
  ["Node", "work", "", "openclaw --profile work node"],
  ["Node", "work", "demo", "openclaw --container demo node"],
] as const;
const createGatewayLifecycleMutationAudit = vi.fn(
  (params: { action: string; source?: string }) => (mutation: { mode: string; pid?: number }) =>
    appendGatewayLifecycleAudit({
      action: params.action,
      source: params.source ?? "cli",
      ...mutation,
    }),
);

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => loadConfig(),
  loadConfig: () => loadConfig(),
  readBestEffortConfig: async () => loadConfig(),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: lifecycleTestRuntime,
}));

vi.mock("../../infra/restart-intent.js", () => ({
  clearGatewayRestartIntentSync: () => clearGatewayRestartIntentSync(),
  writeGatewayRestartIntentSync: (opts: unknown) => writeGatewayRestartIntentSync(opts),
}));

vi.mock("./lifecycle-audit.js", () => ({
  appendGatewayLifecycleAudit: (params: unknown) => appendGatewayLifecycleAudit(params),
  createGatewayLifecycleMutationAudit: (params: { action: string; source?: string }) =>
    createGatewayLifecycleMutationAudit(params),
  createServiceLifecycleMutationAudit: (params: { serviceNoun: string; action: string }) =>
    params.serviceNoun === "Gateway" ? createGatewayLifecycleMutationAudit(params) : undefined,
  appendServiceLifecycleRepairAudit: (params: {
    serviceNoun: string;
    action: string;
    pid?: number;
  }) => {
    if (params.serviceNoun === "Gateway") {
      appendGatewayLifecycleAudit({
        action: params.action,
        source: "cli",
        mode: "service-repair",
        ...(params.pid === undefined ? {} : { pid: params.pid }),
      });
    }
  },
}));

let runServiceRestart: typeof import("./lifecycle-core.js").runServiceRestart;
let runServiceStart: typeof import("./lifecycle-core.js").runServiceStart;
let runServiceStop: typeof import("./lifecycle-core.js").runServiceStop;
let runServiceUninstall: typeof import("./lifecycle-core.js").runServiceUninstall;

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Test helper lets assertions ascribe logged JSON shape.
function readJsonLog<T extends object>() {
  const jsonLine = lifecycleRuntimeLogs.find((line) => line.trim().startsWith("{"));
  return JSON.parse(jsonLine ?? "{}") as T;
}

function stubConfigSecretRefGatewayToken() {
  loadConfig.mockReturnValue({
    secrets: {
      providers: {
        default: { source: "env" },
      },
    },
    gateway: {
      auth: {
        mode: "token",
        token: {
          source: "env",
          provider: "default",
          id: "SERVICE_GATEWAY_TOKEN",
        },
      },
    },
  });
}

function stubServiceGatewayTokenEnv() {
  service.readCommand.mockResolvedValue({
    programArguments: [],
    environment: {
      OPENCLAW_GATEWAY_TOKEN: "service-token",
      SERVICE_GATEWAY_TOKEN: "service-token",
    },
  });
}

async function withUnsupportedGatewayService(
  run: (unsupportedService: GatewayService) => Promise<void>,
) {
  const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("aix");
  try {
    const { resolveGatewayService } = await import("../../daemon/service.js");
    await run(resolveGatewayService());
  } finally {
    platformSpy.mockRestore();
  }
}

function expectUnsupportedServiceCheckFailure() {
  const payload = readJsonLog<{ ok?: boolean; error?: string }>();
  expect(payload.ok).toBe(false);
  expect(payload.error).toContain(
    "Gateway service check failed: Error: Gateway service install not supported on aix",
  );
}

describe("runServiceRestart token drift", () => {
  beforeAll(async () => {
    ({ runServiceRestart, runServiceStart, runServiceStop, runServiceUninstall } =
      await import("./lifecycle-core.js"));
  });

  beforeEach(() => {
    appendGatewayLifecycleAudit.mockClear();
    createGatewayLifecycleMutationAudit.mockClear();
    resetLifecycleRuntimeLogs();
    loadConfig.mockReset();
    loadConfig.mockReturnValue({
      gateway: {
        auth: {
          token: "config-token",
        },
      },
    });
    resetLifecycleServiceMocks();
    writeGatewayRestartIntentSync.mockClear();
    clearGatewayRestartIntentSync.mockClear();
    service.readCommand.mockResolvedValue({
      programArguments: [],
      environment: { OPENCLAW_GATEWAY_TOKEN: "service-token" },
    });
    stubEmptyGatewayEnv();
  });

  it("rejects unsupported-platform start before not-loaded recovery", async () => {
    const onNotLoaded = vi.fn(async () => ({
      result: "started" as const,
      message: "should not run",
      loaded: true,
    }));

    await withUnsupportedGatewayService(async (unsupportedService) => {
      await expect(
        runServiceStart({
          serviceNoun: "Gateway",
          service: unsupportedService,
          renderStartHints: () => ["openclaw gateway install"],
          opts: { json: true },
          onNotLoaded,
        }),
      ).rejects.toThrow("__exit__:1");
    });

    expect(onNotLoaded).not.toHaveBeenCalled();
    expectUnsupportedServiceCheckFailure();
  });

  it("rejects unsupported-platform stop before unmanaged fallback", async () => {
    const onNotLoaded = vi.fn(async () => ({
      result: "stopped" as const,
      message: "should not run",
    }));

    await withUnsupportedGatewayService(async (unsupportedService) => {
      await expect(
        runServiceStop({
          serviceNoun: "Gateway",
          service: unsupportedService,
          opts: { json: true },
          onNotLoaded,
        }),
      ).rejects.toThrow("__exit__:1");
    });

    expect(onNotLoaded).not.toHaveBeenCalled();
    expectUnsupportedServiceCheckFailure();
  });

  it("rejects unsupported-platform restart before unmanaged fallback", async () => {
    const onNotLoaded = vi.fn(async () => ({
      result: "restarted" as const,
      message: "should not run",
    }));
    const postRestartCheck = vi.fn(async () => {});

    await withUnsupportedGatewayService(async (unsupportedService) => {
      await expect(
        runServiceRestart({
          serviceNoun: "Gateway",
          service: unsupportedService,
          renderStartHints: () => ["openclaw gateway install"],
          opts: { json: true },
          onNotLoaded,
          postRestartCheck,
        }),
      ).rejects.toThrow("__exit__:1");
    });

    expect(onNotLoaded).not.toHaveBeenCalled();
    expect(postRestartCheck).not.toHaveBeenCalled();
    expectUnsupportedServiceCheckFailure();
  });

  it.each([
    {
      name: "initial uninstall inspection",
      arrange: () => service.isLoaded.mockRejectedValue(new Error("initial inspection failed")),
      run: () => runServiceUninstall(createGatewayUninstallArgs()),
      action: "uninstall",
      detail: "initial inspection failed",
      stopCalls: 0,
      uninstallCalls: 0,
    },
    {
      name: "post-uninstall verification",
      arrange: () =>
        service.isLoaded
          .mockResolvedValueOnce(false)
          .mockRejectedValueOnce(new Error("uninstall verification failed")),
      run: () => runServiceUninstall(createGatewayUninstallArgs()),
      action: "uninstall",
      detail: "uninstall verification failed",
      stopCalls: 0,
      uninstallCalls: 1,
    },
    {
      name: "post-stop verification",
      arrange: () =>
        service.isLoaded
          .mockResolvedValueOnce(true)
          .mockRejectedValueOnce(new Error("stop verification failed")),
      run: () => runServiceStop({ serviceNoun: "Gateway", service, opts: { json: true } }),
      action: "stop",
      detail: "stop verification failed",
      stopCalls: 1,
      uninstallCalls: 0,
    },
  ])("fails $name without reporting false absence", async (testCase) => {
    testCase.arrange();

    await expect(testCase.run()).rejects.toThrow("__exit__:1");

    expect(
      readJsonLog<{ action?: string; ok?: boolean; result?: string; error?: string }>(),
    ).toEqual(
      expect.objectContaining({
        action: testCase.action,
        ok: false,
        error: expect.stringContaining(testCase.detail),
      }),
    );
    expect(service.stop).toHaveBeenCalledTimes(testCase.stopCalls);
    expect(service.uninstall).toHaveBeenCalledTimes(testCase.uninstallCalls);
  });

  it("fails restart with the container hint when no service is installed", async () => {
    service.isLoaded.mockResolvedValue(false);
    service.readCommand.mockResolvedValue(null);
    const hasInstalledDefinition = vi.fn(async () => false);
    vi.stubEnv("OPENCLAW_CONTAINER_HINT", "openclaw-demo-container");

    await expect(
      runServiceRestart({
        serviceNoun: "Gateway",
        service: { ...service, hasInstalledDefinition } as GatewayService,
        renderStartHints: () => [
          "Restart the container or the service that manages it for openclaw-demo-container.",
          "openclaw gateway install",
        ],
        opts: { json: true },
      }),
    ).rejects.toThrow("__exit__:1");

    const payload = readJsonLog<{
      action?: string;
      ok?: boolean;
      error?: string;
      hints?: string[];
      hintItems?: Array<{ kind: string; text: string }>;
    }>();
    expect(payload).toMatchObject({
      action: "restart",
      ok: false,
      error: "Gateway service not loaded.",
    });
    expect(payload.hints).toContain(
      "Restart the container or the service that manages it for openclaw-demo-container.",
    );
    expect(payload.hintItems).toContainEqual(
      expect.objectContaining({ kind: "container-restart" }),
    );
    expect(hasInstalledDefinition).toHaveBeenCalledWith({ env: process.env });
  });

  it("restarts a disabled installed service through its native manager", async () => {
    service.isLoaded.mockResolvedValue(false);
    const hasInstalledDefinition = vi.fn(async () => true);
    const onNotLoaded = vi.fn(async () => null);
    const renderStartHints = vi.fn(() => ["openclaw gateway install"]);
    service.restart.mockImplementationOnce(async (args?: GatewayServiceControlArgs) => {
      args?.onMutation?.({ mode: "systemctl-restart" });
      return { outcome: "completed" };
    });

    await expect(
      runServiceRestart({
        ...createServiceRunArgs(),
        service: { ...service, hasInstalledDefinition } as GatewayService,
        renderStartHints,
        onNotLoaded,
      }),
    ).resolves.toBe(true);

    expect(hasInstalledDefinition).toHaveBeenCalledWith({ env: process.env });
    expect(service.restart).toHaveBeenCalledTimes(1);
    expect(onNotLoaded).not.toHaveBeenCalled();
    expect(renderStartHints).not.toHaveBeenCalled();
    expect(appendGatewayLifecycleAudit).toHaveBeenCalledWith({
      action: "restart",
      source: "cli",
      mode: "systemctl-restart",
    });
    expect(readJsonLog<{ ok?: boolean; result?: string; hints?: string[] }>()).toMatchObject({
      ok: true,
      result: "restarted",
    });
  });

  it("runs the service mutation guard before restarting a loaded service", async () => {
    const beforeServiceMutation = vi.fn();

    await runServiceRestart({
      ...createServiceRunArgs(),
      beforeServiceMutation,
    });

    expect(beforeServiceMutation).toHaveBeenCalledTimes(1);
    expect(beforeServiceMutation.mock.invocationCallOrder[0]).toBeLessThan(
      service.restart.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("fails restart when an installed service cannot be inspected", async () => {
    service.isLoaded.mockRejectedValue(
      new Error(
        "systemctl is-enabled unavailable: Command failed during launch or output capture (EACCES)",
      ),
    );
    service.readCommand.mockResolvedValue(null);
    const hasInstalledDefinition = vi.fn(async () => true);
    const postRestartCheck = vi.fn(async () => {});

    await expect(
      runServiceRestart({
        ...createServiceRunArgs(),
        service: { ...service, hasInstalledDefinition } as GatewayService,
        postRestartCheck,
      }),
    ).rejects.toThrow("__exit__:1");

    expect(hasInstalledDefinition).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
    expect(postRestartCheck).not.toHaveBeenCalled();
    expect(readJsonLog<{ ok?: boolean; error?: string }>()).toMatchObject({
      ok: false,
      error: expect.stringContaining("systemctl is-enabled unavailable"),
    });
  });

  it("aborts loaded-service mutation when the service guard rejects", async () => {
    const repairLoadedService = vi.fn();

    await expect(
      runServiceRestart({
        ...createServiceRunArgs(),
        beforeServiceMutation: () => {
          throw new Error("service mutation denied");
        },
        repairLoadedService,
      }),
    ).rejects.toThrow("service mutation denied");

    expect(writeGatewayRestartIntentSync).not.toHaveBeenCalled();
    expect(repairLoadedService).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
  });

  it("does not run the service mutation guard before not-loaded recovery", async () => {
    service.isLoaded.mockResolvedValue(false);
    service.readCommand.mockResolvedValue(null);
    const beforeServiceMutation = vi.fn();

    await runServiceRestart({
      ...createServiceRunArgs(),
      beforeServiceMutation,
      onNotLoaded: async () => ({
        result: "restarted",
        message: "Gateway restart signal sent to unmanaged process on port 18789: 4200.",
      }),
    });

    expect(beforeServiceMutation).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
  });

  it("repairs managed port drift before restarting", async () => {
    service.readRuntime.mockResolvedValue({ status: "running", pid: 1234 });
    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "--port", "18789"],
      environment: { OPENCLAW_GATEWAY_PORT: "18789" },
    });
    type RepairLoadedService = NonNullable<
      Parameters<typeof runServiceRestart>[0]["repairLoadedService"]
    >;
    const repairLoadedService = vi.fn<RepairLoadedService>(async () => ({
      result: "restarted" as const,
      message: "Gateway service definition repaired and restarted.",
      loaded: true,
    }));

    await runServiceRestart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => [],
      opts: { json: true, restartIntent: { waitMs: 2_500 } },
      expectedPort: 19_001,
      repairLoadedService,
    });

    expect(repairLoadedService).toHaveBeenCalledWith(
      expect.objectContaining({
        issues: [
          {
            code: "port-mismatch",
            message: "service port 18789 does not match current gateway config port 19001",
          },
        ],
      }),
    );
    expect(service.restart).not.toHaveBeenCalled();
    expect(writeGatewayRestartIntentSync).toHaveBeenCalledWith({
      targetPid: 1234,
      reason: "gateway.restart",
      intent: { waitMs: 2_500 },
    });
    expect(readJsonLog<{ result?: string; message?: string }>()).toMatchObject({
      result: "restarted",
      message: "Gateway service definition repaired and restarted.",
    });
  });

  it("emits drift warning when enabled", async () => {
    await runServiceRestart(createServiceRunArgs(true));

    expect(loadConfig).toHaveBeenCalledTimes(1);
    const payload = readJsonLog<{ warnings?: string[] }>();
    expect(payload.warnings?.some((warning) => warning.includes("gateway install --force"))).toBe(
      true,
    );
  });

  it("compares restart drift against config token even when caller env is set", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        auth: {
          token: "config-token",
        },
      },
    });
    service.readCommand.mockResolvedValue({
      programArguments: [],
      environment: { OPENCLAW_GATEWAY_TOKEN: "env-token" },
    });
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "env-token");

    await runServiceRestart(createServiceRunArgs(true));

    const payload = readJsonLog<{ warnings?: string[] }>();
    expect(payload.warnings?.some((warning) => warning.includes("gateway install --force"))).toBe(
      true,
    );
  });

  it("resolves config token SecretRefs using service command env before drift checks", async () => {
    stubConfigSecretRefGatewayToken();
    stubServiceGatewayTokenEnv();

    await runServiceRestart(createServiceRunArgs(true));

    const payload = readJsonLog<{ warnings?: string[] }>();
    expect(payload.warnings).toBeUndefined();
  });

  it("prefers service command env over process env for SecretRef token drift resolution", async () => {
    stubConfigSecretRefGatewayToken();
    stubServiceGatewayTokenEnv();
    vi.stubEnv("SERVICE_GATEWAY_TOKEN", "process-token");

    await runServiceRestart(createServiceRunArgs(true));

    const payload = readJsonLog<{ warnings?: string[] }>();
    expect(payload.warnings).toBeUndefined();
  });

  it("skips drift warning when disabled", async () => {
    await runServiceRestart({
      serviceNoun: "Node",
      service,
      renderStartHints: () => [],
      opts: { json: true },
    });

    expect(loadConfig).not.toHaveBeenCalled();
    expect(service.readCommand).not.toHaveBeenCalled();
    expect(writeGatewayRestartIntentSync).not.toHaveBeenCalled();
    const payload = readJsonLog<{ warnings?: string[] }>();
    expect(payload.warnings).toBeUndefined();
  });

  it("emits stopped when an unmanaged process handles stop", async () => {
    service.isLoaded.mockResolvedValue(false);

    await runServiceStop({
      serviceNoun: "Gateway",
      service,
      opts: { json: true },
      onNotLoaded: async () => ({
        result: "stopped",
        message: "Gateway stop signal sent to unmanaged process on port 18789: 4200.",
      }),
    });

    const payload = readJsonLog<{ result?: string; message?: string }>();
    expect(payload.result).toBe("stopped");
    expect(payload.message).toContain("unmanaged process");
    expect(service.stop).not.toHaveBeenCalled();
  });

  it("runs a requested managed stop even when the service is not loaded", async () => {
    const onNotLoaded = vi.fn(async () => ({
      result: "stopped" as const,
      message: "Gateway stop signal sent to unmanaged process on port 18789: 4200.",
    }));
    service.isLoaded.mockResolvedValue(false);

    await runServiceStop({
      serviceNoun: "Gateway",
      service,
      opts: { json: true, disable: true },
      stopWhenNotLoaded: true,
      onNotLoaded,
    });

    const payload = readJsonLog<{ result?: string; service?: { loaded?: boolean } }>();
    expect(payload.result).toBe("stopped");
    expect(payload.service?.loaded).toBe(false);
    expect(service.stop).toHaveBeenCalledTimes(1);
    const [stopOptions] = service.stop.mock.calls[0] ?? [];
    expect(stopOptions?.env).toBe(process.env);
    expect(stopOptions?.disable).toBe(true);
    expect(onNotLoaded).not.toHaveBeenCalled();
  });

  it("emits started when a not-loaded start path repairs the service", async () => {
    service.isLoaded.mockResolvedValue(false);

    await runServiceStart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => [],
      opts: { json: true },
      onNotLoaded: async () => ({
        result: "started",
        message:
          "Gateway LaunchAgent was installed but not loaded; re-bootstrapped launchd service.",
        loaded: true,
      }),
    });

    const payload = readJsonLog<{
      result?: string;
      message?: string;
      service?: { loaded?: boolean };
    }>();
    expect(payload.result).toBe("started");
    expect(payload.message).toContain("re-bootstrapped");
    expect(payload.service?.loaded).toBe(true);
    expect(service.start).not.toHaveBeenCalled();
  });

  it("runs restart health checks after an unmanaged restart signal", async () => {
    const postRestartCheck = vi.fn(async () => {});
    service.isLoaded.mockResolvedValue(false);
    service.readCommand.mockResolvedValue(null);

    await runServiceRestart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => [],
      opts: { json: true },
      onNotLoaded: async () => ({
        result: "restarted",
        message: "Gateway restart signal sent to unmanaged process on port 18789: 4200.",
      }),
      postRestartCheck,
    });

    expect(postRestartCheck).toHaveBeenCalledTimes(1);
    expect(service.restart).not.toHaveBeenCalled();
    const payload = readJsonLog<{ result?: string; message?: string }>();
    expect(payload.result).toBe("restarted");
    expect(payload.message).toContain("unmanaged process");
  });

  it("emits loaded restart state when launchd repair handles a not-loaded restart", async () => {
    const postRestartCheck = vi.fn(async () => {});
    service.isLoaded.mockResolvedValue(false);
    service.readCommand.mockResolvedValue(null);

    await runServiceRestart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => [],
      opts: { json: true },
      onNotLoaded: async () => ({
        result: "restarted",
        message:
          "Gateway LaunchAgent was installed but not loaded; re-bootstrapped launchd service.",
        loaded: true,
      }),
      postRestartCheck,
    });

    expect(postRestartCheck).toHaveBeenCalledTimes(1);
    expect(service.restart).not.toHaveBeenCalled();
    const payload = readJsonLog<{
      result?: string;
      message?: string;
      service?: { loaded?: boolean };
    }>();
    expect(payload.result).toBe("restarted");
    expect(payload.message).toContain("re-bootstrapped");
    expect(payload.service?.loaded).toBe(true);
  });

  it("skips restart health checks when restart is only scheduled", async () => {
    const postRestartCheck = vi.fn(async () => {});
    service.restart.mockResolvedValue({ outcome: "scheduled" });

    const result = await runServiceRestart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => [],
      opts: { json: true },
      postRestartCheck,
    });

    expect(result).toBe(true);
    expect(postRestartCheck).not.toHaveBeenCalled();
    const payload = readJsonLog<{ result?: string; message?: string }>();
    expect(payload.result).toBe("scheduled");
    expect(payload.message).toBe("restart scheduled, gateway will restart momentarily");
  });

  it("writes a restart intent before service-manager restart", async () => {
    service.readRuntime.mockResolvedValue({ status: "running", pid: 1234 });

    await runServiceRestart(createServiceRunArgs());

    expect(writeGatewayRestartIntentSync).toHaveBeenCalledWith({
      targetPid: 1234,
      reason: "gateway.restart",
    });
    expect(clearGatewayRestartIntentSync).not.toHaveBeenCalled();
    expect(service.restart).toHaveBeenCalledTimes(1);
  });

  it("captures service restart warnings in json restart output", async () => {
    service.restart.mockImplementationOnce(async (args?: GatewayServiceControlArgs) => {
      args?.warn?.(
        "Existing generated LaunchAgent env wrapper contains custom behavior and will be overwritten.",
      );
      return { outcome: "completed" };
    });

    await runServiceRestart(createServiceRunArgs());

    const payload = readJsonLog<{ warnings?: string[] }>();
    expect(payload.warnings).toContain(
      "Existing generated LaunchAgent env wrapper contains custom behavior and will be overwritten.",
    );
    expect(service.restart).toHaveBeenCalledWith(
      expect.objectContaining({ warn: expect.any(Function) }),
    );
  });

  it("writes restart force and wait options into the service-manager intent", async () => {
    service.readRuntime.mockResolvedValue({ status: "running", pid: 1234 });

    await runServiceRestart({
      ...createServiceRunArgs(),
      opts: {
        json: true,
        restartIntent: {
          waitMs: 2_500,
        },
      },
    });

    expect(writeGatewayRestartIntentSync).toHaveBeenCalledWith({
      targetPid: 1234,
      reason: "gateway.restart",
      intent: {
        waitMs: 2_500,
      },
    });
  });

  it("clears restart intent when service-manager restart fails before signaling", async () => {
    service.readRuntime.mockResolvedValue({ status: "running", pid: 1234 });
    writeGatewayRestartIntentSync.mockReturnValueOnce(true);
    service.restart.mockRejectedValueOnce(new Error("launchctl failed before signaling"));

    await expect(runServiceRestart(createServiceRunArgs())).rejects.toThrow("__exit__:1");

    expect(writeGatewayRestartIntentSync).toHaveBeenCalledWith({
      targetPid: 1234,
      reason: "gateway.restart",
    });
    expect(clearGatewayRestartIntentSync).toHaveBeenCalledOnce();
  });

  it("reports an already-running gateway without starting it", async () => {
    service.readRuntime.mockResolvedValue({ status: "running", pid: 4242 });

    await runServiceStart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => [],
      opts: { json: true },
    });

    const payload = readJsonLog<{ ok?: boolean; result?: string; message?: string }>();
    expect(payload).toMatchObject({
      ok: true,
      result: "already-running",
      message: "Gateway service already running (pid 4242).",
    });
    expect(service.start).not.toHaveBeenCalled();
    expect(appendGatewayLifecycleAudit).not.toHaveBeenCalled();
  });

  it.each(SERVICE_REPAIR_COMMAND_CASES)(
    "warns in json with the correct %s service restart command",
    async (serviceNoun, profile, container, command) => {
      vi.stubEnv("OPENCLAW_PROFILE", profile);
      vi.stubEnv("OPENCLAW_CONTAINER_HINT", container);
      service.readRuntime.mockResolvedValue({ status: "running", pid: 4242 });
      service.readCommand.mockResolvedValue({
        programArguments: ["openclaw", serviceNoun.toLowerCase(), "--port", "18789"],
      });

      await runServiceStart({ ...createServiceRunArgs(), serviceNoun, expectedPort: 19_001 });

      const payload = readJsonLog<{ result?: string; warnings?: string[] }>();
      expect(payload.result).toBe("already-running");
      expect(payload.warnings).toEqual([
        `${serviceNoun} service already running, but its installed service definition needs repair: service port 18789 does not match current gateway config port 19001; run \`${command} restart\` to apply.`,
      ]);
      expect(service.start).not.toHaveBeenCalled();
    },
  );

  it.each(["Gateway", "Node"])(
    "prints one warning line when an already-running %s service needs repair",
    async (serviceNoun) => {
      service.readRuntime.mockResolvedValue({ status: "running", pid: 4242 });
      service.readCommand.mockResolvedValue({
        programArguments: ["openclaw", serviceNoun.toLowerCase(), "--port", "18789"],
      });

      await runServiceStart({
        serviceNoun,
        service,
        renderStartHints: () => [],
        expectedPort: 19_001,
      });

      const repairWarnings = lifecycleRuntimeLogs.filter((line) =>
        line.startsWith(
          `${serviceNoun} service already running, but its installed service definition needs repair:`,
        ),
      );
      expect(repairWarnings).toHaveLength(1);
      expect(repairWarnings[0]).toContain(
        `run \`openclaw ${serviceNoun.toLowerCase()} restart\` to apply.`,
      );
      expect(service.start).not.toHaveBeenCalled();
    },
  );

  it("audits a service start that actually mutates the gateway", async () => {
    service.start.mockImplementationOnce(async (args?: GatewayServiceControlArgs) => {
      args?.onMutation?.({ mode: "kickstart" });
    });

    await runServiceStart(createServiceRunArgs());

    expect(appendGatewayLifecycleAudit).toHaveBeenCalledWith({
      action: "start",
      source: "cli",
      mode: "kickstart",
    });
  });

  it("audits direct managed restart mutations", async () => {
    service.readRuntime.mockResolvedValue({ status: "running", pid: 4242 });
    service.restart.mockImplementationOnce(async (args?: GatewayServiceControlArgs) => {
      args?.onMutation?.({ mode: "kickstart" });
      return { outcome: "completed" };
    });

    await runServiceRestart(createServiceRunArgs());

    expect(appendGatewayLifecycleAudit).toHaveBeenCalledWith({
      action: "restart",
      source: "cli",
      mode: "kickstart",
    });
  });

  it("audits direct managed stop mutations", async () => {
    service.stop.mockImplementationOnce(async (args?: GatewayServiceControlArgs) => {
      args?.onMutation?.({ mode: "bootout" });
    });

    await runServiceStop({
      serviceNoun: "Gateway",
      service,
      opts: { json: true },
    });

    expect(appendGatewayLifecycleAudit).toHaveBeenCalledWith({
      action: "stop",
      source: "cli",
      mode: "bootout",
    });
  });

  it("captures service start warnings in json start output", async () => {
    service.start.mockImplementationOnce(async (args?: GatewayServiceControlArgs) => {
      args?.warn?.(
        "Existing generated LaunchAgent env wrapper contains custom behavior and will be overwritten.",
      );
    });

    await runServiceStart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => [],
      opts: { json: true },
    });

    const payload = readJsonLog<{ warnings?: string[] }>();
    expect(payload.warnings).toContain(
      "Existing generated LaunchAgent env wrapper contains custom behavior and will be overwritten.",
    );
    expect(service.start).toHaveBeenCalledWith(
      expect.objectContaining({ warn: expect.any(Function) }),
    );
  });

  it("repairs loaded services with port drift during start before reporting success", async () => {
    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "--port", "18789"],
    });
    type RepairLoadedService = NonNullable<
      Parameters<typeof runServiceStart>[0]["repairLoadedService"]
    >;
    const repairLoadedService = vi.fn<RepairLoadedService>(async (ctx) => {
      ctx.warn?.(
        "Existing generated LaunchAgent env wrapper contains custom behavior and will be overwritten.",
      );
      return {
        result: "started" as const,
        message: "Gateway service definition repaired and started.",
        warnings: ["service port 18789 does not match current gateway config port 19001"],
        loaded: true,
      };
    });

    await runServiceStart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => [],
      opts: { json: true },
      repairLoadedService,
      expectedPort: 19_001,
    });

    expect(repairLoadedService).toHaveBeenCalledTimes(1);
    expect(service.start).not.toHaveBeenCalled();
    const payload = readJsonLog<{
      result?: string;
      message?: string;
      warnings?: string[];
      service?: { loaded?: boolean };
    }>();
    expect(payload.result).toBe("started");
    expect(payload.message).toBe("Gateway service definition repaired and started.");
    expect(payload.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("service port 18789"),
        expect.stringContaining("custom behavior and will be overwritten"),
      ]),
    );
    expect(payload.service?.loaded).toBe(true);
  });

  it.each(SERVICE_REPAIR_COMMAND_CASES)(
    "fails %s service start with its own install hint when repair is required",
    async (serviceNoun, profile, container, command) => {
      vi.stubEnv("OPENCLAW_PROFILE", profile);
      vi.stubEnv("OPENCLAW_CONTAINER_HINT", container);
      service.readCommand.mockResolvedValue({
        programArguments: ["openclaw", serviceNoun.toLowerCase(), "--port", "18789"],
      });

      await expect(
        runServiceStart({ ...createServiceRunArgs(), serviceNoun, expectedPort: 19_001 }),
      ).rejects.toThrow("__exit__:1");

      const payload = readJsonLog<{
        ok?: boolean;
        error?: string;
        hints?: string[];
        hintItems?: Array<{ kind: string; text: string }>;
      }>();
      expect(payload.ok).toBe(false);
      expect(payload.error).toContain("service needs repair");
      expect(payload.hints).toEqual([`${command} install --force`]);
      expect(payload.hintItems).toEqual([{ kind: "install", text: `${command} install --force` }]);

      resetLifecycleRuntimeLogs();
      await expect(
        runServiceStart({
          ...createServiceRunArgs(),
          serviceNoun,
          opts: { json: false },
          expectedPort: 19_001,
        }),
      ).rejects.toThrow("__exit__:1");
      expect(lifecycleRuntimeLogs).toContain(`Tip: ${command} install --force`);
      expect(service.start).not.toHaveBeenCalled();
    },
  );

  it("fails start when starting a stopped installed service errors", async () => {
    service.isLoaded.mockResolvedValue(false);
    service.start.mockRejectedValue(new Error("launchctl kickstart failed: permission denied"));

    await expect(runServiceStart(createServiceRunArgs())).rejects.toThrow("__exit__:1");

    const payload = readJsonLog<{ ok?: boolean; error?: string }>();
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("launchctl kickstart failed: permission denied");
  });

  it("fails start with install hints when no service is installed", async () => {
    service.isLoaded.mockResolvedValue(false);
    service.readCommand.mockResolvedValue(null);

    await expect(
      runServiceStart({
        serviceNoun: "Gateway",
        service,
        renderStartHints: () => ["openclaw gateway install"],
        opts: { json: true },
      }),
    ).rejects.toThrow("__exit__:1");

    const payload = readJsonLog<{
      ok?: boolean;
      error?: string;
      hints?: string[];
      hintItems?: Array<{ kind: string; text: string }>;
    }>();
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("Gateway service not loaded.");
    expect(payload.hints?.includes("openclaw gateway install")).toBe(true);
    expect(
      payload.hintItems?.some(
        (item) => item.kind === "install" && item.text === "openclaw gateway install",
      ),
    ).toBe(true);
    expect(service.start).not.toHaveBeenCalled();
  });
});
