import path from "node:path";
import type { Readable } from "node:stream";

type ManagedSystemdPostExitState = {
  activeState: string;
  generation?: "cleared" | "parked" | "replacement";
  id?: string;
  invocation?: "cleared" | "parked" | "replacement";
  loadState?: string;
  mainPid?: "parent" | "replacement" | "none";
};

export type ManagedServiceManagerBoundaryOptions = {
  cancelAfterPark?: boolean;
  parentExitTimeoutMs?: number;
  launchdFault?: "wrong-parent" | "missing-restored-pid" | "dead-restored-pid";
  launchdTeardown?: {
    bootoutDelayMs?: number;
    clockEachCommandMs?: number;
    loadedPrints?: number;
    pendingBootstrapFailures?: number;
    pendingOperationInProgress?: number;
  };
  overdueCommit?: boolean;
  systemdFault?: "start-failed" | "dead-restored-pid";
  systemdHandoffDeadlineMs?: number;
  systemdHandoffFailure?: boolean;
  systemdPostExitStates?: ManagedSystemdPostExitState[];
  systemdStopDelayMs?: number;
  updaterExitCode?: number;
  updaterSignal?: NodeJS.Signals;
  recoveryExitCode?: number;
  recoveryHang?: boolean;
  recoverySentinel?: "retained" | "consumed" | "replaced";
};

export type ManagedServiceCommandTiming = {
  action: string;
  startedAtMs: number;
  timeoutMs: number;
};

export type ManagedServiceManagerBoundaryResult = {
  commands: string[];
  parentSignal: NodeJS.Signals | null;
  state: Record<string, unknown>;
  sentinel: unknown;
  commandTimings: ManagedServiceCommandTiming[];
};

type ManagedSystemdFailureCase = readonly [string, ManagedSystemdPostExitState];

type ManagedTestApi = {
  (name: string, callback: () => Promise<void>): void;
  each(
    cases: readonly ManagedSystemdFailureCase[],
  ): (
    name: string,
    callback: (label: string, value: ManagedSystemdPostExitState) => Promise<void>,
  ) => void;
};

type ManagedExpectation = {
  toBeNull(): void;
  toBeUndefined(): void;
  toEqual(expected: unknown): void;
  toHaveLength(expected: number): void;
  toMatchObject(expected: unknown): void;
};

type ManagedExpect = {
  (actual: unknown): ManagedExpectation;
  arrayContaining(expected: readonly unknown[]): unknown;
  objectContaining(expected: object): unknown;
};

