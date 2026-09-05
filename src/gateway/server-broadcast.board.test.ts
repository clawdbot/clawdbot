import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
} from "../../packages/gateway-protocol/src/client-info.js";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import {
  deleteSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { boardStore } from "./board-store.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import {
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import { createBoardHandlers } from "./server-methods/board.js";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import type { GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { createSessionObserverAudience } from "./session-observer-audience.js";
import {
  canReceiveSessionEvent as canReceiveSessionEventForClient,
  invalidateSessionSharingSnapshot,
  resolveSessionSharingTarget,
} from "./session-sharing.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import { resolveSessionSubscriptionKeys } from "./session-subscription-keys.js";

type RecordingSocket = {
  readyState: number;
  bufferedAmount: number;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  events: string[];
};

function makeClient(
  connId: string,
  role: "node" | "operator",
  scopes: string[],
): { client: GatewayWsClient; socket: RecordingSocket } {
  const events: string[] = [];
  const socket: RecordingSocket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    close: vi.fn(),
    send: vi.fn((payload: string) => {
      events.push((JSON.parse(payload) as { event: string }).event);
    }),
    events,
  };
  return {
    client: {
      socket: socket as unknown as GatewayWsClient["socket"],
      connect: { role, scopes } as GatewayWsClient["connect"],
      connId,
      usesSharedGatewayAuth: false,
    },
    socket,
  };
}

describe("read-capable operator event scope guards", () => {
  it.each(["skills.changed", "users.prefs.changed"] as const)(
    "delivers %s only to read-capable operators",
    (event) => {
      const pairing = makeClient("pairing", "operator", ["operator.pairing"]);
      const node = makeClient("node", "node", ["operator.read"]);
      const read = makeClient("read", "operator", ["operator.read"]);
      const write = makeClient("write", "operator", ["operator.write"]);
      const admin = makeClient("admin", "operator", ["operator.admin"]);
      const clients = new GatewayClientRegistry(
        [pairing, node, read, write, admin].map((entry) => entry.client),
      );
      const { broadcast } = createGatewayBroadcaster({ clients });

      broadcast(
        event,
        event === "users.prefs.changed"
          ? { profileId: "profile-1", keys: ["ui.accent"] }
          : { reason: "remote-node" },
      );

      expect(pairing.socket.events).toEqual([]);
      expect(node.socket.events).toEqual([]);
      expect(read.socket.events).toEqual([event]);
      expect(write.socket.events).toEqual([event]);
      expect(admin.socket.events).toEqual([event]);
    },
  );
});

describe("update run event scope guards", () => {
  it("delivers run identities only to administrators", () => {
    const read = makeClient("read", "operator", ["operator.read"]);
    const admin = makeClient("admin", "operator", ["operator.admin"]);
    const node = makeClient("node", "node", ["operator.admin"]);
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([read.client, admin.client, node.client]),
    });
    broadcast("update.run.changed", {
      runId: "run",
      phase: "staging",
      status: "running",
      updatedAtMs: 1,
    });
    expect(read.socket.events).toEqual([]);
    expect(node.socket.events).toEqual([]);
    expect(admin.socket.events).toEqual(["update.run.changed"]);
  });
});

describe("device setup event scope guards", () => {
  it("delivers exact setup completion only to pairing-capable operators", () => {
    const pairing = makeClient("pairing", "operator", ["operator.pairing"]);
    const node = makeClient("node", "node", ["operator.read"]);
    const read = makeClient("read", "operator", ["operator.read"]);
    const admin = makeClient("admin", "operator", ["operator.admin"]);
    const clients = new GatewayClientRegistry(
      [pairing, node, read, admin].map((entry) => entry.client),
    );
    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("device.pair.setup.completed", {
      setupId: "setup-123",
      deviceId: "device-123",
      access: "limited",
      ts: 1,
    });

    expect(pairing.socket.events).toEqual(["device.pair.setup.completed"]);
    expect(node.socket.events).toEqual([]);
    expect(read.socket.events).toEqual([]);
    expect(admin.socket.events).toEqual(["device.pair.setup.completed"]);
  });
});

