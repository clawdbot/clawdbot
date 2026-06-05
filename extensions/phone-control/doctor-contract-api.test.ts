// Phone Control tests cover doctor contract api plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";

function createDoctorContext(env: NodeJS.ProcessEnv): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStoreForTests<T>("phone-control", {
        ...options,
        env: options.env ?? env,
      });
    },
  };
}

describe("phone-control doctor state migration", () => {
  let stateDir = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-phone-control-doctor-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("imports legacy armed state into plugin state", async () => {
    const sourcePath = path.join(stateDir, "plugins", "phone-control", "armed.json");
    const legacyState = {
      version: 2,
      armedAtMs: 100,
      expiresAtMs: 200,
      group: "writes",
      armedCommands: ["sms.send"],
      addedToAllow: ["sms.send"],
      removedFromDeny: [],
    };
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, JSON.stringify(legacyState));

    const migration = stateMigrations[0];
    await expect(
      migration.detectLegacyState({
        config: {},
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context: createDoctorContext(env),
      }),
    ).resolves.toMatchObject({
      preview: [expect.stringContaining("Phone Control armed state")],
    });

    const result = await migration.migrateLegacyState({
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated Phone Control armed state -> plugin state",
      expect.stringContaining("Archived Phone Control armed-state legacy source"),
    ]);
    await expect(fs.access(sourcePath)).rejects.toThrow();
    await expect(fs.access(`${sourcePath}.migrated`)).resolves.toBeUndefined();
    await expect(
      createDoctorContext(env)
        .openPluginStateKeyedStore({
          namespace: "armed",
          maxEntries: 1,
        })
        .lookup("current"),
    ).resolves.toEqual(legacyState);
  });
});
