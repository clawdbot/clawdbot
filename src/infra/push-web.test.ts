// Tests SQLite-backed Web Push subscription storage and delivery helpers.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import webPush from "web-push";
import {
  insertOperatorApproval,
  resolveOperatorApproval,
} from "../gateway/operator-approval-store.js";
import { tableExists, tableHasColumn } from "../state/openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  createWebPushVapidKeyPair,
  deleteWebPushApprovalDeliveryTargets,
  findBoundWebPushSubscriptionByEndpoint,
  hashWebPushEndpoint,
  listBoundWebPushSubscriptions,
  listTerminalWebPushApprovalDeliveryIds,
  listWebPushApprovalDeliveryTargets,
  listWebPushSubscriptions,
  prepareWebPushApprovalDeliveries,
  readPersistedVapidKeyPair,
  retainSuccessfulWebPushApprovalDeliveries,
  setWebPushSubscriptionPreferences,
} from "./push-web-store.js";
import {
  broadcastWebPush,
  clearWebPushSubscriptionByEndpoint,
  prepareWebPushNotificationSender,
  registerWebPushSubscription,
  resolveVapidKeys,
} from "./push-web.js";

let tmpDir: string;
const defaultDevicePreferences = { enabled: true, label: "" };

function insertPendingApproval(id: string): void {
  const inserted = insertOperatorApproval({
    approval: {
      id,
      kind: "exec",
      presentation: {
        kind: "exec",
        commandText: "echo approval",
        commandPreview: "echo approval",
        warningText: null,
        host: "gateway",
        nodeId: null,
        agentId: "main",
        allowedDecisions: ["allow-once", "deny"],
      },
      runtimeEpoch: "web-push-test-runtime",
      createdAtMs: 1_000,
      expiresAtMs: 60_000,
    },
    databaseOptions: { env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir } },
  });
  if (inserted.outcome !== "inserted") {
    throw new Error("expected pending approval insert");
  }
}
const generatedVapidKeys = vi.hoisted(
  () =>
    Object.fromEntries([
      ["publicKey", "test-public-key-base64url"],
      ["privateKey", "test-private-key-base64url"],
    ]) as { publicKey: string; privateKey: string },
);
vi.mock("../config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/paths.js")>();
  return {
    ...actual,
    resolveStateDir: () => tmpDir,
  };
});

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

  it("lazily adds and persists authenticated device bindings", async () => {
    const environment = { ...process.env, OPENCLAW_STATE_DIR: tmpDir };
    const database = openOpenClawStateDatabase({ env: environment });
    database.db.exec("ALTER TABLE web_push_subscriptions DROP COLUMN device_id;");
    database.db.exec("ALTER TABLE web_push_subscriptions DROP COLUMN user_profile_id;");
    database.db.exec("ALTER TABLE web_push_subscriptions DROP COLUMN preferences_json;");
    expect(tableHasColumn(database.db, "web_push_subscriptions", "device_id")).toBe(false);
    expect(tableHasColumn(database.db, "web_push_subscriptions", "user_profile_id")).toBe(false);
    expect(tableHasColumn(database.db, "web_push_subscriptions", "preferences_json")).toBe(false);

    const subscription = await registerWebPushSubscription({
      endpoint,
      keys,
      binding: { deviceId: "browser-device", userProfileId: "profile-1" },
      baseDir: tmpDir,
    });

    expect(tableHasColumn(database.db, "web_push_subscriptions", "device_id")).toBe(true);
    expect(tableHasColumn(database.db, "web_push_subscriptions", "user_profile_id")).toBe(true);
    expect(tableHasColumn(database.db, "web_push_subscriptions", "preferences_json")).toBe(true);
    expect(listBoundWebPushSubscriptions(tmpDir)).toEqual([
      {
        ...subscription,
        deviceId: "browser-device",
        userProfileId: "profile-1",
        devicePreferences: defaultDevicePreferences,
      },
    ]);
  });

  it("keeps legacy unbound rows test-only until browser reconciliation", async () => {
    await registerWebPushSubscription({ endpoint, keys, baseDir: tmpDir });
    expect(listBoundWebPushSubscriptions(tmpDir)).toEqual([]);

    const rebound = await registerWebPushSubscription({
      endpoint,
      keys,
      binding: { deviceId: "browser-device", userProfileId: null },
      baseDir: tmpDir,
    });
    expect(listBoundWebPushSubscriptions(tmpDir)).toEqual([
      {
        ...rebound,
        deviceId: "browser-device",
        userProfileId: null,
        devicePreferences: defaultDevicePreferences,
      },
    ]);
  });

  it("preserves bindings when an older writer updates only the original columns", async () => {
    const subscription = await registerWebPushSubscription({
      endpoint,
      keys,
      binding: { deviceId: "browser-device", userProfileId: "profile-1" },
      baseDir: tmpDir,
    });
    closeOpenClawStateDatabase();

    const olderWriter = new DatabaseSync(path.join(tmpDir, "state", "openclaw.sqlite"));
    olderWriter
      .prepare(
        "UPDATE web_push_subscriptions SET auth = ?, updated_at_ms = ? WHERE endpoint_hash = ?",
      )
      .run("older-auth", subscription.updatedAtMs + 1, hashWebPushEndpoint(endpoint));
    olderWriter.close();

    expect(listBoundWebPushSubscriptions(tmpDir)).toEqual([
      {
        ...subscription,
        keys: { ...subscription.keys, auth: "older-auth" },
        updatedAtMs: subscription.updatedAtMs + 1,
        deviceId: "browser-device",
        userProfileId: "profile-1",
        devicePreferences: defaultDevicePreferences,
      },
    ]);
  });

  it("persists preferences only while the authenticated subscription binding still matches", async () => {
    await registerWebPushSubscription({
      endpoint,
      keys,
      binding: { deviceId: "browser-device", userProfileId: "profile-1" },
      baseDir: tmpDir,
    });
    expect(
      setWebPushSubscriptionPreferences({
        endpoint,
        expectedDeviceId: "different-device",
        expectedUserProfileId: "profile-1",
        preferences: { enabled: false, label: "Wrong" },
        stateDir: tmpDir,
      }),
    ).toBe(false);
    expect(
      setWebPushSubscriptionPreferences({
        endpoint,
        expectedDeviceId: "browser-device",
        expectedUserProfileId: "profile-1",
        preferences: {
          enabled: true,
          label: "Slot 1",
          categories: { agentQuestion: true },
        },
        stateDir: tmpDir,
      }),
    ).toBe(true);
    expect(findBoundWebPushSubscriptionByEndpoint({ endpoint, stateDir: tmpDir })).toMatchObject({
      deviceId: "browser-device",
      userProfileId: "profile-1",
      devicePreferences: {
        enabled: true,
        label: "Slot 1",
        categories: { agentQuestion: true },
      },
    });
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

describe("approval delivery target persistence", () => {
  const keys = { p256dh: "p256dh-key", auth: "auth-key" };

  it("lazily persists successful targets across reopen until terminal replacement", async () => {
    const approvalId = "exec:restart-safe-push";
    insertPendingApproval(approvalId);
    const first = await registerWebPushSubscription({
      endpoint: "https://push.example.com/approval-first",
      keys,
      binding: { deviceId: "device-first", userProfileId: "profile-first" },
      baseDir: tmpDir,
    });
    const second = await registerWebPushSubscription({
      endpoint: "https://push.example.com/approval-second",
      keys,
      binding: { deviceId: "device-second", userProfileId: null },
      baseDir: tmpDir,
    });
    const firstBound = {
      ...first,
      deviceId: "device-first",
      userProfileId: "profile-first",
      devicePreferences: defaultDevicePreferences,
    };
    const secondBound = {
      ...second,
      deviceId: "device-second",
      userProfileId: null,
      devicePreferences: defaultDevicePreferences,
    };
    const database = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir },
    });
    expect(tableExists(database.db, "web_push_approval_deliveries")).toBe(false);

    expect(
      prepareWebPushApprovalDeliveries({
        approvalId,
        subscriptions: [firstBound, secondBound],
        preparedAtMs: 2_000,
        stateDir: tmpDir,
      }),
    ).toBe(true);
    expect(tableExists(database.db, "web_push_approval_deliveries")).toBe(true);
    closeOpenClawStateDatabase();

    const expectedSubscriptionIds = [first, second]
      .toSorted(
        (a, b) => a.createdAtMs - b.createdAtMs || a.subscriptionId.localeCompare(b.subscriptionId),
      )
      .map((subscription) => subscription.subscriptionId);
    expect(
      listWebPushApprovalDeliveryTargets({ approvalId, stateDir: tmpDir }).map(
        (subscription) => subscription.subscriptionId,
      ),
    ).toEqual(expectedSubscriptionIds);

    retainSuccessfulWebPushApprovalDeliveries({
      approvalId,
      successfulSubscriptionIds: [first.subscriptionId],
      stateDir: tmpDir,
    });
    closeOpenClawStateDatabase();
    expect(listWebPushApprovalDeliveryTargets({ approvalId, stateDir: tmpDir })).toEqual([
      firstBound,
    ]);

    expect(
      resolveOperatorApproval({
        id: approvalId,
        decision: "deny",
        resolver: { kind: "system", id: null },
        nowMs: 3_000,
        databaseOptions: { env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir } },
      }).outcome,
    ).toBe("resolved");
    expect(listTerminalWebPushApprovalDeliveryIds(tmpDir)).toEqual({
      approvalIds: [approvalId],
      truncated: false,
    });

    deleteWebPushApprovalDeliveryTargets({
      approvalId,
      subscriptionIds: [first.subscriptionId],
      stateDir: tmpDir,
    });
    expect(listWebPushApprovalDeliveryTargets({ approvalId, stateDir: tmpDir })).toEqual([]);
  });

  it("cascades delivery targets when the browser subscription is removed", async () => {
    const approvalId = "exec:removed-push-target";
    insertPendingApproval(approvalId);
    const subscription = await registerWebPushSubscription({
      endpoint: "https://push.example.com/approval-removed",
      keys,
      binding: { deviceId: "device-removed", userProfileId: "profile-removed" },
      baseDir: tmpDir,
    });
    expect(
      prepareWebPushApprovalDeliveries({
        approvalId,
        subscriptions: [
          {
            ...subscription,
            deviceId: "device-removed",
            userProfileId: "profile-removed",
            devicePreferences: defaultDevicePreferences,
          },
        ],
        preparedAtMs: 2_000,
        stateDir: tmpDir,
      }),
    ).toBe(true);

    await expect(clearWebPushSubscriptionByEndpoint(subscription.endpoint, tmpDir)).resolves.toBe(
      true,
    );
    expect(listWebPushApprovalDeliveryTargets({ approvalId, stateDir: tmpDir })).toEqual([]);
  });

  it("rejects a terminal target after the endpoint is rebound to another owner", async () => {
    const approvalId = "exec:rebound-push-target";
    insertPendingApproval(approvalId);
    const original = await registerWebPushSubscription({
      endpoint: "https://push.example.com/approval-rebound",
      keys,
      binding: { deviceId: "device-original", userProfileId: "profile-original" },
      baseDir: tmpDir,
    });
    expect(
      prepareWebPushApprovalDeliveries({
        approvalId,
        subscriptions: [
          {
            ...original,
            deviceId: "device-original",
            userProfileId: "profile-original",
            devicePreferences: defaultDevicePreferences,
          },
        ],
        preparedAtMs: 2_000,
        stateDir: tmpDir,
      }),
    ).toBe(true);
    expect(
      resolveOperatorApproval({
        id: approvalId,
        decision: "deny",
        resolver: { kind: "system", id: null },
        nowMs: 3_000,
        databaseOptions: { env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir } },
      }).outcome,
    ).toBe("resolved");
    closeOpenClawStateDatabase();

    const rebound = await registerWebPushSubscription({
      endpoint: original.endpoint,
      keys: { p256dh: "rebound-p256dh", auth: "rebound-auth" },
      binding: { deviceId: "device-rebound", userProfileId: "profile-rebound" },
      baseDir: tmpDir,
    });
    expect(rebound.subscriptionId).toBe(original.subscriptionId);
    expect(listTerminalWebPushApprovalDeliveryIds(tmpDir).approvalIds).toContain(approvalId);
    expect(listWebPushApprovalDeliveryTargets({ approvalId, stateDir: tmpDir })).toEqual([]);
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

  it("sends a bounded high-urgency notification only to selected subscriptions", async () => {
    const selected = await registerWebPushSubscription({
      endpoint: "https://push.example.com/selected",
      keys,
      baseDir: tmpDir,
    });
    await registerWebPushSubscription({
      endpoint: "https://push.example.com/not-selected",
      keys,
      baseDir: tmpDir,
    });

    const send = await prepareWebPushNotificationSender(tmpDir);
    await expect(
      send({
        subscriptions: [selected],
        payload: { title: "Approval", url: "/approve/1" },
        deliveryOptions: { TTL: 60, urgency: "high", timeout: 10_000 },
      }),
    ).resolves.toEqual([{ ok: true, subscriptionId: selected.subscriptionId, statusCode: 201 }]);
    expect(vi.mocked(webPush.sendNotification)).toHaveBeenCalledOnce();
    expect(vi.mocked(webPush.sendNotification)).toHaveBeenCalledWith(
      {
        endpoint: selected.endpoint,
        keys: selected.keys,
      },
      JSON.stringify({ title: "Approval", url: "/approve/1" }),
      { TTL: 60, urgency: "high", timeout: 10_000 },
    );
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
