import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { NativeNotificationMessage } from "../../packages/gateway-protocol/src/schema/push.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { deriveDeviceIdFromPublicKey } from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { revokeDeviceToken } from "../infra/device-pairing-tokens.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import {
  WEB_PUSH_USER_PREFERENCES_KEY,
  normalizeWebPushNotificationPreferences,
} from "../infra/push-web-preferences.js";
import { getUserPreferences, setUserPreferences } from "../state/user-preferences.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createApprovalWebPushDelivery } from "./approval-web-push.js";
import { createEventWebPushDelivery } from "./event-web-push.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import {
  createNativeNotificationRegistry,
  type NativeNotificationRegistry,
} from "./native-notifications.js";
import type { OperatorScope } from "./operator-scopes.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { notificationHandlers } from "./server-methods/notifications.js";
import type { GatewayWsClient } from "./server/ws-types.js";

function show(
  id: string,
  expiresAtMs = Date.now() + 60_000,
): NativeNotificationMessage & { action: "show" } {
  return {
    action: "show",
    id,
    category: "approval-requested",
    title: "Approval requested",
    body: "Open OpenClaw to review.",
    path: "/approve/request",
    expiresAtMs,
    alert: true,
  };
}

async function withRegistry(
  run: (fixture: {
    registry: NativeNotificationRegistry;
    clients: Set<GatewayWsClient>;
    sent: Array<{ client: GatewayWsClient; message: NativeNotificationMessage }>;
    send: ReturnType<
      typeof vi.fn<(client: GatewayWsClient, message: NativeNotificationMessage) => void>
    >;
    replay: ReturnType<typeof vi.fn>;
    changed: ReturnType<typeof vi.fn>;
    setConfig: (config: OpenClawConfig) => void;
    getConfig: () => OpenClawConfig;
    stateDir: string;
    connect: (
      seed: number,
      options?: { profile?: string; scopes?: string[]; connectionScopes?: string[] },
    ) => Promise<GatewayWsClient>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    const clients = new Set<GatewayWsClient>();
    const sent: Array<{ client: GatewayWsClient; message: NativeNotificationMessage }> = [];
    let config: OpenClawConfig = {};
    const replay = vi.fn((client: GatewayWsClient) => registry.targets(["operator.read"], client));
    const changed = vi.fn();
    const send = vi.fn((client: GatewayWsClient, message: NativeNotificationMessage): void => {
      sent.push({ client, message });
    });
    const registry = createNativeNotificationRegistry({
      clients,
      getRuntimeConfig: () => config,
      send,
      onSubscribe: replay,
      onPreferencesChanged: changed,
      createTestNotification: () => show("test"),
      stateDir,
    });
    const connect = async (
      seed: number,
      options: { profile?: string; scopes?: string[]; connectionScopes?: string[] } = {},
    ) => {
      const scopes = options.scopes ?? ["operator.admin"];
      const publicKey = Buffer.alloc(32, seed).toString("base64url");
      const deviceId = expectDefined(deriveDeviceIdFromPublicKey(publicKey), "fixture device ID");
      const pending = await requestDevicePairing(
        { deviceId, publicKey, role: "operator", scopes },
        stateDir,
      );
      expect(
        await approveDevicePairing(
          pending.request.requestId,
          { callerScopes: ["operator.admin"] },
          stateDir,
        ),
      ).not.toBeNull();
      const profile = options.profile ? ensureProfileForEmail(options.profile) : undefined;
      // This registry consumes post-handshake peers; only the physical socket is a test double.
      const client: GatewayWsClient = {
        socket: { readyState: 1 } as WebSocket,
        connId: `connection-${seed}-${clients.size}`,
        usesSharedGatewayAuth: false,
        connect: {
          minProtocol: 3,
          maxProtocol: 3,
          client: { id: "openclaw-macos", mode: "ui", version: "test", platform: "macos" },
          role: "operator",
          scopes: options.connectionScopes ?? scopes,
          device: {
            id: deviceId,
            publicKey,
            signature: "verified-by-handshake",
            signedAt: Date.now(),
            nonce: "challenge",
          },
        },
        ...(profile
          ? {
              authenticatedUserProfile: {
                profileId: profile.id,
                displayName: null,
                avatarRevision: "",
                hasAvatar: false,
                updatedAt: profile.updatedAt,
              },
            }
          : {}),
      };
      clients.add(client);
      return client;
    };
    try {
      await run({
        registry,
        clients,
        sent,
        send,
        replay,
        changed,
        setConfig: (next) => {
          config = next;
        },
        getConfig: () => config,
        stateDir,
        connect,
      });
    } finally {
      registry.clear();
    }
  });
}

