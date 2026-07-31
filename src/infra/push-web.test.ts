// Tests SQLite-backed Web Push subscription storage and delivery helpers.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import webPush from "web-push";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  createWebPushVapidKeyPair,
  listWebPushSubscriptions,
  readPersistedVapidKeyPair,
} from "./push-web-store.js";
import {
  broadcastWebPush,
  clearWebPushSubscriptionByEndpoint,
  registerWebPushSubscription,
  resolveVapidKeys,
} from "./push-web.js";

let tmpDir: string;
const generatedVapidKeys = vi.hoisted(
  () =>
    Object.fromEntries([
      ["publicKey", "test-public-key-base64url"],
      ["privateKey", "test-private-key-base64url"],
    ]) as { publicKey: string; privateKey: string },
);
vi.mock("../config/paths.js", () => ({
  resolveStateDir: () => tmpDir,
}));

vi.mock("web-push", () => ({
  default: {
    generateVAPIDKeys: vi.fn(() => generatedVapidKeys),
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn().mockResolvedValue({ statusCode: 201 }),
  },
}));

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "push-web-test-"));
  vi.clearAllMocks();
  vi.mocked(webPush.sendNotification).mockResolvedValue({ statusCode: 201 } as never);
});

afterEach(async () => {
  closeOpenClawStateDatabase();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("resolveVapidKeys", () => {
  it("generates one durable SQLite VAPID identity", async () => {
    const keys = await resolveVapidKeys(tmpDir);
    expect(keys).toEqual(
      createWebPushVapidKeyPair(
        "test-public-key-base64url",
        "test-private-key-base64url",
        "https://openclaw.ai",
      ),
    );
    expect(readPersistedVapidKeyPair(tmpDir)).toEqual(keys);

    closeOpenClawStateDatabase();
    await expect(resolveVapidKeys(tmpDir)).resolves.toEqual(keys);
    expect(vi.mocked(webPush.generateVAPIDKeys)).toHaveBeenCalledTimes(1);
    await expect(fs.stat(path.join(tmpDir, "push", "vapid-keys.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("requires Doctor before creating an identity beside retired state", async () => {
    const pushDir = path.join(tmpDir, "push");
    const legacyPath = path.join(pushDir, "vapid-keys.json");
    await fs.mkdir(pushDir, { recursive: true });
    await fs.writeFile(legacyPath, "{}", "utf8");

    await expect(resolveVapidKeys(tmpDir)).rejects.toThrow("openclaw doctor --fix");
    expect(readPersistedVapidKeyPair(tmpDir)).toBeNull();
    expect(vi.mocked(webPush.generateVAPIDKeys)).not.toHaveBeenCalled();

    await fs.rename(legacyPath, `${legacyPath}.doctor-importing`);
    await expect(resolveVapidKeys(tmpDir)).rejects.toThrow("openclaw doctor --fix");
    expect(vi.mocked(webPush.generateVAPIDKeys)).not.toHaveBeenCalled();

    await fs.rm(`${legacyPath}.doctor-importing`);
    await fs.symlink(path.join(tmpDir, "missing-vapid-keys.json"), legacyPath);
    await expect(resolveVapidKeys(tmpDir)).rejects.toThrow("openclaw doctor --fix");
    expect(vi.mocked(webPush.generateVAPIDKeys)).not.toHaveBeenCalled();
  });

  it("converges concurrent first-use generation on the first committed identity", async () => {
    vi.mocked(webPush.generateVAPIDKeys)
      .mockReturnValueOnce(createWebPushVapidKeyPair("public-a", "private-a", "ignored"))
      .mockReturnValueOnce(createWebPushVapidKeyPair("public-b", "private-b", "ignored"));

    const [first, second] = await Promise.all([resolveVapidKeys(tmpDir), resolveVapidKeys(tmpDir)]);

    expect(first).toEqual(second);
    expect(readPersistedVapidKeyPair(tmpDir)).toEqual(first);
    expect(vi.mocked(webPush.generateVAPIDKeys)).toHaveBeenCalledTimes(2);
  });

  it("prefers a complete environment override without persisting it", async () => {
    const environmentKeys = createWebPushVapidKeyPair(
      "env-public",
      "env-private",
      "mailto:env@test.com",
    );
    const envSnapshot = captureEnv([
      "OPENCLAW_VAPID_PUBLIC_KEY",
      "OPENCLAW_VAPID_PRIVATE_KEY",
      "OPENCLAW_VAPID_SUBJECT",
    ]);
    setTestEnvValue("OPENCLAW_VAPID_PUBLIC_KEY", `  ${environmentKeys.publicKey}  `);
    setTestEnvValue("OPENCLAW_VAPID_PRIVATE_KEY", `  ${environmentKeys.privateKey}  `);
    setTestEnvValue("OPENCLAW_VAPID_SUBJECT", `  ${environmentKeys.subject}  `);
    try {
      await expect(resolveVapidKeys(tmpDir)).resolves.toEqual(environmentKeys);
      expect(readPersistedVapidKeyPair(tmpDir)).toBeNull();
      expect(vi.mocked(webPush.generateVAPIDKeys)).not.toHaveBeenCalled();
    } finally {
      envSnapshot.restore();
    }
  });

  it("treats blank environment values as unset", async () => {
    const envSnapshot = captureEnv([
      "OPENCLAW_VAPID_PUBLIC_KEY",
      "OPENCLAW_VAPID_PRIVATE_KEY",
      "OPENCLAW_VAPID_SUBJECT",
    ]);
    setTestEnvValue("OPENCLAW_VAPID_PUBLIC_KEY", "   ");
    setTestEnvValue("OPENCLAW_VAPID_PRIVATE_KEY", "   ");
    setTestEnvValue("OPENCLAW_VAPID_SUBJECT", "   ");
    try {
      const keys = await resolveVapidKeys(tmpDir);
      expect(keys).toEqual(
        createWebPushVapidKeyPair(
          "test-public-key-base64url",
          "test-private-key-base64url",
          "https://openclaw.ai",
        ),
      );
      expect(readPersistedVapidKeyPair(tmpDir)).toEqual(keys);
      expect(vi.mocked(webPush.generateVAPIDKeys)).toHaveBeenCalledTimes(1);
    } finally {
      envSnapshot.restore();
    }
  });

  it("applies the current subject to a persisted identity", async () => {
    const initial = await resolveVapidKeys(tmpDir);
    process.env.OPENCLAW_VAPID_SUBJECT = "mailto:changed@test.com";
    try {
      await expect(resolveVapidKeys(tmpDir)).resolves.toEqual({
        ...initial,
        subject: "mailto:changed@test.com",
      });
      expect(readPersistedVapidKeyPair(tmpDir)?.subject).toBe("https://openclaw.ai");
    } finally {
      delete process.env.OPENCLAW_VAPID_SUBJECT;
    }
  });
});

describe("subscription CRUD", () => {
  const endpoint = "https://push.example.com/send/abc123";
  const keys = { p256dh: "p256dh-key", auth: "auth-key" };

  it("registers, updates, and reopens a durable subscription", async () => {
    const first = await registerWebPushSubscription({ endpoint, keys, baseDir: tmpDir });
    const updated = await registerWebPushSubscription({
      endpoint,
      keys: { p256dh: "new-p256dh", auth: "new-auth" },
      baseDir: tmpDir,
    });
    expect(updated).toMatchObject({
      subscriptionId: first.subscriptionId,
      createdAtMs: first.createdAtMs,
      endpoint,
      keys: { p256dh: "new-p256dh", auth: "new-auth" },
    });

    closeOpenClawStateDatabase();
    expect(listWebPushSubscriptions(tmpDir)).toEqual([updated]);
    await expect(fs.stat(path.join(tmpDir, "push"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves unrelated concurrent registrations", async () => {
    await Promise.all(
      ["a", "b", "c"].map((suffix) =>
        registerWebPushSubscription({
          endpoint: `https://push.example.com/${suffix}`,
          keys,
          baseDir: tmpDir,
        }),
      ),
    );
    expect(
      listWebPushSubscriptions(tmpDir)
        .map((entry) => entry.endpoint)
        .toSorted(),
    ).toEqual([
      "https://push.example.com/a",
      "https://push.example.com/b",
      "https://push.example.com/c",
    ]);
  });

  it("clears only the matching endpoint", async () => {
    await registerWebPushSubscription({ endpoint, keys, baseDir: tmpDir });
    await expect(clearWebPushSubscriptionByEndpoint(endpoint, tmpDir)).resolves.toBe(true);
    await expect(clearWebPushSubscriptionByEndpoint(endpoint, tmpDir)).resolves.toBe(false);
  });

  it("rejects invalid registration data", async () => {
    await expect(
      registerWebPushSubscription({
        endpoint: "http://insecure.example.com",
        keys,
        baseDir: tmpDir,
      }),
    ).rejects.toThrow("invalid push subscription endpoint");
    await expect(
      registerWebPushSubscription({
        endpoint,
        keys: { p256dh: "", auth: "auth" },
        baseDir: tmpDir,
      }),
    ).rejects.toThrow("invalid push subscription keys");
  });

  it("blocks an empty broadcast while retired subscriptions await Doctor", async () => {
    const pushDir = path.join(tmpDir, "push");
    const legacyPath = path.join(pushDir, "web-push-subscriptions.json");
    await fs.mkdir(pushDir, { recursive: true });
    await fs.writeFile(
      legacyPath,
      JSON.stringify({
        subscriptionsByEndpointHash: {
          legacy: {
            subscriptionId: "c0a80101-0000-4000-8000-000000000001",
            endpoint: "https://push.example.com/legacy",
            keys,
            createdAtMs: 1,
            updatedAtMs: 1,
          },
        },
      }),
    );

    expect(listWebPushSubscriptions(tmpDir)).toEqual([]);
    await expect(broadcastWebPush({ title: "Blocked" }, tmpDir)).rejects.toThrow(
      "openclaw doctor --fix",
    );
    expect(vi.mocked(webPush.sendNotification)).not.toHaveBeenCalled();
  });

  it("blocks mutations while a Doctor claim is pending", async () => {
    const existing = await registerWebPushSubscription({ endpoint, keys, baseDir: tmpDir });
    const pushDir = path.join(tmpDir, "push");
    const claimPath = path.join(pushDir, "web-push-subscriptions.json.doctor-importing");
    await fs.mkdir(pushDir, { recursive: true });
    await fs.writeFile(claimPath, "{}", "utf8");

    await expect(clearWebPushSubscriptionByEndpoint(endpoint, tmpDir)).rejects.toThrow(
      "openclaw doctor --fix",
    );
    await expect(
      registerWebPushSubscription({
        endpoint: "https://push.example.com/new",
        keys,
        baseDir: tmpDir,
      }),
    ).rejects.toThrow("openclaw doctor --fix");
    expect(listWebPushSubscriptions(tmpDir)).toEqual([existing]);
  });
});

describe("sending", () => {
  const keys = { p256dh: "p256dh-key", auth: "auth-key" };

  it("configures VAPID details once before broadcasting", async () => {
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

  it("does not delete a subscription re-registered during an expired send", async () => {
    const endpoint = "https://push.example.com/reregistered";
    await registerWebPushSubscription({ endpoint, keys, baseDir: tmpDir });
    let rejectSend: ((error: unknown) => void) | undefined;
    vi.mocked(webPush.sendNotification).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectSend = reject;
        }),
    );

    const broadcast = broadcastWebPush({ title: "Race" }, tmpDir);
    await vi.waitFor(() => expect(rejectSend).toBeTypeOf("function"));
    const replacement = await registerWebPushSubscription({
      endpoint,
      keys: { p256dh: "replacement-p256dh", auth: "replacement-auth" },
      baseDir: tmpDir,
    });
    rejectSend?.(Object.assign(new Error("gone"), { statusCode: 410 }));
    await broadcast;

    expect(listWebPushSubscriptions(tmpDir)).toEqual([replacement]);
  });

  it("does not delete an expired subscription after a legacy claim appears", async () => {
    const endpoint = "https://push.example.com/pending-claim";
    const subscription = await registerWebPushSubscription({ endpoint, keys, baseDir: tmpDir });
    let rejectSend: ((error: unknown) => void) | undefined;
    vi.mocked(webPush.sendNotification).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectSend = reject;
        }),
    );

    const broadcast = broadcastWebPush({ title: "Race" }, tmpDir);
    await vi.waitFor(() => expect(rejectSend).toBeTypeOf("function"));
    const pushDir = path.join(tmpDir, "push");
    await fs.mkdir(pushDir, { recursive: true });
    await fs.writeFile(
      path.join(pushDir, "web-push-subscriptions.json.doctor-importing"),
      "{}",
      "utf8",
    );
    rejectSend?.(Object.assign(new Error("gone"), { statusCode: 410 }));

    await expect(broadcast).resolves.toEqual([
      expect.objectContaining({ ok: false, statusCode: 410 }),
    ]);
    expect(listWebPushSubscriptions(tmpDir)).toEqual([subscription]);
  });

  it("keeps completed delivery results when expired-subscription cleanup fails", async () => {
    const endpoint = "https://push.example.com/expired";
    await registerWebPushSubscription({ endpoint, keys, baseDir: tmpDir });
    await resolveVapidKeys(tmpDir);
    let rejectSend: ((error: unknown) => void) | undefined;
    vi.mocked(webPush.sendNotification).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectSend = reject;
        }),
    );

    const broadcast = broadcastWebPush({ title: "Expired" }, tmpDir);
    await vi.waitFor(() => expect(rejectSend).toBeTypeOf("function"));
    closeOpenClawStateDatabase();
    const databasePath = path.join(tmpDir, "state", "openclaw.sqlite");
    await fs.rename(databasePath, `${databasePath}.backup`);
    await fs.mkdir(databasePath);
    rejectSend?.(Object.assign(new Error("gone"), { statusCode: 410 }));

    await expect(broadcast).resolves.toEqual([
      expect.objectContaining({ ok: false, statusCode: 410 }),
    ]);
  });
});
