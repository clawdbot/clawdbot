import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { UpdateRunResult } from "../infra/update-runner.js";
import { ExitError } from "../runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contributions.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

const mocks = vi.hoisted(() => ({
  offerUpdate: vi.fn<typeof import("../commands/doctor-update.js").maybeOfferUpdateBeforeDoctor>(),
  runGatewayUpdate: vi.fn<typeof import("../infra/update-runner.js").runGatewayUpdate>(),
  triageCommand: vi.fn(async () => undefined),
  outro: vi.fn(),
  config: vi.fn<() => OpenClawConfig>(),
  runContributions: vi.fn<(ctx: DoctorHealthFlowContext) => Promise<void>>(),
  service: vi.fn(),
  packageRoot: vi.fn<() => string | undefined>(),
}));

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  note: vi.fn(),
  outro: mocks.outro,
}));

vi.mock("../commands/doctor-prompter.js", () => ({
  createDoctorPrompter: () => ({ confirm: async () => true }),
}));

vi.mock("../infra/openclaw-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRoot: async () => mocks.packageRoot(),
}));

vi.mock("../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/service.js")>()),
  resolveGatewayService: () => mocks.service(),
}));

vi.mock("../config/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/paths.js")>()),
  // The fixture's native manager belongs to its isolated state directory.
  isDefaultInstallIdentity: () => true,
}));

vi.mock("../daemon/schtasks-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/schtasks-runtime.js")>()),
  isScheduledTaskDefinitelyNotRunning: () => true,
  readWindowsStartupFallbackRuntimeForUpdate: async () => null,
}));

vi.mock("../cli/update-cli/update-command-service-plan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/update-cli/update-command-service-plan.js")>()),
  // Host profile policy must not select a real service for the fixture's manager.
  assertGatewayServiceManagementAllowedForUpdate: () => undefined,
  resolveGatewayServiceManagementBlockMessageForUpdate: () => undefined,
}));

vi.mock("../cli/daemon-cli/restart-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/daemon-cli/restart-health.js")>()),
  waitForGatewayHealthyRestart: async () => ({ healthy: true, runtime: { status: "running" } }),
  renderRestartDiagnostics: () => ["synthetic readiness failure"],
}));

vi.mock("../infra/update-candidate-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/update-candidate-state.js")>();
  return {
    ...actual,
    // This flow controls update outcomes without installing an artifact. Keep the
    // real child-process schema read, but resolve its worker from source on both sides.
    readUpdateStateSchemaVersions: (
      params: Parameters<typeof actual.readUpdateStateSchemaVersions>[0],
    ) => actual.readUpdateStateSchemaVersions({ ...params, root: undefined }),
  };
});

vi.mock("../infra/update-runner.js", () => ({
  runGatewayUpdate: mocks.runGatewayUpdate,
}));

vi.mock("../commands/doctor-update.js", () => ({
  maybeOfferUpdateBeforeDoctor: mocks.offerUpdate,
}));

vi.mock("../commands/triage.js", () => ({
  triageCommand: mocks.triageCommand,
}));

vi.mock("../commands/doctor-ui.js", () => ({
  maybeRepairUiProtocolFreshness: async () => undefined,
}));

vi.mock("../commands/doctor-install.js", () => ({
  noteSourceInstallIssues: () => undefined,
}));

vi.mock("../commands/doctor/shared/plugin-runtime-symlinks.js", () => ({
  noteStalePluginRuntimeSymlinks: async () => undefined,
}));

vi.mock("../commands/doctor-platform-notes.js", () => ({
  noteStartupOptimizationHints: () => undefined,
}));

vi.mock("../commands/doctor-config-flow.js", () => ({
  loadAndMaybeMigrateDoctorConfig: async () => ({ cfg: mocks.config(), shouldWriteConfig: true }),
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  CONFIG_PATH: "/tmp/openclaw.json",
}));

vi.mock("./doctor-health-contributions.js", () => ({
  runDoctorHealthContributions: mocks.runContributions,
}));

