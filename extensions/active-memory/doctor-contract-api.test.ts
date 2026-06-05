// Active Memory tests cover doctor contract api plugin behavior.
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
      return createPluginStateKeyedStoreForTests<T>("active-memory", {
        ...options,
        env: options.env ?? env,
      });
    },
  };
}

describe("active-memory doctor state migration", () => {
  let stateDir = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-active-memory-doctor-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("imports legacy session opt-outs into plugin state", async () => {
    const sourcePath = path.join(stateDir, "plugins", "active-memory", "session-toggles.json");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        sessions: {
          "telegram:dm:123": { disabled: true, updatedAt: 1700 },
          "telegram:dm:456": { disabled: false, updatedAt: 1701 },
        },
      }),
    );

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
      preview: [expect.stringContaining("1 entry")],
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
      expect.stringContaining("Migrated 1 Active Memory session toggle entry"),
      expect.stringContaining("Archived Active Memory session toggles legacy source"),
    ]);
    await expect(fs.access(sourcePath)).rejects.toThrow();
    await expect(fs.access(`${sourcePath}.migrated`)).resolves.toBeUndefined();

    const entries = await createDoctorContext(env)
      .openPluginStateKeyedStore({
        namespace: "session-toggles",
        maxEntries: 10_000,
      })
      .entries();
    expect(entries).toMatchObject([
      {
        key: expect.any(String),
        value: {
          sessionKey: "telegram:dm:123",
          disabled: true,
          updatedAt: 1700,
        },
      },
    ]);
  });
});
