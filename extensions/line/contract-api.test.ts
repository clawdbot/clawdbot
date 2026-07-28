// Line tests cover the doctor state migration for pre-drain webhook spool rows.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { webhook } from "@line/bot-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests as createChannelIngressQueue,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { PluginDoctorStateMigrationContext } from "openclaw/plugin-sdk/runtime-doctor";
import { afterEach, describe, expect, it } from "vitest";
import { stateMigrations } from "./contract-api.js";

const migration = stateMigrations[0]!;

const context: PluginDoctorStateMigrationContext = {
  openPluginStateKeyedStore: () => {
    throw new Error("the LINE spool migration does not use plugin keyed state");
  },
};

function legacyEvent(webhookEventId: string): webhook.Event {
  return {
    type: "message",
    message: { id: `message-${webhookEventId}`, type: "text", text: "hello" },
    replyToken: "test-reply-token",
    timestamp: Date.now(),
    source: { type: "user", userId: "user-1" },
    mode: "active",
    webhookEventId,
    deliveryContext: { isRedelivery: false },
  } as webhook.MessageEvent;
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
    context,
  };
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

  it("detects and migrates pre-drain rows for a configured account", async () => {
    await withStateDir(async (stateDir) => {
      const legacySeed = createChannelIngressQueue<{
        version: number;
        destination: string;
        event: webhook.Event;
      }>({ channelId: "line", accountId: "work", stateDir });
      await legacySeed.enqueue(
        "legacy-doctor-1",
        { version: 1, destination: "destination-1", event: legacyEvent("legacy-doctor-1") },
        { laneKey: "user:user-1" },
      );
      const config: OpenClawConfig = {
        channels: { line: { accounts: { work: {} } } },
      };

      const detected = await migration.detectLegacyState(migrationParams(stateDir, config));
      expect(detected?.preview).toEqual([
        '- LINE pre-drain spool rows (account "work"): 1 row(s) -> canonical ingress contract',
      ]);

      const result = await migration.migrateLegacyState(migrationParams(stateDir, config));
      expect(result.changes).toEqual([
        'Migrated LINE pre-drain spool rows (account "work"): 1 delivered to the canonical queue, 0 dead-lettered at the identity fence',
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
});