export function registerManagedSystemdHandoffConvergenceTests(
  runManagedServiceManagerBoundary: (
    kind: "systemd",
    options?: ManagedServiceManagerBoundaryOptions,
  ) => Promise<ManagedServiceManagerBoundaryResult>,
  itUnix: ManagedTestApi,
  expect: ManagedExpect,
): void {
  itUnix("waits for the exact systemd stop job to finish after parent exit", async () => {
    const { commands, sentinel, state } = await runManagedServiceManagerBoundary("systemd", {
      systemdPostExitStates: [
        { activeState: "deactivating", mainPid: "none" },
        { activeState: "inactive", mainPid: "none" },
      ],
      systemdStopDelayMs: 100,
      updaterExitCode: 0,
    });

    expect(commands.map((command) => command.split(" ")[1])).toEqual([
      "show",
      "stop",
      "show",
      "show",
    ]);
    expect(state).toMatchObject({ parked: true, postExitShows: 2, stopCompleted: true });
    expect(state.reset).toBeUndefined();
    expect(state.restored).toBeUndefined();
    expect(sentinel).toBeNull();
  });

  itUnix.each([
    [
      "an inactive replacement generation",
      {
        activeState: "inactive",
        generation: "replacement",
        invocation: "replacement",
        mainPid: "none",
      },
    ],
    [
      "a cleared generation with the parked invocation",
      { activeState: "inactive", generation: "cleared", invocation: "parked", mainPid: "none" },
    ],
    [
      "the parked generation with a cleared invocation",
      { activeState: "inactive", generation: "parked", invocation: "cleared", mainPid: "none" },
    ],
    ["a replacement main PID", { activeState: "deactivating", mainPid: "replacement" }],
    ["an active service", { activeState: "active", mainPid: "replacement" }],
    ["a restarting service", { activeState: "activating", mainPid: "none" }],
    ["a failed service", { activeState: "failed", mainPid: "none" }],
    ["an inactive service retaining a main PID", { activeState: "inactive", mainPid: "parent" }],
    ["a replaced service unit", { activeState: "inactive", id: "replacement.service" }],
    ["an unloaded service unit", { activeState: "inactive", loadState: "not-found" }],
  ] as const)(
    "fails closed after stop completion when systemd reports %s",
    async (_label, invalidState) => {
      const { commands, sentinel, state } = await runManagedServiceManagerBoundary("systemd", {
        systemdHandoffFailure: true,
        systemdPostExitStates: [invalidState],
      });

      expect(state).toMatchObject({ parked: true, stopCompleted: true, postExitShows: 1 });
      expect(commands.filter((command) => command.includes("reset-failed"))).toHaveLength(1);
      expect(sentinel).toMatchObject({
        payload: {
          status: "error",
          stats: {
            reason: "managed-service-handoff-helper-failed",
            steps: expect.arrayContaining([
              expect.objectContaining({ name: "service-restore", log: { exitCode: 0 } }),
            ]),
          },
        },
      });
    },
  );

  itUnix(
    "fails closed when the exact systemd stop job exhausts the parent-exit deadline",
    async () => {
      const { sentinel, state } = await runManagedServiceManagerBoundary("systemd", {
        systemdHandoffDeadlineMs: 5_000,
        systemdHandoffFailure: true,
        systemdStopDelayMs: 6_000,
      });

      expect(state).toMatchObject({ parked: true, reset: true, restored: true });
      expect(state.stopCompleted).toBeUndefined();
      expect(sentinel).toMatchObject({
        payload: { status: "error", stats: { reason: "managed-service-handoff-helper-failed" } },
      });
    },
  );
}

