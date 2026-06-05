// Msteams tests cover doctor contract api plugin behavior.
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
import {
  buildMSTeamsConversationStateKey,
  MSTEAMS_CONVERSATIONS_NAMESPACE,
  type MSTeamsLegacyConversationStoreData,
} from "./src/conversation-store-state.js";
import type { StoredConversationReference } from "./src/conversation-store.js";
import {
  buildMSTeamsPollStateKey,
  buildMSTeamsPollVoteBucketKey,
  MSTEAMS_POLL_VOTE_BUCKETS_NAMESPACE,
  MSTEAMS_POLLS_NAMESPACE,
  selectMSTeamsPollVoteBucket,
  type MSTeamsPoll,
  type StoredMSTeamsPoll,
  type StoredMSTeamsPollVoteBucket,
} from "./src/polls.js";
import {
  makeMSTeamsSsoTokenStoreKey,
  MSTEAMS_SSO_TOKENS_NAMESPACE,
  type MSTeamsSsoStoredToken,
} from "./src/sso-token-store.js";

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

function migrationById(id: string) {
  const migration = stateMigrations.find((entry) => entry.id === id);
  if (!migration) {
    throw new Error(`missing migration ${id}`);
  }
  return migration;
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

  it("imports legacy conversations into plugin state", async () => {
    const filePath = path.join(stateDir, "msteams-conversations.json");
    const ref: StoredConversationReference = {
      conversation: { id: "19:conv@thread.tacv2" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com",
      user: { id: "user-1" },
    };
    await fs.writeFile(
      filePath,
      `${JSON.stringify({
        version: 1,
        conversations: {
          "19:conv@thread.tacv2": ref,
        },
      } satisfies MSTeamsLegacyConversationStoreData)}\n`,
    );

    const migration = migrationById("msteams-conversations-json-to-plugin-state");
    const context = createDoctorContext(env);
    await expect(
      migration.detectLegacyState({
        config: {},
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context,
      }),
    ).resolves.toMatchObject({
      preview: [expect.stringContaining("Microsoft Teams conversations")],
    });

    const result = await migration.migrateLegacyState({
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      expect.stringContaining("Migrated 1 Microsoft Teams conversation entry"),
      expect.stringContaining("Archived Microsoft Teams conversation legacy source"),
    ]);
    await expect(fs.access(filePath)).rejects.toThrow();
    await expect(fs.access(`${filePath}.migrated`)).resolves.toBeUndefined();
    const store = context.openPluginStateKeyedStore<StoredConversationReference>({
      namespace: MSTEAMS_CONVERSATIONS_NAMESPACE,
      maxEntries: 2000,
    });
    await expect(
      store.lookup(buildMSTeamsConversationStateKey("19:conv@thread.tacv2")),
    ).resolves.toMatchObject({
      conversation: { id: "19:conv@thread.tacv2" },
      user: { id: "user-1" },
    });
  });

  it("imports legacy polls and vote buckets into plugin state", async () => {
    const filePath = path.join(stateDir, "msteams-polls.json");
    const poll: MSTeamsPoll = {
      id: "poll-legacy",
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      maxSelections: 1,
      createdAt: new Date().toISOString(),
      votes: {
        "user-legacy": ["0"],
        "user-new": ["1"],
      },
    };
    await fs.writeFile(
      filePath,
      `${JSON.stringify({
        version: 1,
        polls: {
          "poll-legacy": poll,
        },
      })}\n`,
    );
    const context = createDoctorContext(env);
    const voteBucketStore = context.openPluginStateKeyedStore<StoredMSTeamsPollVoteBucket>({
      namespace: MSTEAMS_POLL_VOTE_BUCKETS_NAMESPACE,
      maxEntries: 32_032,
    });
    const legacyBucket = selectMSTeamsPollVoteBucket("poll-legacy", "user-legacy");
    await voteBucketStore.register(buildMSTeamsPollVoteBucketKey("poll-legacy", legacyBucket), {
      pollId: "poll-legacy",
      bucket: legacyBucket,
      votes: { "user-legacy": ["1"] },
      updatedAt: poll.createdAt,
    });

    const migration = migrationById("msteams-polls-json-to-plugin-state");
    const result = await migration.migrateLegacyState({
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      expect.stringContaining("Migrated 1 Microsoft Teams poll entry"),
      expect.stringContaining("Archived Microsoft Teams poll legacy source"),
    ]);
    const pollStore = context.openPluginStateKeyedStore<StoredMSTeamsPoll>({
      namespace: MSTEAMS_POLLS_NAMESPACE,
      maxEntries: 2000,
    });
    await expect(pollStore.lookup(buildMSTeamsPollStateKey("poll-legacy"))).resolves.toMatchObject({
      id: "poll-legacy",
      question: "Lunch?",
    });
    const newBucket = selectMSTeamsPollVoteBucket("poll-legacy", "user-new");
    await expect(
      voteBucketStore.lookup(buildMSTeamsPollVoteBucketKey("poll-legacy", legacyBucket)),
    ).resolves.toMatchObject({
      votes: { "user-legacy": ["1"] },
    });
    await expect(
      voteBucketStore.lookup(buildMSTeamsPollVoteBucketKey("poll-legacy", newBucket)),
    ).resolves.toMatchObject({
      votes: { "user-new": ["1"] },
    });
    await expect(fs.access(`${filePath}.migrated`)).resolves.toBeUndefined();
  });

  it("imports legacy SSO tokens into the existing plugin-state token namespace", async () => {
    const filePath = path.join(stateDir, "msteams-sso-tokens.json");
    const token: MSTeamsSsoStoredToken = {
      connectionName: "conn::alpha",
      userId: "user::one",
      token: "test-token-value",
      updatedAt: "2026-04-10T00:00:00.000Z",
    };
    await fs.writeFile(
      filePath,
      `${JSON.stringify({
        version: 1,
        tokens: {
          "legacy::wrong-key": token,
        },
      })}\n`,
    );

    const migration = migrationById("msteams-sso-tokens-json-to-plugin-state");
    const context = createDoctorContext(env);
    const result = await migration.migrateLegacyState({
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      expect.stringContaining("Migrated 1 Microsoft Teams SSO token entry"),
      expect.stringContaining("Archived Microsoft Teams SSO-token legacy source"),
    ]);
    const store = context.openPluginStateKeyedStore<MSTeamsSsoStoredToken>({
      namespace: MSTEAMS_SSO_TOKENS_NAMESPACE,
      maxEntries: 5000,
    });
    await expect(
      store.lookup(makeMSTeamsSsoTokenStoreKey("conn::alpha", "user::one")),
    ).resolves.toEqual(token);
    expect(result.changes.join("\n")).not.toContain(token.token);
    expect(result.warnings.join("\n")).not.toContain(token.token);
    await expect(fs.access(`${filePath}.migrated`)).resolves.toBeUndefined();
  });

  it("does not register a doctor migration for pending-upload cache files", () => {
    expect(stateMigrations.map((migration) => migration.id)).not.toContain(
      "msteams-pending-uploads-json-to-plugin-state",
    );
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

    const migration = migrationById("msteams-feedback-learnings-json-to-plugin-state");
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