describe("board event scope guards", () => {
  it("delivers board events only to read-capable operators", () => {
    const pairing = makeClient("pairing", "operator", ["operator.pairing"]);
    const node = makeClient("node", "node", ["operator.read"]);
    const read = makeClient("read", "operator", ["operator.read"]);
    const write = makeClient("write", "operator", ["operator.write"]);
    const admin = makeClient("admin", "operator", ["operator.admin"]);
    const clients = new GatewayClientRegistry(
      [pairing, node, read, write, admin].map((entry) => entry.client),
    );
    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("board.changed", { sessionKey: "agent:main:main", revision: 1 });
    broadcast("board.command", {
      sessionKey: "agent:main:main",
      command: { kind: "focus_tab", tabId: "main" },
    });

    expect(pairing.socket.events).toEqual([]);
    expect(node.socket.events).toEqual([]);
    expect(read.socket.events).toEqual(["board.changed", "board.command"]);
    expect(write.socket.events).toEqual(["board.changed", "board.command"]);
    expect(admin.socket.events).toEqual(["board.changed", "board.command"]);
  });

  it("applies session visibility filtering from the event payload key", () => {
    const hidden = makeClient("hidden", "operator", ["operator.read"]);
    const visible = makeClient("visible", "operator", ["operator.read"]);
    const canReceiveSessionEvent = vi.fn(
      (client: GatewayWsClient, sessionKeys: readonly string[], agentId?: string) => {
        expect(sessionKeys).toEqual(["global"]);
        expect(agentId).toBe("work");
        return client.connId === "visible";
      },
    );
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([hidden.client, visible.client]),
      canReceiveSessionEvent,
    });

    broadcast("board.changed", {
      request: { sessionKey: "global", agentId: "work" },
      revision: 1,
    });

    expect(hidden.socket.events).toEqual([]);
    expect(visible.socket.events).toEqual(["board.changed"]);
    expect(canReceiveSessionEvent).toHaveBeenCalledTimes(2);
  });
});

