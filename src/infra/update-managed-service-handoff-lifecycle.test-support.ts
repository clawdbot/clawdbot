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
