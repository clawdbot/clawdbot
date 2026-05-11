import { describe, expect, it } from "vitest";
import {
  createSlackBoltApp,
  createSlackSocketModeLogger,
  resolveSlackBoltInterop,
  shouldSkipOpenClawSlackSelfEvent,
} from "./provider-support.js";

describe("resolveSlackBoltInterop", () => {
  function FakeApp() {}
  function FakeHTTPReceiver() {}
  function FakeSocketModeReceiver() {}

  it("uses the default import when it already exposes named exports", () => {
    const resolved = resolveSlackBoltInterop({
      defaultImport: {
        App: FakeApp,
        HTTPReceiver: FakeHTTPReceiver,
        SocketModeReceiver: FakeSocketModeReceiver,
      },
      namespaceImport: {},
    });

    expect(resolved).toEqual({
      App: FakeApp,
      HTTPReceiver: FakeHTTPReceiver,
      SocketModeReceiver: FakeSocketModeReceiver,
    });
  });

  it("uses nested default export when the default import is a wrapper object", () => {
    const resolved = resolveSlackBoltInterop({
      defaultImport: {
        default: {
          App: FakeApp,
          HTTPReceiver: FakeHTTPReceiver,
          SocketModeReceiver: FakeSocketModeReceiver,
        },
      },
      namespaceImport: {},
    });

    expect(resolved).toEqual({
      App: FakeApp,
      HTTPReceiver: FakeHTTPReceiver,
      SocketModeReceiver: FakeSocketModeReceiver,
    });
  });

  it("uses the namespace receiver when the default import is the App constructor itself", () => {
    const resolved = resolveSlackBoltInterop({
      defaultImport: FakeApp,
      namespaceImport: {
        HTTPReceiver: FakeHTTPReceiver,
        SocketModeReceiver: FakeSocketModeReceiver,
      },
    });

    expect(resolved).toEqual({
      App: FakeApp,
      HTTPReceiver: FakeHTTPReceiver,
      SocketModeReceiver: FakeSocketModeReceiver,
    });
  });

  it("uses namespace.default when it exposes named exports", () => {
    const resolved = resolveSlackBoltInterop({
      defaultImport: undefined,
      namespaceImport: {
        default: {
          App: FakeApp,
          HTTPReceiver: FakeHTTPReceiver,
          SocketModeReceiver: FakeSocketModeReceiver,
        },
      },
    });

    expect(resolved).toEqual({
      App: FakeApp,
      HTTPReceiver: FakeHTTPReceiver,
      SocketModeReceiver: FakeSocketModeReceiver,
    });
  });

  it("falls back to the namespace import when it exposes named exports", () => {
    const resolved = resolveSlackBoltInterop({
      defaultImport: undefined,
      namespaceImport: {
        App: FakeApp,
        HTTPReceiver: FakeHTTPReceiver,
        SocketModeReceiver: FakeSocketModeReceiver,
      },
    });

    expect(resolved).toEqual({
      App: FakeApp,
      HTTPReceiver: FakeHTTPReceiver,
      SocketModeReceiver: FakeSocketModeReceiver,
    });
  });

  it("throws when the module cannot be resolved", () => {
    expect(() =>
      resolveSlackBoltInterop({
        defaultImport: null,
        namespaceImport: {},
      }),
    ).toThrow("Unable to resolve @slack/bolt App/HTTPReceiver exports");
  });
});

