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
      return createPluginStateKeyedStoreForTests<T>("nostr", {
        ...options,
        env: options.env ?? env,
      });
    },
  };
}

describe("nostr doctor state migration", () => {
  let stateDir = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-nostr-doctor-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("imports legacy bus and profile state into plugin state", async () => {
    const nostrDir = path.join(stateDir, "nostr");
    const busPath = path.join(nostrDir, "bus-state-main.json");
    const profilePath = path.join(nostrDir, "profile-state-main.json");
    await fs.mkdir(nostrDir, { recursive: true });
    await fs.writeFile(
      busPath,
      JSON.stringify({
        version: 1,
        lastProcessedAt: 1700,
        gatewayStartedAt: 1600,
      }),
    );
    await fs.writeFile(
      profilePath,
      JSON.stringify({
        version: 1,
        lastPublishedAt: 1800,
        lastPublishedEventId: "event-1",
        lastPublishResults: { "wss://relay.example": "ok", bad: "nope" },
      }),
    );

    const context = createDoctorContext(env);
    const busResult = await stateMigrations[0].migrateLegacyState({
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context,
    });
    const profileResult = await stateMigrations[1].migrateLegacyState({
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context,
    });

    expect(busResult.warnings).toEqual([]);
    expect(profileResult.warnings).toEqual([]);
    await expect(fs.access(busPath)).rejects.toThrow();
    await expect(fs.access(profilePath)).rejects.toThrow();
    await expect(fs.access(`${busPath}.migrated`)).resolves.toBeUndefined();
    await expect(fs.access(`${profilePath}.migrated`)).resolves.toBeUndefined();
    await expect(
      context.openPluginStateKeyedStore({ namespace: "bus-state", maxEntries: 256 }).lookup("main"),
    ).resolves.toEqual({
      version: 2,
      lastProcessedAt: 1700,
      gatewayStartedAt: 1600,
      recentEventIds: [],
    });
    await expect(
      context
        .openPluginStateKeyedStore({ namespace: "profile-state", maxEntries: 256 })
        .lookup("main"),
    ).resolves.toEqual({
      version: 1,
      lastPublishedAt: 1800,
      lastPublishedEventId: "event-1",
      lastPublishResults: { "wss://relay.example": "ok" },
    });
  });
});
