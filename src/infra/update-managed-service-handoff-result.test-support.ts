import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ManagedServiceManagerBoundaryOptions,
  ManagedServiceManagerBoundaryResult,
} from "./update-managed-service-handoff-lifecycle.test-support.js";
import type { UpdateRunResult } from "./update-runner-types.js";

export function registerManagedTerminalResultTests(
  runManagedServiceManagerBoundary: (
    kind: "systemd" | "launchd",
    options?: ManagedServiceManagerBoundaryOptions,
  ) => Promise<ManagedServiceManagerBoundaryResult>,
  itUnix: ReturnType<typeof import("vitest").it.runIf>,
  expect: typeof import("vitest").expect,
  tempDirs: Set<string>,
): void {
  itUnix.each(["ready", "unready"] as const)(
    "finishes a cancelled handoff ledger when recovery is %s without a Gateway boot",
    async (gatewayHealth) => {
      const { run } = await runManagedServiceManagerBoundary("systemd", {
        ledger: true,
        cancelAfterPark: true,
        gatewayHealth,
      });
      expect(run).toMatchObject({
        phase: "finished",
        status: gatewayHealth === "ready" ? "skipped" : "failed",
        reason:
          gatewayHealth === "ready"
            ? "managed-service-handoff-cancelled"
            : "managed-service-handoff-restore-failed",
        verification: { serviceRunning: true, runningVersion: "1.0.0", versionMatch: true },
      });
      expect(run?.verification.booted).toBeUndefined();
      expect(run?.downtimeMs).toEqual(gatewayHealth === "ready" ? expect.any(Number) : null);
      expect(run?.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            step: "service-stop",
            status: "completed",
            startedAtMs: expect.any(Number),
          }),
        ]),
      );
    },
  );

  itUnix.each(
    (["systemd", "launchd"] as const).flatMap((kind) =>
      (["git", "npm"] as const).flatMap((mode) =>
        (["same", "replacement", "replacement-symlink"] as const).flatMap((rootKind) =>
          (["published", "consumed"] as const).map((updaterNotification) => ({
            kind,
            mode,
            rootKind,
            updaterNotification,
          })),
        ),
      ),
    ),
  )(
    "$kind preserves completed $mode success at $rootKind root (notification=$updaterNotification)",
    async ({ kind, mode, rootKind, updaterNotification }) => {
      let root: string | undefined;
      if (rootKind !== "same") {
        const replacement = await fs.realpath(
          await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-replacement-")),
        );
        tempDirs.add(replacement);
        root = path.join(replacement, "checkout");
        await fs.mkdir(root);
        if (rootKind === "replacement-symlink") {
          const link = path.join(replacement, "global-package");
          await fs.symlink(root, link, "dir");
          expect(await fs.realpath(link)).toBe(root);
          root = link;
        }
      }
      const updaterResult = {
        status: "ok",
        mode,
        ...(root ? { root } : {}),
        before: { version: "1.0.0", ...(mode === "git" ? { sha: "a".repeat(40) } : {}) },
        after: {
          version: "1.1.0",
          ...(mode === "git" ? { sha: "b".repeat(40), buildId: "updated-git-build" } : {}),
        },
        steps: [],
        durationMs: 100,
      } satisfies UpdateRunResult;
      const { commands, state, sentinel } = await runManagedServiceManagerBoundary(kind, {
        updaterExitCode: 0,
        updaterResult,
        updaterNotification,
        recordedFailure: { error: "A diagnostic export cannot override direct success." },
      });
      expect(
        commands.some((command) =>
          /(?:^| )(?:start|reset-failed|enable|bootstrap|kickstart)(?: |$)/.test(command),
        ),
      ).toBe(false);
      expect(state.restored).toBeUndefined();
      expect(state.healthProbed).toBeUndefined();
      expect(state.triageCalls).toBeUndefined();
      expect(state.publishedSentinel).toMatchObject({ payload: { status: "ok", stats: { mode } } });
      if (updaterNotification === "consumed") {
        expect(state.consumedNotifications).toBe(1);
        expect(sentinel).toBeNull();
      } else {
        expect(state.consumedNotifications).toBeUndefined();
        expect(sentinel).toEqual(state.publishedSentinel);
      }
    },
  );

  itUnix.each(
    (["systemd", "launchd"] as const).flatMap((kind) =>
      (["error", "skipped"] as const).map((status) => ({ kind, status })),
    ),
  )(
    "$kind rejects foreign-root $status recovery despite positive runtime proof",
    async ({ kind, status }) => {
      const root = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-foreign-")),
      );
      tempDirs.add(root);
      const { commands, state, sentinel } = await runManagedServiceManagerBoundary(kind, {
        updaterExitCode: status === "skipped" ? 0 : 7,
        helperExitCode: status === "skipped" ? 1 : 7,
        updaterResult: {
          status,
          root,
          mode: "git",
          steps: [],
          durationMs: 100,
          recovery: { serviceRestartSafe: true, version: "1.0.0", buildId: "original-git-build" },
        } satisfies UpdateRunResult,
        recordedFailure: {
          result: {
            status: "error",
            mode: "git",
            steps: [],
            recovery: { serviceRestartSafe: true },
          },
        },
      });
      expect(
        commands.some((command) =>
          /(?:^| )(?:start|reset-failed|enable|bootstrap|kickstart)(?: |$)/.test(command),
        ),
      ).toBe(false);
      expect(state.restored).toBeUndefined();
      expect(state.healthProbed).toBeUndefined();
      expect(state.triageCalls).toBe(1);
      expect(sentinel).toMatchObject({
        payload: { status: "error", stats: { reason: "managed-service-handoff-failed" } },
      });
    },
  );
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
      (["ready", "exited", "throw"] as const).map((gatewayHealth) => ({ kind, gatewayHealth })),
    ),
  )(
    "restores the verified previous $kind generation after updater exit 79 (health=$gatewayHealth)",
    async ({ kind, gatewayHealth }) => {
      const { run, state, log } = await runManagedServiceManagerBoundary(kind, {
        ledger: true,
        rollbackRestoration: true,
        updaterExitCode: 79,
        helperExitCode: gatewayHealth === "ready" ? 1 : 79,
        gatewayHealth,
        updaterResult: {
          status: "error",
          mode: "npm",
          reason: "restart-unhealthy",
          before: { version: "1.0.0" },
          after: { version: "1.0.0" },
          recovery: { serviceRestartSafe: true, packageRollbackVerified: true, version: "1.0.0" },
        },
      });
      expect(state).toMatchObject({
        restored: true,
        healthProbeCount: 1,
        expectedVersion: "1.0.0",
        recoveryAllowance: "1",
        triageObservedRestored: true,
      });
      expect(state.triageRecoveryAllowance).toBeUndefined();
      expect(run, log).toMatchObject({
        status: gatewayHealth === "ready" ? "rolled-back" : "failed",
        reason:
          gatewayHealth === "ready"
            ? "restart-unhealthy"
            : "managed-service-handoff-restore-failed",
        after: { version: "1.0.0" },
        verification: {
          serviceRunning: gatewayHealth !== "exited",
        },
        downtimeMs: gatewayHealth === "ready" ? expect.any(Number) : null,
      });
      expect(run?.verification.runningVersion).toBe(
        gatewayHealth === "throw" ? undefined : "1.0.0",
      );
      expect(run?.verification.versionMatch).toBe(gatewayHealth === "throw" ? undefined : true);
      expect(run?.verification.pid).toBe(gatewayHealth === "exited" ? undefined : process.pid);
      expect(run?.verification.readyz).toBeUndefined();
      expect(run?.verification.inferenceProbe).toBeUndefined();
      expect(run?.verification.settled).toBe(
        gatewayHealth === "throw" ? undefined : gatewayHealth === "ready",
      );
      expect(run?.verification.channelsReady).toBe(
        gatewayHealth === "throw" ? undefined : gatewayHealth === "ready",
      );
      expect(run?.verification.pluginErrors).toEqual(gatewayHealth === "throw" ? undefined : []);
      expect(log).not.toContain("keep the gateway stopped");
    },
  );

  itUnix.each(
    (["systemd", "launchd"] as const).flatMap((kind) =>
      (["none", "stdout-only", "ledger-only"] as const).map((proof) => ({ kind, proof })),
    ),
  )(
    "keeps $kind parked on unsafe exit 79 without a complete recovery verdict (proof=$proof)",
    async ({ kind, proof }) => {
      const { commands, sentinel, state } = await runManagedServiceManagerBoundary(kind, {
        updaterExitCode: 79,
        ledger: proof === "ledger-only",
        rollbackRestoration: proof === "ledger-only",
        recordedFailure:
          proof === "stdout-only"
            ? {
                error: "Diagnostic restart safety must not override the direct updater outcome",
                result: {
                  status: "error",
                  mode: "npm",
                  recovery: { serviceRestartSafe: true },
                  steps: [],
                },
              }
            : undefined,
        updaterResult:
          proof === "stdout-only"
            ? {
                status: "error",
                mode: "npm",
                before: { version: "1.0.0" },
                after: { version: "1.0.0" },
                recovery: {
                  serviceRestartSafe: true,
                  packageRollbackVerified: true,
                  version: "1.0.0",
                },
              }
            : undefined,
      });

      expect(state.parked).toBe(true);
      expect(state.restored).toBeUndefined();
      expect(state).toMatchObject({
        triageCalls: 1,
        triageObservedRestored: false,
        triageObservedRecovery: false,
      });
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

  itUnix.each([
    ...(["systemd", "launchd"] as const).flatMap((kind) =>
      (["error", "skipped"] as const).flatMap((status) =>
        ([undefined, "published", "consumed"] as const).map((updaterNotification) => ({
          kind,
          status,
          updaterNotification,
          updaterOutput: undefined,
        })),
      ),
    ),
    ...(["systemd", "launchd"] as const).map((kind) => ({
      kind,
      status: "error" as const,
      updaterNotification: "published" as const,
      updaterOutput: "split-utf8" as const,
    })),
  ])(
    "$kind restores a verified Git $status before the child owns a service stop (notification=$updaterNotification, output=$updaterOutput)",
    async ({ kind, status, updaterNotification, updaterOutput }) => {
      const reason = status === "skipped" ? "no-upstream" : "preflight-fetch";
      const { commands, state, sentinel, log } = await runManagedServiceManagerBoundary(kind, {
        updaterExitCode: status === "skipped" ? 0 : 7,
        helperExitCode: status === "skipped" ? 1 : 7,
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
        triageCalls: 1,
        triageObservedRestored: true,
        triageObservedRecovery: true,
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
      const reason = status === "skipped" ? "no-upstream" : "preflight-fetch";
      const { commands, state, sentinel, log } = await runManagedServiceManagerBoundary(kind, {
        updaterExitCode: status === "skipped" ? 0 : 7,
        helperExitCode: status === "skipped" ? 1 : 7,
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
        expect(state.triageCalls).toBe(1);
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
