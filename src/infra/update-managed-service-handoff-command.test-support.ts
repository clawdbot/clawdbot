import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isPidAlive } from "../shared/pid-alive.js";
import type {
  ManagedServiceManagerBoundaryResult,
  ManagedServiceManagerBoundaryOptions,
} from "./update-managed-service-handoff-lifecycle.test-support.js";

/** A LaunchAgent gateway's own environment; the handoff keeps only the label for its children. */
export const LAUNCHD_GATEWAY_IDENTITY_ENV = {
  OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway",
  XPC_SERVICE_NAME: "ai.openclaw.gateway",
  OPENCLAW_SERVICE_MARKER: "openclaw",
  OPENCLAW_SERVICE_KIND: "gateway",
} as const;

/** The pre-fix CLI emulation restarts launchd after it exits; never leave that shell behind. */
export async function awaitEmulatedRecoveryHandoffExit(statePath: string): Promise<void> {
  const state = JSON.parse(await fs.readFile(statePath, "utf8").catch(() => "{}")) as {
    recoveryHandoffPid?: number;
  };
  const pid = state.recoveryHandoffPid;
  if (typeof pid !== "number") {
    return;
  }
  const deadline = Date.now() + 6_000;
  while (isPidAlive(pid)) {
    if (Date.now() >= deadline) {
      throw new Error(`emulated recovery handoff ${pid} is still running`);
    }
    await sleep(50);
  }
}