export function registerManagedLaunchdHandoffRestorationTests(
  runManagedServiceManagerBoundary: (
    kind: "launchd",
    options?: ManagedServiceManagerBoundaryOptions,
  ) => Promise<ManagedServiceManagerBoundaryResult>,
  itUnix: ReturnType<typeof import("vitest").it.runIf>,
  expect: typeof import("vitest").expect,
): void {
  itUnix("parks and restores the exact launchd service from its detached helper", async () => {
    const { commands, sentinel, state } = await runManagedServiceManagerBoundary("launchd");
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
        status: "error",
        stats: {
          reason: "managed-service-handoff-failed",
          steps: expect.arrayContaining([
            expect.objectContaining({ name: "service-restore", log: { exitCode: 0 } }),
          ]),
        },
      },
    });
  });

  itUnix.each([
    {
      label: "keeps bootout alive beyond the short command timeout before authorizing the updater",
      options: { launchdTeardown: { bootoutDelayMs: 5_250, loadedPrints: 2 } },
      updaterRan: true,
    },
    {
      label: "restores a cancelled handoff after loaded teardown and transient bootstrap EIO",
      options: {
        cancelAfterPark: true,
        launchdTeardown: { loadedPrints: 2, pendingBootstrapFailures: 2 },
      },
      updaterRan: false,
    },
    {
      label: "restores an expired handoff after loaded teardown and transient bootstrap EIO",
      options: {
        parentExitTimeoutMs: 500,
        launchdTeardown: { loadedPrints: 2, pendingBootstrapFailures: 2 },
      },
      updaterRan: false,
    },
    {
      label:
        "retries canonical bootstrap when an operation-in-progress service disappears during restoration",
      options: {
        cancelAfterPark: true,
        launchdTeardown: { loadedPrints: 2, pendingOperationInProgress: 1 },
      },
      updaterRan: false,
    },
  ])(
    "$label",
    async ({ options, updaterRan }) => {
      const { commands, parentSignal, sentinel, state } = await runManagedServiceManagerBoundary(
        "launchd",
        options,
      );
      const verbs = commands.map((command) => command.split(" ")[0]);

      expect(state).toMatchObject({
        disabled: false,
        parked: true,
        unloaded: true,
        restored: true,
        loadedPrintsObserved: 2,
        ...(updaterRan
          ? { bootoutCompleted: true, updaterObservedUnloaded: true }
          : {
              pendingBootstrapFailures: 0,
              bootstrapAttempts: "pendingOperationInProgress" in options.launchdTeardown ? 2 : 3,
              ...("pendingOperationInProgress" in options.launchdTeardown
                ? { operationInProgressObserved: 1, pendingOperationInProgress: 0 }
                : {}),
            }),
      });
      expect(verbs.filter((verb) => verb === "print").length).toBeGreaterThanOrEqual(4);
      expect(parentSignal).toBe("parentExitTimeoutMs" in options ? "SIGKILL" : null);
      expect(sentinel).toMatchObject({
        payload: {
          status: "error",
          stats: {
            reason: updaterRan
              ? "managed-service-handoff-failed"
              : "managed-service-handoff-cancelled",
            steps: expect.arrayContaining([
              expect.objectContaining({ name: "service-restore", log: { exitCode: 0 } }),
            ]),
          },
        },
      });
    },
    20_000,
  );

  itUnix(
    "never starts launchd bootstrap after its absolute restoration deadline or grants a command excess time",
    async () => {
      const { commandTimings, commands, sentinel, state } = await runManagedServiceManagerBoundary(
        "launchd",
        {
          cancelAfterPark: true,
          launchdTeardown: { clockEachCommandMs: 5_000, loadedPrints: 4 },
        },
      );
      const restoreIndex = commandTimings.findIndex(({ action }) => action === "enable");
      expect(restoreIndex).toBeGreaterThan(0);
      const restoration = commandTimings.slice(restoreIndex);
      const restoreStartedAtMs = restoration[0]?.startedAtMs ?? 0;

      expect(restoration.map(({ action }) => action)).toEqual([
        "enable",
        "print",
        "print",
        "print",
        "print",
        "print",
      ]);
      expect(commands.some((command) => command.startsWith("bootstrap "))).toBe(false);
      for (const { startedAtMs, timeoutMs } of restoration) {
        const elapsedMs = startedAtMs - restoreStartedAtMs;
        expect(elapsedMs).toBeLessThan(30_000);
        expect(timeoutMs).toBeLessThanOrEqual(5_000);
        expect(elapsedMs + timeoutMs).toBeLessThanOrEqual(30_000);
      }
      expect(restoration.at(-1)?.timeoutMs).toBeLessThan(5_000);
      expect(state).toMatchObject({ disabled: false, parked: true, unloaded: true });
      expect(state.restored).toBeUndefined();
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
    15_000,
  );

  itUnix(
    "rejects a launchd target owned by a different parent without native mutation",
    async () => {
      const { commands, sentinel, state } = await runManagedServiceManagerBoundary("launchd", {
        launchdFault: "wrong-parent",
      });

      expect(commands).toEqual(["print gui/501/ai.openclaw.gateway"]);
      expect(state).toEqual({});
      expect(sentinel).toMatchObject({
        payload: {
          status: "error",
          stats: { reason: "managed-service-handoff-cancelled" },
        },
      });
    },
  );

  itUnix.each([
    ["a missing PID", "missing-restored-pid"],
    ["a dead PID", "dead-restored-pid"],
  ] as const)("rejects launchd restoration reporting running with %s", async (_label, fault) => {
    const { commands, sentinel, state } = await runManagedServiceManagerBoundary("launchd", {
      launchdFault: fault,
      cancelAfterPark: true,
    });

    expect(commands).toEqual(
      expect.arrayContaining([
        "disable gui/501/ai.openclaw.gateway",
        "bootout gui/501/ai.openclaw.gateway",
        "enable gui/501/ai.openclaw.gateway",
      ]),
    );
    expect(state).toMatchObject({ disabled: false, parked: true, restored: true });
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
  });
}

