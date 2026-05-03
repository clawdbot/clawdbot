import { EventEmitter } from "node:events";
import {
  GatewayCloseCodes,
  GatewayDispatchEvents,
  GatewayIntentBits,
  GatewayOpcodes,
  InteractionType,
  PresenceUpdateStatus,
  type GatewaySendPayload,
} from "discord-api-types/v10";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sharedGatewayIdentifyLimiter } from "./gateway-identify-limiter.js";
import { GatewayPlugin } from "./gateway.js";

function attachOpenSocket(gateway: GatewayPlugin) {
  const send = vi.fn();
  (gateway as unknown as { ws: unknown }).ws = {
    readyState: 1,
    send,
  };
  return send;
}

function presenceUpdate(
  status: PresenceUpdateStatus.Online | PresenceUpdateStatus.Idle = PresenceUpdateStatus.Online,
): GatewaySendPayload {
  return {
    op: GatewayOpcodes.PresenceUpdate,
    d: {
      since: null,
      activities: [],
      status,
      afk: false,
    },
  };
}

class FakeSocket extends EventEmitter {
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
}

class TestGatewayPlugin extends GatewayPlugin {
  sockets: FakeSocket[] = [];
  connectCalls: boolean[] = [];

  connect(resume = false): void {
    this.connectCalls.push(resume);
    super.connect(resume);
  }

  protected createWebSocket(): never {
    const socket = new FakeSocket();
    this.sockets.push(socket);
    return socket as never;
  }
}

type GatewaySessionState = {
  sessionId: string | null;
  resumeGatewayUrl: string | null;
  sequence: number | null;
};

function gatewaySessionState(gateway: GatewayPlugin): GatewaySessionState {
  return gateway as unknown as GatewaySessionState;
}

