import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPluginStateKeyedStoreForTests as createPluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor";
import { describe, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import { createWorkboardSqliteStores } from "./src/sqlite-store.js";
import { WorkboardStore, type PersistedWorkboardCard } from "./src/store.js";

function createDoctorContext(env: NodeJS.ProcessEnv): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStore<T>("workboard", {
        ...options,
        env: options.env ?? env,
      });
    },
  };
}

describe("workboard doctor contract", () => {
  it("migrates shipped .28 plugin-state workboard data into sqlite", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-doctor-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    try {
      const cardStore = createPluginStateKeyedStore<PersistedWorkboardCard>("workboard", {
        namespace: "workboard.cards",
        maxEntries: 2000,
        env,
      });
      const boardStore = createPluginStateKeyedStore("workboard", {
        namespace: "workboard.boards",
        maxEntries: 200,
        env,
      });
      const notifyStore = createPluginStateKeyedStore("workboard", {
        namespace: "workboard.notify",
        maxEntries: 2000,
        env,
      });
      const attachmentStore = createPluginStateKeyedStore("workboard", {
        namespace: "workboard.attachments",
        maxEntries: 42_000,
        env,
      });
      await boardStore.register("planning", {
        version: 1,
        board: { id: "planning", name: "Planning", createdAt: 1, updatedAt: 2 },
      });
      await cardStore.register("card-1", {
        version: 1,
        card: {
          id: "card-1",
          title: "Migrate me",
          status: "todo",
          priority: "normal",
          labels: ["sqlite"],
          position: 1000,
          createdAt: 1,
          updatedAt: 2,
          metadata: {
            automation: { boardId: "planning" },
            attachments: [
              {
                id: "attachment-1",
                cardId: "card-1",
                createdAt: 2,
                fileName: "proof.txt",
                byteSize: 2,
              },
            ],
          },
        },
      });
      await notifyStore.register("sub-1", {
        version: 1,
        subscription: { id: "sub-1", boardId: "planning", createdAt: 1, updatedAt: 2 },
      });
      await attachmentStore.register("attachment-1", {
        version: 1,
        attachment: {
          id: "attachment-1",
          cardId: "card-1",
          createdAt: 2,
          fileName: "proof.txt",
          byteSize: 2,
        },
        contentBase64: Buffer.from("ok").toString("base64"),
      });

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
        preview: [expect.stringContaining("4 legacy .28 plugin-state KV entries")],
      });

      const result = await migration.migrateLegacyState({
        config: {},
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context: createDoctorContext(env),
      });

      expect(result).toMatchObject({
        changes: [expect.stringContaining("Migrated 4 Workboard .28 plugin-state KV entries")],
        warnings: [],
      });
      expect(await cardStore.entries()).toEqual([]);
      expect(await boardStore.entries()).toEqual([]);
      expect(await notifyStore.entries()).toEqual([]);
      expect(await attachmentStore.entries()).toEqual([]);

      const sqlite = createWorkboardSqliteStores({ env });
      const store = new WorkboardStore(sqlite.cards, {
        boards: sqlite.boards,
        subscriptions: sqlite.subscriptions,
        attachments: sqlite.attachments,
      });
      expect(await store.get("card-1")).toMatchObject({
        title: "Migrate me",
        metadata: {
          automation: { boardId: "planning" },
          attachments: [expect.objectContaining({ id: "attachment-1" })],
        },
      });
      expect(await store.getAttachment("attachment-1")).toMatchObject({
        contentBase64: Buffer.from("ok").toString("base64"),
      });
      expect(await store.listBoards()).toMatchObject({
        boards: [
          expect.objectContaining({ id: "default" }),
          expect.objectContaining({ id: "planning" }),
        ],
      });
      expect(await store.listNotificationSubscriptions({ boardId: "planning" })).toMatchObject({
        subscriptions: [expect.objectContaining({ id: "sub-1" })],
      });
      sqlite.close();
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("resumes attachment migration when the owning card was already copied", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-doctor-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    try {
      const attachmentStore = createPluginStateKeyedStore("workboard", {
        namespace: "workboard.attachments",
        maxEntries: 42_000,
        env,
      });
      await attachmentStore.register("attachment-1", {
        version: 1,
        attachment: {
          id: "attachment-1",
          cardId: "card-1",
          createdAt: 2,
          fileName: "proof.txt",
          byteSize: 2,
        },
        contentBase64: Buffer.from("ok").toString("base64"),
      });

      const sqlite = createWorkboardSqliteStores({ env });
      await sqlite.cards.register("card-1", {
        version: 1,
        card: {
          id: "card-1",
          title: "Already copied",
          status: "todo",
          priority: "normal",
          labels: [],
          position: 1000,
          createdAt: 1,
          updatedAt: 2,
          metadata: {
            attachments: [
              {
                id: "attachment-1",
                cardId: "card-1",
                createdAt: 2,
                fileName: "proof.txt",
                byteSize: 2,
              },
            ],
          },
        },
      });
      sqlite.close();

      const result = await stateMigrations[0].migrateLegacyState({
        config: {},
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context: createDoctorContext(env),
      });

      expect(result).toMatchObject({
        changes: [expect.stringContaining("Migrated 1 Workboard .28 plugin-state KV entry")],
        warnings: [],
      });
      expect(await attachmentStore.entries()).toEqual([]);

      const reopenedStores = createWorkboardSqliteStores({ env });
      expect(await reopenedStores.attachments.lookup("attachment-1")).toMatchObject({
        contentBase64: Buffer.from("ok").toString("base64"),
      });
      reopenedStores.close();
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("skips malformed legacy attachments without aborting valid attachment migration", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-doctor-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    try {
      const attachmentStore = createPluginStateKeyedStore<unknown>("workboard", {
        namespace: "workboard.attachments",
        maxEntries: 42_000,
        env,
      });
      await attachmentStore.register("broken", { version: 1 });
      await attachmentStore.register("attachment-1", {
        version: 1,
        attachment: {
          id: "attachment-1",
          cardId: "card-1",
          createdAt: 2,
          fileName: "proof.txt",
          byteSize: 2,
        },
        contentBase64: Buffer.from("ok").toString("base64"),
      });

      const sqlite = createWorkboardSqliteStores({ env });
      await sqlite.cards.register("card-1", {
        version: 1,
        card: {
          id: "card-1",
          title: "Already copied",
          status: "todo",
          priority: "normal",
          labels: [],
          position: 1000,
          createdAt: 1,
          updatedAt: 2,
          metadata: {
            attachments: [
              {
                id: "attachment-1",
                cardId: "card-1",
                createdAt: 2,
                fileName: "proof.txt",
                byteSize: 2,
              },
            ],
          },
        },
      });
      sqlite.close();

      const result = await stateMigrations[0].migrateLegacyState({
        config: {},
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context: createDoctorContext(env),
      });

      expect(result.changes).toEqual([
        expect.stringContaining("Migrated 1 Workboard .28 plugin-state KV entry"),
      ]);
      expect(result.warnings).toEqual([
        expect.stringContaining("Skipped malformed legacy Workboard attachment entry broken"),
      ]);
      expect((await attachmentStore.entries()).map((entry) => entry.key)).toEqual(["broken"]);

      const reopenedStores = createWorkboardSqliteStores({ env });
      expect(await reopenedStores.attachments.lookup("attachment-1")).toMatchObject({
        contentBase64: Buffer.from("ok").toString("base64"),
      });
      reopenedStores.close();
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps orphan legacy attachments when migrated card metadata does not reference them", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-doctor-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    try {
      const cardStore = createPluginStateKeyedStore<PersistedWorkboardCard>("workboard", {
        namespace: "workboard.cards",
        maxEntries: 2000,
        env,
      });
      const attachmentStore = createPluginStateKeyedStore("workboard", {
        namespace: "workboard.attachments",
        maxEntries: 42_000,
        env,
      });
      await cardStore.register("card-1", {
        version: 1,
        card: {
          id: "card-1",
          title: "Migrated card",
          status: "todo",
          priority: "normal",
          labels: [],
          position: 1000,
          createdAt: 1,
          updatedAt: 1,
        },
      });
      await attachmentStore.register("attachment-1", {
        version: 1,
        attachment: {
          id: "attachment-1",
          cardId: "card-1",
          createdAt: 2,
          fileName: "orphan.txt",
          byteSize: 2,
        },
        contentBase64: Buffer.from("ok").toString("base64"),
      });

      const result = await stateMigrations[0].migrateLegacyState({
        config: {},
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context: createDoctorContext(env),
      });

      expect(result.changes).toEqual([
        expect.stringContaining("Migrated 1 Workboard .28 plugin-state KV entry"),
      ]);
      expect(result.warnings).toEqual([
        expect.stringContaining("does not reference the attachment"),
      ]);
      expect(await cardStore.entries()).toEqual([]);
      expect(await attachmentStore.entries()).toHaveLength(1);

      const reopenedStores = createWorkboardSqliteStores({ env });
      expect(await reopenedStores.attachments.lookup("attachment-1")).toBeUndefined();
      reopenedStores.close();
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps current sqlite rows when legacy kv ids conflict", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-doctor-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    try {
      const cardStore = createPluginStateKeyedStore<PersistedWorkboardCard>("workboard", {
        namespace: "workboard.cards",
        maxEntries: 2000,
        env,
      });
      const attachmentStore = createPluginStateKeyedStore("workboard", {
        namespace: "workboard.attachments",
        maxEntries: 42_000,
        env,
      });
      await cardStore.register("card-1", {
        version: 1,
        card: {
          id: "card-1",
          title: "Legacy card",
          status: "todo",
          priority: "normal",
          labels: [],
          position: 1000,
          createdAt: 1,
          updatedAt: 1,
        },
      });
      await attachmentStore.register("attachment-1", {
        version: 1,
        attachment: {
          id: "attachment-1",
          cardId: "card-1",
          createdAt: 1,
          fileName: "old.txt",
          byteSize: 2,
        },
        contentBase64: Buffer.from("no").toString("base64"),
      });

      const sqlite = createWorkboardSqliteStores({ env });
      await sqlite.cards.register("card-1", {
        version: 1,
        card: {
          id: "card-1",
          title: "Current card",
          status: "todo",
          priority: "normal",
          labels: [],
          position: 1000,
          createdAt: 2,
          updatedAt: 2,
        },
      });
      sqlite.close();

      const result = await stateMigrations[0].migrateLegacyState({
        config: {},
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context: createDoctorContext(env),
      });

      expect(result.changes).toEqual([]);
      expect(result.warnings).toEqual([
        expect.stringContaining("SQLite target already exists"),
        expect.stringContaining("owning card was not migrated"),
      ]);
      expect(await cardStore.entries()).toHaveLength(1);
      expect(await attachmentStore.entries()).toHaveLength(1);

      const reopenedStores = createWorkboardSqliteStores({ env });
      const store = new WorkboardStore(reopenedStores.cards);
      expect(await store.get("card-1")).toMatchObject({ title: "Current card" });
      expect(await reopenedStores.attachments.lookup("attachment-1")).toBeUndefined();
      reopenedStores.close();
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