describe("board event session ownership", () => {
  it.each(["global", "per-sender"] as const)(
    "delivers board events only to the canonical draft owner in %s mode",
    async (scope) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const cfg: OpenClawConfig = {
          ...rolePolicyConfig(),
          agents: { list: [{ id: "main", default: true }, { id: "work" }] },
          session: { scope },
          tools: { exec: { mode: "ask" } },
        };
        setRuntimeConfigSnapshot(cfg, cfg);
        const targets = [
          { sessionKey: "global", agentId: "work", label: "raw-owner" },
          { sessionKey: "agent:work:global", agentId: "work", label: "ordinary-owner" },
          { sessionKey: "global", agentId: "main", label: "other-agent-owner" },
        ];
        const peers = targets.map(({ label }) => {
          const peer = makeClient(label, "operator", ["operator.read"]);
          Object.assign(peer.client, roleClient("view", label));
          return peer;
        });
        for (const [index, target] of targets.entries()) {
          await upsertSessionEntryCore(target, {
            sessionId: target.label,
            label: target.label,
            updatedAt: 1,
            visibility: "draft",
            createdActor: {
              type: "human",
              source: "profile",
              id: peers[index]!.client.authenticatedUserProfile!.profileId,
            },
          });
        }
        invalidateSessionSharingSnapshot();
        const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({
          clients: new GatewayClientRegistry(peers.map(({ client }) => client)),
          canReceiveSessionEvent: (client, sessionKeys, agentId, event, payload) =>
            canReceiveSessionEventForClient({ cfg, client, sessionKeys, agentId, event, payload }),
        });
        const handlers = createBoardHandlers(boardStore);
        const context = {
          broadcast,
          broadcastToConnIds,
          getRuntimeConfig: () => cfg,
          getSessionEventSubscriberConnIds: () => new Set(peers.map(({ client }) => client.connId)),
          chatAbortControllers: new Map(),
          resolveGatewayContext: (): GatewayRequestContext => context,
        } as unknown as GatewayRequestContext;
        const invoke = async (method: string, params: Record<string, unknown>) => {
          const respond = vi.fn<RespondFn>();
          await handlers[method]!({
            req: { type: "req", id: "event-owner", method, params },
            params,
            client: peers[0]!.client,
            isWebchatConnect: () => false,
            respond,
            context,
          });
          flushPendingSessionsChangedEvents(context);
          expect(respond.mock.calls[0]?.[0]).toBe(true);
          return peers.map(({ socket }) => {
            const frames = socket.send.mock.calls.map(([frame]) => JSON.parse(String(frame)));
            socket.send.mockClear();
            return frames.map(({ event, payload }) => ({ event, payload }));
          });
        };
        const target = { sessionKey: "global", agentId: "work" };
        const rawUpdate = await invoke("board.update", {
          ...target,
          ops: [{ kind: "tab_create", tabId: "notes", title: "Notes" }],
        });
        const rawPut = await invoke("board.widget.put", {
          ...target,
          name: "status",
          content: { kind: "html", html: "<p>Working</p>" },
          declared: { tools: ["status.refresh"] },
        });
        const widget = boardStore.getSnapshot(target).widgets[0]!;
        const rawGrant = await invoke("board.widget.grant", {
          ...target,
          name: "status",
          decision: "granted",
          revision: widget.revision,
          instanceId: widget.instanceId,
        });
        const emptyUpdate = await invoke("board.update", { ...target, ops: [] });
        const ordinaryUpdate = await invoke("board.update", {
          sessionKey: "agent:work:global",
          ops: [{ kind: "tab_create", tabId: "ordinary", title: "Ordinary" }],
        });
        const otherAgentUpdate = await invoke("board.update", {
          sessionKey: "global",
          agentId: "main",
          ops: [{ kind: "tab_create", tabId: "main-notes", title: "Main notes" }],
        });
        expect(boardStore.getSnapshot(target)).toMatchObject({
          sessionKey: "global",
          revision: 3,
          widgets: [{ name: "status", grantState: "granted" }],
        });
        const changed = (agentId: string, revision: number, widgetName?: string) => ({
          event: "board.changed",
          payload: {
            sessionKey: `agent:${agentId}:global`,
            revision,
            ...(widgetName ? { widget: widgetName } : {}),
          },
        });
        const sessionChanged = (sessionKey: string, agentId: string, label: string) => ({
          event: "sessions.changed",
          payload: expect.objectContaining({
            sessionKey,
            agentId,
            sessionId: label,
            label,
            reason: "board",
          }),
        });
        const rawSession = sessionChanged("global", "work", "raw-owner");
        expect({
          rawUpdate,
          rawPut,
          rawGrant,
          emptyUpdate,
          ordinaryUpdate,
          otherAgentUpdate,
        }).toEqual({
          rawUpdate: [[rawSession, changed("work", 1)], [], []],
          rawPut: [[rawSession, changed("work", 2, "status")], [], []],
          rawGrant: [[changed("work", 3)], [], []],
          emptyUpdate: [[], [], []],
          ordinaryUpdate: [
            [],
            [sessionChanged("agent:work:global", "work", "ordinary-owner"), changed("work", 1)],
            [],
          ],
          otherAgentUpdate: [
            [],
            [],
            [sessionChanged("global", "main", "other-agent-owner"), changed("main", 1)],
          ],
        });
      });
    },
  );
});

