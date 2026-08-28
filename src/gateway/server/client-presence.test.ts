import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PresenceEntrySchema } from "../../../packages/gateway-protocol/src/schema/snapshot.js";
import {
  listSystemPresence,
  updateSystemPresence,
  upsertPresence,
} from "../../infra/system-presence.js";
import { buildAuthenticatedPresenceUser } from "../authenticated-presence-user.js";
import { recordClientPresenceActivity, refreshClientPresence } from "./client-presence.js";
import { GatewayClientRegistry } from "./client-registry.js";
import { attachGatewayWsConnectionHandler } from "./ws-connection.js";
import {
  attachGatewayWsForTest,
  createGatewayWsTestRequestContext,
} from "./ws-connection.test-helpers.js";
import type { GatewayWsMessageHandlerParams } from "./ws-connection/message-handler.js";
import type { GatewayWsClient } from "./ws-types.js";

const { attachMessageHandler } = vi.hoisted(() => ({
  attachMessageHandler: vi.fn<(params: GatewayWsMessageHandlerParams) => void>(),
}));
vi.mock("./ws-connection/message-handler.js", () => ({
  attachGatewayWsMessageHandler: attachMessageHandler,
}));

describe("live person presence timing", () => {
  it("qualifies presence sender provenance only from an authenticated profile", () => {
    const authenticatedUserId = "same-id";
    const fallback = buildAuthenticatedPresenceUser({ authenticatedUserId });
    expect(fallback).toEqual({ id: authenticatedUserId, email: authenticatedUserId });
    expect(buildAuthenticatedPresenceUser({})).toBeUndefined();
    const profile = buildAuthenticatedPresenceUser({
      authenticatedUserId,
      authenticatedUserProfile: {
        profileId: authenticatedUserId,
        displayName: "Person",
        avatarRevision: "1",
      },
    });
    expect(profile).toMatchObject({
      id: authenticatedUserId,
      identity: { type: "profile", id: authenticatedUserId },
    });
    expect(Value.Check(PresenceEntrySchema, { ts: 1, user: profile })).toBe(true);
    expect(
      Value.Check(PresenceEntrySchema, {
        ts: 1,
        user: {
          ...fallback,
          identity: {
            type: "observation",
            id: authenticatedUserId,
            pluginId: null,
            accountId: null,
            senderKind: "unknown",
          },
        },
      }),
    ).toBe(false);
  });

  const clients = new GatewayClientRegistry();
  const sockets: ReturnType<typeof attachGatewayWsForTest>["socket"][] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2040-01-01T00:00:00Z"));
    attachMessageHandler.mockClear();
  });
  afterEach(() => {
    for (const socket of sockets.splice(0)) {
      socket.readyState = 3;
      socket.emit("close", 1000, Buffer.alloc(0));
    }
    clients.clear();
    vi.setSystemTime(Date.now() + 300_001);
    listSystemPresence();
    vi.useRealTimers();
  });

  async function connect(email: string, profileId = "timing-person") {
    const { socket } = attachGatewayWsForTest({
      attach: attachGatewayWsConnectionHandler,
      clients,
      options: {
        buildRequestContext: () =>
          createGatewayWsTestRequestContext({
            nodeRegistry: { get: vi.fn(() => undefined), unregister: vi.fn(() => null) } as never,
          }) as never,
      },
    });
    sockets.push(socket);
    await vi.dynamicImportSettled();
    const handler = attachMessageHandler.mock.lastCall?.[0];
    if (!handler) {
      throw new Error("message handler was not attached");
    }
    const client: GatewayWsClient = {
      socket: socket as unknown as GatewayWsClient["socket"],
      connId: handler.connId,
      presenceKey: handler.connId,
      usesSharedGatewayAuth: false,
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        role: "operator",
        client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      },
      authenticatedUserId: email,
      authenticatedUserProfile: {
        profileId,
        displayName: "Timing Person",
        avatarRevision: "1",
        hasAvatar: false,
        updatedAt: 1,
      },
    };
    return { client, handler, socket };
  }

  function row(email: string) {
    return listSystemPresence().find((entry) => entry.user?.email === email);
  }

  it("retains the oldest online interval across overlapping sockets but not a full reconnect", async () => {
    const first = await connect("first@timing.test");
    const started = Date.now();
    expect(first.handler.setClient(first.client)).toBe(true);
    expect(row("first@timing.test")).toMatchObject({ onlineSince: started });
    expect(row("first@timing.test")?.lastActivityAt).toBeUndefined();

    vi.setSystemTime(started + 1_000);
    const second = await connect("second@timing.test");
    expect(second.handler.setClient(second.client)).toBe(true);
    expect(recordClientPresenceActivity(clients, second.client)).toBe(true);
    first.socket.readyState = 3;
    first.socket.emit("close", 1000, Buffer.alloc(0));

    vi.setSystemTime(started + 2_000);
    const third = await connect("third@timing.test");
    expect(third.handler.setClient(third.client)).toBe(true);
    expect(row("third@timing.test")).toMatchObject({
      onlineSince: started,
      lastActivityAt: started + 1_000,
    });
    for (const connection of [second, third]) {
      connection.socket.readyState = 3;
      connection.socket.emit("close", 1000, Buffer.alloc(0));
    }
    vi.setSystemTime(started + 3_000);
    const fresh = await connect("fresh@timing.test");
    expect(fresh.handler.setClient(fresh.client)).toBe(true);
    expect(row("fresh@timing.test")).toMatchObject({ onlineSince: started + 3_000 });
    expect(row("fresh@timing.test")?.lastActivityAt).toBeUndefined();
  });

  it("keeps heartbeat freshness and cache eviction independent of person timing", async () => {
    const first = await connect("heartbeat@timing.test", "heartbeat-person");
    const started = Date.now();
    first.handler.setClient(first.client);
    recordClientPresenceActivity(clients, first.client);
    vi.setSystemTime(started + 10_000);
    first.socket.emit("pong");
    updateSystemPresence({
      instanceId: first.client.presenceKey,
      text: "heartbeat",
      lastInputSeconds: 0,
    });
    expect(row("heartbeat@timing.test")).toMatchObject({
      ts: started + 10_000,
      onlineSince: started,
      lastActivityAt: started,
    });

    vi.setSystemTime(started + 20_000);
    for (let index = 0; index < 201; index++) {
      upsertPresence(`timing-eviction-${index}`, { text: "cache pressure" });
    }
    expect(row("heartbeat@timing.test")).toBeUndefined();
    const overlap = await connect("eviction@timing.test", "heartbeat-person");
    overlap.handler.setClient(overlap.client);
    expect(row("eviction@timing.test")).toMatchObject({
      onlineSince: started,
      lastActivityAt: started,
    });

    vi.setSystemTime(started + 400_000);
    expect(row("eviction@timing.test")).toBeUndefined();
    expect(recordClientPresenceActivity(clients, overlap.client)).toBe(true);
    expect(row("eviction@timing.test")).toMatchObject({
      onlineSince: started,
      lastActivityAt: started + 400_000,
    });
  });

  it("keeps delayed identity timing on its accepted socket without reviving closed clients", async () => {
    const delayed = await connect("pending@timing.test", "delayed-person");
    const profile = delayed.client.authenticatedUserProfile;
    delete delayed.client.authenticatedUserProfile;
    delayed.client.authenticatedGitHubIdentitySync = async () => ({
      profileId: "delayed-person",
      updatedAt: 1,
    });
    const started = Date.now();
    delayed.handler.setClient(delayed.client);
    expect(row("pending@timing.test")).toBeUndefined();
    expect(recordClientPresenceActivity(clients, delayed.client)).toBe(false);
    vi.setSystemTime(started + 1_000);
    delayed.client.authenticatedUserProfile = profile;
    refreshClientPresence(clients, delayed.client);
    expect(row("pending@timing.test")).toMatchObject({ onlineSince: started });
    delayed.socket.readyState = 3;
    delayed.socket.emit("close", 1000, Buffer.alloc(0));
    vi.setSystemTime(started + 400_000);
    expect(row("pending@timing.test")).toBeUndefined();
    expect(refreshClientPresence(clients, delayed.client)).toBe(false);
    expect(recordClientPresenceActivity(clients, delayed.client)).toBe(false);
    expect(row("pending@timing.test")).toBeUndefined();
  });

  it("rejects copied, invalidated, closing, and unregistered clients without changing activity", async () => {
    const live = await connect("exact@timing.test", "exact-person");
    live.handler.setClient(live.client);
    expect(recordClientPresenceActivity(clients, { ...live.client })).toBe(false);
    live.client.invalidated = true;
    expect(recordClientPresenceActivity(clients, live.client)).toBe(false);
    live.client.invalidated = false;
    live.socket.readyState = 2;
    expect(recordClientPresenceActivity(clients, live.client)).toBe(false);
    expect(row("exact@timing.test")?.lastActivityAt).toBeUndefined();
    const rejected = await connect("rejected@timing.test");
    rejected.socket.emit("close", 1000, Buffer.alloc(0));
    expect(rejected.handler.setClient(rejected.client)).toBe(false);
    expect(rejected.client.personPresence).toBeUndefined();
    expect(row("rejected@timing.test")).toBeUndefined();
  });

  it.each(["ephemeral", "unidentified", "node"])(
    "does not create person timing for %s clients",
    async (kind) => {
      const connection = await connect(`${kind}@timing.test`);
      if (kind === "ephemeral") {
        delete connection.client.presenceKey;
      } else if (kind === "node") {
        connection.client.connect.role = "node";
      } else {
        delete connection.client.authenticatedUserId;
        delete connection.client.authenticatedUserProfile;
      }
      expect(connection.handler.setClient(connection.client)).toBe(true);
      expect(connection.client.personPresence).toBeUndefined();
      expect(recordClientPresenceActivity(clients, connection.client)).toBe(false);
    },
  );

  it("does not refresh a node's heartbeat or timing when its person is active", async () => {
    const node = await connect("node@timing.test", "node-person");
    node.client.connect.role = "node";
    node.handler.setClient(node.client);
    const nodeHeartbeat = Date.now();
    upsertPresence(node.client.presenceKey!, {
      user: { id: "node-person", email: "node@timing.test" },
    });
    vi.setSystemTime(nodeHeartbeat + 1_000);
    const person = await connect("person@timing.test", "node-person");
    person.handler.setClient(person.client);
    recordClientPresenceActivity(clients, person.client);
    expect(row("node@timing.test")).toMatchObject({ ts: nodeHeartbeat });
    expect(row("node@timing.test")?.onlineSince).toBeUndefined();
    expect(row("node@timing.test")?.lastActivityAt).toBeUndefined();
  });
});