export function createManagedServiceManagerFixtureScript(params: {
  kind: "systemd" | "launchd";
  parentPid: number;
  statePath: string;
  commandsPath: string;
  options?: ManagedServiceManagerBoundaryOptions;
}): string {
  const { commandsPath, kind, options, parentPid, statePath } = params;
  return `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(statePath)};
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
fs.appendFileSync(${JSON.stringify(commandsPath)}, args.join(" ") + "\\n");
const action = args.find((arg) => ["show", "stop", "reset-failed", "start", "print", "disable", "bootout", "enable", "bootstrap", "kickstart"].includes(arg));
if (${JSON.stringify(kind)} === "systemd") {
  if (action === "stop") {
    state.parked = true;
    fs.writeFileSync(statePath, JSON.stringify(state));
    for (;;) {
      try { process.kill(${parentPid}, 0); sleep(10); } catch { break; }
    }
    sleep(${options?.systemdStopDelayMs ?? 0});
    state.stopCompleted = true;
  }
  if (action === "reset-failed") state.reset = true;
  if (action === "start" && ${JSON.stringify(options?.systemdFault)} === "start-failed") {
    state.startFailed = true;
    process.stderr.write("start limit hit\\n");
    process.exitCode = 1;
  } else if (action === "start") state.restored = true;
  if (action === "show") {
    const active = !state.parked || state.restored;
    const restoredPid = ${JSON.stringify(options?.systemdFault)} === "dead-restored-pid" ? 2147483647 : ${process.pid};
    const postExitStates = ${JSON.stringify(options?.systemdPostExitStates ?? [])};
    const observation = state.parked && !state.restored && postExitStates.length
      ? postExitStates[Math.min(state.postExitShows || 0, postExitStates.length - 1)]
      : undefined;
    if (observation) state.postExitShows = (state.postExitShows || 0) + 1;
    const observedPid = observation?.mainPid === "parent" ? ${parentPid}
      : observation?.mainPid === "replacement" ? ${process.pid}
      : observation?.mainPid === "none" ? 0
      : state.restored ? restoredPid : active ? ${parentPid} : 0;
    const observedGeneration = state.restored || observation?.generation === "replacement" ? "222"
      : observation?.generation === "parked" ? "111"
        : observation?.generation === "cleared" ? "0"
          : active || observation?.activeState === "deactivating" ? "111" : "0";
    const observedInvocation = state.restored || observation?.invocation === "replacement"
      ? "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      : observation?.invocation === "parked" ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        : observation?.invocation === "cleared" ? ""
          : active || observation?.activeState === "deactivating"
            ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            : "";
    process.stdout.write([
      "Id=" + (observation?.id || "openclaw-gateway.service"),
      "LoadState=" + (observation?.loadState || "loaded"),
      "ActiveState=" + (observation?.activeState || (active ? "active" : "inactive")),
      "MainPID=" + observedPid,
      "ExecMainStartTimestampMonotonic=" + observedGeneration,
      "InvocationID=" + observedInvocation,
    ].join("\\n") + "\\n");
  }
  } else {
  if (action === "disable") state.disabled = true;
  if (action === "bootout") {
    state.parked = true;
    state.loadedPrintsRemaining = ${options?.launchdTeardown?.loadedPrints ?? 0};
    state.pendingBootstrapFailures = ${options?.launchdTeardown?.pendingBootstrapFailures ?? 0};
    state.pendingOperationInProgress = ${options?.launchdTeardown?.pendingOperationInProgress ?? 0};
    const delay = ${options?.launchdTeardown?.bootoutDelayMs ?? 0};
    if (delay) setTimeout(() => {
      state.bootoutCompleted = true;
      fs.writeFileSync(statePath, JSON.stringify(state));
    }, delay);
  }
  if (action === "enable") state.disabled = false;
  if (action === "bootstrap" || action === "kickstart") {
    state.bootstrapAttempts = (state.bootstrapAttempts || 0) + 1;
    if (state.pendingOperationInProgress > 0) {
      state.pendingOperationInProgress -= 1;
      state.operationInProgressObserved = (state.operationInProgressObserved || 0) + 1;
      process.stderr.write("Bootstrap failed: 37: Operation already in progress\\n");
      process.exitCode = 37;
    } else if (!state.unloaded) {
      process.stderr.write("Bootstrap failed: 37: Operation already in progress\\n");
      process.exitCode = 37;
    } else if (action === "bootstrap" && state.pendingBootstrapFailures > 0) {
      state.pendingBootstrapFailures -= 1;
      process.stderr.write("Bootstrap failed: 5: Input/output error\\n");
      process.exitCode = 5;
    } else state.restored = true;
  }
  if (action === "print") {
    let parentAlive = false;
    try { process.kill(${parentPid}, 0); parentAlive = true; } catch {}
    if (state.parked && !state.restored && !parentAlive) {
      if (state.loadedPrintsRemaining > 0) {
        state.loadedPrintsRemaining -= 1;
        state.loadedPrintsObserved = (state.loadedPrintsObserved || 0) + 1;
      } else {
        state.unloaded = true;
        process.stderr.write("Could not find service\\n");
        fs.writeFileSync(statePath, JSON.stringify(state));
        process.exit(113);
      }
    }
    const fault = ${JSON.stringify(options?.launchdFault)};
    if (state.restored && fault === "missing-restored-pid") {
      process.stdout.write("state = running\\n");
    } else {
      const restoredPid = fault === "dead-restored-pid" ? 2147483647 : ${process.pid};
      const currentPid = fault === "wrong-parent" ? ${process.pid} : ${parentPid};
      process.stdout.write("state = running\\npid = " + (state.restored ? restoredPid : currentPid) + "\\n");
    }
  }
}
fs.writeFileSync(statePath, JSON.stringify(state));
`;
}