export function createManagedServiceCommandFixture(params: {
  kind: "systemd" | "launchd";
  root: string;
  statePath: string;
  stateDatabasePath: string;
  options?: ManagedServiceManagerBoundaryOptions;
}) {
  const { kind, root, statePath, options } = params;
  const checksServiceIdentity = kind === "launchd" && options?.recoveryChecksServiceIdentity;
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
    recoveryCommandArgv: [
      process.execPath,
      ...(checksServiceIdentity ? ["--input-type=module"] : []),
      "-e",
      [
        ...(checksServiceIdentity
          ? [
              `import { createRequire } from "node:module";`,
              `const require = createRequire(import.meta.url);`,
              `const { register } = await import(${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href)});`,
              // The recovery command runs from the helper's temp dir; name the repo tsconfig for path aliases.
              `register({ tsconfig: ${JSON.stringify(fileURLToPath(new URL("../../tsconfig.json", import.meta.url)))} });`,
              `const { isCurrentProcessInsideLaunchdService } = await import(${JSON.stringify(new URL("../daemon/launchd-current-service.ts", import.meta.url).href)});`,
            ]
          : []),
        `const fs = require("node:fs");`,
        `const { spawnSync } = require("node:child_process");`,
        `const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8"));`,
        `state.guardedRestart = process.argv.slice(1);`,
        ...(checksServiceIdentity
          ? [
              `state.recoveryInsideService = await isCurrentProcessInsideLaunchdService("ai.openclaw.gateway", process.env);`,
              `state.recoveryEnv = Object.fromEntries(["LAUNCH_JOB_LABEL", "LAUNCH_JOB_NAME", "XPC_SERVICE_NAME", "OPENCLAW_SERVICE_MARKER", "OPENCLAW_SERVICE_KIND", "OPENCLAW_LAUNCHD_LABEL"].map((key) => [key, process.env[key]]));`,
              // Reproduce the old CLI's early success while its detached restart waits for exit.
              `if (state.recoveryInsideService) {`,
              `  const { spawn } = require("node:child_process");`,
              `  const child = spawn("/bin/sh", ["-c", ${JSON.stringify('attempts=0; while kill -0 "$1" 2>/dev/null && [ "$attempts" -lt 100 ]; do attempts=$((attempts + 1)); sleep 0.05; done; launchctl enable gui/501/ai.openclaw.gateway; launchctl bootstrap gui/501 "$2"')}, "openclaw-test-recovery", String(process.pid), ${JSON.stringify(path.join(root, "ai.openclaw.gateway.plist"))}], { detached: true, stdio: "ignore" });`,
              `  state.recoveryHandoffPid = child.pid;`,
              `  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));`,
              `  child.unref();`,
              `  console.log(JSON.stringify({ action: "restart", ok: true, result: "scheduled" }));`,
              `  process.exit(0);`,
              `}`,
            ]
          : []),
        `state.recoveryAllowance = process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS;`,
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
          : options?.recoveryExitCode === undefined || options.recoveryExitCode === 0
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
        ...(checksServiceIdentity
          ? [`console.log(JSON.stringify({ action: "restart", ok: true, result: "restarted" }));`]
          : []),
      ].join(""),
      "--",
      "gateway",
      "restart",
      "--preserve-definition",
      "--json",
    ],
    triageCommandArgv: options?.triageMissing
      ? [path.join(root, "missing-triage")]
      : [
          process.execPath,
          "-e",
          [
            `const fs = require("node:fs");`,
            `const args = process.argv.slice(1);`,
            `const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8"));`,
            `const contextPath = args[args.indexOf("--update-result") + 1];`,
            `state.triageCalls = (state.triageCalls || 0) + 1;`,
            `state.triageArgs = args;`,
            `state.triageInput = JSON.parse(fs.readFileSync(contextPath, "utf8"));`,
            `state.triageInputMode = fs.statSync(contextPath).mode & 0o777;`,
            `state.triageObservedRestored = state.restored === true;`,
            `state.triageObservedRecovery = Array.isArray(state.guardedRestart);`,
            `state.triageRecoveryAllowance = process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS;`,
            `fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));`,
            ...(options?.triageHang
              ? [
                  `const { spawn } = require("node:child_process");`,
                  `state.triageDescendantPid = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }).pid;`,
                  `fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));`,
                  `setInterval(() => {}, 1000);`,
                ]
              : [
                  `console.log(JSON.stringify({ promptPath: "triage-prompt.md", bundlePath: "support.zip" }));`,
                  `process.exit(${options?.triageExitCode ?? 0});`,
                ]),
          ].join(""),
          "--",
          "triage",
          "--json",
          "--non-interactive",
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

export function registerManagedRecoveryCommandTests(
  runManagedServiceManagerBoundary: (
    kind: "systemd" | "launchd",
    options?: ManagedServiceManagerBoundaryOptions,
  ) => Promise<ManagedServiceManagerBoundaryResult>,
  itUnix: ReturnType<typeof import("vitest").it.runIf>,
  expect: typeof import("vitest").expect,
): void {
  itUnix("verifies launchd after a slow guarded restart", async () => {
    const { state, sentinel, commandTimings } = await runManagedServiceManagerBoundary("launchd", {
      recoveryClockAdvanceMs: 31_000,
      updaterExitCode: 0,
      helperExitCode: 1,
      updaterNotification: "published",
      updaterResult: {
        status: "skipped",
        mode: "git",
        reason: "no-upstream",
        recovery: { serviceRestartSafe: true, version: "1.0.0", buildId: "original-git-build" },
      },
    });
    expect(state).toMatchObject({ restored: true, healthProbeCount: 1 });
    expect(sentinel).toMatchObject({
      payload: {
        status: "skipped",
        stats: { steps: [{ name: "service-restore", log: { exitCode: 0 } }] },
      },
    });
    const inspections = commandTimings.filter(({ action }) => action === "print");
    expect(inspections.at(-1)!.startedAtMs - inspections.at(-2)!.startedAtMs).toBe(31_000);
    expect(inspections.at(-1)!.timeoutMs).toBe(5_000);
  });

  itUnix(
    "restores launchd through a synchronous installed-CLI restart when the helper inherits only the configured label",
    async () => {
      const { state, sentinel, log } = await runManagedServiceManagerBoundary("launchd", {
        recoveryChecksServiceIdentity: true,
        updaterNotification: "published",
        updaterResult: {
          status: "error",
          mode: "npm",
          reason: "global update (omit optional)",
          recovery: { serviceRestartSafe: true, version: "1.0.0" },
        },
      });
      // The guarded CLI sees the service identity without launchd's own labels or markers.
      expect(state.recoveryEnv, log).toEqual({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" });
      expect(state.guardedRestart).toEqual([
        "gateway",
        "restart",
        "--preserve-definition",
        "--json",
      ]);
      expect(state.recoveryInsideService, log).toBe(false);
      expect(state).toMatchObject({ restored: true, healthProbeCount: 1 });
      expect(log).toContain(
        "gateway service recovery succeeded (readiness and runtime identity verified)",
      );
      // The updater's published reason survives; only the restore step records recovery.
      expect(sentinel).toMatchObject({
        payload: {
          status: "error",
          stats: {
            reason: "global update (omit optional)",
            steps: expect.arrayContaining([
              expect.objectContaining({ name: "service-restore", log: { exitCode: 0 } }),
            ]),
          },
        },
      });
    },
  );

  itUnix.each(["systemd", "launchd"] as const)(
    "keeps %s parked when the installed CLI refuses a verified recovery restart",
    async (kind) => {
      const { commands, sentinel, state } = await runManagedServiceManagerBoundary(kind, {
        recoveryExitCode: 1,
        updaterNotification: "published",
        updaterResult: {
          status: "error",
          mode: "npm",
          reason: "managed-service-handoff-failed",
          recovery: { serviceRestartSafe: true, version: "1.0.0" },
        },
      });
      expect(state.guardedRestart).toEqual([
        "gateway",
        "restart",
        "--preserve-definition",
        "--json",
      ]);
      expect(state.restored).toBeUndefined();
      expect(
        commands.some((command) => /(?:^| )(?:start|enable|bootstrap|kickstart) /.test(command)),
      ).toBe(false);
      expect(sentinel).toMatchObject({
        payload: {
          status: "error",
          stats: {
            reason: "managed-service-handoff-failed",
            steps: [
              expect.objectContaining({
                name: "service-restore",
                log: { exitCode: 1, stderrTail: "managed-service-handoff-restore-failed" },
              }),
            ],
          },
        },
      });
    },
  );

  itUnix("bounds a stalled recovery command and terminates its descendants", async () => {
    const { state, sentinel } = await runManagedServiceManagerBoundary("systemd", {
      recoveryHang: true,
      updaterNotification: "published",
      updaterResult: {
        status: "error",
        mode: "npm",
        reason: "managed-service-handoff-failed",
        recovery: { serviceRestartSafe: true, version: "1.0.0" },
      },
    });
    expect(state.guardedRestart).toEqual(["gateway", "restart", "--preserve-definition", "--json"]);
    expect(state.restored).toBeUndefined();
    expect(typeof state.recoveryDescendantPid).toBe("number");
    await expect.poll(() => isPidAlive(Number(state.recoveryDescendantPid))).toBe(false);
    expect(sentinel).toMatchObject({
      payload: {
        status: "error",
        stats: {
          reason: "managed-service-handoff-failed",
          steps: [
            expect.objectContaining({
              name: "service-restore",
              log: { exitCode: 1, stderrTail: "managed-service-handoff-restore-failed" },
            }),
          ],
        },
      },
    });
  });
}

export function registerManagedLaunchdTeardownTests(
  runManagedServiceManagerBoundary: (
    kind: "systemd" | "launchd",
    options?: ManagedServiceManagerBoundaryOptions,
  ) => Promise<ManagedServiceManagerBoundaryResult>,
  itUnix: ReturnType<typeof import("vitest").it.runIf>,
  expect: typeof import("vitest").expect,
): void {
  itUnix.each([
    {
      label: "keeps bootout alive beyond the short command timeout before authorizing the updater",
      options: {
        launchdTeardown: { bootoutDelayMs: 5_250, loadedPrints: 2 },
        updaterNotification: "published" as const,
        updaterResult: {
          status: "error",
          mode: "npm",
          recovery: { serviceRestartSafe: true, version: "1.0.0" },
        },
      },
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
          status: updaterRan ? "error" : "skipped",
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
      const restoreIndex = commandTimings.findIndex(({ action }) => action === "bootout") + 1;
      expect(restoreIndex).toBeGreaterThan(0);
      const restoration = commandTimings.slice(restoreIndex);
      const restoreStartedAtMs = restoration[0]?.startedAtMs ?? 0;

      expect(restoration.map(({ action }) => action)).toEqual([
        "print",
        "enable",
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
      expect(state).toMatchObject({ disabled: false, parked: true });
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
          status: "skipped",
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