describe("createSlackBoltApp", () => {
  class FakeApp {
    args: Record<string, unknown>;
    middleware: unknown[] = [];

    constructor(args: Record<string, unknown>) {
      this.args = args;
    }

    use(middleware: unknown) {
      this.middleware.push(middleware);
      return this;
    }
  }

  class FakeHTTPReceiver {
    args: Record<string, unknown>;

    constructor(args: Record<string, unknown>) {
      this.args = args;
    }
  }

  class FakeSocketModeReceiver {
    args: Record<string, unknown>;

    constructor(args: Record<string, unknown>) {
      this.args = args;
    }
  }

  it("uses SocketModeReceiver with native reconnects and shared client options", () => {
    const clientOptions = { teamId: "T1" };
    const { app, receiver } = createSlackBoltApp({
      interop: {
        App: FakeApp as never,
        HTTPReceiver: FakeHTTPReceiver as never,
        SocketModeReceiver: FakeSocketModeReceiver as never,
      },
      slackMode: "socket",
      botToken: "xoxb-test",
      appToken: "xapp-test",
      slackWebhookPath: "/slack/events",
      clientOptions,
    });

    expect(receiver).toBeInstanceOf(FakeSocketModeReceiver);
    const receiverArgs = (receiver as unknown as FakeSocketModeReceiver).args;
    const receiverLogger = receiverArgs.logger as { error?: unknown; warn?: unknown };
    expect(receiverLogger.error).toBeTypeOf("function");
    expect(receiverLogger.warn).toBeTypeOf("function");
    expect(receiverArgs).toEqual({
      appToken: "xapp-test",
      autoReconnectEnabled: true,
      clientPingTimeout: 15_000,
      logger: receiverLogger,
      installerOptions: {
        clientOptions,
      },
    });
    expect(app).toBeInstanceOf(FakeApp);
    expect((app as unknown as FakeApp).args).toEqual({
      token: "xoxb-test",
      receiver,
      clientOptions,
      ignoreSelf: false,
      tokenVerificationEnabled: false,
    });
    expect((app as unknown as FakeApp).middleware).toHaveLength(1);
  });

  it("routes native reconnect start failures through the socket disconnect event", async () => {
    const startError = new Error("invalid_auth");
    class FakeSocketModeClient {
      emitted: unknown[][] = [];
      clientPingTimeoutMS = 0;
      numOfConsecutiveReconnectionFailures = 0;
      logger = { debug: () => undefined };
      shuttingDown = false;
      start = async () => {
        throw startError;
      };

      delayReconnectAttempt(callback: (this: FakeSocketModeClient) => Promise<unknown>) {
        return Promise.resolve(callback.call(this));
      }

      emit(event: string, ...args: unknown[]) {
        this.emitted.push([event, ...args]);
      }
    }
    class FakeObservedSocketModeReceiver {
      args: Record<string, unknown>;
      client = new FakeSocketModeClient();

      constructor(args: Record<string, unknown>) {
        this.args = args;
      }
    }
    const { receiver } = createSlackBoltApp({
      interop: {
        App: FakeApp as never,
        HTTPReceiver: FakeHTTPReceiver as never,
        SocketModeReceiver: FakeObservedSocketModeReceiver as never,
      },
      slackMode: "socket",
      botToken: "xoxb-test",
      appToken: "xapp-test",
      slackWebhookPath: "/slack/events",
      clientOptions: {},
    });

    const client = (receiver as unknown as FakeObservedSocketModeReceiver).client;

    await expect(client.delayReconnectAttempt(client.start)).resolves.toBeUndefined();
    await expect(
      client.delayReconnectAttempt(async () => {
        throw new Error("transient");
      }),
    ).rejects.toThrow("transient");
    expect(client.emitted).toEqual([
      ["reconnecting"],
      ["unable_to_socket_mode_start", startError],
      ["reconnecting"],
    ]);
  });

  it("passes Socket Mode ping/pong options through Slack's public receiver API", () => {
    const clientOptions = { teamId: "T1" };
    const { receiver } = createSlackBoltApp({
      interop: {
        App: FakeApp as never,
        HTTPReceiver: FakeHTTPReceiver as never,
        SocketModeReceiver: FakeSocketModeReceiver as never,
      },
      slackMode: "socket",
      botToken: "xoxb-test",
      appToken: "xapp-test",
      slackWebhookPath: "/slack/events",
      clientOptions,
      socketMode: {
        clientPingTimeout: 20_000,
        serverPingTimeout: 45_000,
        pingPongLoggingEnabled: true,
      },
    });

    const receiverArgs = (receiver as unknown as FakeSocketModeReceiver).args;
    const receiverLogger = receiverArgs.logger as { error?: unknown; warn?: unknown };
    expect(receiverLogger.error).toBeTypeOf("function");
    expect(receiverLogger.warn).toBeTypeOf("function");
    expect(receiverArgs).toEqual({
      appToken: "xapp-test",
      autoReconnectEnabled: true,
      clientPingTimeout: 20_000,
      serverPingTimeout: 45_000,
      pingPongLoggingEnabled: true,
      logger: receiverLogger,
      installerOptions: {
        clientOptions,
      },
    });
  });

  it("uses HTTPReceiver for webhook mode", () => {
    const clientOptions = { teamId: "T1" };
    const { app, receiver } = createSlackBoltApp({
      interop: {
        App: FakeApp as never,
        HTTPReceiver: FakeHTTPReceiver as never,
        SocketModeReceiver: FakeSocketModeReceiver as never,
      },
      slackMode: "http",
      botToken: "xoxb-test",
      signingSecret: "secret",
      slackWebhookPath: "/slack/events",
      clientOptions,
    });

    expect(receiver).toBeInstanceOf(FakeHTTPReceiver);
    expect((receiver as unknown as FakeHTTPReceiver).args).toEqual({
      signingSecret: "secret",
      endpoints: "/slack/events",
    });
    expect(app).toBeInstanceOf(FakeApp);
    expect((app as unknown as FakeApp).args).toEqual({
      token: "xoxb-test",
      receiver,
      clientOptions,
      ignoreSelf: false,
      tokenVerificationEnabled: false,
    });
    expect((app as unknown as FakeApp).middleware).toHaveLength(1);
  });

  it("prevents Bolt's constructor-time token verification side effect", () => {
    let eagerAuthTestCalls = 0;
    class BoltLikeEagerAuthApp extends FakeApp {
      constructor(args: Record<string, unknown>) {
        super(args);
        if (args.tokenVerificationEnabled !== false) {
          eagerAuthTestCalls += 1;
        }
      }
    }

    createSlackBoltApp({
      interop: {
        App: BoltLikeEagerAuthApp as never,
        HTTPReceiver: FakeHTTPReceiver as never,
        SocketModeReceiver: FakeSocketModeReceiver as never,
      },
      slackMode: "socket",
      botToken: "xoxb-invalid",
      appToken: "xapp-test",
      slackWebhookPath: "/slack/events",
      clientOptions: {},
    });

    expect(eagerAuthTestCalls).toBe(0);
  });

  it("suppresses Slack's redundant heartbeat timeout warnings while forwarding other SDK warnings", () => {
    const warnCalls: unknown[][] = [];
    const logger = createSlackSocketModeLogger({
      debug: () => {},
      info: () => {},
      warn: (...args: unknown[]) => warnCalls.push(args),
      error: () => {},
    });

    logger.setName("SlackWebSocket:1");
    logger.warn("A pong wasn't received from the server before the timeout of 15000ms!");
    logger.warn("A ping wasn't received from the server before the timeout of 30000ms!");
    logger.warn("The logLevel given to Socket Mode was ignored as you also gave logger");
    logger.warn("another socket warning");

    expect(warnCalls).toEqual([["socket-mode:SlackWebSocket:1", "another socket warning"]]);
    expect(logger.getLastMessage()).toBe("socket-mode:SlackWebSocket:1 another socket warning");
  });

  it("remembers the last Socket Mode SDK error for retry diagnostics", () => {
    const logger = createSlackSocketModeLogger({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    });

    logger.setName("SlackWebSocket:1");
    logger.error("failed to retrieve WSS URL", {
      data: {
        error: "missing_scope",
        needed: "connections:write",
      },
    });

    expect(logger.getLastMessage()).toBe(
      "socket-mode:SlackWebSocket:1 failed to retrieve WSS URL slack error: missing_scope; needed: connections:write",
    );
  });

  it("keeps Bolt self filtering except assistant message_changed events", () => {
    expect(
      shouldSkipOpenClawSlackSelfEvent({
        context: { botUserId: "U_BOT", botId: "B_BOT" },
        event: { type: "reaction_added", user: "U_BOT" },
      }),
    ).toBe(true);

    expect(
      shouldSkipOpenClawSlackSelfEvent({
        context: { botUserId: "U_BOT", botId: "B_BOT" },
        event: { type: "message", subtype: "message_changed", user: "U_BOT" },
      }),
    ).toBe(false);

    expect(
      shouldSkipOpenClawSlackSelfEvent({
        context: { botUserId: "U_BOT", botId: "B_BOT" },
        event: { type: "message", user: "U_BOT" },
      }),
    ).toBe(true);

    expect(
      shouldSkipOpenClawSlackSelfEvent({
        context: { botUserId: "U_BOT", botId: "B_BOT" },
        event: { type: "message", user: "U_OTHER" },
        message: { subtype: "bot_message", bot_id: "B_BOT" },
      }),
    ).toBe(true);
  });
});
