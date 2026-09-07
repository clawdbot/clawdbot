/**
 * Tests managed-service update handoff behavior exposed by gateway methods.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { SUPERVISOR_HINT_ENV_VARS } from "./supervisor-markers.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "./update-control-plane-sentinel.js";
import {
  createManagedServiceManagerBoundary,
  pathExists,
} from "./update-managed-service-handoff-boundary.test-support.js";
import {
  cleanupStaleManagedServiceUpdateHandoffs,
  MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX,
} from "./update-managed-service-handoff-cleanup.js";
import {
  registerManagedRecoveryCommandTests,
  registerManagedLaunchdTeardownTests,
} from "./update-managed-service-handoff-command.test-support.js";
import {
  registerManagedSystemdHandoffConvergenceTests,
  registerManagedHandoffOwnerTests,
} from "./update-managed-service-handoff-lifecycle.test-support.js";
import { runManagedRepairAuthorityBoundary } from "./update-managed-service-handoff-repair.test-support.js";
import {
  registerManagedRecoveryOutcomeTests,
  registerManagedTerminalResultTests,
} from "./update-managed-service-handoff-result.test-support.js";
import { registerManagedUpdateHandoffTriageTests } from "./update-managed-service-handoff-triage.test-support.js";
import { signalMockManagedUpdateHandoffReady } from "./update-managed-service-handoff.test-support.js";

const { forceKillChildProcessTreeMock, resolvePreferredOpenClawTmpDirMock, spawnMock } = vi.hoisted(
  () => ({
    forceKillChildProcessTreeMock: vi.fn(),
    resolvePreferredOpenClawTmpDirMock: vi.fn(),
    spawnMock: vi.fn(),
  }),
);
const MOCK_INSTALL_ROOT = path.join(os.tmpdir(), `openclaw-handoff-lifecycle-${process.pid}`);

function createSpawnMock(params?: { pid?: number }) {
  const child = Object.assign(new EventEmitter(), {
    pid: params?.pid ?? process.pid,
    exitCode: null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    unref: vi.fn(),
  });
  return child;
}

const mockedHandoffLeaseCleanups = new Set<() => void>();

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessModule } =
    await import("../gateway/server-methods/node-child-process.test-support.js");
  return mockNodeChildProcessModule({
    spawn: spawnMock as unknown as typeof import("node:child_process").spawn,
  });
});

vi.mock("../process/child-process-tree.js", async () => {
  const actual = await vi.importActual<typeof import("../process/child-process-tree.js")>(
    "../process/child-process-tree.js",
  );
  return { ...actual, forceKillChildProcessTree: forceKillChildProcessTreeMock };
});

vi.mock("./tmp-openclaw-dir.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tmp-openclaw-dir.js")>()),
  resolvePreferredOpenClawTmpDir: resolvePreferredOpenClawTmpDirMock,
}));

const tempDirs = new Set<string>();
const managedProcessCleanups = new Set<() => Promise<void>>();

beforeEach(async () => {
  // Helpers in one fixture share a coordinator without touching the operator's database.
  const coordinatorDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-coordinator-")),
  );
  tempDirs.add(coordinatorDir);
  resolvePreferredOpenClawTmpDirMock.mockReturnValue(coordinatorDir);
  forceKillChildProcessTreeMock.mockReset();
  spawnMock.mockReset();
  spawnMock.mockImplementation((_command: string, args: string[]) => {
    const child = createSpawnMock();
    process.nextTick(() => {
      signalMockManagedUpdateHandoffReady({
        child,
        paramsPath: args.at(-1) ?? "",
        cleanups: mockedHandoffLeaseCleanups,
      });
    });
    return child;
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all([...managedProcessCleanups].map((cleanup) => cleanup()));
  managedProcessCleanups.clear();
  for (const cleanup of mockedHandoffLeaseCleanups) {
    cleanup();
  }
  closeOpenClawStateDatabaseForTest();
  await Promise.all([...tempDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
  vi.resetModules();
});

const runManagedServiceManagerBoundary = createManagedServiceManagerBoundary({
  spawnMock,
  tempDirs,
  cleanups: managedProcessCleanups,
});

describe("managed service update handoff", () => {
  const itUnix = it.runIf(process.platform !== "win32");

  registerManagedHandoffOwnerTests(runManagedServiceManagerBoundary, itUnix, expect);

  itUnix.each(["acknowledged", "stalled", "rejected"] as const)(
    "parks after the transferred pre-park notice is %s, within its bounded attempt",
    async (beforeParkNotice) => {
      const { commands, log, state } = await runManagedServiceManagerBoundary("systemd", {
        controlDisconnect: "transferred",
        beforeParkNotice,
        updaterExitCode: 0,
        updaterResult: { status: "ok", mode: "npm" },
      });
      expect(commands.some((command) => command.includes("stop openclaw-gateway.service"))).toBe(
        true,
      );
      expect(state).toMatchObject({ parked: true, stopCompleted: true });
      expect(log.includes("pre-park notice timed out after 10 seconds")).toBe(
        beforeParkNotice === "stalled",
      );
      expect(log.includes("pre-park notice failed")).toBe(beforeParkNotice === "rejected");
    },
  );

  itUnix.each(["systemd", "launchd"] as const)(
    "preserves updater staging and validation history after %s parking",
    async (kind) => {
      const { run } = await runManagedServiceManagerBoundary(kind, {
        ledger: true,
        updaterExitCode: 0,
        updaterResult: { status: "ok", mode: "npm" },
      });
      const steps = run?.steps.map((step) => step.step);
      expect(steps).toEqual(expect.arrayContaining(["staging", "validating"]));
      expect(steps).not.toContain("activating");
      expect(run?.steps).toContainEqual(
        expect.objectContaining({ step: "service-stop", status: "completed" }),
      );
    },
  );

  itUnix.each(
    (["systemd", "launchd"] as const).flatMap((kind) =>
      [false, true].map((recover) => ({ kind, recover })),
    ),
  )(
    "keeps $kind serving through ten minutes of validation before activation and preserves relative inputs (recovery=$recover)",
    async ({ kind, recover }) => {
      const { commands, state, sensitiveFilesRemoved } = await runManagedServiceManagerBoundary(
        kind,
        {
          controlDisconnect: "transferred",
          validationClockAdvanceMs: 10 * 60_000,
          relativeInput: true,
          updaterExitCode: recover ? 7 : 0,
          helperExitCode: recover ? 7 : 0,
          updaterResult: {
            status: recover ? "error" : "ok",
            mode: "npm",
            ...(recover ? { recovery: { serviceRestartSafe: true, version: "1.0.0" } } : {}),
          },
        },
      );
      expect(commands.some((command) => /\b(stop|bootout)\b/.test(command))).toBe(true);
      expect(state).toMatchObject({ parked: true });
      if (recover) {
        expect(state).toMatchObject({
          restored: true,
          healthProbeCount: 1,
          triageCalls: 1,
          triageObservedRestored: true,
          triageObservedRecovery: true,
        });
      }
      expect(sensitiveFilesRemoved).toBe(true);
    },
  );

  itUnix("carries the activation acknowledgement through the spawn fallback runner", async () => {
    const { state } = await runManagedServiceManagerBoundary("systemd", {
      controlDisconnect: "transferred",
      runnerFallback: true,
      updaterExitCode: 0,
      updaterResult: { status: "ok", mode: "npm" },
    });
    expect(state).toMatchObject({ parked: true, stopCompleted: true });
  });

  itUnix(
    "finalizes through the installed runtime after the updater replaces its module graph",
    async () => {
      const { run, log } = await runManagedServiceManagerBoundary("systemd", {
        controlDisconnect: "transferred",
        ledger: true,
        replaceLedgerWriter: true,
        updaterExitCode: 0,
        updaterResult: { status: "ok", mode: "npm" },
      });
      expect(run).toMatchObject({ status: "succeeded", phase: "finished" });
      expect(log).not.toContain("the previous runtime must not finalize the candidate");
      expect(log).toContain("managed update finalize command exited code=0");
    },
  );

  itUnix.each(["failed", "skipped"] as const)(
    "leaves the serving generation untouched when validation finishes %s",
    async (validationResult) => {
      const { commands, parentSignal, log } = await runManagedServiceManagerBoundary("systemd", {
        controlDisconnect: "transferred",
        validationResult,
        validationClockAdvanceMs: 10 * 60_000,
        helperExitCode: validationResult === "failed" ? 1 : 0,
      });
      expect(commands).toEqual([]);
      expect(parentSignal).toBeNull();
      expect(log).not.toContain("gateway service recovery");
    },
  );

  itUnix(
    "rechecks revoked chat ownership after validation before stopping the Gateway",
    async () => {
      const { commands, parentSignal, sentinel } = await runManagedServiceManagerBoundary(
        "systemd",
        {
          controlDisconnect: "transferred",
          requester: { channel: "slack", accountId: "primary", senderId: "owner" },
          revokeWhileValidating: true,
          helperExitCode: 1,
        },
      );
      expect(commands).toEqual([]);
      expect(parentSignal).toBeNull();
      expect(sentinel).toMatchObject({
        payload: { status: "error", stats: { reason: "owner_required" } },
      });
    },
  );

  itUnix.each(
    (["validating", "verifying"] as const).flatMap((phase) =>
      [false, true].map((revoke) => ({ phase, revoke })),
    ),
  )(
    "guards $phase repair effects with the current chat requester (revoked=$revoke)",
    async ({ phase, revoke }) => {
      const { commands, parentSignal, repairEffects, helperExitCode, log, run } =
        await runManagedRepairAuthorityBoundary(runManagedServiceManagerBoundary, phase, revoke);
      expect(commands).toEqual([]);
      expect(parentSignal).toBeNull();
      expect(repairEffects, log).toEqual({
        firstSpawn: true,
        secondSpawn: !revoke,
        firstExec: true,
        secondExec: !revoke,
        secondWrite: !revoke,
      });
      expect(helperExitCode, log).toBe(revoke ? 1 : 0);
      expect(run?.repair).toHaveLength(1);
      if (revoke) {
        expect(run?.steps).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              step: "repairing",
              status: "failed",
              detail: expect.stringContaining("requester-revoked"),
            }),
          ]),
        );
        expect(
          run?.steps.find((step) => step.step === "repairing" && step.status === "failed")?.detail,
        ).toContain(phase === "validating" ? "candidate rehearsal" : "live");
        expect(run?.repair[0]?.reason).toBe("requester-revoked");
      } else {
        expect(run?.repair[0]).toMatchObject({ status: "succeeded" });
      }
    },
    120_000,
  );

  itUnix("expires admission without interrupting the serving generation", async () => {
    const { commands, parentSignal, sentinel } = await runManagedServiceManagerBoundary("systemd", {
      parentExitTimeoutMs: 100,
    });
    expect(commands).toEqual([]);
    expect(parentSignal).toBeNull();
    expect(sentinel).toMatchObject({
      payload: { status: "skipped", stats: { reason: "managed-service-handoff-cancelled" } },
    });
  });

  itUnix("cancels a validating updater without stopping the serving generation", async () => {
    const { commands, parentSignal, log } = await runManagedServiceManagerBoundary("systemd", {
      controlDisconnect: "transferred",
      cancelDuringValidation: true,
    });
    expect(commands).toEqual([]);
    expect(parentSignal).toBeNull();
    expect(log).not.toContain("gateway service recovery");
    expect(log).toContain("managed update helper completed code=0");
  });

  itUnix.each([
    ["systemd", "requester"],
    ["systemd", "inspection"],
    ["launchd", "requester"],
    ["launchd", "inspection"],
  ] as const)("cancels before %s activation completes its %s check", async (kind, boundary) => {
    const { commands, parentSignal, state, sentinel } = await runManagedServiceManagerBoundary(
      kind,
      {
        controlDisconnect: "transferred",
        cancelAtActivation: boundary,
        ...(boundary === "requester"
          ? { requester: { channel: "synthetic", senderId: "owner" } }
          : {}),
      },
    );
    expect(commands.filter((command) => !/\b(?:show|print)\b/u.test(command))).toEqual([]);
    expect(parentSignal).toBeNull();
    expect(state.parked).toBeUndefined();
    expect(state.disabled).toBeUndefined();
    expect(sentinel).toMatchObject({
      payload: { status: "skipped", stats: { reason: "managed-service-handoff-cancelled" } },
    });
  });

  itUnix.each(["unarmed", "dead-parent"] as const)(
    "does not stop or update the service after %s control disconnect",
    async (controlDisconnect) => {
      const { commands, sentinel } = await runManagedServiceManagerBoundary("systemd", {
        controlDisconnect,
        updaterExitCode: 0,
      });
      expect(commands).toEqual([]);
      expect(sentinel).toMatchObject({
        payload: { status: "skipped", stats: { reason: "managed-service-handoff-cancelled" } },
      });
    },
  );

  it.each([
    ["spawn error", { code: "ENOENT" }],
    [
      "launcher exit",
      { message: "managed update handoff exited before signaling readiness (code=1, signal=null)" },
    ],
    [
      "readiness timeout",
      { message: "managed update handoff did not signal readiness within 30 seconds" },
    ],
  ] as const)("rejects %s and cleans up the sensitive handoff", async (failure, expected) => {
    if (failure === "readiness timeout") {
      vi.useFakeTimers();
    }
    const child = createSpawnMock();
    spawnMock.mockImplementationOnce(() => {
      // Readiness listeners and the deadline are installed after spawn returns.
      process.nextTick(() => {
        if (failure === "spawn error") {
          child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
        } else if (failure === "launcher exit") {
          child.emit("exit", 1, null);
        } else {
          vi.advanceTimersByTime(30_000);
        }
      });
      return child;
    });
    let env: NodeJS.ProcessEnv | undefined;
    if (failure === "launcher exit") {
      const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-systemd-run-bin-"));
      tempDirs.add(binDir);
      await fs.writeFile(path.join(binDir, "systemd-run"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      env = { PATH: binDir, OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service" };
    }
    const { startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");
    const resultPromise = startManagedServiceUpdateHandoff({
      root: MOCK_INSTALL_ROOT,
      restartDrainTimeoutMs: 300_000,
      parentPid: process.pid,
      execPath:
        failure === "spawn error" ? "/definitely/missing/openclaw-node" : "/usr/local/bin/node",
      argv1: "/opt/openclaw/openclaw.mjs",
      supervisor: failure === "launcher exit" ? "systemd" : undefined,
      env,
      meta: { sessionKey: "agent:test:webchat:dm:user-123" },
    });
    await expect(resultPromise).rejects.toMatchObject(expected);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0] as unknown as [string, string[]];
    const handoffDir = path.dirname(args.at(-2) ?? "");
    tempDirs.add(handoffDir);

    if (failure === "readiness timeout") {
      expect(forceKillChildProcessTreeMock).toHaveBeenCalledExactlyOnceWith(child);
    }
    expect(child.unref).not.toHaveBeenCalled();
    await expect(pathExists(handoffDir)).resolves.toBe(false);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.stdout.destroyed).toBe(true);
  });

  it("strips supervisor hints while preserving service identity for the CLI handoff", async () => {
    const { startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");
    const serviceIdentityEnv = {
      OPENCLAW_LAUNCHD_LABEL: "com.example.openclaw.test",
      OPENCLAW_SYSTEMD_UNIT: "openclaw-test.service",
      OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Test Gateway",
    } satisfies NodeJS.ProcessEnv;
    const supervisorEnv = Object.fromEntries(
      SUPERVISOR_HINT_ENV_VARS.map((key) => [key, "supervised"]),
    ) as NodeJS.ProcessEnv;

    const result = await startManagedServiceUpdateHandoff({
      root: MOCK_INSTALL_ROOT,
      timeoutMs: 1_800_000,
      restartDrainTimeoutMs: 300_000,
      restartDelayMs: 500,
      parentPid: process.pid,
      execPath: "/usr/local/bin/node",
      argv1: "/opt/openclaw/openclaw.mjs",
      env: {
        ...supervisorEnv,
        ...serviceIdentityEnv,
        KEEP_ME: "1",
      },
      meta: {
        sessionKey: "agent:test:webchat:dm:user-123",
        continuationMessage: "continue after restart",
      },
    });

    expect(result.status).toBe("started");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args, options] = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    tempDirs.add(path.dirname(args[0] ?? result.logPath));
    const helperParams = JSON.parse(await fs.readFile(args[1] ?? "", "utf-8")) as {
      metaPath: string;
      triageContextPath: string;
    };
    expect(options.env.KEEP_ME).toBe("1");
    for (const [key, value] of Object.entries(serviceIdentityEnv)) {
      expect(options.env[key]).toBe(value);
    }
    for (const key of SUPERVISOR_HINT_ENV_VARS.filter(
      (envKey) => !(envKey in serviceIdentityEnv),
    )) {
      expect(options.env[key]).toBeUndefined();
    }
    expect(options.env.OPENCLAW_UPDATE_RUN_HANDOFF).toBe("1");
    expect(options.env[CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]).toBe(helperParams.metaPath);
    expect(JSON.parse(await fs.readFile(helperParams.metaPath, "utf8"))).toMatchObject({
      meta: { triageContextPath: helperParams.triageContextPath },
    });
  });

  it("launches systemd handoffs through a transient user scope", async () => {
    const { startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-systemd-run-bin-"));
    tempDirs.add(binDir);
    const systemdRunPath = path.join(binDir, "systemd-run");
    await fs.writeFile(systemdRunPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const result = await startManagedServiceUpdateHandoff({
      root: MOCK_INSTALL_ROOT,
      timeoutMs: 1_800_000,
      restartDrainTimeoutMs: 300_000,
      restartDelayMs: 500,
      parentPid: process.pid,
      execPath: "/usr/local/bin/node",
      argv1: "/opt/openclaw/openclaw.mjs",
      handoffId: "handoff-123",
      channel: "beta",
      supervisor: "systemd",
      env: {
        PATH: binDir,
        OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service",
        INVOCATION_ID: "gateway-invocation",
        KEEP_ME: "1",
      },
      meta: {
        handoffId: "handoff-123",
        sessionKey: "agent:test:webchat:dm:user-123",
        continuationMessage: "continue after restart",
      },
    });

    expect(result.status).toBe("started");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv; detached?: boolean; cwd?: string },
    ];
    expect(command).toBe(systemdRunPath);
    expect(args.slice(0, 4)).toEqual([
      "--user",
      "--scope",
      "--collect",
      "--unit=openclaw-update-handoff-123.scope",
    ]);
    expect(args.slice(4, 7)).toEqual([
      "/usr/local/bin/node",
      expect.stringMatching(/handoff\.cjs$/u),
      expect.stringMatching(/handoff\.json$/u),
    ]);
    tempDirs.add(path.dirname(args[5] ?? result.logPath));
    const helperParams = JSON.parse(await fs.readFile(args[6] ?? "", "utf-8")) as {
      commandArgv?: string[];
      handoffId?: string;
      serviceRecovery?: unknown;
    };
    expect(helperParams.serviceRecovery).toEqual({
      kind: "systemd",
      unit: "openclaw-gateway.service",
    });
    expect(helperParams.commandArgv).toEqual([
      "/usr/local/bin/node",
      "/opt/openclaw/openclaw.mjs",
      "update",
      "--yes",
      "--json",
      "--channel",
      "beta",
      "--timeout",
      "1800",
    ]);
    expect(helperParams.handoffId).toBe("handoff-123");
    expect(options.detached).toBe(true);
    expect(options.env.OPENCLAW_SYSTEMD_UNIT).toBe("openclaw-gateway.service");
    expect(options.env.INVOCATION_ID).toBeUndefined();
    expect(options.env.KEEP_ME).toBe("1");
    expect(options.env.OPENCLAW_UPDATE_RUN_HANDOFF).toBe("1");
  });

  itUnix("parks and restores the exact user-systemd service from its detached helper", async () => {
    const { commands, sentinel, state } = await runManagedServiceManagerBoundary("systemd", {
      cancelAfterPark: true,
    });
    const verbs = commands.map((command) =>
      command.split(" ").find((part) => ["show", "stop", "reset-failed", "start"].includes(part)),
    );

    expect(verbs).toEqual(["show", "stop", "show", "start", "show"]);
    expect(commands.every((command) => command.startsWith("--user "))).toBe(true);
    expect(commands[0]).toContain(
      "--property=Id,LoadState,ActiveState,MainPID,ExecMainStartTimestampMonotonic,InvocationID",
    );
    expect(commands[1]).toContain("stop openclaw-gateway.service");
    expect(state).toMatchObject({ parked: true, restored: true });
    expect(state.guardedRestart).toBeUndefined();
    expect(sentinel).toMatchObject({
      payload: {
        status: "skipped",
        stats: {
          reason: "managed-service-handoff-cancelled",
          steps: expect.arrayContaining([
            expect.objectContaining({ name: "service-restore", log: { exitCode: 0 } }),
          ]),
        },
      },
    });
  });

  registerManagedRecoveryOutcomeTests(runManagedServiceManagerBoundary, itUnix, expect);

  registerManagedTerminalResultTests(runManagedServiceManagerBoundary, itUnix, expect, tempDirs);

  registerManagedSystemdHandoffConvergenceTests(runManagedServiceManagerBoundary, itUnix, expect);

  registerManagedRecoveryCommandTests(runManagedServiceManagerBoundary, itUnix, expect);

  registerManagedUpdateHandoffTriageTests(runManagedServiceManagerBoundary, itUnix, expect);

  itUnix.each([
    ["cannot restart", "start-failed", { startFailed: true }],
    ["reports a dead replacement PID", "dead-restored-pid", { restored: true }],
  ] as const)(
    "records one durable failure when the canonical systemd service %s",
    async (_label, systemdFault, expectedState) => {
      const { commands, parentSignal, sentinel, state } = await runManagedServiceManagerBoundary(
        "systemd",
        { cancelAfterPark: true, systemdFault },
      );

      expect(parentSignal).toBeNull();
      expect(commands.filter((command) => command.includes("reset-failed"))).toHaveLength(0);
      expect(
        commands.filter((command) => command.includes("start openclaw-gateway.service")),
      ).toHaveLength(1);
      expect(state).toMatchObject({ parked: true, ...expectedState });
      expect(state.triageCalls).toBe(1);
      expect(sentinel).toMatchObject({
        payload: {
          status: "error",
          stats: {
            reason: "managed-service-handoff-restore-failed",
            steps: expect.arrayContaining([
              expect.objectContaining({ name: "service-restore", log: { exitCode: 1 } }),
            ]),
          },
        },
      });
    },
  );

  itUnix("parks and restores the exact launchd service from its detached helper", async () => {
    const { commands, sentinel, state } = await runManagedServiceManagerBoundary("launchd", {
      cancelAfterPark: true,
    });
    const verbs = commands.map((command) => command.split(" ")[0]);
    const disable = verbs.indexOf("disable");
    const bootout = verbs.indexOf("bootout");
    const enable = verbs.indexOf("enable");
    const restart = verbs.findIndex((verb) => verb === "bootstrap" || verb === "kickstart");

    expect(disable).toBeGreaterThan(0);
    expect(commands[0]).toBe("print gui/501/ai.openclaw.gateway");
    expect(bootout).toBeGreaterThan(disable);
    expect(enable).toBeGreaterThan(bootout);
    expect(verbs.slice(bootout + 1, enable)).toContain("print");
    expect(restart).toBeGreaterThan(enable);
    expect(verbs.lastIndexOf("print")).toBeGreaterThan(restart);
    expect(commands[disable]).toBe("disable gui/501/ai.openclaw.gateway");
    expect(commands[bootout]).toBe("bootout gui/501/ai.openclaw.gateway");
    expect(commands.every((command) => !command.includes("kickstart -k"))).toBe(true);
    expect(state).toMatchObject({ disabled: false, parked: true, restored: true });
    expect(sentinel).toMatchObject({
      payload: {
        status: "skipped",
        stats: {
          reason: "managed-service-handoff-cancelled",
          steps: expect.arrayContaining([
            expect.objectContaining({ name: "service-restore", log: { exitCode: 0 } }),
          ]),
        },
      },
    });
  });

  registerManagedLaunchdTeardownTests(runManagedServiceManagerBoundary, itUnix, expect);

  it("passes a gateway service recovery descriptor for each supervisor", async () => {
    const { startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");
    const cases = [
      {
        supervisor: "launchd" as const,
        env: { OPENCLAW_LAUNCHD_LABEL: "test.gateway", HOME: "/Users/test" },
        expected: {
          kind: "launchd",
          uid: typeof process.getuid === "function" ? process.getuid() : 501,
          label: "test.gateway",
          plistPath: path.posix.join(
            "/Users/test",
            "Library",
            "LaunchAgents",
            "test.gateway.plist",
          ),
        },
      },
      {
        supervisor: "schtasks" as const,
        env: { OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Test Gateway" },
        expected: { kind: "schtasks", taskName: "OpenClaw Test Gateway" },
      },
    ];

    for (const testCase of cases) {
      const result = await startManagedServiceUpdateHandoff({
        root: MOCK_INSTALL_ROOT,
        timeoutMs: 1_800_000,
        restartDrainTimeoutMs: 300_000,
        restartDelayMs: 500,
        parentPid: process.pid,
        execPath: "/usr/local/bin/node",
        argv1: "/opt/openclaw/openclaw.mjs",
        supervisor: testCase.supervisor,
        env: testCase.env,
        meta: { sessionKey: "agent:test:webchat:dm:user-123" },
      });
      expect(result.status).toBe("started");
      const [, args] = spawnMock.mock.calls.at(-1) as unknown as [string, string[]];
      tempDirs.add(path.dirname(args[0] ?? ""));
      const helperParams = JSON.parse(await fs.readFile(args[1] ?? "", "utf-8")) as {
        serviceRecovery?: unknown;
      };
      expect(helperParams.serviceRecovery).toEqual(testCase.expected);
      const child = spawnMock.mock.results.at(-1)?.value as
        | ReturnType<typeof createSpawnMock>
        | undefined;
      child?.emit("exit", 0, null);
    }
  });

  it("sweeps stale handoff temp directories while keeping fresh handoff logs", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-cleanup-test-"));
    tempDirs.add(tmpDir);
    const staleDir = path.join(tmpDir, `${MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX}stale`);
    const freshDir = path.join(tmpDir, `${MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX}fresh`);
    const unrelatedDir = path.join(tmpDir, "openclaw-other-temp");
    await fs.mkdir(staleDir, { recursive: true });
    await fs.mkdir(freshDir, { recursive: true });
    await fs.mkdir(unrelatedDir, { recursive: true });
    const now = Date.now();
    const staleTime = new Date(now - 25 * 60 * 60_000);
    await fs.utimes(staleDir, staleTime, staleTime);

    await expect(
      cleanupStaleManagedServiceUpdateHandoffs({
        tmpDir,
        nowMs: now,
        ttlMs: 24 * 60 * 60_000,
      }),
    ).resolves.toBe(1);

    await expect(pathExists(staleDir)).resolves.toBe(false);
    await expect(pathExists(freshDir)).resolves.toBe(true);
    await expect(pathExists(unrelatedDir)).resolves.toBe(true);
  });
});