describe("native notification registrations", () => {
  it("requires the exact live paired operator and registers before passive replay", async () => {
    await withRegistry(async ({ registry, connect, clients, replay }) => {
      const client = await connect(1);
      expect(registry.subscribe({ ...client }, true)).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN" },
      });
      expect(registry.subscribe(client, true)).toMatchObject({
        ok: true,
        value: { devicePersistence: "session", canManageUserPreferences: false },
      });
      expect(replay.mock.results[0]?.value).toHaveLength(1);
      const first = expectDefined(registry.targets(["operator.read"])[0], "first target");
      expect(registry.subscribe(client, true).ok).toBe(true);
      expect(registry.send(first, show("stale"))).toBe(false);
      clients.delete(client);
      expect(registry.targets(["operator.read"])).toEqual([]);
      clients.add(client);
      expect(registry.targets(["operator.read"])).toEqual([]);
    });
  });

  it.each<{
    device: OperatorScope[];
    profile: OperatorScope[];
    connection: OperatorScope[];
    admin: boolean;
  }>([
    {
      device: ["operator.admin"],
      profile: ["operator.admin"],
      connection: ["operator.admin"],
      admin: true,
    },
    {
      device: ["operator.admin"],
      profile: ["operator.read", "operator.approvals"],
      connection: ["operator.admin"],
      admin: false,
    },
    {
      device: ["operator.read", "operator.approvals"],
      profile: ["operator.admin"],
      connection: ["operator.read", "operator.approvals"],
      admin: false,
    },
    {
      device: ["operator.admin"],
      profile: ["operator.admin"],
      connection: ["operator.read"],
      admin: false,
    },
  ])(
    "intersects device/profile/live scope ceilings: $device / $profile / $connection",
    async (scopes) => {
      await withRegistry(async ({ registry, connect, setConfig }) => {
        const client = await connect(1, {
          profile: "operator@example.test",
          scopes: scopes.device,
          connectionScopes: scopes.connection,
        });
        setConfig({
          gateway: {
            roles: {
              default: "operator",
              definitions: {
                operator: { scopes: scopes.profile, agents: "*", sessions: { others: "write" } },
              },
            },
          },
        });
        expect(registry.subscribe(client, true).ok).toBe(true);
        const read = expectDefined(registry.targets(["operator.read"])[0], "read target");
        expect(read.visibilityClient.connect.scopes?.includes("operator.admin")).toBe(scopes.admin);
        expect(registry.targets(["operator.approvals"])).toHaveLength(
          scopes.connection.includes("operator.read") &&
            !scopes.connection.includes("operator.approvals")
            ? 0
            : 1,
        );
        expect(registry.targets(["operator.read"])).toHaveLength(1);
      });
    },
  );

  it("persists account and signed-device preferences without sharing device overrides", async () => {
    await withRegistry(async ({ registry, connect, changed }) => {
      const first = await connect(1, { profile: "alice@example.test" });
      const second = await connect(2, { profile: "alice@example.test" });
      const other = await connect(3, { profile: "bob@example.test" });
      for (const client of [first, second, other]) {
        expect(registry.subscribe(client, true).ok).toBe(true);
      }
      const user = normalizeWebPushNotificationPreferences({ categories: { agentFinished: true } });
      expect(registry.setPreferences(first, { scope: "user", preferences: user }).ok).toBe(true);
      expect(
        registry.setPreferences(first, {
          scope: "device",
          preferences: { enabled: false, label: "Office", detailLevel: "identified" },
        }).ok,
      ).toBe(true);
      expect(registry.preferences(second)).toMatchObject({
        ok: true,
        value: { user, device: { enabled: true, label: "" }, devicePersistence: "profile" },
      });
      expect(registry.preferences(other)).toMatchObject({
        ok: true,
        value: { user: { categories: { agentFinished: false } } },
      });
      const profileId = expectDefined(first.authenticatedUserProfile?.profileId, "profile");
      const deviceId = expectDefined(first.connect.device?.id, "device");
      expect(getUserPreferences(profileId)).toEqual({
        [WEB_PUSH_USER_PREFERENCES_KEY]: user,
        [`notifications.native.v1.${deviceId}`]: {
          enabled: false,
          label: "Office",
          detailLevel: "identified",
        },
      });
      registry.unregister(first);
      expect(registry.subscribe(first, true)).toMatchObject({
        ok: true,
        value: { device: { enabled: false, label: "Office" } },
      });
      expect(changed).toHaveBeenCalledWith(profileId, [WEB_PUSH_USER_PREFERENCES_KEY]);
      const replacement = normalizeWebPushNotificationPreferences({ detailLevel: "detailed" });
      expect(
        setUserPreferences(profileId, { [WEB_PUSH_USER_PREFERENCES_KEY]: replacement }).ok,
      ).toBe(true);
      expect(registry.preferences(second)).toMatchObject({
        ok: true,
        value: { user: replacement },
      });
    });
  });

  it("keeps profileless overrides only for the current registration lease", async () => {
    await withRegistry(async ({ registry, connect }) => {
      const client = await connect(1);
      expect(registry.subscribe(client, true).ok).toBe(true);
      expect(
        registry.setPreferences(client, {
          scope: "device",
          preferences: { enabled: false, label: "Temporary" },
        }).ok,
      ).toBe(true);
      expect(registry.subscribe(client, true)).toMatchObject({
        ok: true,
        value: { device: { label: "Temporary" } },
      });
      expect(
        registry.setPreferences(client, {
          scope: "user",
          preferences: normalizeWebPushNotificationPreferences({}),
        }),
      ).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
      registry.unregister(client);
      expect(registry.subscribe(client, true)).toMatchObject({
        ok: true,
        value: { device: { enabled: true, label: "" } },
      });
    });
  });

  it.each(["token", "profile", "invalidated", "disconnect"] as const)(
    "retires stale authority and clears only owned notifications: %s",
    async (reason) => {
      await withRegistry(async ({ registry, connect, clients, sent, stateDir }) => {
        const client = await connect(1, { profile: "alice@example.test" });
        expect(registry.subscribe(client, true).ok).toBe(true);
        const target = expectDefined(registry.targets(["operator.read"])[0], "target");
        const notification = show("owned");
        expect(registry.send(target, notification)).toBe(true);
        if (reason === "token") {
          await revokeDeviceToken({
            deviceId: expectDefined(client.connect.device?.id, "device"),
            role: "operator",
            baseDir: stateDir,
          });
        } else if (reason === "profile") {
          const other = await connect(2, { profile: "bob@example.test" });
          client.authenticatedUserProfile = other.authenticatedUserProfile;
        } else if (reason === "invalidated") {
          client.invalidated = true;
        } else {
          clients.delete(client);
        }
        expect(registry.send(target, show("stale"))).toBe(false);
        expect(sent.map(({ message }) => message)).toEqual([
          notification,
          ...(reason === "disconnect" ? [] : [{ action: "remove", id: "owned" }]),
        ]);
        expect(registry.preferences(client)).toMatchObject({
          ok: false,
          error: { code: "INVALID_REQUEST" },
        });
      });
    },
  );

  it("removes only shown IDs even after notification preferences are disabled", async () => {
    await withRegistry(async ({ registry, connect, sent }) => {
      const first = await connect(1);
      const second = await connect(2);
      for (const client of [first, second]) {
        registry.subscribe(client, true);
      }
      const firstTarget = expectDefined(
        registry.targets(["operator.approvals"], first)[0],
        "first target",
      );
      expect(registry.send(firstTarget, show("approval"))).toBe(true);
      registry.setPreferences(first, {
        scope: "device",
        preferences: { enabled: false, label: "" },
      });
      registry.remove("unknown");
      registry.remove("approval");
      expect(sent).toHaveLength(2);
      expect(sent[1]).toEqual({ client: first, message: { action: "remove", id: "approval" } });
      expect(registry.send(firstTarget, show("unsubscribe-owned"))).toBe(true);
      expect(registry.unsubscribe(first).ok).toBe(true);
      expect(sent.at(-1)).toEqual({
        client: first,
        message: { action: "remove", id: "unsubscribe-owned" },
      });
      expect(registry.targets(["operator.read"])).toHaveLength(1);
    });
  });

  it("bounds notification ownership and expires old leases", async () => {
    await withRegistry(async ({ registry, connect, sent }) => {
      const client = await connect(1);
      registry.subscribe(client, true);
      const target = expectDefined(registry.targets(["operator.read"])[0], "target");
      for (let index = 0; index <= 256; index += 1) {
        expect(registry.send(target, show(`notification-${index}`))).toBe(true);
      }
      expect(
        sent.filter(({ message }) => message.action === "remove").map(({ message }) => message.id),
      ).toEqual(["notification-0"]);
      registry.remove("notification-0");
      const before = sent.length;
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
      try {
        expect(registry.send(target, show("fresh"))).toBe(true);
        expect(
          sent.slice(before).filter(({ message }) => message.action === "remove"),
        ).toHaveLength(256);
      } finally {
        clock.mockRestore();
      }
    });
  });

  it("rejects unsafe notification paths and tests only the registered enabled socket", async () => {
    await withRegistry(async ({ registry, connect, sent }) => {
      const client = await connect(1);
      const other = await connect(2);
      registry.subscribe(client, false);
      registry.subscribe(other, true);
      expect(registry.test(client).ok).toBe(false);
      registry.subscribe(client, true);
      registry.setPreferences(client, {
        scope: "device",
        preferences: { enabled: false, label: "" },
      });
      expect(registry.test(client).ok).toBe(true);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.client).toBe(client);
      const target = expectDefined(registry.targets(["operator.read"], client)[0], "target");
      for (const path of [
        "https://example.test/",
        "//example.test/",
        "/\\example.test/",
        "/bad\npath",
      ]) {
        expect(registry.send(target, { ...show("bad"), path })).toBe(false);
      }
      expect(sent).toHaveLength(1);
    });
  });

  it.each([
    {
      event: "question.requested",
      payload: { id: "question:1" },
      category: "agent-question",
      path: "/ask/question%3A1",
      title: "OpenClaw needs an answer",
      body: "An agent has a question for you.",
    },
    {
      event: "chat",
      payload: { state: "final", runId: "run-1" },
      category: "agent-finished",
      path: "/sessions",
      title: "OpenClaw agent finished",
      body: "An agent completed its response.",
    },
    {
      event: "task",
      payload: {
        action: "upserted",
        task: { id: "task-1", status: "failed", title: "Private task" },
      },
      category: "background-task-failed",
      path: "/tasks",
      title: "OpenClaw background task failed",
      body: "A background task needs attention.",
    },
    {
      event: "cron",
      payload: {
        action: "finished",
        status: "error",
        jobId: "job-1",
        job: { name: "Private job" },
      },
      category: "scheduled-task-failed",
      path: "/automations",
      title: "OpenClaw scheduled task failed",
      body: "A scheduled task needs attention.",
    },
  ])(
    "delivers prepared $category events using shared defaults and device overrides",
    async (event) => {
      await withRegistry(async ({ registry, connect, sent, stateDir, getConfig }) => {
        const client = await connect(1, { profile: "alice@example.test" });
        registry.subscribe(client, true);
        const delivery = createEventWebPushDelivery({
          getRuntimeConfig: getConfig,
          nativeNotifications: registry,
          stateDir,
        });
        const { broadcast } = createGatewayBroadcaster({
          clients: new Set(),
          onBroadcast: (name, payload, opts) => delivery.handleEvent(name, payload, opts),
        });
        const emitEvent = () =>
          broadcast(event.event, event.payload, { agentRunCompleted: true, agentId: "main" });
        emitEvent();
        expect(sent).toEqual([]);
        expect(
          registry.setPreferences(client, {
            scope: "user",
            preferences: normalizeWebPushNotificationPreferences({
              categories: {
                agentFinished: true,
                agentQuestion: true,
                backgroundTaskFailed: true,
                scheduledTaskFailed: true,
              },
            }),
          }).ok,
        ).toBe(true);
        emitEvent();
        expect(sent).toEqual([
          {
            client,
            message: expect.objectContaining({
              action: "show",
              category: event.category,
              path: event.path,
              title: event.title,
              body: event.body,
              alert: true,
            }),
          },
        ]);

        for (const preferences of [
          { enabled: false, label: "" },
          { enabled: true, label: "", agentIds: ["other-agent"] },
          {
            enabled: true,
            label: "",
            categories: {
              agentFinished: false,
              agentQuestion: false,
              backgroundTaskFailed: false,
              scheduledTaskFailed: false,
            },
          },
        ]) {
          expect(registry.setPreferences(client, { scope: "device", preferences }).ok).toBe(true);
          emitEvent();
          expect(sent).toHaveLength(1);
        }
        expect(
          registry.setPreferences(client, {
            scope: "device",
            preferences: { enabled: true, label: "Desk", detailLevel: "identified" },
          }).ok,
        ).toBe(true);
        emitEvent();
        expect(sent.at(-1)?.message).toMatchObject({ title: `Desk · ${event.title}` });
        expect(sent).toHaveLength(2);
      });
    },
  );

  it("keeps question scope and draft visibility when native clients opt into shared categories", async () => {
    await withRegistry(async ({ registry, connect, sent, stateDir, getConfig }) => {
      const scopes = ["operator.read", "operator.write", "operator.questions"];
      const owner = await connect(1, { profile: "alice@example.test", scopes });
      const stranger = await connect(2, { profile: "bob@example.test", scopes });
      const admin = await connect(3, { profile: "admin@example.test" });
      const sessionKey = "agent:main:dashboard:private-question";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "private-question",
          updatedAt: Date.now(),
          visibility: "draft",
          createdActor: {
            type: "human",
            source: "profile",
            id: expectDefined(owner.authenticatedUserProfile?.profileId, "owner"),
          },
        },
      );
      for (const client of [owner, stranger, admin]) {
        registry.subscribe(client, true);
        expect(
          registry.setPreferences(client, {
            scope: "device",
            preferences: {
              enabled: true,
              label: "",
              categories: { agentQuestion: true },
            },
          }).ok,
        ).toBe(true);
      }
      const delivery = createEventWebPushDelivery({
        getRuntimeConfig: getConfig,
        nativeNotifications: registry,
        stateDir,
      });
      delivery.handleEvent(
        "question.requested",
        { id: "private-question" },
        { sessionKeys: [sessionKey], agentId: "main" },
      );
      expect(sent.map(({ client }) => client)).toEqual([owner, admin]);
      sent.length = 0;
      owner.connect.scopes = ["operator.read"];
      delivery.handleEvent(
        "question.requested",
        { id: "scope-revoked" },
        { sessionKeys: [sessionKey], agentId: "main" },
      );
      expect(sent.map(({ client }) => client)).toEqual([admin]);
    });
  });

  it("replays visible approvals silently and removes only recipients after preferences change", async () => {
    await withRegistry(async ({ registry, connect, sent, replay, stateDir, getConfig }) => {
      const scopes = ["operator.read", "operator.write", "operator.approvals"];
      const reviewer = await connect(1, { scopes });
      const stranger = await connect(2, { scopes });
      const returning = await connect(3, { scopes });
      const admin = await connect(4);
      const record = new ExecApprovalManager().create(
        { command: "sensitive command", agentId: "main" },
        60_000,
        "exec:native-replay",
      );
      record.requestedByDeviceId = "another-requester";
      record.approvalReviewerDeviceIds = [
        expectDefined(reviewer.connect.device?.id, "reviewer"),
        expectDefined(returning.connect.device?.id, "returning reviewer"),
      ];
      const delivery = createApprovalWebPushDelivery({
        getRuntimeConfig: getConfig,
        nativeNotifications: registry,
        stateDir,
      });
      for (const client of [reviewer, stranger, admin]) {
        registry.subscribe(client, true);
      }
      expect(delivery.handleRequested(record)).toBe(true);
      expect(sent.map(({ client }) => client)).toEqual([reviewer, admin]);
      expect(sent[0]?.message).toMatchObject({
        action: "show",
        id: "openclaw-approval-exec:native-replay",
        alert: true,
        path: "/approve/exec%3Anative-replay",
        body: "Open OpenClaw to review this request.",
      });
      replay.mockImplementation((client: GatewayWsClient) =>
        delivery.replayNative([record], client),
      );
      expect(registry.subscribe(returning, true).ok).toBe(true);
      expect(sent).toHaveLength(3);
      expect(sent[2]).toMatchObject({
        client: returning,
        message: { action: "show", alert: false },
      });
      delivery.replayNative([record], stranger);
      expect(sent).toHaveLength(3);
      for (const client of [reviewer, returning, admin]) {
        expect(
          registry.setPreferences(client, {
            scope: "device",
            preferences: { enabled: false, label: "" },
          }).ok,
        ).toBe(true);
        client.connect.scopes = ["operator.read"];
      }
      record.resolvedAtMs = Date.now();
      delivery.replayNative([record], returning);
      await delivery.handleResolved(record);
      expect(sent.slice(3)).toEqual(
        [reviewer, admin, returning].map((client) => ({
          client,
          message: { action: "remove", id: "openclaw-approval-exec:native-replay" },
        })),
      );
      await delivery.handleResolved(record);
      expect(sent).toHaveLength(6);
    });
  });

  it("replays the newest 32 eligible approvals without truncating the pending manager", async () => {
    await withRegistry(async ({ registry, connect, sent, replay, stateDir, getConfig }) => {
      const client = await connect(1, { scopes: ["operator.read", "operator.approvals"] });
      const deviceId = expectDefined(client.connect.device?.id, "reviewer device");
      const manager = new ExecApprovalManager();
      const delivery = createApprovalWebPushDelivery({
        getRuntimeConfig: getConfig,
        nativeNotifications: registry,
        stateDir,
      });
      vi.useFakeTimers();
      const records = Array.from({ length: 45 }, (_, index) => {
        const record = manager.create({ command: "echo ok" }, 60_000, `exec:replay-${index}`);
        record.createdAtMs += index;
        // Newer hidden approvals must not consume the returning reviewer's replay budget.
        record.requestedByDeviceId = index < 40 ? deviceId : "another-requester";
        return record;
      });
      try {
        for (const record of records) {
          void manager.register(record, 60_000);
        }
        replay.mockImplementation((recipient: GatewayWsClient) =>
          delivery.replayNative(manager.listPendingRecords(), recipient),
        );
        expect(registry.subscribe(client, true).ok).toBe(true);
        expect(sent).toEqual(
          Array.from({ length: 32 }, (_, index) => ({
            client,
            message: expect.objectContaining({
              action: "show",
              id: `openclaw-approval-exec:replay-${39 - index}`,
              alert: false,
            }),
          })),
        );
        expect(manager.listPendingRecords().map(({ id }) => id)).toEqual(
          records.map(({ id }) => id),
        );
      } finally {
        for (const record of records) {
          manager.resolve(record.id, "deny");
        }
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
      }
    });
  });

  it.each(["invalidated", "replaced"] as const)(
    "does not report approval delivery or retain ownership after the send callback %s its registration",
    async (transition) => {
      await withRegistry(async ({ registry, connect, sent, send, stateDir, getConfig }) => {
        const client = await connect(1);
        registry.subscribe(client, true);
        const manager = new ExecApprovalManager();
        const stale = manager.create({ command: "echo ok" }, 60_000, "exec:stale-native");
        const delivery = createApprovalWebPushDelivery({
          getRuntimeConfig: getConfig,
          nativeNotifications: registry,
          stateDir,
        });
        send.mockImplementationOnce((recipient, message) => {
          sent.push({ client: recipient, message });
          if (transition === "invalidated") {
            recipient.invalidated = true;
          } else {
            registry.subscribe(recipient, true);
          }
        });
        expect(delivery.handleRequested(stale)).toBe(false);
        registry.targets(["operator.read"]);
        client.invalidated = false;
        registry.subscribe(client, true);
        const current = manager.create({ command: "echo ok" }, 60_000, "exec:current-native");
        expect(delivery.handleRequested(current)).toBe(true);
        await delivery.handleResolved(stale);
        expect(sent.filter(({ message }) => message.action === "remove")).toEqual([]);
        await delivery.handleResolved(current);
        expect(sent.filter(({ message }) => message.action === "remove")).toEqual([
          {
            client,
            message: {
              action: "remove",
              id: "openclaw-approval-exec:current-native",
            },
          },
        ]);
      });
    },
  );

  it("enforces existing preference bounds and rejects caller-selected identities at the RPC boundary", async () => {
    await withRegistry(async ({ registry, connect }) => {
      const client = await connect(1, { profile: "alice@example.test" });
      const context = createDirectChatContext({ nativeNotifications: registry });
      const respond = vi.fn();
      const subscribe = expectDefined(
        notificationHandlers["notifications.subscribe"],
        "subscribe handler",
      );
      await subscribe({
        context,
        client,
        params: { enabled: true, deviceId: "other" },
        respond,
        req: {} as never,
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenLastCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expect(registry.targets(["operator.read"])).toEqual([]);
      registry.subscribe(client, true);
      expect(
        registry.setPreferences(client, {
          scope: "device",
          preferences: {
            enabled: true,
            label: "",
            agentIds: Array.from({ length: 40 }, (_, index) => `${index}${"a".repeat(125)}`),
          },
        }),
      ).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST", message: expect.stringContaining("value-too-large") },
      });
      expect(
        registry.setPreferences(client, {
          scope: "device",
          preferences: {
            enabled: true,
            label: "",
            quietHours: {
              enabled: true,
              startMinute: 1,
              endMinute: 2,
              timeZone: "invalid/timezone",
            },
          },
        }),
      ).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
      expect(registry.preferences(client)).toMatchObject({
        ok: true,
        value: { device: { enabled: true, label: "" } },
      });
      client.connect.scopes = ["operator.read"];
      expect(registry.preferences(client)).toMatchObject({
        ok: true,
        value: { canManageUserPreferences: false },
      });
      expect(
        registry.setPreferences(client, {
          scope: "device",
          preferences: { enabled: false, label: "" },
        }),
      ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    });
  });
});
