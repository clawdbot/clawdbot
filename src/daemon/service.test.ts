import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { captureEnv } from "../test-utils/env.js";
import type { GatewayService } from "./service.js";
import {
  describeGatewayServiceRestart,
  formatGatewayServiceStartRepairIssues,
  readGatewayServiceState,
  resolveGatewayService,
  startGatewayService,
} from "./service.js";
import { createMockGatewayService } from "./service.test-helpers.js";

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(value: NodeJS.Platform | "aix") {
  if (!originalPlatformDescriptor) {
    throw new Error("missing process.platform descriptor");
  }
  Object.defineProperty(process, "platform", {
    configurable: true,
    enumerable: originalPlatformDescriptor.enumerable ?? false,
    value,
  });
}

afterEach(() => {
  if (!originalPlatformDescriptor) {
    return;
  }
  Object.defineProperty(process, "platform", originalPlatformDescriptor);
});

function createService(overrides: Partial<GatewayService> = {}): GatewayService {
  return createMockGatewayService(overrides);
}

describe("resolveGatewayService", () => {
  it.each([
    { platform: "darwin" as const, label: "LaunchAgent", loadedText: "loaded" },
    { platform: "linux" as const, label: "systemd user", loadedText: "enabled" },
    { platform: "win32" as const, label: "Scheduled Task", loadedText: "registered" },
  ])("returns the registered adapter for $platform", ({ platform, label, loadedText }) => {
    setPlatform(platform);
    const service = resolveGatewayService();
    expect(service.label).toBe(label);
    expect(service.loadedText).toBe(loadedText);
  });

  it("throws for unsupported platforms", () => {
    setPlatform("aix");
    expect(() => resolveGatewayService()).toThrow("Gateway service install not supported on aix");
  });

  it("guards mutating service adapters when config was written by a newer OpenClaw", async () => {
    const tempHome = await makeTempWorkspace("openclaw-service-future-config-");
    const stateDir = path.join(tempHome, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const envSnapshot = captureEnv(["HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]);
    try {
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            meta: {
              lastTouchedVersion: "9999.1.1",
            },
          },
          null,
          2,
        ),
      );
      process.env.HOME = tempHome;
      process.env.OPENCLAW_STATE_DIR = stateDir;
      process.env.OPENCLAW_CONFIG_PATH = configPath;
      clearConfigCache();
      clearRuntimeConfigSnapshot();

      const service = resolveGatewayService();

      await expect(service.restart({ env: process.env, stdout: process.stdout })).rejects.toThrow(
        "Refusing to restart the gateway service",
      );
    } finally {
      envSnapshot.restore();
      clearConfigCache();
      clearRuntimeConfigSnapshot();
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it("describes scheduled restart handoffs consistently", () => {
    expect(describeGatewayServiceRestart("Gateway", { outcome: "scheduled" })).toEqual({
      scheduled: true,
      daemonActionResult: "scheduled",
      message: "restart scheduled, gateway will restart momentarily",
      progressMessage: "Gateway service restart scheduled.",
    });
  });
});

describe("readGatewayServiceState", () => {
  it("tracks installed, loaded, and running separately", async () => {
    const service = createService({
      isLoaded: vi.fn(async () => true),
      readCommand: vi.fn(async () => ({
        programArguments: ["openclaw", "gateway", "run"],
        environment: { OPENCLAW_GATEWAY_PORT: "18789" },
      })),
      readRuntime: vi.fn(async () => ({ status: "running" })),
    });

    const state = await readGatewayServiceState(service, {
      env: { OPENCLAW_GATEWAY_PORT: "1" },
    });

    expect(state.installed).toBe(true);
    expect(state.loaded).toBe(true);
    expect(state.running).toBe(true);
    expect(state.env.OPENCLAW_GATEWAY_PORT).toBe("18789");
  });
});

describe("startGatewayService", () => {
  it("returns missing-install without attempting restart", async () => {
    const service = createService();

    const result = await startGatewayService(service, {
      env: {},
      stdout: process.stdout,
    });

    expect(result.outcome).toBe("missing-install");
    expect(service.restart).not.toHaveBeenCalled();
  });

  it("restarts stopped installed services and returns post-start state", async () => {
    const readCommand = vi.fn(async () => ({
      programArguments: ["openclaw", "gateway", "run"],
      environment: { OPENCLAW_GATEWAY_PORT: "18789" },
    }));
    const isLoaded = vi
      .fn<GatewayService["isLoaded"]>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const readRuntime = vi
      .fn<GatewayService["readRuntime"]>()
      .mockResolvedValueOnce({ status: "stopped" })
      .mockResolvedValueOnce({ status: "running" });
    const service = createService({
      readCommand,
      isLoaded,
      readRuntime,
    });

    const result = await startGatewayService(service, {
      env: {},
      stdout: process.stdout,
    });

    expect(result.outcome).toBe("started");
    expect(service.restart).toHaveBeenCalledTimes(1);
    expect(result.state.installed).toBe(true);
    expect(result.state.loaded).toBe(true);
    expect(result.state.running).toBe(true);
  });

  it("requests repair before start when the loaded service version is stale", async () => {
    const service = createService({
      readCommand: vi.fn(async () => ({
        programArguments: ["openclaw", "gateway", "run"],
        environment: { OPENCLAW_SERVICE_VERSION: "2026.4.24" },
      })),
      isLoaded: vi.fn(async () => true),
      readRuntime: vi.fn(async () => ({ status: "stopped" })),
    });

    const result = await startGatewayService(service, {
      env: {},
      stdout: process.stdout,
    });

    expect(result.outcome).toBe("repair-required");
    if (result.outcome === "repair-required") {
      expect(formatGatewayServiceStartRepairIssues(result.issues)).toContain(
        "service was installed by OpenClaw 2026.4.24",
      );
    }
    expect(service.restart).not.toHaveBeenCalled();
  });

  it("requests repair before start when the loaded service points at temporary install paths", async () => {
    const service = createService({
      readCommand: vi.fn(async () => ({
        programArguments: [
          "/private/tmp/openclaw-ai-install-cli-pr118/tools/node/bin/node",
          "/tmp/openclaw-ai-install-cli-pr118/lib/node_modules/openclaw/dist/index.js",
          "gateway",
        ],
        environment: {},
      })),
      isLoaded: vi.fn(async () => true),
    });

    const result = await startGatewayService(service, {
      env: {},
      stdout: process.stdout,
    });

    expect(result.outcome).toBe("repair-required");
    if (result.outcome === "repair-required") {
      expect(result.issues.map((issue) => issue.code)).toContain("temporary-program");
    }
    expect(service.restart).not.toHaveBeenCalled();
  });

  it("falls back to missing-install when restart fails and install artifacts are gone", async () => {
    const readCommand = vi
      .fn<GatewayService["readCommand"]>()
      .mockResolvedValueOnce({
        programArguments: ["openclaw", "gateway", "run"],
      })
      .mockResolvedValueOnce(null);
    const service = createService({
      readCommand,
      restart: vi.fn(async () => {
        throw new Error("launchctl bootstrap failed");
      }),
    });

    const result = await startGatewayService(service, {
      env: {},
      stdout: process.stdout,
    });

    expect(result.outcome).toBe("missing-install");
    expect(result.state.installed).toBe(false);
  });
});
