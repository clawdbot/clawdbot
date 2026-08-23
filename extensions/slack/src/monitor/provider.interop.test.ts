// Slack tests cover provider.interop plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { createSlackBoltApp, resolveSlackBoltInterop } from "./provider-support.js";

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
      token: "xoxb-test",
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

  it("filters Socket Mode noise and retains SDK errors through the configured receiver logger", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { receiver, socketModeLogger } = createSlackBoltApp({
        interop: {
          App: FakeApp as never,
          HTTPReceiver: FakeHTTPReceiver as never,
          SocketModeReceiver: FakeSocketModeReceiver as never,
        },
        slackMode: "socket",
        token: "xoxb-test",
        appToken: "xapp-test",
        slackWebhookPath: "/slack/events",
        clientOptions: {},
      });
      const receiverLogger = (receiver as unknown as FakeSocketModeReceiver).args.logger;
      expect(receiverLogger).toBe(socketModeLogger);

      socketModeLogger.setName("SlackWebSocket:1");
      socketModeLogger.warn(
        "A pong wasn't received from the server before the timeout of 15000ms!",
      );
      socketModeLogger.warn(
        "A ping wasn't received from the server before the timeout of 30000ms!",
      );
      socketModeLogger.warn(
        "The logLevel given to Socket Mode was ignored as you also gave logger",
      );
      socketModeLogger.warn("another socket warning");
      socketModeLogger.error("failed to retrieve WSS URL", {
        data: { error: "missing_scope", needed: "connections:write" },
      });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("socket-mode:SlackWebSocket:1", "another socket warning");
      expect(error).toHaveBeenCalledTimes(1);
      expect(socketModeLogger.getLastMessage()).toBe(
        "socket-mode:SlackWebSocket:1 failed to retrieve WSS URL slack error: missing_scope; needed: connections:write",
      );
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("applies OpenClaw self-event filtering through installed Bolt middleware", async () => {
    const { app } = createSlackBoltApp({
      interop: {
        App: FakeApp as never,
        HTTPReceiver: FakeHTTPReceiver as never,
        SocketModeReceiver: FakeSocketModeReceiver as never,
      },
      slackMode: "socket",
      token: "xoxb-test",
      appToken: "xapp-test",
      slackWebhookPath: "/slack/events",
      clientOptions: {},
    });
    const middleware = (app as unknown as FakeApp).middleware[0] as
      | ((args: {
          next: () => Promise<void>;
          context?: { botId?: string; botUserId?: string };
          event?: unknown;
          message?: unknown;
        }) => Promise<void>)
      | undefined;
    if (!middleware) {
      throw new Error("expected Slack self-event middleware");
    }

    const cases = [
      {
        args: {
          context: { botUserId: "U_BOT", botId: "B_BOT" },
          event: { type: "reaction_added", user: "U_BOT" },
        },
        forwarded: false,
      },
      {
        args: {
          context: { botUserId: "U_BOT", botId: "B_BOT" },
          event: { type: "message", subtype: "message_changed", user: "U_BOT" },
        },
        forwarded: true,
      },
      {
        args: {
          context: { botUserId: "U_BOT", botId: "B_BOT" },
          event: { type: "message", user: "U_BOT" },
        },
        forwarded: false,
      },
      {
        args: {
          context: { botUserId: "U_USER" },
          event: { type: "message", user: "U_USER", channel_type: "im" },
        },
        forwarded: false,
      },
      {
        args: {
          context: { botUserId: "U_USER" },
          event: { type: "message", user: "U_OTHER", channel_type: "im" },
        },
        forwarded: true,
      },
      {
        args: {
          context: { botUserId: "U_BOT", botId: "B_BOT" },
          event: { type: "message", user: "U_OTHER" },
          message: { subtype: "bot_message", bot_id: "B_BOT" },
        },
        forwarded: false,
      },
    ] as const;

    for (const testCase of cases) {
      const next = vi.fn(async () => {});
      await middleware({ ...testCase.args, next });
      expect(next).toHaveBeenCalledTimes(testCase.forwarded ? 1 : 0);
    }
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
      token: "xoxb-test",
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

  it("uses Slack's fixed Socket Mode receiver policy", () => {
    const clientOptions = { teamId: "T1" };
    const { receiver } = createSlackBoltApp({
      interop: {
        App: FakeApp as never,
        HTTPReceiver: FakeHTTPReceiver as never,
        SocketModeReceiver: FakeSocketModeReceiver as never,
      },
      slackMode: "socket",
      token: "xoxb-test",
      appToken: "xapp-test",
      slackWebhookPath: "/slack/events",
      clientOptions,
    });

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
      token: "xoxb-test",
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

  it.each(["socket", "http"] as const)(
    "routes %s Events API receive through the durable receiver wrapper",
    async (slackMode) => {
      const wrappedReceiver = { durable: true };
      const wrapReceiver = vi.fn(() => wrappedReceiver as never);
      const { app, receiver } = createSlackBoltApp({
        interop: {
          App: FakeApp as never,
          HTTPReceiver: FakeHTTPReceiver as never,
          SocketModeReceiver: FakeSocketModeReceiver as never,
        },
        slackMode,
        token: "test-bot-token",
        ...(slackMode === "socket"
          ? { appToken: "test-app-token" }
          : { signingSecret: "test-signing-secret" }),
        slackWebhookPath: "/slack/events",
        clientOptions: {},
        wrapReceiver,
      });

      expect(wrapReceiver).toHaveBeenCalledWith(receiver);
      expect((app as unknown as FakeApp).args.receiver).toBe(wrappedReceiver);
      const receiverArgs = (receiver as unknown as FakeHTTPReceiver | FakeSocketModeReceiver).args;
      expect(receiverArgs.processEventErrorHandler).toBeTypeOf("function");
      await expect(
        (receiverArgs.processEventErrorHandler as () => Promise<boolean>)(),
      ).resolves.toBe(false);
    },
  );

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
      token: "xoxb-invalid",
      appToken: "xapp-test",
      slackWebhookPath: "/slack/events",
      clientOptions: {},
    });

    expect(eagerAuthTestCalls).toBe(0);
  });
});