describe("collaboration event scope guards", () => {
  it("revalidates an authoritative session-generation creator replacement before socket I/O", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:draft-owner-filter";
      const ownerActor = {
        type: "human" as const,
        source: "profile" as const,
        id: "profile-owner",
      };
      const successorActor = {
        type: "human" as const,
        source: "profile" as const,
        id: "profile-successor",
      };
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-draft-owner-filter",
          updatedAt: 1,
          visibility: "draft",
          createdActor: ownerActor,
        },
      );
      const owner = makeClient("owner", "operator", ["operator.read"]);
      const successor = makeClient("successor", "operator", ["operator.read"]);
      for (const [entry, actor] of [
        [owner, ownerActor],
        [successor, successorActor],
      ] as const) {
        entry.client.authenticatedUserId = actor.id;
        entry.client.authenticatedUserProfile = {
          profileId: actor.id,
          displayName: null,
          hasAvatar: false,
          avatarRevision: "1",
          updatedAt: 1,
        };
      }
      const cfg: OpenClawConfig = {};
      const filter = vi.fn(
        (
          client: GatewayWsClient,
          sessionKeys: readonly string[],
          agentId?: string,
          event?: string,
          payload?: unknown,
        ) => canReceiveSessionEventForClient({ cfg, client, sessionKeys, agentId, event, payload }),
      );
      const { broadcastToConnIds } = createGatewayBroadcaster({
        clients: new GatewayClientRegistry([owner.client, successor.client]),
        canReceiveSessionEvent: filter,
      });
      const broadcast = () =>
        broadcastToConnIds(
          "sessions.changed",
          { sessionKey, agentId: "main", reason: "updated" },
          new Set([owner.client.connId, successor.client.connId]),
          { agentId: "main", sessionKeys: [sessionKey] },
        );

      broadcast();

      expect(owner.socket.send).toHaveBeenCalledOnce();
      expect(successor.socket.send).not.toHaveBeenCalled();
      expect(filter.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER).toBeLessThan(
        owner.socket.send.mock.invocationCallOrder[0] ?? -1,
      );
      expect(JSON.parse(String(owner.socket.send.mock.calls[0]?.[0]))).toMatchObject({
        event: "sessions.changed",
        payload: { sessionKey, agentId: "main", reason: "updated" },
      });

      const target = resolveSessionSharingTarget({ cfg, sessionKey, agentId: "main" });
      if (!target) {
        throw new Error("expected the persisted draft session target");
      }
      await expect(
        deleteSessionEntryLifecycle({
          agentId: target.agentId,
          archiveTranscript: false,
          expectedSessionId: "session-draft-owner-filter",
          storePath: target.storePath,
          target: { canonicalKey: target.canonicalKey, storeKeys: target.storeKeys },
        }),
      ).resolves.toMatchObject({ deleted: true });
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-draft-successor-filter",
          updatedAt: 2,
          visibility: "draft",
          createdActor: successorActor,
        },
      );
      invalidateSessionSharingSnapshot(sessionKey);
      owner.socket.send.mockClear();
      successor.socket.send.mockClear();
      owner.socket.events.length = 0;
      successor.socket.events.length = 0;
      filter.mockClear();

      broadcast();

      expect(owner.socket.send).not.toHaveBeenCalled();
      expect(successor.socket.send).toHaveBeenCalledOnce();
      expect(filter.mock.invocationCallOrder.at(-1) ?? Number.MAX_SAFE_INTEGER).toBeLessThan(
        successor.socket.send.mock.invocationCallOrder[0] ?? -1,
      );
      expect(JSON.parse(String(successor.socket.send.mock.calls[0]?.[0]))).toMatchObject({
        event: "sessions.changed",
        payload: { sessionKey, agentId: "main", reason: "updated" },
      });
    });
  });

  it("uses the payload session scope for observer subscription filtering", () => {
    const subscribed = makeClient("subscribed", "operator", ["operator.read"]);
    const otherSession = makeClient("other-session", "operator", ["operator.read"]);
    const unsubscribed = makeClient("unsubscribed", "operator", ["operator.read"]);
    for (const entry of [subscribed, otherSession, unsubscribed]) {
      entry.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
    }
    const sessionMessageSubscribers = createSessionMessageSubscriberRegistry();
    sessionMessageSubscribers.subscribe(subscribed.client.connId, "agent:main:main");
    sessionMessageSubscribers.subscribe(otherSession.client.connId, "agent:main:other");
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([
        subscribed.client,
        otherSession.client,
        unsubscribed.client,
      ]),
      sessionMessageSubscribers,
    });

    broadcast(
      "session.observer",
      { sessionKey: "agent:main:main", revision: 1 },
      { dropIfSlow: true },
    );

    expect(subscribed.socket.events).toEqual(["session.observer"]);
    expect(otherSession.socket.events).toEqual([]);
    expect(unsubscribed.socket.events).toEqual([]);
  });

  it("prepares session subscription lookups once per ordinary broadcast", () => {
    const first = makeClient("first", "operator", ["operator.read"]);
    const second = makeClient("second", "operator", ["operator.read"]);
    const unrelated = makeClient("unrelated", "operator", ["operator.read"]);
    const legacy = makeClient("legacy", "operator", ["operator.read"]);
    for (const entry of [first, second, unrelated]) {
      entry.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
    }
    const subscribers = createSessionMessageSubscriberRegistry();
    subscribers.subscribe(first.client.connId, "session-a");
    subscribers.subscribe(second.client.connId, "session-a");
    const getSubscribers = vi.spyOn(subscribers, "get");
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([
        first.client,
        second.client,
        unrelated.client,
        legacy.client,
      ]),
      sessionMessageSubscribers: subscribers,
    });

    broadcast("chat", { sessionKey: "session-a", state: "delta" });

    expect(getSubscribers).toHaveBeenCalledExactlyOnceWith("session-a");
    expect(first.socket.events).toEqual(["chat"]);
    expect(second.socket.events).toEqual(["chat"]);
    expect(unrelated.socket.events).toEqual([]);
    expect(legacy.socket.events).toEqual(["chat"]);
  });

  it("suppresses session.tool mirrors for scoped clients without a matching subscription", () => {
    const subscribed = makeClient("subscribed", "operator", ["operator.read"]);
    const otherSession = makeClient("other-session", "operator", ["operator.read"]);
    const unscoped = makeClient("unscoped", "operator", ["operator.read"]);
    for (const entry of [subscribed, otherSession]) {
      entry.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
    }
    const sessionMessageSubscribers = createSessionMessageSubscriberRegistry();
    sessionMessageSubscribers.subscribe(subscribed.client.connId, "agent:main:main");
    sessionMessageSubscribers.subscribe(otherSession.client.connId, "agent:main:other");
    const { broadcastToConnIds } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([subscribed.client, otherSession.client, unscoped.client]),
      sessionMessageSubscribers,
    });

    // Mirrors the server-chat session.tool fanout: targeted at all session
    // subscribers, session identity carried in the payload.
    broadcastToConnIds(
      "session.tool",
      { sessionKey: "agent:main:main", tool: { name: "exec", args: { command: "ls" } } },
      new Set(["subscribed", "other-session", "unscoped"]),
      { dropIfSlow: true },
    );

    expect(subscribed.socket.events).toEqual(["session.tool"]);
    // The scoped client subscribed to a different session must not receive
    // another session's tool args via the mirror event.
    expect(otherSession.socket.events).toEqual([]);
    // Unscoped Control UI clients keep full fanout.
    expect(unscoped.socket.events).toEqual(["session.tool"]);
  });

  it("delivers prepared global observer audiences exactly once", () => {
    const main = makeClient("main", "operator", ["operator.read"]);
    const legacy = makeClient("legacy", "operator", ["operator.read"]);
    const both = makeClient("both", "operator", ["operator.read"]);
    const work = makeClient("work", "operator", ["operator.read"]);
    const workRaw = makeClient("work-raw", "operator", ["operator.read"]);
    for (const entry of [main, legacy, both, work, workRaw]) {
      entry.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
    }
    const subscribers = createSessionMessageSubscriberRegistry();
    subscribers.subscribe(main.client.connId, "agent:main:global");
    subscribers.subscribe(legacy.client.connId, "global");
    subscribers.subscribe(both.client.connId, "agent:main:global");
    subscribers.subscribe(both.client.connId, "global");
    subscribers.subscribe(work.client.connId, "agent:work:global");
    subscribers.subscribe(workRaw.client.connId, "global");
    const audience = createSessionObserverAudience({
      subscribers,
      isVisible: () => true,
      getConfig: () =>
        ({ agents: { list: [{ id: "main", default: true }, { id: "work" }] } }) as OpenClawConfig,
    });
    const { broadcastToConnIds } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([
        main.client,
        legacy.client,
        both.client,
        work.client,
        workRaw.client,
      ]),
      sessionMessageSubscribers: subscribers,
    });

    for (const agentId of ["main", "work"]) {
      const sessionKeys = resolveSessionSubscriptionKeys(" GLOBAL ", agentId, "MAIN");
      const recipients = audience.recipients("global", agentId);
      broadcastToConnIds("session.observer", { sessionKey: "global", agentId }, recipients, {
        sessionKeys,
        agentId,
      });
    }

    expect(main.socket.events).toEqual(["session.observer"]);
    expect(legacy.socket.events).toEqual(["session.observer"]);
    expect(both.socket.events).toEqual(["session.observer"]);
    expect(work.socket.events).toEqual(["session.observer"]);
    expect(workRaw.socket.events).toEqual(["session.observer"]);
  });

  it("preserves event-only recipients selected by the critical observer audience", () => {
    const message = makeClient("message", "operator", ["operator.read"]);
    const eventOnly = makeClient("event-only", "operator", ["operator.read"]);
    const unrelated = makeClient("unrelated", "operator", ["operator.read"]);
    for (const entry of [message, eventOnly, unrelated]) {
      entry.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
    }
    const subscribers = createSessionMessageSubscriberRegistry();
    const sessionEventSubscribers = createSessionEventSubscriberRegistry();
    subscribers.subscribe(message.client.connId, "agent:main:global");
    sessionEventSubscribers.subscribe(eventOnly.client.connId);
    const audience = createSessionObserverAudience({
      subscribers,
      sessionEventSubscribers,
      isVisible: () => true,
      getConfig: () =>
        ({ agents: { list: [{ id: "main", default: true }, { id: "work" }] } }) as OpenClawConfig,
    });
    const { broadcastToConnIds } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([message.client, eventOnly.client, unrelated.client]),
      sessionMessageSubscribers: subscribers,
    });

    const recipients = audience.criticalRecipients("global", "main");
    broadcastToConnIds(
      "session.observer",
      { sessionKey: "global", agentId: "main" },
      recipients,
      audience.deliveryOptions("global", "main"),
    );

    expect(message.socket.events).toEqual(["session.observer"]);
    expect(eventOnly.socket.events).toEqual(["session.observer"]);
    expect(unrelated.socket.events).toEqual([]);
  });

  it.each(["agent", "chat", "chat.side_result"])(
    "keeps global %s events scoped to their owning agent",
    (event) => {
      const work = makeClient("work", "operator", ["operator.read"]);
      const main = makeClient("main", "operator", ["operator.read"]);
      const bareGlobal = makeClient("bare-global", "operator", ["operator.read"]);
      for (const entry of [work, main, bareGlobal]) {
        entry.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
      }
      const subscribers = createSessionMessageSubscriberRegistry();
      subscribers.subscribe(work.client.connId, "agent:work:global");
      subscribers.subscribe(main.client.connId, "agent:main:global");
      subscribers.subscribe(bareGlobal.client.connId, "global");
      const { broadcast } = createGatewayBroadcaster({
        clients: new GatewayClientRegistry([work.client, main.client, bareGlobal.client]),
        sessionMessageSubscribers: subscribers,
      });

      broadcast(
        event,
        { sessionKey: "global", agentId: "work" },
        {
          sessionKeys: resolveSessionSubscriptionKeys("global", "work", "main"),
          agentId: "work",
        },
      );

      expect(work.socket.events).toEqual([event]);
      expect(main.socket.events).toEqual([]);
      expect(bareGlobal.socket.events).toEqual([]);
    },
  );

  it("subscription-gates Browser Copilot without relying on the capability bit", () => {
    const subscribed = makeClient("subscribed", "operator", ["operator.read"]);
    const unrelated = makeClient("unrelated", "operator", ["operator.read"]);
    for (const entry of [subscribed, unrelated]) {
      entry.client.connect.client = { id: GATEWAY_CLIENT_IDS.BROWSER_COPILOT } as never;
      entry.client.connect.caps = [];
    }
    const subscribers = createSessionMessageSubscriberRegistry();
    subscribers.subscribe(subscribed.client.connId, "agent:work:global");
    subscribers.subscribe(unrelated.client.connId, "agent:other:global");
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([subscribed.client, unrelated.client]),
      sessionMessageSubscribers: subscribers,
    });

    broadcast(
      "chat",
      { sessionKey: "global", agentId: "work" },
      {
        sessionKeys: ["agent:work:global"],
        agentId: "work",
      },
    );

    expect(subscribed.socket.events).toEqual(["chat"]);
    expect(unrelated.socket.events).toEqual([]);
  });

  it.each([
    { sessionKey: "agent:work:global", agentId: "work" },
    { sessionKey: "agent:work:other", agentId: "work" },
    { sessionKey: "global", agentId: undefined },
  ])("preserves exact subscription keys for $sessionKey", ({ sessionKey, agentId }) => {
    const subscribed = makeClient("subscribed", "operator", ["operator.read"]);
    const unrelated = makeClient("unrelated", "operator", ["operator.read"]);
    subscribed.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
    unrelated.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
    const subscribers = createSessionMessageSubscriberRegistry();
    subscribers.subscribe(subscribed.client.connId, sessionKey);
    subscribers.subscribe(unrelated.client.connId, "agent:other:global");
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([subscribed.client, unrelated.client]),
      sessionMessageSubscribers: subscribers,
    });

    broadcast("chat", { sessionKey, ...(agentId ? { agentId } : {}) });

    expect(subscribed.socket.events).toEqual(["chat"]);
    expect(unrelated.socket.events).toEqual([]);
  });

  it("guards suggestion and typing events and forwards payloads to visibility filtering", () => {
    const pairing = makeClient("pairing", "operator", ["operator.pairing"]);
    const reader = makeClient("reader", "operator", ["operator.read"]);
    const unrelated = makeClient("unrelated", "operator", ["operator.read"]);
    const sessionMessageSubscribers = createSessionMessageSubscriberRegistry();
    sessionMessageSubscribers.subscribe("reader", "agent:main:main");
    const canReceiveSessionEvent = vi.fn(
      (
        _client: GatewayWsClient,
        sessionKeys: readonly string[],
        agentId: string | undefined,
        event: string | undefined,
        payload: unknown,
      ) => {
        expect(sessionKeys).toEqual(["agent:main:main"]);
        expect(agentId).toBe("main");
        expect(payload).toBeDefined();
        return event === "session.typing";
      },
    );
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([pairing.client, reader.client, unrelated.client]),
      canReceiveSessionEvent,
      sessionMessageSubscribers,
    });

    broadcast("session.suggestion", {
      suggestion: { sessionKey: "agent:main:main", agentId: "main" },
    });
    broadcast(
      "session.typing",
      {
        sessionKey: "agent:main:main",
        agentId: "main",
        typing: true,
      },
      { sessionKeys: ["agent:main:main"], agentId: "main" },
    );

    expect(pairing.socket.events).toEqual([]);
    expect(reader.socket.events).toEqual(["session.typing"]);
    expect(unrelated.socket.events).toEqual([]);
    expect(canReceiveSessionEvent).toHaveBeenCalledTimes(4);
  });
});
