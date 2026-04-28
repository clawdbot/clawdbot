import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
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

  it("emits drift warning when enabled", async () => {
    await runServiceRestart(createServiceRunArgs(true));

    expect(loadConfig).toHaveBeenCalledTimes(1);
    const payload = readJsonLog<{ warnings?: string[] }>();
    expect(payload.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("gateway install --force")]),
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
    expect(payload.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("gateway install --force")]),
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

    expect(writeGatewayRestartIntentSync).toHaveBeenCalledWith({ targetPid: 1234 });
    expect(clearGatewayRestartIntentSync).not.toHaveBeenCalled();
    expect(service.restart).toHaveBeenCalledTimes(1);
  });

  it("clears restart intent when service-manager restart fails before signaling", async () => {
    service.readRuntime.mockResolvedValue({ status: "running", pid: 1234 });
    writeGatewayRestartIntentSync.mockReturnValueOnce(true);
    service.restart.mockRejectedValueOnce(new Error("launchctl failed before signaling"));

    await expect(runServiceRestart(createServiceRunArgs())).rejects.toThrow("__exit__:1");

    expect(writeGatewayRestartIntentSync).toHaveBeenCalledWith({ targetPid: 1234 });
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
    expect(payload.hints).toEqual(expect.arrayContaining(["openclaw gateway install"]));
    expect(payload.hintItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "install",
          text: "openclaw gateway install",
        }),
      ]),
    );
    expect(service.restart).not.toHaveBeenCalled();
  });
});
