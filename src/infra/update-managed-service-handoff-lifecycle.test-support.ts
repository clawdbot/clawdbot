import { buildUpdateRestartSentinelPayload } from "./update-restart-sentinel-payload.js";
import type { UpdateRunResult } from "./update-runner-types.js";

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
  recoveryExitCode?: number;
  recoveryHang?: boolean;
  recoveryClockAdvanceMs?: number;
  recoverySentinel?: "retained" | "consumed" | "replaced";
  helperExitCode?: number;
  updaterResult?: unknown;
  updaterOutput?: "malformed" | "overflow" | "missing" | "split-utf8";
  updaterSignal?: boolean;
  updaterNotification?: "published" | "consumed";
  gatewayHealth?: "ready" | "unready" | "wrong-version" | "wrong-build" | "exited";
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
  log: string;
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
      updaterResult: { status: "ok", mode: "npm" },
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

      expect(state).toMatchObject({ parked: true, stopCompleted: true, postExitShows: 2 });
      expect(commands.filter((command) => command.includes("reset-failed"))).toHaveLength(0);
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

  itUnix(
    "fails closed when the exact systemd stop job exhausts the parent-exit deadline",
    async () => {
      const { sentinel, state } = await runManagedServiceManagerBoundary("systemd", {
        systemdHandoffDeadlineMs: 5_000,
        systemdHandoffFailure: true,
        systemdStopDelayMs: 6_000,
      });

      expect(state).toMatchObject({ parked: true });
      expect(state.reset).toBeUndefined();
      expect(state.restored).toBeUndefined();
      expect(state.stopCompleted).toBeUndefined();
      expect(sentinel).toMatchObject({
        payload: { status: "error", stats: { reason: "managed-service-handoff-restore-failed" } },
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

export function createManagedServiceUpdaterFixtureScript(params: {
  kind: "systemd" | "launchd";
  root: string;
  statePath: string;
  updaterPath: string;
  logPath: string;
  stateDatabasePath: string;
  consumeNotification: string;
  options?: ManagedServiceManagerBoundaryOptions;
}): string {
  const { kind, root, statePath, updaterPath, stateDatabasePath, consumeNotification, options } =
    params;
  const updaterResult = options?.updaterResult
    ? { root, ...(options.updaterResult as UpdateRunResult) }
    : null;
  const notification =
    updaterResult && options?.updaterNotification
      ? buildUpdateRestartSentinelPayload({
          result: {
            ...updaterResult,
            steps: updaterResult.steps ?? [],
            durationMs: updaterResult.durationMs ?? 0,
          },
          meta: { root, handoffId: `${kind}-boundary` },
        })
      : null;
  return [
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
    ...(notification
      ? [
          `const notification = ${JSON.stringify(notification)};`,
          `const db = new (require("node:sqlite").DatabaseSync)(${JSON.stringify(stateDatabasePath)});`,
          `db.prepare("INSERT INTO gateway_restart_sentinel (sentinel_key, version, kind, status, ts, stats_json, payload_json, updated_at_ms) VALUES ('current', 1, ?, ?, ?, ?, ?, ?)").run(notification.kind, notification.status, notification.ts, JSON.stringify(notification.stats), JSON.stringify(notification), notification.ts); db.close();`,
          `{ const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); state.publishedSentinel = { version: 1, payload: notification, revision: notification.ts }; fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state)); }`,
          ...(options?.updaterNotification === "consumed" &&
          (updaterResult?.status === "ok" ||
            (updaterResult?.recovery?.serviceRestartSafe && updaterResult.recovery.service))
            ? [`{ ${consumeNotification} }`]
            : []),
        ]
      : []),
    `const result = JSON.stringify(${JSON.stringify(updaterResult)});`,
    `const mode = ${JSON.stringify(options?.updaterOutput)};`,
    `const output = mode === "missing" ? "" : mode === "malformed" ? "diagnostic before JSON\\n" + result : mode === "overflow" ? " ".repeat(4 * 1024 * 1024) + result : result;`,
    `let remaining = Buffer.from(output);`,
    ...(options?.updaterOutput === "split-utf8"
      ? [
          `const split = remaining.findIndex((byte) => byte >= 0x80) + 1;`,
          `if (!split) throw new Error("expected a Unicode installation root");`,
          `const prefix = remaining.subarray(0, split);`,
          `const logPath = ${JSON.stringify(params.logPath)};`,
          `const logOffset = fs.statSync(logPath).size;`,
          `fs.writeSync(1, prefix);`,
          // The raw log acknowledges a distinct pipe read before the remaining UTF-8 bytes.
          `const deadline = Date.now() + 5000;`,
          `while (!fs.readFileSync(logPath).subarray(logOffset).includes(prefix)) {`,
          `  if (Date.now() >= deadline) throw new Error("helper did not receive the UTF-8 prefix");`,
          `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);`,
          `}`,
          `remaining = remaining.subarray(split);`,
        ]
      : []),
    `process.stdout.write(remaining, () => { ${options?.updaterSignal ? 'process.kill(process.pid, "SIGTERM");' : `process.exit(${options?.updaterExitCode ?? 7});`} });`,
  ].join("");
}

export function createManagedServiceLaunchdClockPreload(params: {
  commandTimingsPath: string;
  clockEachCommandMs: number;
  recoveryClockAdvanceMs?: number;
  recoveryCommandArgv: string[];
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
    "  const child = actualSpawn(command, args, options);",
    // Advance only when the exact guarded restart closes, before the helper resumes.
    `  if (command === process.execPath && args.at(-1) === ${JSON.stringify(JSON.stringify(params.recoveryCommandArgv))}) {`,
    `    child.once("close", () => { elapsed += ${params.recoveryClockAdvanceMs ?? 0}; });`,
    "  }",
    "  return child;",
    "};",
  ].join("\n");
}

export function registerManagedRecoveryOutcomeTests(
  runManagedServiceManagerBoundary: (
    kind: "systemd" | "launchd",
    options?: ManagedServiceManagerBoundaryOptions,
  ) => Promise<ManagedServiceManagerBoundaryResult>,
  itUnix: ReturnType<typeof import("vitest").it.runIf>,
  expect: typeof import("vitest").expect,
): void {
  itUnix.each(
    (["systemd", "launchd"] as const).flatMap((kind) =>
      [false, true].map((contradictory) => ({ kind, contradictory })),
    ),
  )(
    "keeps $kind parked on unsafe exit 79 (contradictory stdout=$contradictory)",
    async ({ kind, contradictory }) => {
      const { commands, sentinel, state } = await runManagedServiceManagerBoundary(kind, {
        updaterExitCode: 79,
        updaterResult: contradictory
          ? {
              status: "error",
              mode: "npm",
              recovery: { serviceRestartSafe: true, version: "1.0.0" },
            }
          : undefined,
      });

      expect(state.parked).toBe(true);
      expect(state.restored).toBeUndefined();
      expect(
        commands.some((command) => /(?:^| )(?:start|enable|bootstrap|kickstart) /.test(command)),
      ).toBe(false);
      expect(sentinel).toMatchObject({
        payload: {
          status: "error",
          stats: { reason: "managed-service-handoff-unsafe-recovery", steps: [] },
        },
      });
    },
  );

  itUnix.each(["systemd", "launchd"] as const)(
    "%s never overrides a rejected or missing updater recovery result",
    async (kind) => {
      for (const updaterResult of [
        undefined,
        { status: "error", mode: "git", recovery: { serviceRestartSafe: true, version: "1.0.0" } },
        ...(["healthy", "failed"] as const).map((service) => ({
          status: "error",
          mode: "npm",
          recovery: { serviceRestartSafe: true, version: "1.0.0", service },
        })),
        {
          status: "error",
          mode: "npm",
          reason: "doctor-failed",
          recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        },
      ]) {
        const { commands, state, sentinel } = await runManagedServiceManagerBoundary(kind, {
          updaterResult,
          updaterNotification: "published",
        });
        expect(
          commands.some((command) =>
            /(?:^| )(?:start|reset-failed|enable|bootstrap|kickstart)(?: |$)/.test(command),
          ),
        ).toBe(false);
        expect(state.restored).toBeUndefined();
        expect(sentinel).toMatchObject({ payload: { status: "error" } });
      }
    },
  );

  itUnix.each(
    (["systemd", "launchd"] as const).flatMap((kind) => [
      ...(["error", "skipped"] as const).flatMap((status) =>
        ([undefined, "published", "consumed"] as const).map((updaterNotification) => ({
          kind,
          status,
          updaterNotification,
          updaterOutput: undefined,
        })),
      ),
      {
        kind,
        status: "error" as const,
        updaterNotification: "published" as const,
        updaterOutput: "split-utf8" as const,
      },
    ]),
  )(
    "$kind restores a verified Git $status before the child owns a service stop (notification=$updaterNotification, output=$updaterOutput)",
    async ({ kind, status, updaterNotification, updaterOutput }) => {
      const reason = status === "skipped" ? "no-upstream" : "preflight-fetch";
      const { commands, state, sentinel, log } = await runManagedServiceManagerBoundary(kind, {
        updaterExitCode: status === "skipped" ? 0 : 7,
        updaterNotification,
        updaterOutput,
        updaterResult: {
          status,
          reason,
          mode: "git",
          recovery: { serviceRestartSafe: true, version: "1.0.0", buildId: "original-git-build" },
        },
      });
      expect(
        commands.filter((command) => /(?:^| )(?:start|bootstrap|kickstart)(?: |$)/.test(command)),
      ).toHaveLength(1);
      expect(state).toMatchObject({
        restored: true,
        healthProbeCount: 1,
        expectedVersion: "1.0.0",
        expectedBuildId: "original-git-build",
      });
      expect(log).toContain(JSON.stringify(reason));
      if (updaterNotification === "published") {
        expect(sentinel).toMatchObject({
          payload: {
            status,
            stats: {
              reason,
              steps: [{ name: "service-restore", log: { exitCode: 0 } }],
            },
          },
        });
      } else {
        expect(sentinel).toBeNull();
      }
    },
  );

  itUnix.each(
    (["systemd", "launchd"] as const).flatMap((kind) =>
      (["error", "skipped"] as const).flatMap((status) =>
        [
          undefined,
          { serviceRestartSafe: false, reason: "state-migration-started" },
          { serviceRestartSafe: true, version: "1.0.0" },
          ...(["healthy", "failed"] as const).map((service) => ({
            serviceRestartSafe: true,
            version: "1.0.0",
            buildId: "original-git-build",
            service,
          })),
        ].map((recovery) => ({
          kind,
          status,
          recovery,
          recoveryLabel: recovery && "service" in recovery ? recovery.service : recovery,
        })),
      ),
    ),
  )(
    "$kind preserves terminal foreground $status outcomes and rejects unverified recovery ($recoveryLabel)",
    async ({ kind, status, recovery }) => {
      const healthy = recovery && "service" in recovery && recovery.service === "healthy";
      const reason = status === "skipped" ? "no-upstream" : "preflight-fetch";
      const { commands, state, sentinel, log } = await runManagedServiceManagerBoundary(kind, {
        updaterExitCode: status === "skipped" ? 0 : 7,
        helperExitCode: status === "skipped" ? (healthy ? 0 : 1) : 7,
        updaterNotification: "consumed",
        updaterResult: { status, reason, mode: "git", recovery },
      });
      expect(
        commands.some((command) =>
          /(?:^| )(?:start|enable|bootstrap|kickstart)(?: |$)/.test(command),
        ),
      ).toBe(false);
      expect(state.healthProbed).toBeUndefined();
      expect(log).toContain("managed update recovery not attempted:");
      if (recovery && "service" in recovery) {
        expect(sentinel).toBeNull();
      } else {
        expect(sentinel).toMatchObject({
          payload: { status: "error", stats: { reason } },
        });
      }
    },
  );

  itUnix.each(["systemd", "launchd"] as const)(
    "%s fails a zero-exit skip when restored Gateway readiness or identity fails",
    async (kind) => {
      for (const gatewayHealth of ["unready", "wrong-version", "wrong-build", "exited"] as const) {
        const { state, sentinel } = await runManagedServiceManagerBoundary(kind, {
          updaterExitCode: 0,
          helperExitCode: 1,
          gatewayHealth,
          updaterNotification: "published",
          updaterResult: {
            status: "skipped",
            reason: "no-upstream",
            mode: "git",
            recovery: { serviceRestartSafe: true, version: "1.0.0", buildId: "original-git-build" },
          },
        });
        expect(state).toMatchObject({ restored: true, healthProbeCount: 1 });
        expect(sentinel).toMatchObject({
          payload: {
            status: "error",
            stats: {
              reason: "no-upstream",
              steps: [
                {
                  name: "service-restore",
                  log: {
                    exitCode: 1,
                    stderrTail: "managed-service-handoff-restore-failed",
                  },
                },
              ],
            },
          },
        });
      }
    },
  );

  itUnix.each(["systemd", "launchd"] as const)(
    "%s parks an updater with missing, malformed, oversized, interrupted, or rootless output",
    async (kind) => {
      for (const fault of [
        "missing",
        "malformed",
        "overflow",
        "signal",
        "missing-root",
        "invalid-root",
      ] as const) {
        const { state, sentinel } = await runManagedServiceManagerBoundary(kind, {
          updaterExitCode: 0,
          helperExitCode: 1,
          updaterOutput:
            fault === "signal" || fault === "missing-root" || fault === "invalid-root"
              ? undefined
              : fault,
          updaterSignal: fault === "signal",
          updaterResult: {
            status: "ok",
            mode: "npm",
            ...(fault === "missing-root"
              ? { root: undefined }
              : fault === "invalid-root"
                ? { root: 42 }
                : {}),
            steps: [],
            durationMs: 100,
            recovery: { serviceRestartSafe: true, version: "1.0.0" },
          },
        });
        expect(state.restored).toBeUndefined();
        expect(state.healthProbed).toBeUndefined();
        expect(sentinel).toMatchObject({
          payload: { status: "error", stats: { reason: "managed-service-handoff-failed" } },
        });
      }
    },
  );

  itUnix.each(["systemd", "launchd"] as const)(
    "%s verifies readiness and expected version before claiming restored service health",
    async (kind) => {
      for (const gatewayHealth of [
        "unready",
        "wrong-version",
        "wrong-build",
        "exited",
        "ready",
      ] as const) {
        const { sentinel, state } = await runManagedServiceManagerBoundary(kind, {
          updaterNotification: "published",
          updaterResult: {
            status: "error",
            reason: "preflight-fetch",
            mode: "git",
            recovery: { serviceRestartSafe: true, version: "1.0.0", buildId: "restored-git-build" },
          },
          gatewayHealth,
        });
        expect(state).toMatchObject({
          healthProbed: true,
          expectedVersion: "1.0.0",
          expectedBuildId: "restored-git-build",
        });
        expect(sentinel).toMatchObject({
          payload: {
            stats: {
              reason: "preflight-fetch",
              steps: expect.arrayContaining([
                expect.objectContaining({
                  name: "service-restore",
                  log: {
                    exitCode: gatewayHealth === "ready" ? 0 : 1,
                    ...(gatewayHealth === "ready"
                      ? {}
                      : { stderrTail: "managed-service-handoff-restore-failed" }),
                  },
                }),
              ]),
            },
          },
        });
      }
    },
  );
}
