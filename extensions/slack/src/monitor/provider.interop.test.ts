import { describe, expect, it } from "vitest";
import { __testing } from "./provider.js";

describe("resolveSlackBoltInterop", () => {
  function FakeApp() {}
  function FakeHTTPReceiver() {}
  function FakeSocketModeReceiver() {}

  it("uses the default import when it already exposes named exports", () => {
    const resolved = __testing.resolveSlackBoltInterop({
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
    const resolved = __testing.resolveSlackBoltInterop({
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
    const resolved = __testing.resolveSlackBoltInterop({
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
    const resolved = __testing.resolveSlackBoltInterop({
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
    const resolved = __testing.resolveSlackBoltInterop({
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
      __testing.resolveSlackBoltInterop({
        defaultImport: null,
        namespaceImport: {},
      }),
    ).toThrow("Unable to resolve @slack/bolt App/HTTPReceiver exports");
  });
});

describe("createSlackBoltApp", () => {
  class FakeApp {
    args: Record<string, unknown>;

    constructor(args: Record<string, unknown>) {
      this.args = args;
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

  it("uses SocketModeReceiver with OpenClaw-owned reconnects and shared client options", () => {
    const clientOptions = { teamId: "T1" };
    const { app, receiver } = __testing.createSlackBoltApp({
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
    expect((receiver as unknown as FakeSocketModeReceiver).args).toEqual({
      appToken: "xapp-test",
      autoReconnectEnabled: false,
      installerOptions: {
        clientOptions,
      },
    });
    expect(app).toBeInstanceOf(FakeApp);
    expect((app as unknown as FakeApp).args).toEqual({
      token: "xoxb-test",
      receiver,
      clientOptions,
    });
  });

  it("uses HTTPReceiver for webhook mode", () => {
    const clientOptions = { teamId: "T1" };
    const { app, receiver } = __testing.createSlackBoltApp({
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
    });
  });
});
