import { describe, expect, it, vi } from "vitest";
import { runGatewayStartupMigrations } from "./startup-migrations.js";

const runDoctorConfigPreflight = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../../commands/doctor-config-preflight.js", () => ({
  runDoctorConfigPreflight,
}));

describe("runGatewayStartupMigrations", () => {
  it("completes the full plugin-aware migration phase", async () => {
    const beforeStateMigrations = vi.fn(async () => true);

    await runGatewayStartupMigrations({ beforeStateMigrations });

    expect(runDoctorConfigPreflight).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      requireStartupMigrationCheckpoint: true,
      pluginRuntime: "full",
      beforeStateMigrations,
    });
  });
});
