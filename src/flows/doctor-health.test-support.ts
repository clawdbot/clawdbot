import { vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contributions.js";

const mocks = vi.hoisted(() => ({
  outro: vi.fn(),
  config: vi.fn<() => OpenClawConfig>(),
  runContributions: vi.fn<(ctx: DoctorHealthFlowContext) => Promise<void>>(),
  writeUpdatePostInstallDoctorResult: vi.fn(),
  service: vi.fn(),
  packageRoot: vi.fn<() => string | undefined>(),
  restartedHealthy: true,
  emulateNativeInstall: true,
  servicePlatform: undefined as NodeJS.Platform | undefined,
  taskDefinitelyStopped: vi.fn(() => true),
  startupFallbackRuntime: vi.fn<() => Promise<{ status: string } | null>>(async () => null),
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

vi.mock("../config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/paths.js")>();
  return {
    ...actual,
    // Native-manager cases use isolated storage; runtime-only coverage retains
    // the real install-identity policy instead of adopting the host service.
    isDefaultInstallIdentity: (env: NodeJS.ProcessEnv) =>
      mocks.emulateNativeInstall || actual.isDefaultInstallIdentity(env),
  };
});

vi.mock("../daemon/schtasks-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/schtasks-runtime.js")>()),
  isScheduledTaskDefinitelyNotRunning: mocks.taskDefinitelyStopped,
  readWindowsStartupFallbackRuntimeForUpdate: mocks.startupFallbackRuntime,
}));

vi.mock("../cli/update-cli/update-command-service-maintenance.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../cli/update-cli/update-command-service-maintenance.js")
    >();
  return {
    ...actual,
    maybeStopManagedServiceBeforeMutableUpdate: async (
      params: Parameters<typeof actual.maybeStopManagedServiceBeforeMutableUpdate>[0],
    ) => {
      // Emulate the native manager only; workspace and SQLite identities must
      // retain the host filesystem's case semantics during real migration.
      const platform = mocks.servicePlatform
        ? vi.spyOn(process, "platform", "get").mockReturnValue(mocks.servicePlatform)
        : undefined;
      try {
        return await actual.maybeStopManagedServiceBeforeMutableUpdate(params);
      } finally {
        platform?.mockRestore();
      }
    },
  };
});

vi.mock("../cli/update-cli/update-command-service-plan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/update-cli/update-command-service-plan.js")>()),
  // The fixture owns an in-memory manager; native machine profile policy is
  // covered at the updater boundary and must not select a host service here.
  assertGatewayServiceManagementAllowedForUpdate: () => undefined,
  resolveGatewayServiceManagementBlockMessageForUpdate: () => undefined,
}));

vi.mock("../cli/daemon-cli/restart-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/daemon-cli/restart-health.js")>()),
  waitForGatewayHealthyRestart: async () => ({ healthy: mocks.restartedHealthy }),
  renderRestartDiagnostics: () => ["synthetic readiness failure"],
}));

vi.mock("../commands/doctor-update.js", () => ({
  maybeOfferUpdateBeforeDoctor: async () => ({ updated: false }),
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

vi.mock("../infra/update-doctor-result.js", () => ({
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE: 86,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV: "OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH",
  writeUpdatePostInstallDoctorResult: mocks.writeUpdatePostInstallDoctorResult,
}));

vi.mock("./doctor-health-contributions.js", () => ({
  runDoctorHealthContributions: mocks.runContributions,
}));

export { mocks };