export function createManagedServiceLaunchdClockPreload(params: {
  commandTimingsPath: string;
  clockEachCommandMs: number;
}): string {
  return [
    'const fs = require("node:fs");',
    'const children = require("node:child_process");',
    "const actualSpawn = children.spawn;",
    "const actualSetTimeout = global.setTimeout;",
    "const startedAt = Date.now();",
    "let elapsed = 0;",
    "Date.now = () => startedAt + elapsed;",
    "global.setTimeout = (callback, delay, ...args) => {",
    "  if (delay === 500) {",
    "    elapsed += delay;",
    "    return actualSetTimeout(callback, 0, ...args);",
    "  }",
    "  return actualSetTimeout(callback, delay, ...args);",
    "};",
    "children.spawn = (command, args, options) => {",
    '  if (command === "launchctl") {',
    "    const timeoutMs = options.timeout;",
    "    const startedAtMs = Date.now();",
    `    fs.appendFileSync(${JSON.stringify(params.commandTimingsPath)}, JSON.stringify({ action: args[0], startedAtMs, timeoutMs }) + "\\n");`,
    `    elapsed += Math.min(${params.clockEachCommandMs}, timeoutMs);`,
    "  }",
    "  return actualSpawn(command, args, options);",
    "};",
  ].join("\n");
}

