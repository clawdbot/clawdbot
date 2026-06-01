import { createHash } from "node:crypto";
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
      return createPluginStateKeyedStoreForTests<T>("msteams", {
        ...options,
        env: options.env ?? env,
      });
    },
  };
}

function encodeSessionKey(sessionKey: string): string {
  return Buffer.from(sessionKey, "utf8").toString("base64url");
}

function learningStoreKey(storePath: string, sessionKey: string): string {
  return createHash("sha256").update(`${storePath}\0${sessionKey}`, "utf8").digest("hex");
}

describe("msteams doctor state migration", () => {
  let stateDir = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-doctor-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("imports legacy feedback learnings into plugin state", async () => {
    const agentStoreTemplate = path.join(stateDir, "agents", "{agentId}", "sessions");
    const mainStorePath = path.join(stateDir, "agents", "main", "sessions");
    const workStorePath = path.join(stateDir, "agents", "work", "sessions");
    const encodedSessionKey = "msteams:user1";
    const encodedSourcePath = path.join(
      mainStorePath,
      `${encodeSessionKey(encodedSessionKey)}.learnings.json`,
    );
    const sanitizedSessionKey = "msteams:channel:19:abc@thread.tacv2";
    const sanitizedSourcePath = path.join(
      workStorePath,
      "msteams_channel_19_abc_thread_tacv2.learnings.json",
    );
    await fs.mkdir(mainStorePath, { recursive: true });
    await fs.mkdir(workStorePath, { recursive: true });
    await fs.writeFile(
      path.join(workStorePath, "sessions.json"),
      JSON.stringify({ sessions: { [sanitizedSessionKey]: {} } }),
    );
    await fs.writeFile(encodedSourcePath, JSON.stringify(["Be concise", "Use examples"]));
    await fs.writeFile(sanitizedSourcePath, JSON.stringify(["Prefer cards for channel feedback"]));

    const migration = stateMigrations[0];
    const context = createDoctorContext(env);
    await context
      .openPluginStateKeyedStore({
        namespace: "feedback-learnings",
        maxEntries: 10_000,
      })
      .register(learningStoreKey(mainStorePath, encodedSessionKey), {
        sessionKey: encodedSessionKey,
        learnings: ["Use examples", "New runtime note"],
        updatedAt: 1900,
      });

    await expect(
      migration.detectLegacyState({
        config: {
          session: { store: agentStoreTemplate },
          agents: { list: [{ id: "work" }] },
        },
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context,
      }),
    ).resolves.toMatchObject({
      preview: [expect.stringContaining("2 files")],
    });

    const result = await migration.migrateLegacyState({
      config: {
        session: { store: agentStoreTemplate },
        agents: { list: [{ id: "work" }] },
      },
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context,
    });

    expect(result.changes).toEqual([
      expect.stringContaining("Migrated 2 Microsoft Teams feedback-learning entries"),
      expect.stringContaining("Archived Microsoft Teams feedback-learning legacy source"),
      expect.stringContaining("Archived Microsoft Teams feedback-learning legacy source"),
    ]);
    expect(result.warnings).toEqual([]);
    await expect(fs.access(encodedSourcePath)).rejects.toThrow();
    await expect(fs.access(sanitizedSourcePath)).rejects.toThrow();
    await expect(fs.access(`${encodedSourcePath}.migrated`)).resolves.toBeUndefined();
    await expect(fs.access(`${sanitizedSourcePath}.migrated`)).resolves.toBeUndefined();

    const store = context.openPluginStateKeyedStore({
      namespace: "feedback-learnings",
      maxEntries: 10_000,
    });
    await expect(
      store.lookup(learningStoreKey(mainStorePath, encodedSessionKey)),
    ).resolves.toMatchObject({
      sessionKey: encodedSessionKey,
      learnings: ["Be concise", "Use examples", "New runtime note"],
    });
    await expect(
      store.lookup(learningStoreKey(workStorePath, sanitizedSessionKey)),
    ).resolves.toMatchObject({
      sessionKey: sanitizedSessionKey,
      learnings: ["Prefer cards for channel feedback"],
    });
  });
});
