// Covers fail-closed Doctor import of the retired Web Push JSON stores.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  createWebPushVapidKeyPair,
  hashWebPushEndpoint,
  listWebPushSubscriptions,
  readPersistedVapidKeyPair,
  webPushSubscriptionToRow,
  webPushVapidKeyPairToRow,
  DEFAULT_WEB_PUSH_VAPID_SUBJECT,
  type VapidKeyPair,
  type WebPushDatabase,
  type WebPushSubscription,
} from "./push-web-store.js";
import { detectLegacyWebPush, migrateLegacyWebPush } from "./state-migrations.web-push.js";

describe("legacy Web Push Doctor migration", () => {
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      envSnapshot?.restore();
      envSnapshot = undefined;
      cleanup();
    });
  });

  function useStateDir(): string {
    const stateDir = tempDirs.make("openclaw-web-push-migration-");
    envSnapshot ??= captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    return stateDir;
  }

  function subscription(overrides: Partial<WebPushSubscription> = {}): WebPushSubscription {
    return {
      subscriptionId: "c0a80101-0000-4000-8000-000000000001",
      endpoint: "https://push.example.com/send/legacy",
      keys: { p256dh: "legacy-p256dh", auth: "legacy-auth" },
      createdAtMs: 1_000,
      updatedAtMs: 2_000,
      ...overrides,
    };
  }

  function vapidKeys(overrides: Partial<VapidKeyPair> = {}): VapidKeyPair {
    return {
      ...createWebPushVapidKeyPair(
        "legacy-public-key",
        "legacy-private-key",
        "https://openclaw.ai",
      ),
      ...overrides,
    };
  }

  async function writeLegacyState(params: {
    stateDir: string;
    subscriptions?: unknown;
    vapid?: unknown;
  }): Promise<{ subscriptionsPath?: string; vapidKeysPath?: string }> {
    const pushDir = path.join(params.stateDir, "push");
    await fsp.mkdir(pushDir, { recursive: true });
    const result: { subscriptionsPath?: string; vapidKeysPath?: string } = {};
    if (params.subscriptions !== undefined) {
      result.subscriptionsPath = path.join(pushDir, "web-push-subscriptions.json");
      const subscriptionsByEndpointHash = Array.isArray(params.subscriptions)
        ? Object.fromEntries(
            (params.subscriptions as readonly WebPushSubscription[]).map((entry) => [
              hashWebPushEndpoint(entry.endpoint),
              entry,
            ]),
          )
        : params.subscriptions;
      await fsp.writeFile(
        result.subscriptionsPath,
        JSON.stringify({ subscriptionsByEndpointHash }, null, 2),
        "utf8",
      );
    }
    if (params.vapid !== undefined) {
      result.vapidKeysPath = path.join(pushDir, "vapid-keys.json");
      await fsp.writeFile(result.vapidKeysPath, JSON.stringify(params.vapid, null, 2), "utf8");
    }
    return result;
  }

  function seedSubscription(endpointHash: string, value: WebPushSubscription): void {
    const database = openOpenClawStateDatabase();
    executeSqliteQuerySync(
      database.db,
      getNodeSqliteKysely<WebPushDatabase>(database.db)
        .insertInto("web_push_subscriptions")
        .values(webPushSubscriptionToRow({ endpointHash, subscription: value })),
    );
  }

  function seedVapid(value: VapidKeyPair): void {
    const database = openOpenClawStateDatabase();
    executeSqliteQuerySync(
      database.db,
      getNodeSqliteKysely<WebPushDatabase>(database.db)
        .insertInto("web_push_vapid_keys")
        .values(webPushVapidKeyPairToRow({ keyPair: value, nowMs: 1 })),
    );
  }

  it("detects original and interrupted-claim files only for explicit Doctor repair", async () => {
    const stateDir = useStateDir();
    const { subscriptionsPath } = await writeLegacyState({
      stateDir,
      subscriptions: [],
    });
    expect(detectLegacyWebPush({ stateDir }).hasLegacy).toBe(false);
    expect(detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }).hasLegacy).toBe(true);

    await fsp.rename(subscriptionsPath!, `${subscriptionsPath}.doctor-importing`);
    expect(detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }).hasLegacy).toBe(true);
  });

  it("requires exclusive state ownership before reading or committing legacy state", async () => {
    const stateDir = useStateDir();
    const { subscriptionsPath } = await writeLegacyState({
      stateDir,
      subscriptions: [subscription()],
    });
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const gatewayLock = await acquireGatewayLock({
      allowInTests: true,
      env,
      pollIntervalMs: 10,
      port: 18_789,
      timeoutMs: 100,
    });
    if (!gatewayLock) {
      throw new Error("expected test Gateway lock");
    }

    let blocked: Awaited<ReturnType<typeof migrateLegacyWebPush>>;
    try {
      blocked = await migrateLegacyWebPush({
        detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
        env,
        stateDir,
      });
    } finally {
      await gatewayLock.release();
    }

    expect(blocked.warnings[0]).toContain("Gateway or another SQLite maintenance command");
    expect(fs.existsSync(subscriptionsPath!)).toBe(true);
    expect(listWebPushSubscriptions(stateDir)).toEqual([]);

    const retry = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
    });
    expect(retry.warnings).toEqual([]);
    expect(listWebPushSubscriptions(stateDir)).toEqual([subscription()]);
    expect(fs.existsSync(subscriptionsPath!)).toBe(false);
  });

  it("imports subscriptions and VAPID identity in one verified operation", async () => {
    const stateDir = useStateDir();
    const first = subscription();
    const second = subscription({
      subscriptionId: "c0a80101-0000-4000-8000-000000000002",
      endpoint: "https://push.example.com/send/second",
    });
    const paths = await writeLegacyState({
      stateDir,
      subscriptions: [first, second],
      vapid: vapidKeys(),
    });

    const result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });

    expect(result.warnings).toEqual([]);
    expect(listWebPushSubscriptions(stateDir)).toEqual([first, second]);
    expect(readPersistedVapidKeyPair(stateDir)).toEqual(vapidKeys());
    expect(fs.existsSync(paths.subscriptionsPath!)).toBe(false);
    expect(fs.existsSync(paths.vapidKeysPath!)).toBe(false);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
  ])("normalizes a %s legacy VAPID subject", async (_label, subject) => {
    const stateDir = useStateDir();
    const legacyKeys = vapidKeys({ subject: subject ?? "" });
    if (subject === undefined) {
      delete (legacyKeys as Partial<VapidKeyPair>).subject;
    }
    await writeLegacyState({ stateDir, vapid: legacyKeys });

    const result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });

    expect(result.warnings).toEqual([]);
    expect(readPersistedVapidKeyPair(stateDir)?.subject).toBe(DEFAULT_WEB_PUSH_VAPID_SUBJECT);
  });

  it("removes an empty valid store only after opening SQLite", async () => {
    const stateDir = useStateDir();
    const { subscriptionsPath } = await writeLegacyState({ stateDir, subscriptions: [] });

    const result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });

    expect(result.warnings).toEqual([]);
    expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(true);
    expect(fs.existsSync(subscriptionsPath!)).toBe(false);
  });

  it("rejects either malformed file without importing its valid pair", async () => {
    const stateDir = useStateDir();
    const paths = await writeLegacyState({
      stateDir,
      subscriptions: [subscription()],
      vapid: { publicKey: "incomplete" },
    });

    const result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });

    expect(result.warnings[0]).toContain("VAPID keys are invalid");
    expect(listWebPushSubscriptions(stateDir)).toEqual([]);
    expect(readPersistedVapidKeyPair(stateDir)).toBeNull();
    expect(fs.existsSync(paths.subscriptionsPath!)).toBe(true);
    expect(fs.existsSync(paths.vapidKeysPath!)).toBe(true);
  });

  it("rejects a forged endpoint hash and duplicate subscription ids", async () => {
    const stateDir = useStateDir();
    const pushDir = path.join(stateDir, "push");
    await fsp.mkdir(pushDir, { recursive: true });
    const sourcePath = path.join(pushDir, "web-push-subscriptions.json");
    await fsp.writeFile(
      sourcePath,
      JSON.stringify({ subscriptionsByEndpointHash: { forged: subscription() } }),
      "utf8",
    );
    let result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });
    expect(result.warnings[0]).toContain("subscription is invalid");

    const first = subscription();
    const second = subscription({ endpoint: "https://push.example.com/send/second" });
    await fsp.writeFile(
      sourcePath,
      JSON.stringify({
        subscriptionsByEndpointHash: {
          [hashWebPushEndpoint(first.endpoint)]: first,
          [hashWebPushEndpoint(second.endpoint)]: second,
        },
      }),
      "utf8",
    );
    result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });
    expect(result.warnings[0]).toContain("duplicate subscription id");
    expect(listWebPushSubscriptions(stateDir)).toEqual([]);
  });

  it("keeps newer SQLite fields while preserving the earliest creation time", async () => {
    const stateDir = useStateDir();
    const legacy = subscription({ createdAtMs: 100, updatedAtMs: 200 });
    const canonical = subscription({
      keys: { p256dh: "canonical-p256dh", auth: "canonical-auth" },
      createdAtMs: 150,
      updatedAtMs: 300,
    });
    seedSubscription(hashWebPushEndpoint(canonical.endpoint), canonical);
    await writeLegacyState({ stateDir, subscriptions: [legacy] });

    const result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });

    expect(result.warnings).toEqual([]);
    expect(listWebPushSubscriptions(stateDir)).toEqual([{ ...canonical, createdAtMs: 100 }]);
  });

  it("updates an older SQLite row from newer legacy state", async () => {
    const stateDir = useStateDir();
    const canonical = subscription({ updatedAtMs: 200 });
    const legacy = subscription({
      keys: { p256dh: "newer-p256dh", auth: "newer-auth" },
      createdAtMs: 500,
      updatedAtMs: 600,
    });
    seedSubscription(hashWebPushEndpoint(canonical.endpoint), canonical);
    await writeLegacyState({ stateDir, subscriptions: [legacy] });

    const result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });

    expect(result.warnings).toEqual([]);
    expect(listWebPushSubscriptions(stateDir)).toEqual([legacy]);
  });

  it("retries a committed newer-row merge after normalizing its creation time", async () => {
    const stateDir = useStateDir();
    const canonical = subscription({ createdAtMs: 100, updatedAtMs: 200 });
    const legacy = subscription({
      keys: { p256dh: "newer-p256dh", auth: "newer-auth" },
      createdAtMs: 500,
      updatedAtMs: 600,
    });
    seedSubscription(hashWebPushEndpoint(canonical.endpoint), canonical);
    const { subscriptionsPath } = await writeLegacyState({
      stateDir,
      subscriptions: [legacy],
    });

    const first = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
      removeSource: () => {
        throw new Error("simulated unlink failure");
      },
    });
    expect(first.warnings[0]).toContain("legacy cleanup failed");
    expect(listWebPushSubscriptions(stateDir)).toEqual([{ ...legacy, createdAtMs: 100 }]);

    const retry = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });
    expect(retry.warnings).toEqual([]);
    expect(listWebPushSubscriptions(stateDir)).toEqual([{ ...legacy, createdAtMs: 100 }]);
    expect(fs.existsSync(`${subscriptionsPath}.doctor-importing`)).toBe(false);
  });

  it("rolls back equal-timestamp divergence and VAPID identity conflicts", async () => {
    const stateDir = useStateDir();
    const canonical = subscription({ keys: { p256dh: "canonical", auth: "canonical" } });
    seedSubscription(hashWebPushEndpoint(canonical.endpoint), canonical);
    seedVapid(
      createWebPushVapidKeyPair("canonical-public", "canonical-private", "https://openclaw.ai"),
    );
    const paths = await writeLegacyState({
      stateDir,
      subscriptions: [subscription()],
      vapid: vapidKeys(),
    });

    const result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });

    expect(result.warnings[0]).toContain("diverges at the same timestamp");
    expect(listWebPushSubscriptions(stateDir)).toEqual([canonical]);
    expect(readPersistedVapidKeyPair(stateDir)?.publicKey).toBe("canonical-public");
    expect(fs.existsSync(paths.subscriptionsPath!)).toBe(true);
    expect(fs.existsSync(paths.vapidKeysPath!)).toBe(true);
    expect(fs.existsSync(`${paths.subscriptionsPath}.doctor-importing`)).toBe(false);
    expect(fs.existsSync(`${paths.vapidKeysPath}.doctor-importing`)).toBe(false);
  });

  it("rolls back subscription changes when only VAPID conflicts", async () => {
    const stateDir = useStateDir();
    seedVapid(
      createWebPushVapidKeyPair("canonical-public", "canonical-private", "https://openclaw.ai"),
    );
    await writeLegacyState({
      stateDir,
      subscriptions: [subscription()],
      vapid: vapidKeys(),
    });

    const result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });

    expect(result.warnings[0]).toContain("VAPID identity conflicts");
    expect(listWebPushSubscriptions(stateDir)).toEqual([]);
  });

  it("rejects a subscription id already owned by another endpoint", async () => {
    const stateDir = useStateDir();
    const canonical = subscription({ endpoint: "https://push.example.com/canonical" });
    const legacy = subscription({ endpoint: "https://push.example.com/legacy" });
    seedSubscription(hashWebPushEndpoint(canonical.endpoint), canonical);
    const { subscriptionsPath } = await writeLegacyState({
      stateDir,
      subscriptions: [legacy],
    });

    const result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });

    expect(result.warnings[0]).toContain("subscription id conflicts");
    expect(listWebPushSubscriptions(stateDir)).toEqual([canonical]);
    expect(fs.existsSync(subscriptionsPath!)).toBe(true);
  });

  it("fails before database mutation when a source changes after parsing", async () => {
    const stateDir = useStateDir();
    const { subscriptionsPath } = await writeLegacyState({
      stateDir,
      subscriptions: [subscription()],
    });

    const result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
      beforeVerify: () => fs.appendFileSync(subscriptionsPath!, "\n"),
    });

    expect(result.warnings[0]).toContain("source changed");
    expect(listWebPushSubscriptions(stateDir)).toEqual([]);
    expect(fs.existsSync(subscriptionsPath!)).toBe(true);
  });

  it("restores claimed sources without database mutation when claim verification fails", async () => {
    const stateDir = useStateDir();
    const { subscriptionsPath } = await writeLegacyState({
      stateDir,
      subscriptions: [subscription()],
    });

    const result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
      beforeClaim: () => fs.appendFileSync(subscriptionsPath!, "\n"),
    });

    expect(result.warnings[0]).toContain("source changed before doctor could claim it");
    expect(listWebPushSubscriptions(stateDir)).toEqual([]);
    expect(fs.existsSync(subscriptionsPath!)).toBe(true);
    expect(fs.existsSync(`${subscriptionsPath}.doctor-importing`)).toBe(false);
  });

  it("retains fixed claims on cleanup failure and retries idempotently", async () => {
    const stateDir = useStateDir();
    const paths = await writeLegacyState({
      stateDir,
      subscriptions: [subscription()],
      vapid: vapidKeys(),
    });
    const first = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
      removeSource: () => {
        throw new Error("simulated unlink failure");
      },
    });
    expect(first.warnings[0]).toContain("legacy cleanup failed");
    expect(fs.existsSync(`${paths.subscriptionsPath}.doctor-importing`)).toBe(true);
    expect(fs.existsSync(`${paths.vapidKeysPath}.doctor-importing`)).toBe(true);
    expect(listWebPushSubscriptions(stateDir)).toEqual([subscription()]);

    const retry = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });
    expect(retry.warnings).toEqual([]);
    expect(fs.existsSync(`${paths.subscriptionsPath}.doctor-importing`)).toBe(false);
    expect(fs.existsSync(`${paths.vapidKeysPath}.doctor-importing`)).toBe(false);
    expect(listWebPushSubscriptions(stateDir)).toEqual([subscription()]);
  });

  it("refuses symlinked sources", async () => {
    const stateDir = useStateDir();
    const outside = path.join(stateDir, "outside.json");
    await fsp.writeFile(outside, JSON.stringify({ subscriptionsByEndpointHash: {} }), "utf8");
    const sourcePath = path.join(stateDir, "push", "web-push-subscriptions.json");
    await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
    await fsp.symlink(outside, sourcePath);

    const result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });

    expect(result.warnings[0]).toContain("Failed reading legacy Web Push state");
    expect(fs.lstatSync(sourcePath).isSymbolicLink()).toBe(true);
    expect(listWebPushSubscriptions(stateDir)).toEqual([]);
  });

  it("refuses a legacy store reached through a symlinked state-directory ancestor", async () => {
    if (process.platform === "win32") {
      return;
    }
    const stateDir = useStateDir();
    const outside = tempDirs.make("openclaw-web-push-outside-");
    const legacy = subscription();
    const sourcePath = path.join(outside, "web-push-subscriptions.json");
    await fsp.writeFile(
      sourcePath,
      JSON.stringify({
        subscriptionsByEndpointHash: {
          [hashWebPushEndpoint(legacy.endpoint)]: legacy,
        },
      }),
      "utf8",
    );
    await fsp.mkdir(stateDir, { recursive: true });
    await fsp.symlink(outside, path.join(stateDir, "push"));

    const result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });

    expect(result.warnings[0]).toContain("Failed reading legacy Web Push state");
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(listWebPushSubscriptions(stateDir)).toEqual([]);
  });
});
