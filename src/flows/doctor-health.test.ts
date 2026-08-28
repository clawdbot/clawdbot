import { beforeEach, describe, expect, it, vi } from "vitest";
import { runDoctorHealthFlow } from "./doctor-health.js";

const mocks = vi.hoisted(() => ({
  outro: vi.fn(),
  writeUpdatePostInstallDoctorResult: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: mocks.outro,
}));

vi.mock("../config/paths.js", () => ({
  resolveStateDir: () => "/tmp/openclaw-doctor-state-does-not-exist",
}));

vi.mock("../state/openclaw-database-preflight.js", () => ({
  OpenClawDatabaseSchemaPreflightError: class extends Error {},
  preflightOpenClawDatabaseSchemas: () => ({ incompatible: [], indeterminate: [] }),
}));

vi.mock("../state/openclaw-agent-db.js", () => ({
  OPENCLAW_AGENT_SCHEMA_VERSION: 1,
}));

vi.mock("../state/openclaw-state-db-contract.js", () => ({
  OPENCLAW_STATE_SCHEMA_VERSION: 1,
}));

vi.mock("../commands/doctor-prompter.js", () => ({
  createDoctorPrompter: () => ({}),
}));

vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: async () => undefined,
}));

vi.mock("../commands/doctor-update.js", () => ({
  maybeOfferUpdateBeforeDoctor: async () => ({ handled: false }),
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
  loadAndMaybeMigrateDoctorConfig: async () => ({ cfg: {}, shouldWriteConfig: true }),
}));

vi.mock("../config/config.js", () => ({
  CONFIG_PATH: "/tmp/openclaw.json",
}));

vi.mock("../infra/update-doctor-result.js", () => ({
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE: 86,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV: "OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH",
  writeUpdatePostInstallDoctorResult: mocks.writeUpdatePostInstallDoctorResult,
}));

vi.mock("./doctor-health-contributions.js", () => ({
  runDoctorHealthContributions: async (ctx: {
    configWriteRefusal?: "cron-owner-safety";
    postInstallDoctorResult?: {
      status: "advisory";
      advisory: {
        kind: "package-post-install-doctor";
        message: string;
        reason: "deferred-configured-plugin-repair";
        details: string[];
      };
    };
  }) => {
    ctx.configWriteRefusal = "cron-owner-safety";
    ctx.postInstallDoctorResult = {
      status: "advisory",
      advisory: {
        kind: "package-post-install-doctor",
        message: "recoverable plugin repair",
        reason: "deferred-configured-plugin-repair",
        details: ["plugin repair deferred"],
      },
    };
  },
}));

describe("runDoctorHealthFlow", () => {
  beforeEach(() => {
    mocks.outro.mockClear();
    mocks.writeUpdatePostInstallDoctorResult.mockClear();
  });

  it("reports a cron ownership refusal instead of a recoverable post-install advisory", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    vi.stubEnv(
      "OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH",
      "/tmp/openclaw-update-doctor-result.json",
    );

    try {
      await runDoctorHealthFlow(runtime, {});
    } finally {
      vi.unstubAllEnvs();
    }

    expect(mocks.outro).toHaveBeenCalledWith("Doctor finished, but config fixes were not applied.");
    expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.exit).not.toHaveBeenCalledWith(86);
    expect(mocks.writeUpdatePostInstallDoctorResult).not.toHaveBeenCalled();
  });
});
