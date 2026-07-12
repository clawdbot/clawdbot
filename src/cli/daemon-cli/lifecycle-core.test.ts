// Daemon lifecycle core tests cover service lifecycle transitions and platform adapters.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { GatewayServiceControlArgs } from "../../daemon/service-types.js";
import type { GatewayService } from "../../daemon/service.js";
import {
  defaultRuntime,
  resetLifecycleRuntimeLogs,
  resetLifecycleServiceMocks,
  runtimeLogs,
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

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => loadConfig(),
  loadConfig: () => loadConfig(),
  readBestEffortConfig: async () => loadConfig(),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("../../infra/restart.js", () => ({
  clearGatewayRestartIntentSync: () => clearGatewayRestartIntentSync(),
  writeGatewayRestartIntentSync: (opts: unknown) => writeGatewayRestartIntentSync(opts),
}));

let runServiceRestart: typeof import("./lifecycle-core.js").runServiceRestart;
let runServiceStart: typeof import("./lifecycle-core.js").runServiceStart;
let runServiceStop: typeof import("./lifecycle-core.js").runServiceStop;

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Test helper lets assertions ascribe logged JSON shape.
function readJsonLog<T extends object>() {
  const jsonLine = runtimeLogs.find((line) => line.trim().startsWith("{"));
  return JSON.parse(jsonLine ?? "{}") as T;
}

function createServiceRunArgs(checkTokenDrift?: boolean) {
  return {
    serviceNoun: "Gateway",
    service,
    renderStartHints: () => [],
    opts: { json: true as const },
    ...(checkTokenDrift ? { checkTokenDrift } : {}),
  };
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
    ({ runServiceRestart, runServiceStart, runServiceStop } = await import("./lifecycle-core.js"));
  });

  beforeEach(() => {
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

  it("prints the container restart hint when restart is requested for a not-loaded service", async () => {
    service.isLoaded.mockResolvedValue(false);
    vi.stubEnv("OPENCLAW_CONTAINER_HINT", "openclaw-demo-container");

    await runServiceRestart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => [
        "Restart the container or the service that manages it for openclaw-demo-container.",
        "openclaw gateway install",
      ],
      opts: { json: false },
    });

    expect(runtimeLogs).toContain("Gateway service not loaded.");
    expect(runtimeLogs).toContain(
      "Start with: Restart the container or the service that manages it for openclaw-demo-container.",
    );
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
    expect(service.restart).not.toHaveBeenCalled();
  });

  it("runs restart health checks after an unmanaged restart signal", async () => {
    const postRestartCheck = vi.fn(async () => {});
    service.isLoaded.mockResolvedValue(false);

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
    expect(service.readCommand).not.toHaveBeenCalled();
    const payload = readJsonLog<{ result?: string; message?: string }>();
    expect(payload.result).toBe("restarted");
    expect(payload.message).toContain("unmanaged process");
  });

  it("emits loaded restart state when launchd repair handles a not-loaded restart", async () => {
    const postRestartCheck = vi.fn(async () => {});
    service.isLoaded.mockResolvedValue(false);

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

  it("emits scheduled when service start routes through a scheduled restart", async () => {
    service.restart.mockResolvedValue({ outcome: "scheduled" });

    await runServiceStart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => [],
      opts: { json: true },
    });

    expect(service.isLoaded).toHaveBeenCalled();
    const payload = readJsonLog<{ result?: string; message?: string }>();
    expect(payload.result).toBe("scheduled");
    expect(payload.message).toBe("restart scheduled, gateway will restart momentarily");
  });

  it("captures service start warnings in json start output", async () => {
    service.restart.mockImplementationOnce(async (args?: GatewayServiceControlArgs) => {
      args?.warn?.(
        "Existing generated LaunchAgent env wrapper contains custom behavior and will be overwritten.",
      );
      return { outcome: "completed" };
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
    expect(service.restart).toHaveBeenCalledWith(
      expect.objectContaining({ warn: expect.any(Function) }),
    );
  });

  it("repairs stale loaded services during start before reporting success", async () => {
    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway"],
      environment: { OPENCLAW_SERVICE_VERSION: "2026.4.24" },
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
        warnings: ["service was installed by OpenClaw 2026.4.24, current CLI is 2026.5.2"],
        loaded: true,
      };
    });

    await runServiceStart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => [],
      opts: { json: true },
      repairLoadedService,
    });

    expect(repairLoadedService).toHaveBeenCalledTimes(1);
    expect(service.restart).not.toHaveBeenCalled();
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
        expect.stringContaining("service was installed by OpenClaw"),
        expect.stringContaining("custom behavior and will be overwritten"),
      ]),
    );
    expect(payload.service?.loaded).toBe(true);
  });

  it("fails start with an install hint when a stale loaded service has no repair callback", async () => {
    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway"],
      environment: { OPENCLAW_SERVICE_VERSION: "2026.4.24" },
    });

    await expect(runServiceStart(createServiceRunArgs())).rejects.toThrow("__exit__:1");

    const payload = readJsonLog<{ ok?: boolean; error?: string; hints?: string[] }>();
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("service needs repair");
    expect(payload.hints).toEqual(["openclaw gateway install --force"]);
    expect(service.restart).not.toHaveBeenCalled();
  });

  it("fails start when restarting a stopped installed service errors", async () => {
    service.isLoaded.mockResolvedValue(false);
    service.restart.mockRejectedValue(new Error("launchctl kickstart failed: permission denied"));

    await expect(runServiceStart(createServiceRunArgs())).rejects.toThrow("__exit__:1");

    const payload = readJsonLog<{ ok?: boolean; error?: string }>();
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("launchctl kickstart failed: permission denied");
  });

  it("falls back to not-loaded hints when start finds no install artifacts", async () => {
    service.isLoaded.mockResolvedValue(false);
    service.readCommand.mockResolvedValue(null);

    await runServiceStart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => ["openclaw gateway install"],
      opts: { json: true },
    });

    const payload = readJsonLog<{
      ok?: boolean;
      result?: string;
      hints?: string[];
      hintItems?: Array<{ kind: string; text: string }>;
    }>();
    expect(payload.ok).toBe(true);
    expect(payload.result).toBe("not-loaded");
    expect(payload.hints?.includes("openclaw gateway install")).toBe(true);
    expect(
      payload.hintItems?.some(
        (item) => item.kind === "install" && item.text === "openclaw gateway install",
      ),
    ).toBe(true);
    expect(service.restart).not.toHaveBeenCalled();
  });
});