describe("GatewayPlugin", () => {
  afterEach(() => {
    vi.useRealTimers();
    sharedGatewayIdentifyLimiter.reset();
  });

  it("does not auto-handle interactions when autoInteractions is disabled", async () => {
    const gateway = new GatewayPlugin({ autoInteractions: false });
    const handleInteraction = vi.fn(async () => {});
    const dispatchGatewayEvent = vi.fn(async () => {
      await handleInteraction();
    });
    (gateway as unknown as { client: unknown }).client = {
      dispatchGatewayEvent,
      handleInteraction,
    };

    await (
      gateway as unknown as {
        handleDispatch(payload: { t: string; d: unknown }): Promise<void>;
      }
    ).handleDispatch({
      t: GatewayDispatchEvents.InteractionCreate,
      d: { id: "interaction-1", type: InteractionType.MessageComponent },
    });

    expect(dispatchGatewayEvent).toHaveBeenCalledTimes(1);
    expect(handleInteraction).toHaveBeenCalledTimes(1);
  });

  it("emits async dispatch failures as gateway errors", async () => {
    const gateway = new GatewayPlugin({ autoInteractions: false });
    const error = new Error("listener failed");
    (gateway as unknown as { client: unknown }).client = {
      dispatchGatewayEvent: async () => {
        throw error;
      },
    };
    const errorSpy = vi.fn();
    gateway.emitter.on("error", errorSpy);

    (
      gateway as unknown as {
        handlePayload(
          payload: { op: number; t?: string; s?: number; d: unknown },
          resume: boolean,
        ): void;
      }
    ).handlePayload(
      {
        op: GatewayOpcodes.Dispatch,
        t: GatewayDispatchEvents.MessageCreate,
        s: 1,
        d: { id: "m1", channel_id: "c1", author: { id: "u1", username: "user" } },
      },
      false,
    );

    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith(error));
  });

  it("reconnects when the socket closes while waiting for identify concurrency", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    await sharedGatewayIdentifyLimiter.wait({ shardId: 0, maxConcurrency: 1 });
    const gateway = new TestGatewayPlugin({
      autoInteractions: false,
      url: "wss://gateway.example.test",
    });
    const errorSpy = vi.fn();
    gateway.emitter.on("error", errorSpy);

    gateway.connect(false);
    const socket = gateway.sockets[0];
    socket?.emit("open");
    socket?.emit(
      "message",
      JSON.stringify({
        op: GatewayOpcodes.Hello,
        d: { heartbeat_interval: 45_000 },
        s: null,
      }),
    );
    if (socket) {
      socket.readyState = 3;
    }

    await vi.advanceTimersByTimeAsync(5_000);
    expect(errorSpy).toHaveBeenCalledWith(
      new Error("Discord gateway socket closed before IDENTIFY could be sent"),
    );
    await vi.advanceTimersByTimeAsync(2_000);

    expect(gateway.connectCalls).toEqual([false, false]);
    expect(gateway.sockets).toHaveLength(2);
  });

  it("preserves MESSAGE_CREATE author payloads for inbound dispatch", async () => {
    const gateway = new GatewayPlugin({ autoInteractions: false });
    const dispatchGatewayEvent = vi.fn(async (_event: string, _data: unknown) => {});
    (gateway as unknown as { client: unknown }).client = {
      dispatchGatewayEvent,
    };

    await (
      gateway as unknown as {
        handleDispatch(payload: { t: string; d: unknown }): Promise<void>;
      }
    ).handleDispatch({
      t: GatewayDispatchEvents.MessageCreate,
      d: {
        id: "m1",
        channel_id: "c1",
        content: "hello",
        attachments: [],
        timestamp: new Date().toISOString(),
        author: { id: "u1", username: "user", discriminator: "0", avatar: null },
        type: 0,
        tts: false,
        mention_everyone: false,
        pinned: false,
        flags: 0,
      },
    });

    expect(dispatchGatewayEvent).toHaveBeenCalledTimes(1);
    const dispatched = dispatchGatewayEvent.mock.calls[0]?.[1] as {
      author?: { id: string };
      message?: { author?: { id: string } | null; content?: string };
    };
    expect(dispatched.author?.id).toBe("u1");
    expect(dispatched.message?.author?.id).toBe("u1");
    expect(dispatched.message?.content).toBe("hello");
  });

  it("marks successful gateway resumes connected", async () => {
    const gateway = new GatewayPlugin({ autoInteractions: false });
    (gateway as unknown as { client: unknown }).client = {
      dispatchGatewayEvent: vi.fn(async () => {}),
    };
    gateway.isConnected = false;
    (gateway as unknown as { reconnectAttempts: number }).reconnectAttempts = 7;

    await (
      gateway as unknown as {
        handleDispatch(payload: { t: string; d: unknown }): Promise<void>;
      }
    ).handleDispatch({
      t: GatewayDispatchEvents.Resumed,
      d: {},
    });

    expect(gateway.isConnected).toBe(true);
    expect((gateway as unknown as { reconnectAttempts: number }).reconnectAttempts).toBe(0);
  });

  it("queues outbound gateway events when the connection window is exhausted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const gateway = new GatewayPlugin({ autoInteractions: false });
    const send = attachOpenSocket(gateway);

    for (let index = 0; index < 120; index += 1) {
      gateway.send(presenceUpdate());
    }
    gateway.send(presenceUpdate(PresenceUpdateStatus.Idle));

    expect(send).toHaveBeenCalledTimes(120);
    expect(gateway.getRateLimitStatus()).toEqual(
      expect.objectContaining({ remainingEvents: 0, currentEventCount: 120, queuedEvents: 1 }),
    );

    vi.advanceTimersByTime(59_999);
    expect(send).toHaveBeenCalledTimes(120);

    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(121);
    expect(gateway.getRateLimitStatus()).toEqual(
      expect.objectContaining({ currentEventCount: 1, queuedEvents: 0 }),
    );
  });

  it("sends critical gateway events immediately even when regular sends are queued", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const gateway = new GatewayPlugin({ autoInteractions: false });
    const send = attachOpenSocket(gateway);

    for (let index = 0; index < 120; index += 1) {
      gateway.send(presenceUpdate());
    }
    gateway.send(presenceUpdate(PresenceUpdateStatus.Idle));
    gateway.send({ op: GatewayOpcodes.Heartbeat, d: 1 }, true);

    expect(send).toHaveBeenCalledTimes(121);
    expect(JSON.parse(send.mock.calls.at(-1)?.[0] as string)).toEqual({
      op: GatewayOpcodes.Heartbeat,
      d: 1,
    });
    expect(gateway.getRateLimitStatus()).toEqual(
      expect.objectContaining({ remainingEvents: 0, queuedEvents: 1 }),
    );
  });

  it("rejects gateway payloads that exceed Discord's size limit", () => {
    const gateway = new GatewayPlugin({ autoInteractions: false });
    const send = attachOpenSocket(gateway);

    expect(() =>
      gateway.send({
        op: GatewayOpcodes.PresenceUpdate,
        d: {
          since: null,
          activities: [
            {
              name: "x".repeat(4_100),
              type: 0,
            },
          ],
          status: PresenceUpdateStatus.Online,
          afk: false,
        },
      } as GatewaySendPayload),
    ).toThrow(/4096-byte limit/);
    expect(send).not.toHaveBeenCalled();
  });

  it("ignores stale socket close events after reconnecting", () => {
    const gateway = new TestGatewayPlugin({
      autoInteractions: false,
      url: "wss://gateway.example.test",
    });

    gateway.connect(false);
    const oldSocket = gateway.sockets[0];
    oldSocket.emit("open");
    gateway.connect(false);
    const heartbeat = setInterval(() => {}, 1_000);
    gateway.heartbeatInterval = heartbeat;
    gateway.isConnected = true;

    oldSocket.emit("close", 1006);

    expect(gateway.isConnected).toBe(true);
    expect(gateway.heartbeatInterval).toBe(heartbeat);
    clearInterval(heartbeat);
  });

  it("reconnects after active remote normal closes", async () => {
    vi.useFakeTimers();
    const gateway = new TestGatewayPlugin({
      autoInteractions: false,
      url: "wss://gateway.example.test",
    });

    gateway.connect(false);
    gateway.sockets[0]?.emit("open");
    gateway.sockets[0]?.emit("close", 1000);

    expect(gateway.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(gateway.connectCalls).toEqual([false, true]);
    expect(gateway.sockets).toHaveLength(2);
  });

  it.each([GatewayCloseCodes.InvalidSeq, GatewayCloseCodes.AlreadyAuthenticated])(
    "re-identifies after non-resumable gateway close %s",
    async (closeCode) => {
      vi.useFakeTimers();
      const gateway = new TestGatewayPlugin({
        autoInteractions: false,
        url: "wss://gateway.example.test",
      });

      gateway.connect(false);
      gateway.sockets[0]?.emit("open");
      gateway.sockets[0]?.emit("close", closeCode);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(gateway.connectCalls).toEqual([false, false]);
      expect(gateway.sockets).toHaveLength(2);
    },
  );

  it("clears resume state after invalid session false", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const gateway = new TestGatewayPlugin({
      autoInteractions: false,
      url: "wss://gateway.example.test",
    });
    const sessionState = gatewaySessionState(gateway);
    sessionState.sessionId = "session1";
    sessionState.resumeGatewayUrl = "wss://resume.example.test";
    sessionState.sequence = 123;

    gateway.connect(false);
    gateway.sockets[0]?.emit("open");
    (
      gateway as unknown as {
        handlePayload(payload: { op: number; d: unknown }, resume: boolean): void;
      }
    ).handlePayload({ op: GatewayOpcodes.InvalidSession, d: false }, true);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(gateway.connectCalls).toEqual([false, false]);
    expect(sessionState.sessionId).toBeNull();
    expect(sessionState.resumeGatewayUrl).toBeNull();
    expect(sessionState.sequence).toBeNull();
  });

  it("delays invalid-session reconnects by Discord's randomized cooldown floor", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.75);
    const gateway = new TestGatewayPlugin({
      autoInteractions: false,
      url: "wss://gateway.example.test",
    });

    gateway.connect(false);
    gateway.sockets[0]?.emit("open");
    (
      gateway as unknown as {
        handlePayload(payload: { op: number; d: unknown }, resume: boolean): void;
      }
    ).handlePayload({ op: GatewayOpcodes.InvalidSession, d: true }, true);

    await vi.advanceTimersByTimeAsync(3_999);
    expect(gateway.connectCalls).toEqual([false]);

    await vi.advanceTimersByTimeAsync(1);
    expect(gateway.connectCalls).toEqual([false, true]);
  });

  it("includes close code details when reconnect attempts are exhausted", async () => {
    vi.useFakeTimers();
    const gateway = new TestGatewayPlugin({
      autoInteractions: false,
      reconnect: { maxAttempts: 0 },
      url: "wss://gateway.example.test",
    });
    const errorSpy = vi.fn();
    gateway.emitter.on("error", errorSpy);

    gateway.connect(false);
    gateway.sockets[0]?.emit("open");
    gateway.sockets[0]?.emit("close", 1006);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(errorSpy).toHaveBeenCalledWith(
      new Error("Max reconnect attempts (0) reached after close code 1006"),
    );
    expect(gateway.connectCalls).toEqual([false]);
    expect(gateway.sockets).toHaveLength(1);
  });

  it("does not reconnect after fatal gateway closes", async () => {
    vi.useFakeTimers();
    const gateway = new TestGatewayPlugin({
      autoInteractions: false,
      url: "wss://gateway.example.test",
    });
    const errorSpy = vi.fn();
    gateway.emitter.on("error", errorSpy);

    gateway.connect(false);
    gateway.sockets[0]?.emit("open");
    gateway.sockets[0]?.emit("close", GatewayCloseCodes.InvalidIntents);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(errorSpy).toHaveBeenCalledWith(new Error("Fatal gateway close code: 4013"));
    expect(gateway.connectCalls).toEqual([false]);
    expect(gateway.sockets).toHaveLength(1);
  });

  it("clears heartbeat timers before delayed reconnects", () => {
    vi.useFakeTimers();
    const gateway = new GatewayPlugin({
      autoInteractions: false,
      url: "wss://gateway.example.test",
    });
    const send = vi.fn();
    const close = vi.fn();
    gateway.ws = {
      readyState: 1,
      send,
      close,
    } as unknown as GatewayPlugin["ws"];
    const firstHeartbeatTimeout = setTimeout(() => {
      (
        gateway as unknown as {
          sendHeartbeat(): void;
        }
      ).sendHeartbeat();
    }, 10);
    const heartbeatInterval = setInterval(() => {
      (
        gateway as unknown as {
          sendHeartbeat(): void;
        }
      ).sendHeartbeat();
    }, 10);
    gateway.firstHeartbeatTimeout = firstHeartbeatTimeout;
    gateway.heartbeatInterval = heartbeatInterval;
    (gateway as unknown as { shouldReconnect: boolean }).shouldReconnect = true;

    (
      gateway as unknown as {
        handlePayload(payload: { op: number; d: unknown }, resume: boolean): void;
      }
    ).handlePayload({ op: GatewayOpcodes.Reconnect, d: null }, false);

    expect(close).toHaveBeenCalledTimes(1);
    expect(gateway.ws).toBeNull();
    expect(gateway.firstHeartbeatTimeout).toBeUndefined();
    expect(gateway.heartbeatInterval).toBeUndefined();
    expect(() => vi.advanceTimersByTime(20)).not.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(() =>
      (
        gateway as unknown as {
          sendHeartbeat(): void;
        }
      ).sendHeartbeat(),
    ).not.toThrow();
  });

  it("clears stale heartbeat timers before early reconnect exits", () => {
    vi.useFakeTimers();
    const gateway = new GatewayPlugin({
      autoInteractions: false,
      url: "wss://gateway.example.test",
    });
    (gateway as unknown as { isConnecting: boolean }).isConnecting = true;
    gateway.heartbeatInterval = setInterval(() => {}, 1_000);
    gateway.firstHeartbeatTimeout = setTimeout(() => {}, 1_000);

    gateway.connect(true);

    expect(gateway.heartbeatInterval).toBeUndefined();
    expect(gateway.firstHeartbeatTimeout).toBeUndefined();
  });

  it("spaces identify sends by gateway max concurrency bucket", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const first = new GatewayPlugin(
      { autoInteractions: false, shard: [0, 2] },
      {
        url: "wss://gateway.discord.gg/",
        shards: 2,
        session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 },
      },
    );
    const second = new GatewayPlugin(
      { autoInteractions: false, shard: [1, 2] },
      {
        url: "wss://gateway.discord.gg/",
        shards: 2,
        session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 },
      },
    );
    (first as unknown as { client: unknown }).client = { options: { token: "token" } };
    (second as unknown as { client: unknown }).client = { options: { token: "token" } };
    const firstSend = attachOpenSocket(first);
    const secondSend = attachOpenSocket(second);

    for (const gateway of [first, second]) {
      (
        gateway as unknown as {
          handlePayload(payload: { op: number; d: unknown }, resume: boolean): void;
        }
      ).handlePayload({ op: GatewayOpcodes.Hello, d: { heartbeat_interval: 45_000 } }, false);
    }

    await vi.advanceTimersByTimeAsync(0);
    expect(firstSend).toHaveBeenCalledWith(
      expect.stringContaining(`"op":${GatewayOpcodes.Identify}`),
    );
    expect(secondSend).not.toHaveBeenCalledWith(
      expect.stringContaining(`"op":${GatewayOpcodes.Identify}`),
    );

    await vi.advanceTimersByTimeAsync(5_000);
    expect(secondSend).toHaveBeenCalledWith(
      expect.stringContaining(`"op":${GatewayOpcodes.Identify}`),
    );
  });

  it("validates requestGuildMembers before sending", () => {
    const withoutMembersIntent = new GatewayPlugin({ autoInteractions: false });
    attachOpenSocket(withoutMembersIntent);

    expect(() =>
      withoutMembersIntent.requestGuildMembers({ guild_id: "guild1", query: "", limit: 0 }),
    ).toThrow(/GUILD_MEMBERS intent/);

    const withoutPresenceIntent = new GatewayPlugin({
      autoInteractions: false,
      intents: GatewayIntentBits.GuildMembers,
    });
    attachOpenSocket(withoutPresenceIntent);

    expect(() =>
      withoutPresenceIntent.requestGuildMembers({
        guild_id: "guild1",
        query: "",
        limit: 0,
        presences: true,
      }),
    ).toThrow(/GUILD_PRESENCES intent/);

    const valid = new GatewayPlugin({
      autoInteractions: false,
      intents: GatewayIntentBits.GuildMembers | GatewayIntentBits.GuildPresences,
    });
    const send = attachOpenSocket(valid);

    expect(() =>
      valid.requestGuildMembers({
        guild_id: "guild1",
        limit: 1,
      }),
    ).toThrow(/query or user_ids/);

    valid.requestGuildMembers({ guild_id: "guild1", query: "", limit: 0, presences: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0]?.[0] as string)).toEqual({
      op: GatewayOpcodes.RequestGuildMembers,
      d: { guild_id: "guild1", query: "", limit: 0, presences: true },
    });
  });
});
