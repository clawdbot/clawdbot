import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import webPush from "web-push";
import {
  broadcastWebPush,
  clearWebPushSubscription,
  clearWebPushSubscriptionByEndpoint,
  listWebPushSubscriptions,
  loadWebPushSubscription,
  registerWebPushSubscription,
  resolveVapidKeys,
  sendWebPushNotification,
} from "./push-web.js";

type WebPushSubscription = NonNullable<Awaited<ReturnType<typeof loadWebPushSubscription>>>;

// Stub resolveStateDir so tests use a temp directory.
let tmpDir: string;
vi.mock("../config/paths.js", () => ({
  resolveStateDir: () => tmpDir,
}));

// Stub web-push so we don't make real HTTP requests.
vi.mock("web-push", () => ({
  default: {
    generateVAPIDKeys: vi.fn(() => ({
      publicKey: "test-public-key-base64url",
      privateKey: "test-private-key-base64url",
    })),
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn().mockResolvedValue({ statusCode: 201 }),
  },
}));

function expectLoadedSubscription(
  loaded: Awaited<ReturnType<typeof loadWebPushSubscription>>,
): WebPushSubscription {
  if (loaded === null) {
    throw new Error("Expected loaded web push subscription");
  }
  expect(loaded.endpoint).not.toBe("");
  return loaded;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "push-web-test-"));
  vi.clearAllMocks();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("resolveVapidKeys", () => {
  it("generates and persists VAPID keys on first call", async () => {
    const keys = await resolveVapidKeys(tmpDir);
    expect(keys.publicKey).toBe("test-public-key-base64url");
    expect(keys.privateKey).toBe("test-private-key-base64url");
    expect(keys.subject).toMatch(/^mailto:/);

    // Second call returns same keys.
    const keys2 = await resolveVapidKeys(tmpDir);
    expect(keys2.publicKey).toBe(keys.publicKey);
    expect(keys2.privateKey).toBe(keys.privateKey);
    expect(vi.mocked(webPush.generateVAPIDKeys)).toHaveBeenCalledTimes(1);
  });

  it("prefers env vars over persisted keys", async () => {
    // Persist keys first.
    await resolveVapidKeys(tmpDir);

    // Set env overrides.
    process.env.OPENCLAW_VAPID_PUBLIC_KEY = "env-public";
    process.env.OPENCLAW_VAPID_PRIVATE_KEY = "env-private";
    process.env.OPENCLAW_VAPID_SUBJECT = "mailto:env@test.com";
    try {
      const keys = await resolveVapidKeys(tmpDir);
      expect(keys.publicKey).toBe("env-public");
      expect(keys.privateKey).toBe("env-private");
      expect(keys.subject).toBe("mailto:env@test.com");
      expect(vi.mocked(webPush.generateVAPIDKeys)).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.OPENCLAW_VAPID_PUBLIC_KEY;
      delete process.env.OPENCLAW_VAPID_PRIVATE_KEY;
      delete process.env.OPENCLAW_VAPID_SUBJECT;
    }
  });
});