describe("runDoctorHealthFlow update outcomes", () => {
  afterEach(() => vi.unstubAllEnvs());

  beforeEach(() => {
    // Exercise only the isolated fixture manager, independent of the host policy.
    vi.stubEnv("OPENCLAW_SERVICE_REPAIR_POLICY", undefined);
    mocks.offerUpdate.mockReset().mockResolvedValue({ updated: false });
    mocks.runGatewayUpdate.mockReset();
    mocks.triageCommand.mockReset().mockResolvedValue(undefined);
    mocks.config.mockReturnValue({});
    mocks.packageRoot.mockReturnValue(undefined);
    mocks.service.mockReset();
    mocks.outro.mockClear();
    mocks.runContributions.mockReset().mockResolvedValue(undefined);
  });

  it.each([
    "rollback-checkout-dirty",
    "state-migration-started",
    "recovered-update-error",
    "dirty",
    "already-current",
  ] as const)(
    "preserves the accepted update outcome when Doctor completes: %s",
    async (outcome) => {
      const { maybeOfferUpdateBeforeDoctor } = await vi.importActual<
        typeof import("../commands/doctor-update.js")
      >("../commands/doctor-update.js");
      mocks.offerUpdate.mockImplementation(maybeOfferUpdateBeforeDoctor);
      const serviceRecovery = await import("../cli/update-cli/update-command-service-recovery.js");
      const recoverService = vi.spyOn(
        serviceRecovery,
        "maybeRestartServiceAfterFailedMutableUpdate",
      );
      const serviceCommands = await import("../cli/update-cli/update-command-service-command.js");
      const restartUpdatedInstall = vi.spyOn(serviceCommands, "runUpdatedInstallGatewayCommand");
      const scheduledTasks = await import("../daemon/schtasks.js");
      const taskSuspension = vi
        .spyOn(scheduledTasks, "suspendScheduledTaskAutoStartForUpdate")
        .mockResolvedValue(false);
      const terminals = [process.stdin, process.stdout].map((stream) => ({
        stream,
        descriptor: Object.getOwnPropertyDescriptor(stream, "isTTY"),
      }));
      for (const { stream } of terminals) {
        Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
      }
      try {
        await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
          const skipped = outcome === "dirty" || outcome === "already-current";
          const noop = outcome === "already-current";
          const recovered = outcome === "recovered-update-error";
          const cfg: OpenClawConfig = { gateway: { mode: "local" } };
          await state.writeConfig(cfg);
          mocks.config.mockReturnValue(cfg);
          const packageRoot = process.cwd();
          mocks.packageRoot.mockReturnValue(packageRoot);
          let running = true;
          const stop = vi.fn(async () => {
            running = false;
          });
          const restart = vi.fn();
          restartUpdatedInstall.mockImplementation(async () => {
            running = true;
            return "accepted";
          });
          mocks.service.mockReturnValue({
            readCommand: async () => ({
              programArguments: [
                process.execPath,
                path.join(packageRoot, "openclaw.mjs"),
                "gateway",
              ],
              environment: {
                OPENCLAW_STATE_DIR: state.stateDir,
                OPENCLAW_CONFIG_PATH: state.configPath,
              },
            }),
            readRuntime: async () => ({ status: running ? "running" : "stopped" }),
            readLoadState: async () => ({ status: running ? "loaded" : "not-loaded" }),
            isLoaded: async () => running,
            isEnabled: async () => running,
            stop,
            restart,
          });
          const updateResult: UpdateRunResult = {
            status: skipped ? "skipped" : "error",
            mode: "git",
            root: packageRoot,
            reason: skipped ? outcome : recovered ? "deps-install-failed" : "doctor-failed",
            steps: recovered
              ? [
                  {
                    name: "deps install",
                    command: "pnpm install",
                    cwd: packageRoot,
                    durationMs: 1,
                    exitCode: 1,
                    stderrTail: "synthetic dependency install failure",
                  },
                ]
              : [],
            durationMs: 1,
            recovery:
              outcome === "rollback-checkout-dirty" || outcome === "state-migration-started"
                ? { serviceRestartSafe: false, reason: outcome }
                : { serviceRestartSafe: true, version: "2026.9.1" },
          };
          const expectedUpdate = structuredClone(updateResult);
          mocks.runGatewayUpdate.mockImplementation(async (options = {}) => {
            if (!skipped) {
              await options.beforeGitMutation?.({});
            }
            return updateResult;
          });
          const runtime = {
            log: vi.fn(),
            error: vi.fn(),
            exit: vi.fn((code: number) => {
              throw new ExitError(code);
            }),
          };
          let exitCode: number | undefined;
          try {
            await runDoctorHealthFlow(runtime);
          } catch (error) {
            if (!(error instanceof ExitError)) {
              throw error;
            }
            exitCode = error.code;
          }

          expect(mocks.runGatewayUpdate).toHaveBeenCalledOnce();
          expect(stop).toHaveBeenCalledTimes(skipped ? 0 : 1);
          expect(restart).not.toHaveBeenCalled();
          expect(restartUpdatedInstall).toHaveBeenCalledTimes(recovered ? 1 : 0);
          expect(running).toBe(recovered || skipped);
          if (recovered) {
            // Exercise successful native recovery; a recovery failure would hide
            // the bug by already taking Doctor's terminal error branch.
            await expect(recoverService.mock.results[0]?.value).resolves.toBe("healthy");
          }
          if (noop) {
            expect(mocks.runContributions).toHaveBeenCalledOnce();
            expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
            expect(mocks.triageCommand).not.toHaveBeenCalled();
            expect(exitCode).toBeUndefined();
          } else {
            expect(exitCode).toBe(1);
            expect(mocks.runContributions).not.toHaveBeenCalled();
            expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
            expect(mocks.triageCommand).toHaveBeenCalledExactlyOnceWith(
              expect.objectContaining({
                log: runtime.log,
                error: runtime.error,
                exit: expect.any(Function),
              }),
              expect.objectContaining({
                recovery: expect.objectContaining({
                  updateFailure: {
                    result: expect.objectContaining({
                      status: expectedUpdate.status,
                      reason: expectedUpdate.reason,
                      steps: expectedUpdate.steps,
                      recovery: expect.objectContaining(expectedUpdate.recovery),
                    }),
                  },
                }),
              }),
            );
          }
        });
      } finally {
        recoverService.mockRestore();
        restartUpdatedInstall.mockRestore();
        taskSuspension.mockRestore();
        for (const { stream, descriptor } of terminals) {
          if (descriptor) {
            Object.defineProperty(stream, "isTTY", descriptor);
          } else {
            delete (stream as Partial<typeof stream>).isTTY;
          }
        }
      }
    },
  );
});
