// Keep the real lifecycle/version guards across the old-parent and fresh-CLI boundaries.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../config/config.js";
import { buildLaunchAgentPlist } from "../../daemon/launchd-plist.js";
import {
  resolveLaunchAgentPlistPath,
  resolveLaunchAgentEnvFilePath,
  resolveLaunchAgentEnvWrapperPath,
} from "../../daemon/launchd-service-files.js";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { captureEnv } from "../../test-utils/env.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { VERSION } from "../../version.js";
import { runDaemonRestart } from "../daemon-cli/lifecycle.js";
import { addGatewayServiceCommands } from "../daemon-cli/register-service-commands.js";
import * as startRepair from "../daemon-cli/start-repair.js";
import { assertGatewayServiceManagementAllowedForUpdate } from "./update-command-service-plan.js";
import {
  readyRecoveryHealth,
  registerRecoveryTests,
  writeRecoveryConfig,
} from "./update-command-service-recovery.test-support.js";
import { registerInstallRootTransitionTests } from "./update-command-service-transition.test-support.js";
import {
  maybeRestartService,
  maybeStopManagedServiceBeforeMutableUpdate,
  revalidateManagedGatewayServiceAfterUpdate,
} from "./update-command-service.js";

const mocks = vi.hoisted(() => ({
  launchctl: vi.fn<typeof import("../../daemon/launchd-exec.js").execLaunchctl>(),
  handoff:
    vi.fn<
      typeof import("../../daemon/launchd-restart-handoff.js").scheduleDetachedLaunchdRestartHandoff
    >(),
  inLaunchd: false,
  terminateStale: vi.fn(async (pids: number[]) => pids),
  running: true,
  loaded: true,
  listenerPids: vi.fn(() => [4242]),
  ports: vi.fn<typeof import("../../infra/ports-inspect.js").inspectPortUsage>(),
  probe: vi.fn<typeof import("../../gateway/probe.js").probeGateway>(),
  signal: vi.fn(),
  events: [] as string[],
  command: vi.fn<typeof import("../../daemon/systemd.js").readSystemdServiceExecStart>(),
  restart: vi.fn(async () => {
    mocks.events.push("native restart");
    mocks.running = true;
    return { outcome: "completed" as const };
  }),
  start: vi.fn(),
  install: vi.fn(),
  script: vi.fn(),
  child: vi.fn<typeof import("../../process/exec.js").runCommandWithTimeout>(),
  health: vi.fn<typeof import("../daemon-cli/restart-health.js").waitForGatewayHealthyRestart>(),
  doctor: vi.fn(),
  configSnapshot: vi.fn(async () => {
    throw new Error("Unexpected config snapshot during preserved activation");
  }),
  error: vi.fn(),
  log: vi.fn(),
  capability:
    vi.fn<
      typeof import("../../daemon/systemd-definition-mutation.js").readSystemdDefinitionMutationCapability
    >(),
}));

vi.mock(
  "../daemon-cli/lifecycle.runtime.js",
  async () => await import("../daemon-cli/lifecycle.js"),
);

vi.mock("../../daemon/launchd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/launchd-exec.js")>()),
  execLaunchctl: mocks.launchctl,
}));
vi.mock("../../daemon/launchd-current-service.js", () => ({
  isCurrentProcessLaunchdServiceLabel: () => mocks.inLaunchd,
}));
vi.mock("../../daemon/launchd-restart-handoff.js", () => ({
  scheduleDetachedLaunchdRestartHandoff: mocks.handoff,
}));
vi.mock("../../daemon/launchd-system.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/launchd-system.js")>()),
  assertNoSystemLaunchDaemonOwnership: async () => {},
  inspectSystemLaunchDaemonOwnership: async (label: string) => ({
    status: "absent",
    serviceTarget: `system/${label}`,
  }),
}));
vi.mock("../../infra/restart-stale-pids.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/restart-stale-pids.js")>()),
  cleanStaleGatewayProcessesSync: () => [],
  terminateStaleGatewayPids: mocks.terminateStale,
}));
vi.mock("../../infra/ports-inspect.js", () => ({
  inspectPortUsage: mocks.ports,
}));

vi.mock("../../gateway/probe.js", () => ({ probeGateway: mocks.probe }));