export function createManagedServiceUpdateCommandFixture(params: {
  kind: "systemd" | "launchd";
  root: string;
  statePath: string;
  updaterPath: string;
  stateDatabasePath: string;
  options?: ManagedServiceManagerBoundaryOptions;
}) {
  const { kind, root, statePath, updaterPath, options } = params;
  const recovery =
    kind === "systemd"
      ? { kind, unit: "openclaw-gateway.service" }
      : {
          kind,
          uid: 501,
          label: "ai.openclaw.gateway",
          plistPath: path.join(root, "ai.openclaw.gateway.plist"),
        };
  return {
    serviceRecovery: recovery,
    commandArgv: [
      process.execPath,
      "-e",
      [
        `const fs = require("node:fs");`,
        ...(kind === "launchd"
          ? [
              `const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8"));`,
              `if (!state.unloaded) process.exit(19);`,
              `state.updaterObservedUnloaded = true;`,
              `fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));`,
            ]
          : []),
        `fs.writeFileSync(${JSON.stringify(updaterPath)}, "ran");`,
        options?.updaterSignal
          ? `process.kill(process.pid, ${JSON.stringify(options.updaterSignal)});`
          : `process.exit(${options?.updaterExitCode ?? 80});`,
      ].join(""),
    ],
    recoveryCommandArgv: [
      process.execPath,
      "-e",
      [
        `const fs = require("node:fs");`,
        `const { spawnSync } = require("node:child_process");`,
        `const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8"));`,
        `state.guardedRestart = process.argv.slice(1);`,
        `fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));`,
        ...(options?.recoverySentinel
          ? [
              `const { DatabaseSync } = require("node:sqlite");`,
              `const db = new DatabaseSync(${JSON.stringify(params.stateDatabasePath)});`,
              `const row = db.prepare("SELECT payload_json FROM gateway_restart_sentinel WHERE sentinel_key = 'current'").get();`,
              `state.sentinelAtRecovery = JSON.parse(row.payload_json);`,
              `fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));`,
              ...(options.recoverySentinel === "consumed"
                ? [
                    `db.prepare("DELETE FROM gateway_restart_sentinel WHERE sentinel_key = 'current'").run();`,
                  ]
                : options.recoverySentinel === "replaced"
                  ? [
                      `const replacement = { ...state.sentinelAtRecovery, stats: { ...state.sentinelAtRecovery.stats, reason: "newer update failure" } };`,
                      `db.prepare("UPDATE gateway_restart_sentinel SET payload_json = ?, stats_json = ?, updated_at_ms = updated_at_ms + 1 WHERE sentinel_key = 'current'").run(JSON.stringify(replacement), JSON.stringify(replacement.stats));`,
                    ]
                  : []),
              `db.close();`,
            ]
          : []),
        ...(options?.recoveryHang
          ? [
              `const { spawn } = require("node:child_process");`,
              `state.recoveryDescendantPid = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }).pid;`,
              `fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));`,
              `setInterval(() => {}, 1000);`,
            ]
          : options?.recoveryExitCode === undefined
            ? (kind === "systemd"
                ? [
                    ["--user", "reset-failed", recovery.unit],
                    ["--user", "start", recovery.unit],
                    ["--user", "show", recovery.unit],
                  ]
                : [
                    ["enable", `gui/501/ai.openclaw.gateway`],
                    ["bootstrap", "gui/501", path.join(root, "ai.openclaw.gateway.plist")],
                    ["print", "gui/501/ai.openclaw.gateway"],
                  ]
              ).map(
                (args) =>
                  `if (spawnSync(${JSON.stringify(kind === "systemd" ? "systemctl" : "launchctl")}, ${JSON.stringify(args)}).status !== 0) process.exit(1);`,
              )
            : [`process.exit(${options.recoveryExitCode});`]),
      ].join(""),
      "--",
      "gateway",
      "restart",
      "--preserve-definition",
      "--json",
    ],
  };
}

export async function waitForHandoffResponse(
  output: Readable | null,
  expected: string,
): Promise<void> {
  if (!output) {
    throw new Error("expected managed handoff helper stdout");
  }
  await new Promise<void>((resolve, reject) => {
    let buffered = "";
    const onData = (chunk: Buffer | string) => {
      buffered = `${buffered}${chunk.toString()}`.slice(-1024);
      if (buffered.includes(`${expected}\n`)) {
        output.removeListener("data", onData);
        output.removeListener("end", onEnd);
        resolve();
      }
    };
    const onEnd = () => reject(new Error(`managed handoff helper exited before ${expected}`));
    output.on("data", onData);
    output.once("end", onEnd);
  });
}
