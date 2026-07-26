import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readConfigMachineState, writeConfigMachineState } from "../state/config-machine-state.js";
import {
  claimControlUiDeviceAuthMigration,
  completeControlUiDeviceAuthMigration,
  recoverControlUiDeviceAuthMigrationClaim,
  readControlUiDeviceAuthMigrationState,
  releaseControlUiDeviceAuthMigrationClaim,
} from "../state/control-ui-device-auth-migration.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { migrateLegacyConfigMachineState } from "./state-migrations.config-machine-state.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("legacy config machine-state migration", () => {
  it("imports machine-owned values and keeps existing database state", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "openclaw-config-machine-state-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    writeConfigMachineState("config.lastTouchedAt", "canonical", { env });

    const result = migrateLegacyConfigMachineState({
      env,
      config: {
        meta: { lastTouchedVersion: "legacy", lastTouchedAt: "legacy-time" },
        hooks: { internal: { installs: { pack: { source: "npm" } } } },
        plugins: { bundledDiscovery: "compat" },
        tts: { prefsPath: "/tmp/tts.json" },
        cron: { store: "/tmp/jobs.json" },
      } as never,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain("Kept existing shared SQLite config.lastTouchedAt state");
    expect(readConfigMachineState("config.lastTouchedAt", { env })).toBe("canonical");
    expect(readConfigMachineState("hooks.internal.installs", { env })).toEqual({
      pack: { source: "npm" },
    });
    expect(readConfigMachineState("plugins.bundledDiscovery", { env })).toBe("compat");
    expect(readConfigMachineState("tts.prefsPath", { env })).toBe("/tmp/tts.json");
    expect(readConfigMachineState("cron.store", { env })).toBe("/tmp/jobs.json");
  });

  it("merges legacy hook installs while canonical records win conflicts", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "openclaw-config-machine-state-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    writeConfigMachineState(
      "hooks.internal.installs",
      { canonical: { source: "npm" }, shared: { source: "path" } },
      { env },
    );

    migrateLegacyConfigMachineState({
      env,
      config: {
        hooks: {
          internal: {
            installs: {
              legacy: { source: "archive" },
              shared: { source: "archive" },
            },
          },
        },
      } as never,
    });

    expect(readConfigMachineState("hooks.internal.installs", { env })).toEqual({
      canonical: { source: "npm" },
      legacy: { source: "archive" },
      shared: { source: "path" },
    });
  });

  it("conservatively preserves compatibility for an unstamped plugin allowlist", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "openclaw-config-machine-state-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };

    migrateLegacyConfigMachineState({ env, config: { plugins: { allow: ["telegram"] } } });

    expect(readConfigMachineState("plugins.bundledDiscovery", { env })).toBe("compat");
  });

  it("preserves compatibility discovery for a pre-cutover plugin allowlist", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "openclaw-config-machine-state-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };

    migrateLegacyConfigMachineState({
      env,
      config: {
        meta: { lastTouchedVersion: "2026.1.1" },
        plugins: { allow: ["telegram"] },
      },
    });

    expect(readConfigMachineState("plugins.bundledDiscovery", { env })).toBe("compat");
  });

  it("does not infer compatibility discovery after the fixed cutover release", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "openclaw-config-machine-state-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };

    migrateLegacyConfigMachineState({
      env,
      config: {
        meta: { lastTouchedVersion: "2026.7.2" },
        plugins: { allow: ["telegram"] },
      },
    });

    expect(readConfigMachineState("plugins.bundledDiscovery", { env })).toBeUndefined();
  });

  it("preserves the shipped device-auth bypass as pending migration state", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "openclaw-config-machine-state-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };

    migrateLegacyConfigMachineState({
      env,
      config: {
        gateway: { controlUi: { dangerouslyDisableDeviceAuth: true } },
      },
    });

    expect(readControlUiDeviceAuthMigrationState({ env })).toMatchObject({
      version: 1,
      status: "pending",
    });
  });

  it("never reopens a completed migration from stale legacy config", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "openclaw-config-machine-state-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    completeControlUiDeviceAuthMigration("browser-1", { env });

    migrateLegacyConfigMachineState({
      env,
      config: {
        gateway: { controlUi: { dangerouslyDisableDeviceAuth: true } },
      },
    });

    expect(readControlUiDeviceAuthMigrationState({ env })).toMatchObject({
      status: "completed",
      deviceId: "browser-1",
    });
  });

  it("allows one claim and recovers a released or interrupted claim", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "openclaw-config-machine-state-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    migrateLegacyConfigMachineState({
      env,
      config: { gateway: { controlUi: { dangerouslyDisableDeviceAuth: true } } },
    });

    expect(claimControlUiDeviceAuthMigration("browser-1", { env })).toBe(true);
    expect(claimControlUiDeviceAuthMigration("browser-2", { env })).toBe(false);
    releaseControlUiDeviceAuthMigrationClaim("browser-1", { env });
    expect(claimControlUiDeviceAuthMigration("browser-2", { env })).toBe(true);

    expect(recoverControlUiDeviceAuthMigrationClaim({ env })).toMatchObject({
      status: "pending",
    });
    expect(claimControlUiDeviceAuthMigration("browser-3", { env })).toBe(true);
  });

  it("does not create migration state when the retired bypass was disabled", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "openclaw-config-machine-state-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };

    migrateLegacyConfigMachineState({
      env,
      config: {
        gateway: { controlUi: { dangerouslyDisableDeviceAuth: false } },
      },
    });

    expect(readControlUiDeviceAuthMigrationState({ env })).toBeUndefined();
  });

  it("does not treat a newly written current config as upgrade input", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "openclaw-config-machine-state-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };

    migrateLegacyConfigMachineState({
      env,
      config: {
        meta: { lastTouchedVersion: "2026.7.2" },
        gateway: { controlUi: { dangerouslyDisableDeviceAuth: true } },
      },
    });

    expect(readControlUiDeviceAuthMigrationState({ env })).toBeUndefined();
  });
});
