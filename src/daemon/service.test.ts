// Daemon service tests cover service install, start, stop, and status flows.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { captureEnv } from "../test-utils/env.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { resolveNodeService } from "./node-service.js";
import type { GatewayService } from "./service.js";
import {
  describeGatewayServiceRestart,
  readGatewayServiceState,
  resolveGatewayService,
  startGatewayService,
} from "./service.js";
import { createMockGatewayService, mockSystemAccountHome } from "./service.test-helpers.js";

const probePortUsage = vi.hoisted(() =>
  vi.fn<typeof import("../infra/ports-probe.js").probePortUsage>(),
);

vi.mock("../infra/ports-probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/ports-probe.js")>()),
  probePortUsage,
}));

beforeEach(() => {
  mockSystemAccountHome();
  probePortUsage.mockReset();
  probePortUsage.mockRejectedValue(new Error("unexpected port probe"));
});

function setPlatform(value: NodeJS.Platform) {
  mockProcessPlatform(value);
}

afterEach(() => {
  vi.restoreAllMocks();
});

function createService(overrides: Partial<GatewayService> = {}): GatewayService {
  return createMockGatewayService(overrides);
}

const managerlessPreflightCases = [
  ...(["git", "package"] as const).flatMap((updateInstallKind) =>
    ([false, true] as const).map((shouldRestart) => ({
      updateInstallKind,
      shouldRestart,
      condition: "absent",
      portUsage: "free" as const,
      portSource: "env" as const,
    })),
  ),
  { updateInstallKind: "package" as const, shouldRestart: true, condition: "installed" },
  { updateInstallKind: "package" as const, shouldRestart: true, condition: "node absent" },
  { updateInstallKind: "package" as const, shouldRestart: true, condition: "node installed" },
  { updateInstallKind: "package" as const, shouldRestart: true, condition: "global definition" },
  { updateInstallKind: "package" as const, shouldRestart: true, condition: "unreadable" },
  { updateInstallKind: "package" as const, shouldRestart: true, condition: "manager" },
  {
    updateInstallKind: "package" as const,
    shouldRestart: true,
    condition: "busy port",
    portUsage: "busy" as const,
    portSource: "env" as const,
  },
  {
    updateInstallKind: "package" as const,
    shouldRestart: true,
    condition: "configured busy port",
    portUsage: "busy" as const,
    portSource: "config" as const,
  },
  {
    updateInstallKind: "package" as const,
    shouldRestart: true,
    condition: "unknown port",
    portUsage: "unknown" as const,
    portSource: "env" as const,
  },
];

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

  it("returns a read-only unsupported-platform adapter", async () => {
    setPlatform("aix");
    const service = resolveGatewayService();

    await expect(service.readCommand(process.env)).resolves.toBeNull();
    await expect(service.isLoaded({ env: process.env })).rejects.toThrow(
      "Gateway service install not supported on aix",
    );
    await expect(service.readRuntime(process.env)).resolves.toEqual({
      status: "unknown",
      detail: "Gateway service install not supported on aix",
    });
    await expect(service.start({ env: process.env, stdout: process.stdout })).rejects.toThrow(
      "Gateway service install not supported on aix",
    );
    await expect(service.restart({ env: process.env, stdout: process.stdout })).rejects.toThrow(
      "Gateway service install not supported on aix",
    );
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

  it("guards every native service mutation when an external supervisor owns lifecycle", async () => {
    setPlatform("darwin");
    const service = resolveGatewayService();
    const env = { OPENCLAW_SUPERVISOR_MODE: "external" };
    const installArgs = {
      env,
      stdout: process.stdout,
      programArguments: ["openclaw", "gateway", "run"],
    };
    const mutations = [
      () => service.stage(installArgs),
      () => service.install(installArgs),
      () => service.uninstall({ env, stdout: process.stdout }),
      () => service.start({ env, stdout: process.stdout }),
      () => service.stop({ env, stdout: process.stdout }),
      () => service.restart({ env, stdout: process.stdout }),
    ];

    for (const mutate of mutations) {
      await expect(mutate()).rejects.toThrow(
        "gateway lifecycle is managed by an external supervisor",
      );
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
  it.each(managerlessPreflightCases)(
    "handles managerless Linux inspection for $updateInstallKind restart=$shouldRestart ($condition)",
    async ({ updateInstallKind, shouldRestart, condition, portUsage, portSource }) => {
      const { maybeStopManagedServiceBeforeMutableUpdate } =
        await import("../cli/update-cli/update-command-service.js");
      const home = await makeTempWorkspace("openclaw-managerless-preflight-");
      const keys = [
        "HOME",
        "PATH",
        "OPENCLAW_HOME",
        "OPENCLAW_STATE_DIR",
        "OPENCLAW_CONFIG_PATH",
        "OPENCLAW_PROFILE",
        "OPENCLAW_GATEWAY_PORT",
        "OPENCLAW_SUPERVISOR_MODE",
        "OPENCLAW_SERVICE_MARKER",
        "OPENCLAW_SERVICE_KIND",
        "OPENCLAW_SYSTEMD_UNIT",
        "DBUS_SESSION_BUS_ADDRESS",
        "DBUS_SYSTEM_BUS_ADDRESS",
        "XDG_RUNTIME_DIR",
        "XDG_CONFIG_HOME",
        "XDG_CONFIG_DIRS",
        "XDG_DATA_HOME",
        "XDG_DATA_DIRS",
        "SYSTEMD_UNIT_PATH",
        "SUDO_USER",
      ];
      const snapshot = captureEnv(keys);
      try {
        setPlatform("linux");
        for (const key of keys) {
          delete process.env[key];
        }
        process.env.HOME = home;
        process.env.PATH = home;
        const expectedPort = portSource === "config" ? 19902 : 19901;
        if (portSource === "config") {
          await fs.mkdir(path.join(home, ".openclaw"), { recursive: true });
          await fs.writeFile(
            path.join(home, ".openclaw/openclaw.json"),
            JSON.stringify({ gateway: { port: expectedPort } }),
          );
        } else {
          process.env.OPENCLAW_GATEWAY_PORT = String(expectedPort);
        }
        if (portUsage) {
          probePortUsage.mockResolvedValue(portUsage);
        }
        const node = condition.startsWith("node ");
        const unit = path.join(
          home,
          `.config/systemd/user/openclaw-${node ? "node" : "gateway"}.service`,
        );
        if (condition === "installed" || condition === "node installed") {
          await fs.mkdir(path.dirname(unit), { recursive: true });
          await fs.writeFile(
            unit,
            `[Service]\nExecStart=/missing/openclaw ${node ? "node run" : "gateway"}\n`,
          );
        }
        if (node) {
          // Only the fixture HOME contains definitions; no native manager is contacted.
          vi.spyOn(await import("./exec-file.js"), "execFileUtf8").mockResolvedValue({
            stdout: "",
            stderr: "service manager unavailable",
            code: 1,
            termination: "error",
            errorCode: "ENOENT",
          });
          const access = fs.access;
          vi.spyOn(fs, "access").mockImplementation(async (target, mode) => {
            if (!String(target).startsWith(`${home}${path.sep}`)) {
              throw Object.assign(new Error("missing"), { code: "ENOENT" });
            }
            return access(target, mode);
          });
          vi.spyOn(fs, "readdir").mockResolvedValue([]);
        }
        const lstat = fs.lstat;
        vi.spyOn(fs, "lstat").mockImplementation(async (target, options) => {
          const name = String(target);
          if (node && !name.startsWith(`${home}${path.sep}`)) {
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          }
          if (
            (condition === "manager" && name === "/run/systemd") ||
            (condition === "global definition" &&
              name === "/etc/systemd/user/openclaw-gateway.service")
          ) {
            return lstat(home, options);
          }
          if (condition === "unreadable" && name === unit) {
            throw Object.assign(new Error("permission denied"), { code: "EACCES" });
          }
          // The host may run systemd; this fixture models a separate managerless namespace.
          if (name === "/run/systemd" || /^\/run\/user\/\d+\/systemd$/.test(name)) {
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          }
          return lstat(target, options);
        });
        if (node) {
          const result = await readGatewayServiceState(resolveNodeService(), {
            env: process.env,
            timeoutMs: 2_000,
          });
          expect(result.installed).toBe(condition === "node installed");
          if (condition === "node installed") {
            expect(result.command?.sourcePath).toBe(unit);
            expect(result.loadState.status).toBe("unknown");
            expect(result.runtime?.status).toBe("unknown");
          } else {
            expect(result.command).toBeNull();
            expect(result.runtime?.missingUnit).toBe(true);
          }
          return;
        }
        const result = await maybeStopManagedServiceBeforeMutableUpdate({
          root: home,
          updateInstallKind,
          shouldRestart,
          jsonMode: true,
          phase: "inspect",
          timeoutMs: 2_000,
        });
        if (condition === "absent") {
          expect(result.blockMessage).toBeUndefined();
          expect(result.serviceMutationSkipMessage).toContain("no Gateway service or listener");
          expect(result.serviceUpdateVerdict?.kind).toBe("absent");
        } else if (portUsage) {
          expect(result.blockMessage).toContain("Refusing to mutate code");
          expect(result.serviceUpdateVerdict).toMatchObject({ kind: "unavailable" });
        } else {
          expect(result.blockMessage).toContain("Refusing to mutate code");
          expect(result.serviceUpdateVerdict?.kind).not.toBe("absent");
        }
        expect(result.serviceMutationAllowed).toBe(false);
        expect(result.stopped).toBe(false);
        if (portUsage) {
          expect(probePortUsage).toHaveBeenCalledOnce();
          expect(probePortUsage).toHaveBeenCalledWith(expectedPort);
        } else {
          expect(probePortUsage).not.toHaveBeenCalled();
        }
      } finally {
        snapshot.restore();
        await fs.rm(home, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { read: "ordinary", requireEffective: undefined, capabilityFails: false },
    { read: "strict", requireEffective: true, capabilityFails: false },
    { read: "strict with unavailable capability", requireEffective: true, capabilityFails: true },
  ])(
    "tracks service state and reads only needed capability for $read reads",
    async ({ requireEffective, capabilityFails }) => {
      const hasInstalledDefinition = vi.fn(async () => false);
      const readDefinitionMutationCapability = vi.fn<
        NonNullable<GatewayService["readDefinitionMutationCapability"]>
      >(async () => {
        if (capabilityFails) {
          throw new Error("capability unavailable");
        }
        return { kind: "sealed", reason: "foreign-owner" };
      });
      const service = createService({
        hasInstalledDefinition,
        readDefinitionMutationCapability,
        isLoaded: vi.fn(async () => true),
        readCommand: vi.fn(async () => ({
          programArguments: ["openclaw", "gateway", "run"],
          environment: { OPENCLAW_GATEWAY_PORT: "18789" },
        })),
        readRuntime: vi.fn(async () => ({ status: "running" })),
      });

      const state = await readGatewayServiceState(service, {
        env: { OPENCLAW_GATEWAY_PORT: "1" },
        requireEffective,
        timeoutMs: 100,
      });

      expect(state.installed).toBe(true);
      expect(state.loadState).toEqual({ status: "loaded" });
      expect(state.running).toBe(true);
      expect(state.env.OPENCLAW_GATEWAY_PORT).toBe("18789");
      expect(hasInstalledDefinition).not.toHaveBeenCalled();
      if (requireEffective) {
        expect(readDefinitionMutationCapability).toHaveBeenCalledWith({
          env: { OPENCLAW_GATEWAY_PORT: "1" },
          environment: { OPENCLAW_GATEWAY_PORT: "18789" },
          timeoutMs: 100,
        });
        expect(state.definitionMutationCapability).toEqual(
          capabilityFails
            ? { kind: "unknown", reason: "inspection-failed" }
            : { kind: "sealed", reason: "foreign-owner" },
        );
      } else {
        expect(readDefinitionMutationCapability).not.toHaveBeenCalled();
        expect(state.definitionMutationCapability).toBeUndefined();
      }
    },
  );

  it.each([
    { name: "system-scoped OpenClaw service", definition: true, installed: true },
    { name: "missing OpenClaw service definition", definition: false, installed: false },
    { name: "failed service definition inspection", failure: true, installed: false },
  ])("preserves installed ownership for a $name without command details", async (scenario) => {
    const hasInstalledDefinition = vi.fn(async () => {
      if (scenario.failure) {
        throw new Error("service definition inspection failed");
      }
      return scenario.definition ?? false;
    });
    const service = createService({ hasInstalledDefinition });
    const env = { OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service" };

    const state = await readGatewayServiceState(service, { env, timeoutMs: 100 });

    expect(state.installed).toBe(scenario.installed);
    expect(state.command).toBeNull();
    expect(state.env).toBe(env);
    expect(hasInstalledDefinition).toHaveBeenCalledWith({ env, timeoutMs: 100 });
  });

  it("keeps the caller-selected service identity when merging persisted env", async () => {
    const readRuntime = vi.fn(async () => ({ status: "running" }));
    const service = createService({
      isLoaded: vi.fn(async () => true),
      readCommand: vi.fn(async () => ({
        programArguments: ["openclaw", "gateway", "run"],
        environment: {
          OPENCLAW_GATEWAY_PORT: "18789",
          OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service",
        },
      })),
      readRuntime,
    });

    const state = await readGatewayServiceState(service, {
      env: { OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-maintenance.service" },
    });

    expect(state.env.OPENCLAW_SYSTEMD_UNIT).toBe("openclaw-gateway-maintenance.service");
    expect(readRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-maintenance.service",
      }),
      { timeoutMs: undefined },
    );
  });

  it("propagates required effective command inspection failures", async () => {
    const readCommand = vi.fn(async () => {
      throw new Error("manager unavailable");
    });
    const service = createService({ readCommand });

    await expect(readGatewayServiceState(service, { requireEffective: true })).rejects.toThrow(
      "manager unavailable",
    );
    expect(readCommand).toHaveBeenCalledWith(process.env, {
      timeoutMs: undefined,
      requireEffective: true,
    });
  });

  it("normalizes localized runtime probe failures at the service boundary", async () => {
    const readCommand = vi.fn(async () => null);
    const service = createService({
      isLoaded: vi.fn(async () => true),
      readCommand,
      readRuntime: vi.fn(async () => {
        throw new Error("錯誤: 系統找不到指定的檔案。");
      }),
    });

    const state = await readGatewayServiceState(service, { timeoutMs: 100 });

    expect(readCommand).toHaveBeenCalledWith(process.env, { timeoutMs: 100 });
    expect(state.running).toBe(false);
    expect(state.runtime).toEqual({
      status: "unknown",
      detail: "service runtime inspection failed",
      inspectionFailure: {
        code: "service-runtime-inspection-failed",
        detail: "錯誤: 系統找不到指定的檔案。",
      },
    });
  });

  it("bounds structured runtime inspection diagnostics", async () => {
    const service = createService({
      readRuntime: vi.fn(async () => {
        throw new Error("錯".repeat(600));
      }),
    });

    const state = await readGatewayServiceState(service);

    expect(state.runtime?.inspectionFailure).toMatchObject({
      code: "service-runtime-inspection-failed",
    });
    expect(state.runtime?.inspectionFailure?.detail).toHaveLength(500);
  });

  it("preserves loaded-state probe failures as an explicit unknown state", async () => {
    const service = createService({
      isLoaded: vi.fn(async () => {
        throw new Error("systemctl is-enabled timed out");
      }),
    });

    const state = await readGatewayServiceState(service, { timeoutMs: 100 });

    expect(state.loadState).toEqual({
      status: "unknown",
      detail: "Error: systemctl is-enabled timed out",
    });
  });

  it("validates merged service env before native status probes", async () => {
    const isLoaded = vi.fn(async () => true);
    const readRuntime = vi.fn(async () => ({ status: "running" as const }));
    const readDefinitionMutationCapability =
      vi.fn<NonNullable<GatewayService["readDefinitionMutationCapability"]>>();
    const service = createService({
      isLoaded,
      readDefinitionMutationCapability,
      readCommand: vi.fn(async () => ({
        programArguments: ["openclaw", "gateway", "run"],
        environment: { OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service" },
      })),
      readRuntime,
    });

    await expect(
      readGatewayServiceState(service, {
        env: {},
        requireEffective: true,
        validateEnvBeforeStatusRead: (env) => {
          throw new Error(`refused ${env.OPENCLAW_SYSTEMD_UNIT}`);
        },
      }),
    ).rejects.toThrow("refused openclaw-gateway.service");

    expect(isLoaded).not.toHaveBeenCalled();
    expect(readRuntime).not.toHaveBeenCalled();
    expect(readDefinitionMutationCapability).not.toHaveBeenCalled();
  });
});

describe("startGatewayService", () => {
  it("returns missing-install without attempting start", async () => {
    const service = createService();

    const result = await startGatewayService(service, {
      env: {},
      stdout: process.stdout,
    });

    expect(result.outcome).toBe("missing-install");
    expect(service.start).not.toHaveBeenCalled();
  });

  it("starts stopped installed services and returns post-start state", async () => {
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
    expect(service.start).toHaveBeenCalledTimes(1);
    expect(service.restart).not.toHaveBeenCalled();
    expect(result.state.installed).toBe(true);
    expect(result.state.loadState).toEqual({ status: "loaded" });
    expect(result.state.running).toBe(true);
  });

  it("rejects an unknown post-start service inspection", async () => {
    const service = createService({
      readCommand: vi.fn(async () => ({
        programArguments: ["openclaw", "gateway", "run"],
      })),
      isLoaded: vi
        .fn<GatewayService["isLoaded"]>()
        .mockResolvedValueOnce(false)
        .mockRejectedValueOnce(new Error("post-start inspection failed")),
      readRuntime: vi
        .fn<GatewayService["readRuntime"]>()
        .mockResolvedValueOnce({ status: "stopped" })
        .mockResolvedValueOnce({ status: "running" }),
    });

    await expect(startGatewayService(service, { env: {}, stdout: process.stdout })).rejects.toThrow(
      "Service status inspection failed after start: Error: post-start inspection failed",
    );
    expect(service.start).toHaveBeenCalledTimes(1);
  });

  it("reports an explicit post-start process failure instead of claiming success", async () => {
    const service = createService({
      readCommand: vi.fn(async () => ({
        programArguments: ["openclaw", "gateway", "run"],
      })),
      isLoaded: vi.fn(async () => true),
      readRuntime: vi
        .fn<GatewayService["readRuntime"]>()
        .mockResolvedValueOnce({ status: "stopped" })
        .mockResolvedValueOnce({ status: "stopped", lastExitStatus: 78 }),
    });

    await expect(startGatewayService(service, { env: {}, stdout: process.stdout })).rejects.toThrow(
      "Service failed to start (exit 78)",
    );
    expect(service.start).toHaveBeenCalledTimes(1);
  });

  it("reports an explicit post-start failed manager state instead of claiming success", async () => {
    const service = createService({
      readCommand: vi.fn(async () => ({
        programArguments: ["openclaw", "gateway", "run"],
      })),
      isLoaded: vi.fn(async () => true),
      readRuntime: vi
        .fn<GatewayService["readRuntime"]>()
        .mockResolvedValueOnce({ status: "stopped" })
        .mockResolvedValueOnce({ status: "stopped", state: "failed" }),
    });

    await expect(startGatewayService(service, { env: {}, stdout: process.stdout })).rejects.toThrow(
      "Service failed to start (state failed)",
    );
  });

  it("allows asynchronously starting services without terminal failure evidence", async () => {
    const service = createService({
      readCommand: vi.fn(async () => ({
        programArguments: ["openclaw", "gateway", "run"],
      })),
      isLoaded: vi.fn(async () => true),
      readRuntime: vi.fn(async () => ({ status: "stopped" })),
    });

    await expect(
      startGatewayService(service, { env: {}, stdout: process.stdout }),
    ).resolves.toMatchObject({ outcome: "started" });
  });

  it("does not mistake a previous exit code for a new asynchronous start failure", async () => {
    const service = createService({
      readCommand: vi.fn(async () => ({
        programArguments: ["openclaw", "gateway", "run"],
      })),
      isLoaded: vi.fn(async () => true),
      readRuntime: vi.fn(async () => ({ status: "stopped", lastExitStatus: 78 })),
    });

    await expect(
      startGatewayService(service, { env: {}, stdout: process.stdout }),
    ).resolves.toMatchObject({ outcome: "started" });
  });

  it("returns already-running without starting a loaded running service", async () => {
    const service = createService({
      readCommand: vi.fn(async () => ({
        programArguments: ["openclaw", "gateway", "run"],
      })),
      isLoaded: vi.fn(async () => true),
      readRuntime: vi.fn(async () => ({ status: "running", pid: 4242 })),
    });

    const result = await startGatewayService(service, {
      env: {},
      stdout: process.stdout,
    });

    expect(result.outcome).toBe("already-running");
    if (result.outcome === "already-running") {
      expect(result.state.runtime?.pid).toBe(4242);
    }
    expect(service.start).not.toHaveBeenCalled();
  });

  it("ignores legacy version metadata on an already-running service", async () => {
    const service = createService({
      readCommand: vi.fn(async () => ({
        programArguments: ["openclaw", "gateway", "run"],
        environment: { OPENCLAW_SERVICE_VERSION: "2026.4.24" },
      })),
      isLoaded: vi.fn(async () => true),
      readRuntime: vi.fn(async () => ({ status: "running", pid: 4242 })),
    });

    const result = await startGatewayService(service, {
      env: {},
      stdout: process.stdout,
    });

    expect(result.outcome).toBe("already-running");
    if (result.outcome === "already-running") {
      expect(result.issues).toEqual([]);
    }
    expect(service.start).not.toHaveBeenCalled();
  });

  it("starts a stopped service despite legacy version metadata", async () => {
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

    expect(result.outcome).toBe("started");
    expect(service.start).toHaveBeenCalledOnce();
  });

  it("requests repair before start when the managed port differs from config", async () => {
    const service = createService({
      readCommand: vi.fn(async () => ({
        programArguments: ["openclaw", "gateway", "--port", "18789"],
        environment: { OPENCLAW_GATEWAY_PORT: "19001" },
      })),
      isLoaded: vi.fn(async () => true),
      readRuntime: vi.fn(async () => ({ status: "stopped" })),
    });

    const result = await startGatewayService(
      service,
      {
        env: {},
        stdout: process.stdout,
      },
      19_001,
    );

    expect(result.outcome).toBe("repair-required");
    if (result.outcome === "repair-required") {
      expect(result.issues).toContainEqual({
        code: "port-mismatch",
        message: "service port 18789 does not match current gateway config port 19001",
      });
    }
    expect(service.start).not.toHaveBeenCalled();
  });

  it("uses the command-line port before a stale managed environment port", async () => {
    const service = createService({
      readCommand: vi.fn(async () => ({
        programArguments: ["openclaw", "gateway", "--port", "19001"],
        environment: { OPENCLAW_GATEWAY_PORT: "18789" },
      })),
      isLoaded: vi.fn(async () => true),
      readRuntime: vi.fn(async () => ({ status: "stopped" })),
    });

    const result = await startGatewayService(
      service,
      {
        env: {},
        stdout: process.stdout,
      },
      19_001,
    );

    expect(result.outcome).toBe("started");
    expect(service.start).toHaveBeenCalledTimes(1);
  });

  describe("service program paths", () => {
    const entrypoint = path.resolve("openclaw.mjs");
    const missing = path.resolve("missing-gateway-entrypoint.cjs");
    const temporary = path.join(os.tmpdir(), "openclaw-service-layout", "index.js");
    const heapFlag = "--max-old-space-size=16384";

    describe.each([
      { kind: "missing", program: missing },
      { kind: "temporary", program: temporary },
    ])("$kind program", ({ kind, program }) => {
      it.each([
        { layout: "runtime executable", args: [program, heapFlag, entrypoint] },
        { layout: "ordinary entrypoint", args: [process.execPath, program] },
        { layout: "entrypoint after heap flag", args: [process.execPath, heapFlag, program] },
        {
          layout: "entrypoint after a preload named gateway",
          args: [process.execPath, "--require", "gateway", heapFlag, program],
        },
        {
          layout: "entrypoint after separate heap flag values",
          args: [
            process.execPath,
            "--max-old-space-size",
            "16384",
            "--max-semi-space-size",
            "64",
            program,
          ],
        },
        {
          layout: "relative entrypoint after heap flag",
          args: [process.execPath, heapFlag, path.basename(program)],
          workingDirectory: path.dirname(program),
        },
        { layout: "direct wrapper", args: [program] },
        {
          layout: "node-host entrypoint",
          args: [process.execPath, program],
          subcommand: ["node", "run"],
        },
        {
          layout: "node-host entrypoint after dev loader",
          args: [process.execPath, "--import", "tsx", program],
          subcommand: ["node", "run"],
        },
      ])(
        "requests repair before start for $layout",
        async ({ args, workingDirectory, subcommand = ["gateway"] }) => {
          const service = createService({
            readCommand: vi.fn(async () => ({
              programArguments: [...args, ...subcommand],
              workingDirectory,
            })),
            isLoaded: vi.fn(async () => true),
          });

          const result = await startGatewayService(service, { env: {}, stdout: process.stdout });

          expect.soft(result).toMatchObject({
            outcome: "repair-required",
            issues: [
              {
                code: `${kind}-program`,
                message: `service command points at a ${kind} path: ${program}`,
              },
            ],
          });
          expect(service.start).not.toHaveBeenCalled();
        },
      );
    });

    it.each([
      { layout: "ordinary entrypoint", args: [process.execPath, entrypoint] },
      {
        layout: "heap flags and unrelated preload path",
        args: [
          process.execPath,
          "--max-old-space-size",
          "16384",
          "--require",
          temporary,
          entrypoint,
        ],
        workingDirectory: os.tmpdir(),
      },
      {
        layout: "relative entrypoint",
        args: [process.execPath, heapFlag, path.basename(entrypoint)],
        workingDirectory: path.dirname(entrypoint),
      },
      { layout: "direct wrapper", args: [entrypoint] },
      {
        layout: "bare Node runtime for node host",
        args: ["node", entrypoint],
        subcommand: ["node", "run"],
      },
    ])(
      "starts $layout without inspecting application paths",
      async ({ args, workingDirectory, subcommand = ["gateway"] }) => {
        const service = createService({
          readCommand: vi.fn(async () => ({
            programArguments: [
              ...args,
              ...subcommand,
              "--config",
              missing,
              "--log-file",
              temporary,
              "gateway",
            ],
            workingDirectory,
          })),
          isLoaded: vi.fn(async () => true),
        });

        const result = await startGatewayService(service, { env: {}, stdout: process.stdout });

        expect(result.outcome).toBe("started");
        expect(service.start).toHaveBeenCalledOnce();
      },
    );
  });

  it("falls back to missing-install when start fails and install artifacts are gone", async () => {
    const readCommand = vi
      .fn<GatewayService["readCommand"]>()
      .mockResolvedValueOnce({
        programArguments: ["openclaw", "gateway", "run"],
      })
      .mockResolvedValueOnce(null);
    const service = createService({
      readCommand,
      start: vi.fn(async () => {
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
