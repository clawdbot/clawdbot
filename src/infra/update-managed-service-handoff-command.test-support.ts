import path from "node:path";
import type { Readable } from "node:stream";
import { isPidAlive } from "../shared/pid-alive.js";
import type {
  ManagedServiceManagerBoundaryResult,
  ManagedServiceManagerBoundaryOptions,
} from "./update-managed-service-handoff-lifecycle.test-support.js";

export function createManagedServiceRecoveryCommandFixture(params: {
  kind: "systemd" | "launchd";
  root: string;
  statePath: string;
  stateDatabasePath: string;
  options?: ManagedServiceManagerBoundaryOptions;
}) {
  const { kind, root, statePath, options } = params;
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

  itUnix.each([
    { recoverySentinel: "retained", recoveryExitCode: 0 },
    { recoverySentinel: "retained", recoveryExitCode: 1 },
    { recoverySentinel: "consumed", recoveryExitCode: 0 },
    { recoverySentinel: "replaced", recoveryExitCode: 0 },
  ] as const)(
    "preserves the updater notification when recovery leaves it $recoverySentinel (exit $recoveryExitCode)",
    async (options) => {
      const { sentinel, state } = await runManagedServiceManagerBoundary("systemd", {
        ...options,
        updaterResult: {
          status: "error",
          mode: "npm",
          reason: "build failed",
          recovery: { serviceRestartSafe: true, version: "1.0.0" },
        },
      });
      expect(state.sentinelAtRecovery).toMatchObject({
        status: "error",
        stats: { reason: "build failed", handoffId: "systemd-boundary", steps: [] },
      });
      if (options.recoverySentinel === "consumed") {
        expect(sentinel).toBeNull();
      } else {
        expect(sentinel).toMatchObject({
          payload: {
            status: "error",
            stats: {
              reason:
                options.recoverySentinel === "replaced" ? "newer update failure" : "build failed",
              steps:
                options.recoverySentinel === "replaced"
                  ? []
                  : [
                      expect.objectContaining({
                        name: "service-restore",
                        log: {
                          exitCode: options.recoveryExitCode,
                          ...(options.recoveryExitCode === 1
                            ? { stderrTail: "managed-service-handoff-restore-failed" }
                            : {}),
                        },
                      }),
                    ],
            },
          },
        });
      }
    },
  );
}