describe("subscription CRUD", () => {
  const endpoint = "https://push.example.com/send/abc123";
  const keys = { p256dh: "p256dh-key", auth: "auth-key" };

  it("registers a new subscription", async () => {
    const sub = await registerWebPushSubscription({
      endpoint,
      keys,
      baseDir: tmpDir,
    });
    expect(sub.subscriptionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sub.endpoint).toBe(endpoint);
    expect(sub.keys.p256dh).toBe("p256dh-key");
    expect(sub.keys.auth).toBe("auth-key");
    expect(sub.createdAtMs).toBeGreaterThan(0);
  });

  it("updates an existing subscription with the same endpoint", async () => {
    const sub1 = await registerWebPushSubscription({
      endpoint,
      keys,
      baseDir: tmpDir,
    });
    const sub2 = await registerWebPushSubscription({
      endpoint,
      keys: { p256dh: "new-p256dh", auth: "new-auth" },
      baseDir: tmpDir,
    });
    // Same subscription ID, same created time, updated keys.
    expect(sub2.subscriptionId).toBe(sub1.subscriptionId);
    expect(sub2.createdAtMs).toBe(sub1.createdAtMs);
    expect(sub2.keys.p256dh).toBe("new-p256dh");
  });

  it("loads a subscription by ID", async () => {
    const sub = await registerWebPushSubscription({
      endpoint,
      keys,
      baseDir: tmpDir,
    });
    const loaded = await loadWebPushSubscription(sub.subscriptionId, tmpDir);
    expect(expectLoadedSubscription(loaded).endpoint).toBe(endpoint);
  });

  it("returns null for unknown subscription ID", async () => {
    const loaded = await loadWebPushSubscription("nonexistent", tmpDir);
    expect(loaded).toBeNull();
  });

  it("lists all subscriptions", async () => {
    await registerWebPushSubscription({
      endpoint: "https://push.example.com/a",
      keys,
      baseDir: tmpDir,
    });
    await registerWebPushSubscription({
      endpoint: "https://push.example.com/b",
      keys,
      baseDir: tmpDir,
    });
    const list = await listWebPushSubscriptions(tmpDir);
    expect(list).toHaveLength(2);
  });

  it("clears a subscription by ID", async () => {
    const sub = await registerWebPushSubscription({
      endpoint,
      keys,
      baseDir: tmpDir,
    });
    const removed = await clearWebPushSubscription(sub.subscriptionId, tmpDir);
    expect(removed).toBe(true);

    const list = await listWebPushSubscriptions(tmpDir);
    expect(list).toHaveLength(0);
  });

  it("clears a subscription by endpoint", async () => {
    await registerWebPushSubscription({ endpoint, keys, baseDir: tmpDir });
    const removed = await clearWebPushSubscriptionByEndpoint(endpoint, tmpDir);
    expect(removed).toBe(true);

    const list = await listWebPushSubscriptions(tmpDir);
    expect(list).toHaveLength(0);
  });

  it("rejects invalid endpoint", async () => {
    await expect(
      registerWebPushSubscription({
        endpoint: "http://insecure.example.com",
        keys,
        baseDir: tmpDir,
      }),
    ).rejects.toThrow("invalid push subscription endpoint");
  });

  it("rejects empty keys", async () => {
    await expect(
      registerWebPushSubscription({
        endpoint,
        keys: { p256dh: "", auth: "auth-key" },
        baseDir: tmpDir,
      }),
    ).rejects.toThrow("invalid push subscription keys");
  });
});

describe("sending", () => {
  const keys = { p256dh: "p256dh-key", auth: "auth-key" };

  it("configures VAPID details for direct sends", async () => {
    const sub = await registerWebPushSubscription({
      endpoint: "https://push.example.com/direct",
      keys,
      baseDir: tmpDir,
    });

    const result = await sendWebPushNotification(sub, { title: "Direct" });

    expect(result.ok).toBe(true);
    expect(vi.mocked(webPush.setVapidDetails)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(webPush.setVapidDetails)).toHaveBeenCalledWith(
      "mailto:openclaw@localhost",
      "test-public-key-base64url",
      "test-private-key-base64url",
    );
    expect(vi.mocked(webPush.sendNotification)).toHaveBeenCalledTimes(1);
  });

  it("configures VAPID details once before broadcasting to subscribers", async () => {
    await registerWebPushSubscription({
      endpoint: "https://push.example.com/a",
      keys,
      baseDir: tmpDir,
    });
    await registerWebPushSubscription({
      endpoint: "https://push.example.com/b",
      keys,
      baseDir: tmpDir,
    });

    const results = await broadcastWebPush({ title: "Broadcast" }, tmpDir);

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(vi.mocked(webPush.setVapidDetails)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(webPush.sendNotification)).toHaveBeenCalledTimes(2);
  });
});
