import type { TriageUpdateFailure } from "../commands/triage-update.js";
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
  revokeOwner?: boolean;
  requester?: { channel?: string; accountId?: string; senderId?: string };
  updaterExitCode?: number;
  recoveryExitCode?: number;
  recoveryHang?: boolean;
  recoveryClockAdvanceMs?: number;
  recoverySentinel?: "retained" | "consumed" | "replaced";
  triageExitCode?: number;
  triageHang?: boolean;
  triageMissing?: boolean;
  recordedFailure?: TriageUpdateFailure;
  helperExitCode?: number;
  updaterResult?: unknown;
  updaterOutput?: "malformed" | "overflow" | "missing" | "split-utf8";
  updaterSignal?: boolean;
  updaterNotification?: "published" | "consumed";
  gatewayHealth?: "ready" | "unready" | "wrong-version" | "wrong-build" | "exited";
  diagnosticReadFailure?: "before-recovery" | "after-recovery";
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
  savedFailure: { path: string; mode: number; contents: TriageUpdateFailure } | null;
  sensitiveFilesRemoved: boolean;
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
    ${options?.revokeOwner ? `fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify({ commands: { ownerAllowFrom: [] } })); state.ownerRevokedAfterExit = true;` : ""}
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
    ...(options?.diagnosticReadFailure === "before-recovery"
      ? [
          `{ const db = new (require("node:sqlite").DatabaseSync)(${JSON.stringify(stateDatabasePath)}); db.exec("ALTER TABLE gateway_restart_sentinel RENAME COLUMN thread_id TO unreadable_thread_id"); db.close(); }`,
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

export function registerManagedHandoffOwnerTests(
  runManagedServiceManagerBoundary: (
    kind: "systemd",
    options?: ManagedServiceManagerBoundaryOptions,
  ) => Promise<ManagedServiceManagerBoundaryResult>,
  itUnix: ReturnType<typeof import("vitest").it.runIf>,
  expect: typeof import("vitest").expect,
): void {
  itUnix.each(["revoked", "unchanged", "internal", "channel-less"] as const)(
    "rechecks the %s requester after helper readiness and parent exit",
    async (owner) => {
      const { state, sentinel, log, sensitiveFilesRemoved } =
        await runManagedServiceManagerBoundary("systemd", {
          requester: {
            channel:
              owner === "internal" ? "webchat" : owner === "channel-less" ? undefined : "slack",
            accountId: "primary",
            senderId: "owner",
          },
          revokeOwner: owner === "revoked",
          helperExitCode: owner === "revoked" ? 1 : 0,
          updaterExitCode: 0,
          updaterResult: { status: "ok", mode: "npm" },
        });
      expect(state).toMatchObject({ parked: true, stopCompleted: true });
      expect(state.ownerChecked).toBe(
        owner === "revoked" || owner === "unchanged" ? true : undefined,
      );
      if (owner === "revoked") {
        expect(state).toMatchObject({
          ownerRevokedAfterExit: true,
          restored: true,
          healthProbed: true,
        });
        expect(sentinel).toMatchObject({
          payload: {
            status: "error",
            stats: {
              reason: "owner_required",
              steps: expect.arrayContaining([
                expect.objectContaining({ name: "service-restore", log: { exitCode: 0 } }),
              ]),
            },
          },
        });
        expect(log).toContain("owner_required");
        expect(log).not.toContain("starting managed update command");
      } else {
        expect(log).toContain("starting managed update command");
      }
      expect(sensitiveFilesRemoved).toBe(true);
    },
  );
}