vi.mock("../../daemon/systemd.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd.js")>()),
  readSystemdServiceExecStart: mocks.command,
  readSystemdServiceRuntime: async () => ({ status: mocks.running ? "running" : "stopped" }),
  isSystemdServiceEnabled: async () => mocks.loaded,
  findInstalledSystemdGatewayScope: async () => null,
  isSystemdUserServiceAvailable: async () => true,
  stopSystemdService: async () => {
    mocks.events.push("native stop");
    mocks.running = false;
  },
  restartSystemdService: mocks.restart,
  startSystemdService: mocks.start,
  installSystemdService: mocks.install,
}));
vi.mock("../../daemon/systemd-definition-mutation.js", () => ({
  readSystemdDefinitionMutationCapability: mocks.capability,
}));
vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runCommandWithTimeout: mocks.child,
}));
vi.mock("../../infra/gateway-processes.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/gateway-processes.js")>()),
  findVerifiedGatewayListenerPidsOnPortSync: mocks.listenerPids,
  signalVerifiedGatewayPidSync: mocks.signal,
}));
vi.mock("../../commands/doctor.js", () => ({ doctorCommand: mocks.doctor }));
vi.mock("./update-command-config-snapshot.js", () => ({
  createUpdateConfigSnapshot: mocks.configSnapshot,
}));
vi.mock("./restart-helper.js", () => ({ runRestartScript: mocks.script }));
vi.mock("../../runtime.js", () => ({
  defaultRuntime: { log: mocks.log, error: mocks.error, exit: vi.fn(), writeJson: vi.fn() },
}));
vi.mock("../daemon-cli/restart-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon-cli/restart-health.js")>()),
  waitForGatewayHealthyRestart: mocks.health,
}));
vi.mock("../daemon-cli/lifecycle-audit.js", () => ({
  appendServiceLifecycleRepairAudit: vi.fn(),
  createServiceLifecycleMutationAudit: vi.fn(),
  createGatewayLifecycleMutationAudit: vi.fn(),
}));

let root: string;
let configPath: string;
let envSnapshot: ReturnType<typeof captureEnv>;
const writeConfig = (version: string) => writeRecoveryConfig(configPath, version);

