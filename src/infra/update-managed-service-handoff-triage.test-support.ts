import { renderTriagePrompt } from "../commands/triage-prompt.js";
import { sanitizeTriageUpdateFailure } from "../commands/triage-update.js";
import { isPidAlive } from "../shared/pid-alive.js";
import type {
  ManagedServiceManagerBoundaryOptions,
  ManagedServiceManagerBoundaryResult,
} from "./update-managed-service-handoff-lifecycle.test-support.js";

export function registerManagedUpdateHandoffTriageTests(
  runManagedServiceManagerBoundary: (
    kind: "systemd",
    options?: ManagedServiceManagerBoundaryOptions,
  ) => Promise<ManagedServiceManagerBoundaryResult>,
  itUnix: ReturnType<typeof import("vitest").it.runIf>,
  expect: typeof import("vitest").expect,
): void {
  itUnix.each(["before-recovery", "after-recovery"] as const)(
    "keeps recovery and cleanup terminal when diagnostic reads fail %s",
    async (diagnosticReadFailure) => {
      const {
        state,
        sentinel,
        log: helperLog,
        sensitiveFilesRemoved,
      } = await runManagedServiceManagerBoundary("systemd", {
        diagnosticReadFailure,
        updaterExitCode: 7,
        helperExitCode: 7,
        updaterNotification: "consumed",
        updaterResult: {
          status: "error",
          mode: "npm",
          reason: "build failed",
          recovery: { serviceRestartSafe: true, version: "1.0.0" },
        },
      });
      expect(state).toMatchObject({ restored: true, healthProbeCount: 1 });
      expect(state.triageCalls).toBeUndefined();
      expect(sentinel).toBeNull();
      expect(sensitiveFilesRemoved).toBe(true);
      expect(helperLog).toContain("update triage could not complete");
      expect(helperLog).toContain("managed update helper completed code=7");
    },
  );

  itUnix.each([
    { triageExitCode: 7, triageHang: false, triageMissing: false },
    { triageExitCode: 0, triageHang: true, triageMissing: false },
    { triageExitCode: 0, triageHang: false, triageMissing: true },
  ])(
    "preserves update failure after unavailable triage ($triageExitCode, timeout=$triageHang, missing=$triageMissing)",
    async (options) => {
      const secret = "sk-test-preserved-update-secret-1234567890";
      const {
        state,
        sentinel,
        log: helperLog,
        savedFailure,
        sensitiveFilesRemoved,
      } = await runManagedServiceManagerBoundary("systemd", {
        ...options,
        updaterExitCode: 7,
        helperExitCode: 7,
        updaterNotification: "published",
        updaterResult: {
          status: "error",
          mode: "npm",
          reason: "global-install-failed",
          recovery: { serviceRestartSafe: true, version: "2026.8.1" },
        },
        recordedFailure: {
          error: `Original update failed token=${secret}`,
          result: {
            status: "error",
            mode: "npm",
            reason: "global-install-failed",
            before: { version: "2026.8.1" },
            after: { version: "2026.8.1" },
            recovery: { serviceRestartSafe: true },
            steps: [{ name: "package install", exitCode: 42, stderrTail: "Original npm cause" }],
          },
        },
      });
      if (options.triageMissing) {
        expect(state.triageCalls).toBeUndefined();
      } else {
        expect(state).toMatchObject({
          triageCalls: 1,
          triageObservedRecovery: true,
          triageObservedRestored: true,
        });
      }
      expect(sensitiveFilesRemoved).toBe(true);
      expect(savedFailure).toMatchObject({
        path: expect.stringContaining("/logs/support/openclaw-update-failure-"),
        mode: 0o600,
        contents: {
          result: {
            reason: "global-install-failed",
            before: { version: "2026.8.1" },
            after: { version: "2026.8.1" },
            recovery: { serviceRestartSafe: true },
            steps: [{ exitCode: 42, stderrTail: "Original npm cause" }],
          },
        },
      });
      expect(JSON.stringify(savedFailure)).not.toContain(secret);
      expect(helperLog).toContain(`Saved update failure: ${savedFailure?.path}`);
      expect(helperLog).toContain(`--update-result ${savedFailure?.path}`);
      expect(helperLog).toContain("OPENCLAW_STATE_DIR=");
      expect(sentinel).toMatchObject({
        payload: {
          status: "error",
          doctorHint: expect.stringContaining("openclaw triage"),
          stats: {
            reason: "global-install-failed",
            steps: [expect.objectContaining({ name: "service-restore", log: { exitCode: 0 } })],
          },
        },
      });
      expect(sentinel).toHaveProperty(
        "payload.doctorHint",
        expect.not.stringMatching(
          /handoff\.log|OPENCLAW_(?:STATE_DIR|CONFIG_PATH|WORKSPACE_DIR)=/u,
        ),
      );
      expect(helperLog).toContain("update triage could not complete");
      if (options.triageHang) {
        expect(typeof state.triageDescendantPid).toBe("number");
        await expect.poll(() => isPidAlive(Number(state.triageDescendantPid))).toBe(false);
      }
    },
  );

  itUnix.each(["dirty", "already-current", "managed-service-handoff-cancelled"] as const)(
    "classifies a zero-exit skipped updater result before triage: %s",
    async (reason) => {
      const failed = reason === "dirty";
      const { state, sentinel } = await runManagedServiceManagerBoundary("systemd", {
        updaterExitCode: 0,
        helperExitCode: failed ? 1 : 0,
        updaterNotification: "published",
        updaterResult: {
          status: "skipped",
          mode: "npm",
          reason,
          recovery: { serviceRestartSafe: true, version: "1.0.0", service: "healthy" },
        },
      });
      expect(state.triageCalls).toBe(failed ? 1 : undefined);
      expect(state.guardedRestart).toBeUndefined();
      expect(state.healthProbed).toBeUndefined();
      expect(sentinel).toMatchObject({
        payload: { status: "skipped", stats: { reason } },
      });
    },
  );

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
        updaterExitCode: 7,
        helperExitCode: 7,
        updaterResult: {
          status: "error",
          mode: "npm",
          reason: "build failed",
          recovery: { serviceRestartSafe: true, version: "1.0.0" },
        },
        recordedFailure: {
          error: "Original package build diagnostic",
          result: {
            status: "error",
            mode: "npm",
            reason: "build failed",
            recovery: { serviceRestartSafe: true },
            steps: [],
          },
        },
      });
      expect(state.sentinelAtRecovery).toMatchObject({
        status: "error",
        doctorHint: expect.stringContaining("Update triage"),
        stats: { reason: "build failed", handoffId: "systemd-boundary", steps: [] },
      });
      expect(state).toMatchObject({
        triageCalls: 1,
        triageObservedRecovery: true,
        triageObservedRestored: options.recoveryExitCode === 0,
        triageInputMode: 0o600,
        triageArgs: [
          "triage",
          "--json",
          "--non-interactive",
          "--update-result",
          expect.any(String),
        ],
        triageInput: {
          result: {
            status: "error",
            reason: "build failed",
            recovery: { serviceRestartSafe: true },
          },
        },
      });
      const recovery =
        options.recoveryExitCode === 0 ? "Service recovery succeeded." : "Service recovery failed.";
      expect(state.triageInput).toHaveProperty(
        "error",
        `Original package build diagnostic\n${recovery}`,
      );
      const redaction = { env: { HOME: "/triage-test-home" }, stateDir: "/triage-test-state" };
      const prompt = renderTriagePrompt({
        findings: [],
        bundle: { kind: "skipped" },
        redaction,
        updateFailure: sanitizeTriageUpdateFailure(state.triageInput, redaction),
      });
      expect(prompt).toContain("Original package build diagnostic");
      expect(prompt).toContain(recovery);
      expect(prompt).not.toContain("handoff.log");
      expect(state.triageInput).not.toHaveProperty("result.before");
      expect(state.triageInput).not.toHaveProperty("result.after");
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

  itUnix(
    "passes the complete bounded managed failure through triage after long plugin output",
    async () => {
      const secret = "sk-test-managed-plugin-secret-1234567890";
      const { state, log: helperLog } = await runManagedServiceManagerBoundary("systemd", {
        updaterExitCode: 1,
        helperExitCode: 1,
        updaterResult: {
          status: "error",
          mode: "npm",
          reason: "post-update-plugins",
          recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        },
        recordedFailure: {
          result: {
            status: "error",
            mode: "npm",
            reason: "post-update-plugins",
            before: { version: "2026.8.1" },
            after: { version: "2026.9.1" },
            recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
            steps: [
              {
                name: "plugin install",
                exitCode: 1,
                stdoutTail: `${"Earlier package output\n".repeat(1000)}actual terminal compiler failure token=${secret}`,
                stderrTail: `${"Earlier npm output\n".repeat(1000)}terminal npm diagnostic token=${secret}`,
              },
            ],
            postUpdate: {
              plugins: {
                status: "error",
                warnings: [
                  {
                    reason: "Fresh Doctor could not load updated runtime",
                    message: "Refusing to restart",
                  },
                ],
              },
            },
          },
        },
      });

      expect(state).toMatchObject({
        triageCalls: 1,
        triageObservedRestored: false,
        triageObservedRecovery: false,
        triageInputMode: 0o600,
        triageInput: {
          result: {
            before: { version: "2026.8.1" },
            after: { version: "2026.9.1" },
            recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
          },
        },
      });
      const evidence = JSON.stringify(state.triageInput);
      expect(evidence).toContain("actual terminal compiler failure");
      expect(evidence).toContain("terminal npm diagnostic");
      expect(evidence).toContain("Fresh Doctor could not load updated runtime");
      expect(evidence).not.toContain(secret);
      expect(Buffer.byteLength(evidence)).toBeLessThanOrEqual(8 * 1024);
      expect(helperLog).toContain("update triage completed");
    },
  );

  itUnix(
    "diagnoses an exported failure when the updater exits zero without a sentinel",
    async () => {
      const {
        commands,
        state,
        log: helperLog,
      } = await runManagedServiceManagerBoundary("systemd", {
        updaterExitCode: 0,
        helperExitCode: 1,
        updaterResult: {
          status: "skipped",
          mode: "unknown",
          reason: "not-git-install",
          steps: [],
          durationMs: 0,
        },
        recordedFailure: {
          result: {
            status: "skipped",
            mode: "unknown",
            reason: "not-git-install",
            recovery: { serviceRestartSafe: true },
            steps: [],
          },
        },
      });

      expect(state).toMatchObject({
        triageCalls: 1,
        triageObservedRecovery: false,
        triageObservedRestored: false,
        triageInput: {
          result: {
            status: "skipped",
            reason: "not-git-install",
            recovery: { serviceRestartSafe: true },
          },
        },
      });
      expect(state.guardedRestart).toBeUndefined();
      expect(
        commands.some((command) =>
          /(?:^| )(?:start|reset-failed|enable|bootstrap|kickstart)(?: |$)/.test(command),
        ),
      ).toBe(false);
      expect(state.triageInput).toHaveProperty(
        "error",
        expect.stringContaining("Service recovery outcome was not recorded"),
      );
      expect(helperLog).toContain("update triage completed");
    },
  );
}
