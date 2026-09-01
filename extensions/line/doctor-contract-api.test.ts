// Line tests cover the doctor state migration for pre-drain webhook spool rows.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { webhook } from "@line/bot-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests as createChannelIngressQueue,
  listChannelIngressQueueAccountIdsForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  PluginDoctorChannelIngressQueueAccess,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { afterEach, describe, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";

const migration = stateMigrations[0]!;

/** `mutable: false` stands in for the detection phase, which the host runs before it
 *  owns exclusive state: the access entry carries no mutable lane at all. */
function contextFor(
  stateDir: string,
  options?: { mutable?: boolean },
): PluginDoctorStateMigrationContext {
  const open = <TPayload, TMetadata = unknown, TCompletedMetadata = unknown>(openOptions?: {
    accountId?: string;
  }) =>
    createChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>({
      channelId: "line",
      ...(openOptions?.accountId === undefined ? {} : { accountId: openOptions.accountId }),
      stateDir,
    });
  const access: PluginDoctorChannelIngressQueueAccess = {
    channelId: "line",
    openChannelIngressQueueForInspection: (openOptions) => open(openOptions),
    listChannelIngressQueueAccountIds: async () =>
      listChannelIngressQueueAccountIdsForTests({ channelId: "line", stateDir }),
  };
  if (options?.mutable !== false) {
    access.openChannelIngressQueue = (openOptions) => open(openOptions);
  }
  return {
    openPluginStateKeyedStore: () => {
      throw new Error("the LINE spool migration does not use plugin keyed state");
    },
    channelIngressQueues: [access],
  };
}

function legacyEvent(webhookEventId: string): webhook.Event {
  const event: webhook.MessageEvent = {
    type: "message",
    message: {
      id: `message-${webhookEventId}`,
      type: "text",
      text: "hello",
      quoteToken: "test-quote-token-placeholder",
    },
    replyToken: "test-reply-token",
    timestamp: Date.now(),
    source: { type: "user", userId: "user-1" },
    mode: "active",
    webhookEventId,
    deliveryContext: { isRedelivery: false },
  };
  return event;
}

async function withStateDir<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const createdDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-line-doctor-"));
  const stateDir = await fs.realpath(createdDir);
  try {
    return await fn(stateDir);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function migrationParams(stateDir: string, config: OpenClawConfig) {
  return {
    config,
    env: process.env,
    stateDir,
    oauthDir: path.join(stateDir, "oauth"),
    context: contextFor(stateDir),
  };
}

async function seedLegacyRow(stateDir: string, accountId: string, webhookEventId: string) {
  const legacySeed = createChannelIngressQueue<{
    version: number;
    destination: string;
    event: webhook.Event;
  }>({ channelId: "line", accountId, stateDir });
  await legacySeed.enqueue(
    webhookEventId,
    { version: 1, destination: "destination-1", event: legacyEvent(webhookEventId) },
    { laneKey: "user:user-1" },
  );
}

describe("LINE doctor state migration", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("detects nothing on a store without pre-drain rows", async () => {
    await withStateDir(async (stateDir) => {
      expect(await migration.detectLegacyState(migrationParams(stateDir, {}))).toBeNull();
    });
  });

  it("detects and migrates pre-drain rows for the default account absent from config", async () => {
    await withStateDir(async (stateDir) => {
      // Pre-drain rows outlive the account config that admitted them, so the
      // sweep discovers accounts from the durable queue rather than the config.
      await seedLegacyRow(stateDir, "default", "legacy-doctor-default");

      const detected = await migration.detectLegacyState(migrationParams(stateDir, {}));
      expect(detected?.preview).toEqual([
        '- LINE pre-drain spool rows (account "default"): 1 row(s) -> canonical ingress contract',
      ]);

      const result = await migration.migrateLegacyState(migrationParams(stateDir, {}));
      expect(result.changes).toEqual([
        'Migrated LINE pre-drain spool rows (account "default"): 1 queued under the canonical contract, 0 dead-lettered at the identity fence (account not currently configured, so these stay queued until it is restored)',
      ]);
      expect(result.warnings).toEqual([]);

      const queue = createChannelIngressQueue<{
        version: number;
        rawEvent: string;
        destination: string;
      }>({ channelId: "line", accountId: "default", stateDir });
      const pending = await queue.listPending({ limit: "all" });
      expect(pending.map((record) => record.id)).toEqual(["message:message-legacy-doctor-default"]);
    });
  });

  it("detects and migrates pre-drain rows for a configured account", async () => {
    await withStateDir(async (stateDir) => {
      await seedLegacyRow(stateDir, "work", "legacy-doctor-1");
      const config: OpenClawConfig = {
        channels: { line: { accounts: { work: {} } } },
      };

      const detected = await migration.detectLegacyState(migrationParams(stateDir, config));
      expect(detected?.preview).toEqual([
        '- LINE pre-drain spool rows (account "work"): 1 row(s) -> canonical ingress contract',
      ]);

      const result = await migration.migrateLegacyState(migrationParams(stateDir, config));
      expect(result.changes).toEqual([
        'Migrated LINE pre-drain spool rows (account "work"): 1 queued under the canonical contract, 0 dead-lettered at the identity fence',
      ]);
      expect(result.warnings).toEqual([]);

      const queue = createChannelIngressQueue<{
        version: number;
        rawEvent: string;
        destination: string;
      }>({ channelId: "line", accountId: "work", stateDir });
      const pending = await queue.listPending({ limit: "all" });
      expect(pending.map((record) => record.id)).toEqual(["message:message-legacy-doctor-1"]);
      expect(await migration.detectLegacyState(migrationParams(stateDir, config))).toBeNull();
    });
  });

  it("detects and migrates pre-drain rows for a named account removed from config", async () => {
    await withStateDir(async (stateDir) => {
      // The "retired" account no longer exists in config; only queue-account
      // discovery can find its rows, so they must still migrate.
      await seedLegacyRow(stateDir, "retired", "legacy-doctor-retired");
      await seedLegacyRow(stateDir, "default", "legacy-doctor-kept");

      const detected = await migration.detectLegacyState(migrationParams(stateDir, {}));
      expect(detected?.preview).toEqual([
        '- LINE pre-drain spool rows (account "default"): 1 row(s) -> canonical ingress contract',
        '- LINE pre-drain spool rows (account "retired"): 1 row(s) -> canonical ingress contract',
      ]);

      const result = await migration.migrateLegacyState(migrationParams(stateDir, {}));
      expect(result.changes).toEqual([
        'Migrated LINE pre-drain spool rows (account "default"): 1 queued under the canonical contract, 0 dead-lettered at the identity fence (account not currently configured, so these stay queued until it is restored)',
        'Migrated LINE pre-drain spool rows (account "retired"): 1 queued under the canonical contract, 0 dead-lettered at the identity fence (account not currently configured, so these stay queued until it is restored)',
      ]);
      expect(result.warnings).toEqual([]);

      const retiredQueue = createChannelIngressQueue<{
        version: number;
        rawEvent: string;
        destination: string;
      }>({ channelId: "line", accountId: "retired", stateDir });
      const pending = await retiredQueue.listPending({ limit: "all" });
      expect(pending.map((record) => record.id)).toEqual(["message:message-legacy-doctor-retired"]);
      expect(await migration.detectLegacyState(migrationParams(stateDir, {}))).toBeNull();
    });
  });

  it("fails visibly when the doctor host lacks channel ingress queue access", async () => {
    await withStateDir(async (stateDir) => {
      const context: PluginDoctorStateMigrationContext = {
        openPluginStateKeyedStore: () => {
          throw new Error("the LINE spool migration does not use plugin keyed state");
        },
      };
      await expect(
        migration.detectLegacyState({ ...migrationParams(stateDir, {}), context }),
      ).rejects.toThrow(/channel ingress queue access/);
    });
  });
});
