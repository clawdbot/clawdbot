import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
  setMaxPluginStateEntriesPerPluginForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { PluginDoctorStateMigrationContext } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import {
  buildMSTeamsConversationStateKey,
  MSTEAMS_CONVERSATIONS_NAMESPACE,
  MSTEAMS_SQLITE_MAX_CONVERSATION_ROWS,
} from "./src/conversation-store-state.js";
import {
  buildMSTeamsPollStateKey,
  buildMSTeamsPollVoteBucketKey,
  MSTEAMS_MAX_POLL_VOTE_BUCKET_ROWS,
  MSTEAMS_POLL_VOTE_BUCKETS_NAMESPACE,
  MSTEAMS_POLLS_NAMESPACE,
  MSTEAMS_SQLITE_MAX_POLL_ROWS,
  selectMSTeamsPollVoteBucket,
  type MSTeamsPoll,
} from "./src/polls.js";

function makePoll(id: string): MSTeamsPoll {
  return {
    id,
    question: "Pick one",
    options: ["A", "B"],
    maxSelections: 1,
    createdAt: new Date().toISOString(),
    votes: {},
  };
}

describe("Teams custom migration retention", () => {
  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  let context: PluginDoctorStateMigrationContext;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-teams-retention-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    context = {
      openPluginStateKeyedStore: (options) =>
        createPluginStateKeyedStoreForTests("msteams", { ...options, env }),
    };
  });

  afterEach(async () => {
    setMaxPluginStateEntriesPerPluginForTests();
    resetPluginStateStoreForTests();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it.each([
    {
      surface: "conversations",
      namespace: MSTEAMS_CONVERSATIONS_NAMESPACE,
      maxEntries: MSTEAMS_SQLITE_MAX_CONVERSATION_ROWS,
    },
    {
      surface: "polls",
      namespace: MSTEAMS_POLLS_NAMESPACE,
      maxEntries: MSTEAMS_SQLITE_MAX_POLL_ROWS,
    },
    {
      surface: "vote buckets",
      namespace: MSTEAMS_POLL_VOTE_BUCKETS_NAMESPACE,
      maxEntries: MSTEAMS_MAX_POLL_VOTE_BUCKET_ROWS,
    },
  ])(
    "retains the source when $surface evict a pre-existing row",
    async ({ surface, namespace, maxEntries }) => {
      const conversations = surface === "conversations";
      const kind = conversations ? "conversations" : "polls";
      const filePath = path.join(stateDir, `msteams-${kind}.json`);
      const migration = stateMigrations.find(
        (entry) => entry.id === `msteams-${kind}-json-to-plugin-state`,
      )!;
      const store = context.openPluginStateKeyedStore({ namespace, maxEntries });
      // Metadata fills the real namespace. Buckets use the existing plugin fuse
      // to reproduce the same SQLite eviction without seeding 32,032 rows.
      const capacity = surface === "vote buckets" ? 32 : maxEntries;
      if (surface === "vote buckets") {
        setMaxPluginStateEntriesPerPluginForTests(capacity + 1);
      }
      for (let index = 0; index < capacity; index++) {
        const id = `existing-${index}`;
        if (conversations) {
          await store.register(buildMSTeamsConversationStateKey(id), { conversation: { id } });
        } else if (surface === "polls") {
          const { votes: _votes, ...metadata } = makePoll(id);
          await store.register(buildMSTeamsPollStateKey(id), metadata);
        } else {
          const bucket = selectMSTeamsPollVoteBucket(id, "voter");
          await store.register(buildMSTeamsPollVoteBucketKey(id, bucket), {
            pollId: id,
            bucket,
            votes: { voter: ["1"] },
            updatedAt: new Date().toISOString(),
          });
        }
      }
      const before = new Set((await store.entries()).map((entry) => entry.key));
      const poll = {
        ...makePoll("legacy"),
        votes: surface === "vote buckets" ? { voter: ["0"] } : {},
      };
      const source = JSON.stringify({
        version: 1,
        [kind]: { legacy: conversations ? { conversation: { id: "legacy" } } : poll },
      });
      await fs.writeFile(filePath, source);
      const params = { config: {}, env, stateDir, oauthDir: stateDir, context };

      const result = await migration.migrateLegacyState(params);

      const after = new Set((await store.entries()).map((entry) => entry.key));
      expect(after.size).toBe(capacity);
      expect([...before].filter((key) => !after.has(key))).toHaveLength(1);
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe(source);
      await expect(fs.access(`${filePath}.migrated`)).rejects.toThrow();
      expect(result).toEqual({
        changes: [],
        warnings: [expect.stringContaining("failed to retain every required entry (1 missing)")],
      });
      await expect(migration.detectLegacyState(params)).resolves.not.toBeNull();
    },
  );

  it.each(["conversations", "polls", "vote buckets"])(
    "retains the source when plugin-wide pressure evicts imported %s",
    async (surface) => {
      // Exercise real SQLite eviction through the existing test-only plugin fuse.
      // Namespace limits and importer options remain the production values.
      setMaxPluginStateEntriesPerPluginForTests(2);
      const conversations = surface === "conversations";
      const kind = conversations ? "conversations" : "polls";
      const filePath = path.join(stateDir, `msteams-${kind}.json`);
      const migration = stateMigrations.find(
        (entry) => entry.id === `msteams-${kind}-json-to-plugin-state`,
      )!;
      const polls = Object.fromEntries(
        ["first", "second", "third"].map((id) => [id, makePoll(id)]),
      );
      if (surface === "vote buckets") {
        polls.first!.votes = Object.fromEntries(
          Array.from({ length: 100 }, (_, index) => [`voter-${index}`, ["0"]]),
        );
        delete polls.second;
        delete polls.third;
      }
      const source = JSON.stringify({
        version: 1,
        [kind]: conversations
          ? Object.fromEntries(Object.keys(polls).map((id) => [id, { conversation: { id } }]))
          : polls,
      });
      await fs.writeFile(filePath, source);
      const params = { config: {}, env, stateDir, oauthDir: stateDir, context };
      const result = await migration.migrateLegacyState(params);
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe(source);
      await expect(fs.access(`${filePath}.migrated`)).rejects.toThrow();
      expect(result.changes).toEqual([]);
      expect(result.warnings).toEqual([
        expect.stringContaining("failed to retain every required entry"),
      ]);
      await expect(migration.detectLegacyState(params)).resolves.not.toBeNull();
    },
  );

  it.each(["conversations", "polls"])(
    "requires only the %s selected by the existing age and count limits",
    async (kind) => {
      const conversations = kind === "conversations";
      const filePath = path.join(stateDir, `msteams-${kind}.json`);
      const migration = stateMigrations.find(
        (entry) => entry.id === `msteams-${kind}-json-to-plugin-state`,
      )!;
      const entries = Object.fromEntries(
        Array.from({ length: 1002 }, (_, index) => {
          const id = `legacy-${index}`;
          const timestamp =
            index === 0
              ? "2020-01-01T00:00:00.000Z"
              : new Date(Date.now() - 60_000 + index).toISOString();
          return [
            id,
            conversations
              ? { conversation: { id }, lastSeenAt: timestamp }
              : { ...makePoll(id), createdAt: timestamp },
          ];
        }),
      );
      const source = JSON.stringify({ version: 1, [kind]: entries });
      await fs.writeFile(filePath, source);
      const params = { config: {}, env, stateDir, oauthDir: stateDir, context };
      const result = await migration.migrateLegacyState(params);
      expect(result.warnings).toEqual([]);
      expect(result.changes).toContainEqual(expect.stringContaining("Migrated 1000"));
      const store = context.openPluginStateKeyedStore({
        namespace: conversations ? MSTEAMS_CONVERSATIONS_NAMESPACE : MSTEAMS_POLLS_NAMESPACE,
        maxEntries: conversations
          ? MSTEAMS_SQLITE_MAX_CONVERSATION_ROWS
          : MSTEAMS_SQLITE_MAX_POLL_ROWS,
      });
      const keyFor = conversations ? buildMSTeamsConversationStateKey : buildMSTeamsPollStateKey;
      expect((await store.entries()).map((entry) => entry.key).toSorted()).toEqual(
        Array.from({ length: 1000 }, (_, index) => keyFor(`legacy-${index + 2}`)).toSorted(),
      );
      await expect(fs.readFile(`${filePath}.migrated`, "utf8")).resolves.toBe(source);
      await expect(migration.detectLegacyState(params)).resolves.toBeNull();
      await expect(migration.migrateLegacyState(params)).resolves.toEqual({
        changes: [],
        warnings: [],
      });
    },
  );

  it.each([false, true])(
    "preserves empty SSO import behavior (malformed row: %s)",
    async (malformed) => {
      const filePath = path.join(stateDir, "msteams-sso-tokens.json");
      const source = JSON.stringify({ version: 1, tokens: malformed ? { invalid: {} } : {} });
      await fs.writeFile(filePath, source);
      const migration = stateMigrations.find(
        (entry) => entry.id === "msteams-sso-tokens-json-to-plugin-state",
      )!;
      const params = { config: {}, env, stateDir, oauthDir: stateDir, context };
      expect(Boolean(await migration.detectLegacyState(params))).toBe(malformed);
      const result = await migration.migrateLegacyState(params);
      expect(result.warnings).toEqual(
        malformed ? ["Skipped 1 malformed Microsoft Teams SSO token entry during migration"] : [],
      );
      expect(result.changes).toEqual([
        "Migrated 0 Microsoft Teams SSO token entries -> plugin state",
        expect.stringContaining("Archived Microsoft Teams SSO-token legacy source"),
      ]);
      await expect(fs.readFile(`${filePath}.migrated`, "utf8")).resolves.toBe(source);
    },
  );
});