beforeEach(async () => {
  vi.clearAllMocks();
  mockProcessPlatform("linux");
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-activation-")));
  vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: root });
  const keys = [
    "HOME",
    "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_PROFILE",
    "OPENCLAW_GATEWAY_PORT",
    "OPENCLAW_SERVICE_MARKER",
    "OPENCLAW_SERVICE_KIND",
    "OPENCLAW_SUPERVISOR_MODE",
    "OPENCLAW_SYSTEMD_UNIT",
    "OPENCLAW_LAUNCHD_LABEL",
    "OPENCLAW_UPDATE_IN_PROGRESS",
    "OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR",
    "OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS",
  ];
  envSnapshot = captureEnv(keys);
  for (const key of keys) {
    delete process.env[key];
  }
  process.env.HOME = root;
  configPath = path.join(root, ".openclaw", "openclaw.json");
  await fs.mkdir(path.dirname(configPath));
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: VERSION }),
  );
  await fs.writeFile(path.join(root, "dist", "index.js"), "export {};\n");
  await writeConfig(VERSION);
  mocks.ports.mockImplementation(async (port) => ({
    port,
    status: "free",
    listeners: [],
    hints: [],
  }));
  mocks.probe.mockReset();
  mocks.running = true;
  mocks.loaded = true;
  mocks.inLaunchd = false;
  mocks.launchctl.mockImplementation(async () => {
    throw new Error("Unexpected native control in fixture");
  });
  mocks.handoff.mockReturnValue({ ok: true, value: Promise.resolve(true) });
  mocks.events = [];
  mocks.capability.mockResolvedValue({ kind: "sealed", reason: "foreign-owner" });
  mocks.command.mockResolvedValue({
    programArguments: [
      process.execPath,
      path.join(root, "dist", "index.js"),
      "gateway",
      "--port",
      "19305",
    ],
    environment: { HOME: root },
    sourcePath: "/etc/systemd/system/openclaw-gateway.service",
  });
  mocks.child.mockImplementation(async (args) => {
    if (!args.includes("restart")) {
      throw new Error("Unexpected subprocess in activation fixture");
    }
    mocks.events.push("fresh CLI restart");
    mocks.running = true;
    return { code: 0, stdout: "", stderr: "", signal: null, killed: false, termination: "exit" };
  });
  mocks.health.mockImplementation(async ({ port }) => readyRecoveryHealth(port, mocks.running));
});
afterEach(async () => {
  envSnapshot.restore();
  clearConfigCache();
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe("preserved update activation with real version guards", () => {
  it.each([
    ...(
      [
        { mode: "git", outcome: "healthy" },
        { mode: "npm", outcome: "healthy" },
        { mode: "npm", outcome: "stale retry" },
      ] as const
    ).map(({ mode, outcome }) => ({
      mode,
      outcome,
      denial: "sealed" as const,
      channel: "stable" as const,
      phase: "initial",
    })),
    ...(["git", "npm", "pnpm", "bun"] as const).flatMap((mode) =>
      (["sealed", "unknown"] as const).flatMap((denial) =>
        (mode === "git" || mode === "npm"
          ? ["healthy", "json denial", "stale retry", "uninspectable", "foreign"]
          : ["healthy"]
        ).map((outcome) => ({
          mode,
          denial,
          outcome,
          channel: "stable" as const,
          phase: "late",
        })),
      ),
    ),
    ...(["sealed", "unknown"] as const).flatMap((denial) =>
      ["initial", "late"].flatMap((phase) =>
        ["healthy", "stale build", "missing build", "stale retry"].map((outcome) => ({
          mode: "git" as const,
          denial,
          outcome,
          channel: "dev" as const,
          phase,
        })),
      ),
    ),
  ])(
    "handles $phase $denial denial for $channel $mode activation ($outcome)",
    async ({ mode, denial, outcome, channel, phase }) => {
      const late = phase === "late";
      const serviceCommand = await mocks.command(process.env);
      if (!serviceCommand) {
        throw new Error("missing fixture command");
      }
      mocks.command.mockResolvedValue({
        ...serviceCommand,
        environment: { HOME: root, MANAGED_VALUE: "revalidated" },
      });
      mocks.capability.mockResolvedValue(
        late
          ? { kind: "writable" }
          : { kind: denial, reason: denial === "sealed" ? "foreign-owner" : "inspection-failed" },
      );
      const before = await maybeStopManagedServiceBeforeMutableUpdate({
        updateInstallKind: mode === "git" ? "git" : "package",
        root,
        shouldRestart: true,
        jsonMode: true,
      });
      expect(before.serviceUpdateVerdict).toMatchObject({ kind: "owned", refreshDefinition: late });
      const repair = vi.spyOn(startRepair, "repairLoadedGatewayServiceForStart");
      mocks.child.mockImplementation(async (args) => {
        if (args.includes("install")) {
          mocks.capability.mockResolvedValue({
            kind: denial,
            reason: denial === "sealed" ? "foreign-owner" : "inspection-failed",
          });
          if (outcome === "uninspectable") {
            mocks.command.mockRejectedValue(new Error("manager inspection failed"));
          } else if (outcome === "foreign") {
            const command = await mocks.command(process.env);
            mocks.command.mockResolvedValue({
              ...command,
              programArguments: ["/foreign/openclaw", "gateway"],
            });
          }
          return {
            code: 1,
            stdout:
              outcome === "json denial"
                ? JSON.stringify({
                    ok: false,
                    error: `SERVICE_DEFINITION_${denial.toUpperCase()}: late owner denial`,
                  })
                : "",
            stderr:
              outcome === "json denial"
                ? "runtime warning"
                : `SERVICE_DEFINITION_${denial.toUpperCase()}: late owner denial`,
            signal: null,
            killed: false,
            termination: "exit",
          };
        }
        const program = new Command().exitOverride();
        addGatewayServiceCommands(program.command("gateway"));
        await program.parseAsync(args.slice(2), { from: "user" });
        return {
          code: 0,
          stdout: "",
          stderr: "",
          signal: null,
          killed: false,
          termination: "exit",
        };
      });
      const commandBefore = await mocks.command(process.env);
      mocks.ports.mockImplementation(async (port) => ({
        port,
        status: "busy",
        listeners: [{ pid: 4242, command: "openclaw-gateway" }],
        hints: [],
      }));
      mocks.probe.mockImplementation(async ({ url }) => ({
        ok: true,
        url,
        connectLatencyMs: 1,
        error: null,
        close: null,
        auth: { role: "operator", scopes: ["operator.read"], capability: "read_only" },
        server: {
          version: VERSION,
          connId: "fixture",
          ...(outcome === "missing build"
            ? {}
            : { buildId: outcome === "stale build" ? "old-build" : "new-build" }),
        },
        health: {},
        status: {},
        presence: [],
        configSnapshot: null,
      }));
      const { waitForGatewayHealthyRestart } = await vi.importActual<
        typeof import("../daemon-cli/restart-health.js")
      >("../daemon-cli/restart-health.js");
      let retried = false;
      mocks.health.mockImplementation(async (params) => {
        const stale = outcome === "stale retry" && params.expectedVersion === VERSION && !retried;
        retried ||= stale;
        if (stale) {
          return {
            healthy: false,
            staleGatewayPids: [4242],
            runtime: { status: "running" },
            portUsage: { port: params.port, status: "busy", listeners: [], hints: [] },
          };
        }
        return await waitForGatewayHealthyRestart(params);
      });
      const activated = await maybeRestartService({
        channel,
        shouldRestart: true,
        result: {
          status: "ok",
          mode,
          root,
          steps: [],
          durationMs: 0,
          before: { version: "2026.1.1" },
          after: { version: VERSION, buildId: "new-build" },
        },
        opts: { json: outcome === "json denial" || (!late && channel === "stable") },
        refreshServiceEnv: late,
        serviceUpdateVerdict: before.serviceUpdateVerdict,
        serviceEnv: before.serviceEnv,
        gatewayPort: late ? 19001 : 19305,
        requireRunningServiceAfterRestart: true,
        restartScriptPath: "/fixture/prepared-restart.sh",
        timeoutMs: 1000,
      });
      const allowed = !["uninspectable", "foreign"].includes(outcome);
      const buildMismatch = ["stale build", "missing build"].includes(outcome);
      expect(activated).toBe(allowed && !buildMismatch);
      const restarts = mocks.child.mock.calls.filter(([args]) => args.includes("restart"));
      expect(restarts).toHaveLength(allowed ? (retried ? 2 : 1) : 0);
      for (const [args, options] of restarts) {
        expect(args).toContain("--preserve-definition");
        expect(typeof options === "object" && options.env?.MANAGED_VALUE).toBe("revalidated");
        if (!late && channel === "stable") {
          expect(args).toContain("--json");
        }
      }
      expect(mocks.start).not.toHaveBeenCalled();
      expect(mocks.child.mock.calls.filter(([args]) => args.includes("install"))).toHaveLength(
        late ? 1 : 0,
      );
      expect(mocks.restart).toHaveBeenCalledTimes(restarts.length);
      expect(mocks.health.mock.calls.every(([args]) => args.port === 19305)).toBe(true);
      if (retried) {
        expect(mocks.terminateStale).toHaveBeenCalledWith([4242]);
      }
      if (allowed) {
        expect(await mocks.command(process.env)).toEqual(commandBefore);
        const verification = mocks.health.mock.calls.filter(
          ([args]) => args.expectedVersion === VERSION,
        );
        expect(verification.length).toBe(retried ? 2 : 1);
        expect(verification.every(([args]) => args.requireRunningService === true)).toBe(true);
        expect(
          verification.every(
            ([args]) => args.expectedBuildId === (channel === "dev" ? "new-build" : undefined),
          ),
        ).toBe(true);
        expect(mocks.probe.mock.calls.every(([args]) => args.url === "ws://127.0.0.1:19305")).toBe(
          true,
        );
      }
      if (buildMismatch) {
        expect(
          mocks.error.mock.calls.flat().concat(mocks.log.mock.calls.flat()).join("\n"),
        ).toContain(
          `Gateway build mismatch: expected new-build, running gateway reported ${outcome === "missing build" ? "unavailable" : "old-build"}.`,
        );
      }
      expect(repair).not.toHaveBeenCalled();
      expect(mocks.script).not.toHaveBeenCalled();
      expect(mocks.install).not.toHaveBeenCalled();
      expect(mocks.doctor).not.toHaveBeenCalled();
    },
  );

  it("rejects a target without preservation support before automatic repair, with a JSON diagnostic", async () => {
    const before = await maybeStopManagedServiceBeforeMutableUpdate({
      updateInstallKind: "package",
      root,
      shouldRestart: true,
      jsonMode: true,
    });
    expect(before.stopped).toBe(true);
    // Permissions can change after the original preservation verdict.
    mocks.capability.mockResolvedValue({ kind: "writable" });
    const repair = vi
      .spyOn(startRepair, "repairLoadedGatewayServiceForStart")
      .mockRejectedValue(new Error("automatic repair reached"));
    mocks.child.mockImplementation(async (args, options) => {
      const snapshot = captureEnv([
        "OPENCLAW_UPDATE_IN_PROGRESS",
        "OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR",
      ]);
      if (typeof options === "object") {
        for (const key of [
          "OPENCLAW_UPDATE_IN_PROGRESS",
          "OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR",
        ]) {
          const value = options.env?.[key];
          if (value !== undefined) {
            process.env[key] = value;
          }
        }
      }
      let stderr = "";
      const program = new Command().exitOverride().configureOutput({
        writeErr: (text) => {
          stderr += text;
        },
      });
      // A target without this option must reject before its normal restart action.
      program
        .command("gateway")
        .command("restart")
        .option("--json")
        .action(async (opts: { json?: boolean }) => {
          await runDaemonRestart(opts);
        });
      try {
        await program.parseAsync(args.slice(2), { from: "user" });
        return { code: 0, stdout: "", stderr, signal: null, killed: false, termination: "exit" };
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("unknown option")) {
          throw error;
        }
        return { code: 1, stdout: "", stderr, signal: null, killed: false, termination: "exit" };
      } finally {
        snapshot.restore();
      }
    });
    const activated = await maybeRestartService({
      channel: "stable",
      shouldRestart: true,
      result: {
        status: "ok",
        mode: "npm",
        root,
        steps: [],
        durationMs: 0,
        after: { version: VERSION },
      },
      opts: { json: true },
      refreshServiceEnv: false,
      serviceUpdateVerdict: before.serviceUpdateVerdict,
      serviceEnv: before.serviceEnv,
      gatewayPort: 19305,
      requireRunningServiceAfterRestart: true,
      timeoutMs: 1000,
    });
    expect(repair).not.toHaveBeenCalled();
    expect(activated).toBe(false);
    expect(mocks.error.mock.calls.flat().join("\n")).toContain("unknown option");
    expect(mocks.error.mock.calls.flat().join("\n")).toContain("stopped");
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(mocks.health).not.toHaveBeenCalled();
  });

  registerRecoveryTests({ root: () => root, configPath: () => configPath, mocks });

  registerInstallRootTransitionTests(() => ({ root, mocks }));

  it.each(["metadata", "profile", "unit"])(
    "pins writable service identity across %s changes",
    async (change) => {
      mocks.capability.mockResolvedValue({ kind: "writable" });
      const before = await maybeStopManagedServiceBeforeMutableUpdate({
        updateInstallKind: "package",
        root,
        shouldRestart: true,
        jsonMode: true,
      });
      expect(before.stopped).toBe(true);
      expect(before.serviceEnv?.OPENCLAW_SYSTEMD_UNIT).toBeUndefined();
      const command = await mocks.command(process.env);
      if (!command) {
        throw new Error("missing fixture command");
      }
      mocks.command.mockResolvedValue({
        ...command,
        programArguments: [
          process.execPath,
          path.join(root, "dist", "index.js"),
          "gateway",
          "--port",
          "19002",
        ],
        environment: {
          HOME: root,
          OPENCLAW_GATEWAY_PORT: "19002",
          ...(change === "profile"
            ? {
                OPENCLAW_PROFILE: "second",
                OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-second.service",
                OPENCLAW_STATE_DIR: path.join(root, ".openclaw-second"),
                OPENCLAW_CONFIG_PATH: path.join(root, ".openclaw-second", "openclaw.json"),
              }
            : {
                OPENCLAW_PROFILE: "default",
                OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service",
                OPENCLAW_STATE_DIR: path.join(root, ".openclaw"),
                OPENCLAW_CONFIG_PATH: configPath,
              }),
          ...(change === "unit"
            ? { OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-custom.service" }
            : {}),
        },
      });
      const state = await readGatewayServiceState(resolveGatewayService(), {
        env: before.serviceEnv,
        requireEffective: true,
        validateEnvBeforeStatusRead: assertGatewayServiceManagementAllowedForUpdate,
      });
      const revalidated = revalidateManagedGatewayServiceAfterUpdate({
        state,
        root,
        preManagedServiceStop: before,
      });
      if (change !== "metadata") {
        expect(state.env.OPENCLAW_SYSTEMD_UNIT).toBe(
          change === "profile"
            ? "openclaw-gateway-second.service"
            : "openclaw-gateway-custom.service",
        );
        await expect(revalidated).rejects.toThrow("manager identity changed");
      } else {
        await expect(revalidated).resolves.toMatchObject({
          kind: "owned",
          refreshDefinition: true,
        });
      }
      expect(mocks.events).toEqual(["native stop"]);
    },
  );

  it.each(["git", "npm"] as const)(
    "delegates %s activation after candidate doctor stamps newer config",
    async (mode) => {
      const before = await maybeStopManagedServiceBeforeMutableUpdate({
        updateInstallKind: mode === "git" ? "git" : "package",
        root,
        shouldRestart: true,
        jsonMode: true,
      });
      expect(before.stopped).toBe(true);
      mocks.events.push("core updated");
      await writeConfig("9999.1.1");
      mocks.events.push("candidate doctor stamped config");
      const service = resolveGatewayService();
      const state = await readGatewayServiceState(service, { requireEffective: true });
      const verdict = await revalidateManagedGatewayServiceAfterUpdate({
        state,
        root,
        preManagedServiceStop: before,
      });

      const activated = await maybeRestartService({
        channel: "stable",
        shouldRestart: true,
        result: {
          status: "ok",
          mode,
          root,
          steps: [],
          durationMs: 0,
          before: { version: VERSION },
          after: { version: "9999.1.1" },
        },
        opts: {},
        refreshServiceEnv: false,
        serviceUpdateVerdict: verdict,
        serviceEnv: state.env,
        gatewayPort: 19305,
        requireRunningServiceAfterRestart: true,
        timeoutMs: 1000,
      });

      expect(activated, mocks.log.mock.calls.flat().join("\n")).toBe(true);
      expect(mocks.events).toEqual([
        "native stop",
        "core updated",
        "candidate doctor stamped config",
        "fresh CLI restart",
      ]);
      const child = mocks.child.mock.calls[0];
      expect(child?.[0].slice(1)).toEqual([
        path.join(root, "dist", "index.js"),
        "gateway",
        "restart",
        "--preserve-definition",
      ]);
      expect(mocks.health.mock.calls[0]?.[0]).toMatchObject({
        port: 19305,
        expectedVersion: "9999.1.1",
        requireRunningService: true,
      });
      expect(mocks.start).not.toHaveBeenCalled();
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(mocks.doctor).not.toHaveBeenCalled();
      // The old adapter still refuses the same config: delegation must not weaken its guard.
      await expect(service.restart({ env: state.env, stdout: process.stdout })).rejects.toThrow(
        "older than the config",
      );
    },
  );

  it.each(["sealed", "writable"] as const)(
    "fresh restart keeps the preserved launcher even when authority is %s",
    async (kind) => {
      mocks.capability.mockResolvedValue(
        kind === "sealed" ? { kind, reason: "foreign-owner" } : { kind },
      );
      await expect(runDaemonRestart({ json: true, preserveDefinition: true })).resolves.toBe(true);
      expect(mocks.restart).toHaveBeenCalledOnce();
      expect(mocks.install).not.toHaveBeenCalled();
      expect(mocks.health.mock.calls[0]?.[0].port).toBe(19305);
    },
  );

  it.each(["missing", "uninspectable", "disappeared after inspection"])(
    "does not fall through to an unmanaged listener when the selected service is %s",
    async (scenario) => {
      if (scenario === "uninspectable") {
        mocks.command.mockRejectedValue(new Error("manager unavailable"));
        await expect(runDaemonRestart({ json: true, preserveDefinition: true })).rejects.toThrow(
          "manager unavailable",
        );
      } else if (scenario === "missing") {
        mocks.command.mockResolvedValue(null);
        await expect(runDaemonRestart({ json: true, preserveDefinition: true })).rejects.toThrow(
          "could not be inspected",
        );
      } else {
        const command = await mocks.command(process.env);
        mocks.command.mockResolvedValueOnce(command).mockResolvedValue(null);
        mocks.loaded = false;
        await expect(runDaemonRestart({ json: true, preserveDefinition: true })).resolves.toBe(
          false,
        );
      }
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(mocks.install).not.toHaveBeenCalled();
      expect(mocks.listenerPids).not.toHaveBeenCalled();
      expect(mocks.signal).not.toHaveBeenCalled();
      expect(mocks.health).not.toHaveBeenCalled();
    },
  );

  it.each(["safe", "external"])(
    "refuses preserved activation through %s process signaling",
    async (mode) => {
      if (mode === "external") {
        process.env.OPENCLAW_SUPERVISOR_MODE = "external";
      }
      await expect(
        runDaemonRestart({ preserveDefinition: true, safe: mode === "safe" }),
      ).rejects.toThrow();
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(mocks.listenerPids).not.toHaveBeenCalled();
      expect(mocks.signal).not.toHaveBeenCalled();
    },
  );

  it.each([
    "loaded",
    "unloaded",
    "unloaded demand",
    "start demand",
    "handoff",
    "bootstrap denied",
    "parent unhealthy",
    "parent late sealed",
    "parent late unknown",
    "stale retry",
  ])("preserves actual LaunchAgent artifacts during %s activation", async (scenario) => {
    mockProcessPlatform("darwin");
    const label = "ai.openclaw.gateway";
    const plistPath = resolveLaunchAgentPlistPath(process.env);
    const envPath = resolveLaunchAgentEnvFilePath(process.env, label);
    const wrapperPath = resolveLaunchAgentEnvWrapperPath(process.env, label);
    const demandOnly = scenario.endsWith("demand");
    let plist = buildLaunchAgentPlist({
      label,
      programArguments: [
        process.execPath,
        path.join(root, "dist", "index.js"),
        "gateway",
        "--port",
        "19305",
      ],
      stdoutPath: path.join(root, "gateway.log"),
      stderrPath: path.join(root, "gateway.err"),
      environment: {
        HOME: root,
        OPENCLAW_GATEWAY_TOKEN: "fixture-inline-token",
        OPENCLAW_SERVICE_VERSION: "legacy",
      },
    });
    if (demandOnly) {
      plist = plist.replace(/(<key>(?:RunAtLoad|KeepAlive)<\/key>\s*)<true\s*\/>/g, "$1<false/>");
      expect(plist.match(/<key>(?:RunAtLoad|KeepAlive)<\/key>\s*<false\s*\/>/g)).toHaveLength(2);
    }
    const plistMode = scenario === "bootstrap denied" ? 0o400 : 0o444;
    for (const [file, content, mode] of [
      [plistPath, plist, plistMode],
      [envPath, "EXISTING=env\n", 0o600],
      [wrapperPath, "#!/bin/sh\n# existing wrapper\n", 0o700],
    ] as const) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content, { mode });
    }
    const snapshot = async () =>
      Promise.all(
        [plistPath, envPath, wrapperPath, configPath].map(async (file) => ({
          file,
          bytes: await fs.readFile(file),
          mode: (await fs.stat(file)).mode,
        })),
      );
    const before = await snapshot();
    const writeFile = vi.spyOn(fs, "writeFile");
    const chmod = vi.spyOn(fs, "chmod");
    const rename = vi.spyOn(fs, "rename");
    mocks.inLaunchd = scenario === "handoff";
    let loaded = ["loaded", "handoff", "stale retry"].includes(scenario);
    let nativeRunning = loaded;
    mocks.launchctl.mockImplementation(async (args) => {
      if (args[0] === "bootstrap") {
        if (scenario === "bootstrap denied") {
          return { code: 13, stdout: "", stderr: "permission denied", termination: "exit" };
        }
        loaded = true;
        nativeRunning = !demandOnly;
      }
      if ((args[0] === "print" || args[0] === "kickstart") && !loaded) {
        return { code: 113, stdout: "", stderr: "Could not find service", termination: "exit" };
      }
      if (args[0] === "kickstart") {
        nativeRunning = true;
      }
      const state = nativeRunning ? "running" : "stopped";
      return {
        code: 0,
        stdout: args[0] === "print" ? `state = ${state}\n` : "",
        stderr: "",
        termination: "exit",
      };
    });
    if (demandOnly) {
      mocks.health.mockImplementation(async ({ port }) => ({
        healthy: nativeRunning,
        staleGatewayPids: [],
        runtime: { status: nativeRunning ? "running" : "stopped" },
        portUsage: { port, status: nativeRunning ? "busy" : "free", listeners: [], hints: [] },
      }));
    }
    if (scenario === "stale retry") {
      mocks.health.mockResolvedValueOnce({
        healthy: false,
        staleGatewayPids: [4242],
        runtime: { status: "stopped" },
        portUsage: { port: 19305, status: "busy", listeners: [], hints: [] },
      });
    }
    let result: boolean;
    if (scenario === "start demand") {
      await resolveGatewayService().start({ env: process.env, stdout: process.stdout });
      result = nativeRunning;
    } else if (scenario.startsWith("parent")) {
      const lateDenial = scenario.startsWith("parent late");
      const verdict = lateDenial
        ? await revalidateManagedGatewayServiceAfterUpdate({
            state: await readGatewayServiceState(resolveGatewayService(), {
              requireEffective: true,
            }),
            root,
          })
        : { kind: "unresolved" as const, root, fingerprint: "fixture" };
      if (lateDenial) {
        expect(verdict).toMatchObject({ kind: "owned", refreshDefinition: true });
        mocks.child.mockResolvedValueOnce({
          code: 1,
          stdout: "",
          stderr: `SERVICE_DEFINITION_${scenario.endsWith("sealed") ? "SEALED" : "UNKNOWN"}: late denial`,
          signal: null,
          killed: false,
          termination: "exit",
        });
      }
      mocks.health.mockImplementation(async ({ port }) => ({
        healthy: false,
        staleGatewayPids: [],
        runtime: { status: "stopped" },
        portUsage: { port, status: "free", listeners: [], hints: [] },
      }));
      result = await maybeRestartService({
        channel: "stable",
        shouldRestart: true,
        result: {
          status: "ok",
          mode: "npm",
          root,
          steps: [],
          durationMs: 0,
          after: { version: VERSION },
        },
        opts: { json: true },
        refreshServiceEnv: lateDenial,
        serviceUpdateVerdict: verdict,
        serviceEnv: process.env,
        gatewayPort: lateDenial ? 19001 : 19305,
        restartScriptPath: "/fixture/prepared-restart.sh",
        requireRunningServiceAfterRestart: true,
        timeoutMs: 1000,
      });
      expect(mocks.error.mock.calls.flat().join("\n")).toContain("did not become healthy");
      expect(mocks.health.mock.calls.every(([args]) => args.port === 19305)).toBe(true);
      expect(mocks.script).not.toHaveBeenCalled();
      expect(mocks.doctor).not.toHaveBeenCalled();
    } else {
      result = await runDaemonRestart({ json: true, preserveDefinition: true });
    }
    expect(result).toBe(scenario !== "bootstrap denied" && !scenario.startsWith("parent"));
    expect(await snapshot()).toEqual(before);
    expect(mocks.configSnapshot).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(chmod).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    if (demandOnly || scenario === "unloaded") {
      const calls = mocks.launchctl.mock.calls.map(([args]) => args);
      const afterBootstrap = calls.slice(calls.findIndex((args) => args[0] === "bootstrap") + 1);
      const target = `gui/${process.getuid?.() ?? 501}/${label}`;
      expect(afterBootstrap).toContainEqual(["kickstart", target]);
      expect(afterBootstrap).not.toContainEqual(["kickstart", "-k", target]);
    }
    if (scenario === "stale retry") {
      expect(mocks.terminateStale).toHaveBeenCalledWith([4242]);
      expect(mocks.launchctl.mock.calls.filter(([args]) => args[0] === "kickstart")).toHaveLength(
        2,
      );
      expect(mocks.health).toHaveBeenCalledTimes(2);
    }
    if (scenario.startsWith("parent")) {
      expect(mocks.launchctl.mock.calls.every(([args]) => args[0] === "print")).toBe(true);
    } else if (scenario === "handoff") {
      expect(mocks.handoff).toHaveBeenCalledWith(expect.objectContaining({ mode: "kickstart" }));
    } else {
      expect(mocks.launchctl.mock.calls.some(([args]) => args[0] === "kickstart")).toBe(true);
      expect(mocks.launchctl.mock.calls.some(([args]) => args[0] === "bootstrap")).toBe(
        !["loaded", "stale retry"].includes(scenario),
      );
    }
  });

  it("fresh restart still rejects config newer than its own binary", async () => {
    await writeConfig("9999.1.1");
    await expect(runDaemonRestart({ json: true, preserveDefinition: true })).resolves.toBe(false);
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.health).not.toHaveBeenCalled();
  });
});
