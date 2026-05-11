import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { createMockIncomingRequest } from "openclaw/plugin-sdk/test-env";
import { WEBHOOK_IN_FLIGHT_DEFAULTS } from "openclaw/plugin-sdk/webhook-request-guards";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type LineNodeWebhookHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const {
  createLineBotMock,
  createLineNodeWebhookHandlerMock,
  registerWebhookTargetWithPluginRouteMock,
  unregisterHttpMock,
} = vi.hoisted(() => ({
  createLineBotMock: vi.fn(() => ({
    account: { accountId: "default" },
    handleWebhook: vi.fn(),
  })),
  createLineNodeWebhookHandlerMock: vi.fn<() => LineNodeWebhookHandler>(() =>
    vi.fn<LineNodeWebhookHandler>(async () => {}),
  ),
  registerWebhookTargetWithPluginRouteMock: vi.fn(),
  unregisterHttpMock: vi.fn(),
}));

let monitorLineProvider: typeof import("./monitor.js").monitorLineProvider;
let getLineRuntimeState: typeof import("./monitor.js").getLineRuntimeState;
let clearLineRuntimeStateForTests: typeof import("./monitor.js").clearLineRuntimeStateForTests;
let innerLineWebhookHandlerMock: ReturnType<typeof vi.fn<LineNodeWebhookHandler>>;

type RegisteredRoute = {
  accountId?: string;
  auth?: string;
  handler?: LineNodeWebhookHandler;
  path?: string;
  pluginId?: string;
  replaceExisting?: boolean;
};

type RegisteredTarget = {
  accountId?: string;
  path: string;
};

type WebhookRegistration = {
  route: RegisteredRoute;
  target: RegisteredTarget;
};

function requireWebhookRegistration(): WebhookRegistration {
  const registration = registerWebhookTargetWithPluginRouteMock.mock.calls[0]?.[0] as
    | WebhookRegistration
    | undefined;
  if (!registration) {
    throw new Error("expected registered LINE webhook target");
  }
  return registration;
}

function requireRegisteredRoute(): { handler: LineNodeWebhookHandler } {
  const route = requireWebhookRegistration().route;
  if (!route.handler) {
    throw new Error("expected registered LINE webhook route");
  }
  return { handler: route.handler };
}

vi.mock("./bot.js", () => ({
  createLineBot: createLineBotMock,
}));

vi.mock("openclaw/plugin-sdk/reply-runtime", () => ({
  chunkMarkdownText: vi.fn(),
  dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    danger: (value: unknown) => String(value),
    logVerbose: vi.fn(),
    waitForAbortSignal: vi.fn(),
  };
});

vi.mock("openclaw/plugin-sdk/channel-message", () => ({
  createChannelMessageReplyPipeline: vi.fn(() => ({})),
  hasFinalChannelTurnDispatch: vi.fn(() => false),
}));

vi.mock("openclaw/plugin-sdk/webhook-ingress", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/webhook-ingress")>(
    "openclaw/plugin-sdk/webhook-ingress",
  );
  return {
    ...actual,
    normalizePluginHttpPath: (path: string | undefined, fallback: string) => path ?? fallback,
    registerWebhookTargetWithPluginRoute: registerWebhookTargetWithPluginRouteMock,
  };
});

vi.mock("./webhook-node.js", async () => {
  const actual = await vi.importActual<typeof import("./webhook-node.js")>("./webhook-node.js");
  return {
    ...actual,
    createLineNodeWebhookHandler: createLineNodeWebhookHandlerMock,
  };
});

vi.mock("./auto-reply-delivery.js", () => ({
  deliverLineAutoReply: vi.fn(),
}));

vi.mock("./markdown-to-line.js", () => ({
  processLineMessage: vi.fn(),
}));

vi.mock("./reply-chunks.js", () => ({
  sendLineReplyChunks: vi.fn(),
}));

vi.mock("./send.js", () => ({
  createFlexMessage: vi.fn(),
  createImageMessage: vi.fn(),
  createLocationMessage: vi.fn(),
  createQuickReplyItems: vi.fn(),
  createTextMessageWithQuickReplies: vi.fn(),
  getUserDisplayName: vi.fn(),
  pushMessageLine: vi.fn(),
  pushMessagesLine: vi.fn(),
  pushTextMessageWithQuickReplies: vi.fn(),
  replyMessageLine: vi.fn(),
  showLoadingAnimation: vi.fn(),
}));

vi.mock("./template-messages.js", () => ({
  buildTemplateMessageFromPayload: vi.fn(),
}));

describe("monitorLineProvider lifecycle", () => {
  beforeAll(async () => {
    ({ monitorLineProvider, getLineRuntimeState, clearLineRuntimeStateForTests } =
      await import("./monitor.js"));
  });

  afterAll(() => {
    vi.doUnmock("./bot.js");
    vi.doUnmock("openclaw/plugin-sdk/reply-runtime");
    vi.doUnmock("openclaw/plugin-sdk/runtime-env");
    vi.doUnmock("openclaw/plugin-sdk/channel-message");
    vi.doUnmock("openclaw/plugin-sdk/webhook-ingress");
    vi.doUnmock("./webhook-node.js");
    vi.doUnmock("./auto-reply-delivery.js");
    vi.doUnmock("./markdown-to-line.js");
    vi.doUnmock("./reply-chunks.js");
    vi.doUnmock("./send.js");
    vi.doUnmock("./template-messages.js");
    vi.resetModules();
  });

  beforeEach(() => {
    clearLineRuntimeStateForTests();
    createLineBotMock.mockReset();
    createLineBotMock.mockImplementation(() => ({
      account: { accountId: "default" },
      handleWebhook: vi.fn(),
    }));
    innerLineWebhookHandlerMock = vi.fn<LineNodeWebhookHandler>(async () => {});
    createLineNodeWebhookHandlerMock
      .mockReset()
      .mockImplementation(() => innerLineWebhookHandlerMock);
    unregisterHttpMock.mockReset();
    registerWebhookTargetWithPluginRouteMock.mockReset().mockImplementation((params) => {
      const key = params.target.path.startsWith("/")
        ? params.target.path
        : `/${params.target.path}`;
      const normalizedTarget = { ...params.target, path: key };
      const existing = params.targetsByPath.get(key) ?? [];
      params.targetsByPath.set(key, [...existing, normalizedTarget]);
      return {
        target: normalizedTarget,
        unregister: () => {
          unregisterHttpMock();
          const updated = (params.targetsByPath.get(key) ?? []).filter(
            (entry: unknown) => entry !== normalizedTarget,
          );
          if (updated.length > 0) {
            params.targetsByPath.set(key, updated);
          } else {
            params.targetsByPath.delete(key);
          }
        },
      };
    });
  });

  afterEach(() => {
    clearLineRuntimeStateForTests();
  });

  const createRouteResponse = () => {
    const resObj = {
      statusCode: 0,
      headersSent: false,
      setHeader: vi.fn(),
      end: vi.fn(() => {
        resObj.headersSent = true;
      }),
    };
    return resObj as unknown as ServerResponse & { end: ReturnType<typeof vi.fn> };
  };

  it("waits for abort before resolving", async () => {
    const abort = new AbortController();
    let resolved = false;

    const task = monitorLineProvider({
      channelAccessToken: "token",
      channelSecret: "secret", // pragma: allowlist secret
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      abortSignal: abort.signal,
    }).then((monitor) => {
      resolved = true;
      return monitor;
    });

    expect(registerWebhookTargetWithPluginRouteMock).toHaveBeenCalledTimes(1);
    expect(requireWebhookRegistration().route.auth).toBe("plugin");
    expect(resolved).toBe(false);

    abort.abort();
    await task;
    expect(unregisterHttpMock).toHaveBeenCalledTimes(1);
  });

  it("registers an account target without replacing existing route ownership", async () => {
    const monitor = await monitorLineProvider({
      channelAccessToken: "token",
      channelSecret: "secret", // pragma: allowlist secret
      accountId: "work",
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
    });

    const registration = requireWebhookRegistration();
    expect(registration.target.accountId).toBe("work");
    expect(registration.target.path).toBe("/line/webhook");
    expect(registration.route.accountId).toBe("work");
    expect(registration.route.auth).toBe("plugin");
    expect(registration.route.pluginId).toBe("line");
    expect(registration.route).not.toHaveProperty("path");
    expect(registration.route).not.toHaveProperty("replaceExisting");
    monitor.stop();
  });

  it("stops immediately when signal is already aborted", async () => {
    const abort = new AbortController();
    abort.abort();

    await monitorLineProvider({
      channelAccessToken: "token",
      channelSecret: "secret", // pragma: allowlist secret
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      abortSignal: abort.signal,
    });

    expect(unregisterHttpMock).toHaveBeenCalledTimes(1);
  });

  it("returns immediately without abort signal and stop is idempotent", async () => {
    const monitor = await monitorLineProvider({
      channelAccessToken: "token",
      channelSecret: "secret", // pragma: allowlist secret
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
    });

    expect(unregisterHttpMock).not.toHaveBeenCalled();
    monitor.stop();
    monitor.stop();
    expect(unregisterHttpMock).toHaveBeenCalledTimes(1);
  });

  it("records startup state under configured defaultAccount when accountId is omitted", async () => {
    const monitor = await monitorLineProvider({
      channelAccessToken: "token",
      channelSecret: "secret", // pragma: allowlist secret
      config: {
        channels: {
          line: {
            defaultAccount: "work",
            accounts: {
              work: {
                channelAccessToken: "work-token",
                channelSecret: "work-secret",
              },
            },
          },
        },
      } as OpenClawConfig,
      runtime: {} as RuntimeEnv,
    });

    expect(getLineRuntimeState("work")?.running).toBe(true);
    expect(getLineRuntimeState("default")).toBeUndefined();

    monitor.stop();
  });

  it("dispatches shared-path webhook posts to the account matching the signature", async () => {
    const firstMonitor = await monitorLineProvider({
      channelAccessToken: "first-token",
      channelSecret: "first-secret", // pragma: allowlist secret
      accountId: "first",
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
    });
    const secondMonitor = await monitorLineProvider({
      channelAccessToken: "second-token",
      channelSecret: "second-secret", // pragma: allowlist secret
      accountId: "second",
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
    });

    const route = requireRegisteredRoute();

    const payload = JSON.stringify({ events: [{ type: "message" }] });
    const signature = crypto.createHmac("SHA256", "second-secret").update(payload).digest("base64");
    const req = Object.assign(createMockIncomingRequest([payload]), {
      method: "POST",
      headers: { "x-line-signature": signature },
    }) as unknown as IncomingMessage;
    const res = createRouteResponse();

    await route.handler(req, res);

    const firstBot = createLineBotMock.mock.results[0]?.value as {
      handleWebhook: ReturnType<typeof vi.fn>;
    };
    const secondBot = createLineBotMock.mock.results[1]?.value as {
      handleWebhook: ReturnType<typeof vi.fn>;
    };
    expect(res.statusCode).toBe(200);
    expect(firstBot.handleWebhook).not.toHaveBeenCalled();
    expect(secondBot.handleWebhook).toHaveBeenCalledTimes(1);

    firstMonitor.stop();
    secondMonitor.stop();
  });

  it("rejects ambiguous shared-path webhook signatures", async () => {
    const firstMonitor = await monitorLineProvider({
      channelAccessToken: "first-token",
      channelSecret: "shared-secret", // pragma: allowlist secret
      accountId: "first",
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
    });
    const secondMonitor = await monitorLineProvider({
      channelAccessToken: "second-token",
      channelSecret: "shared-secret", // pragma: allowlist secret
      accountId: "second",
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
    });

    const route = requireRegisteredRoute();

    const payload = JSON.stringify({ events: [{ type: "message" }] });
    const signature = crypto.createHmac("SHA256", "shared-secret").update(payload).digest("base64");
    const req = Object.assign(createMockIncomingRequest([payload]), {
      method: "POST",
      headers: { "x-line-signature": signature },
    }) as unknown as IncomingMessage;
    const res = createRouteResponse();

    await route.handler(req, res);

    const firstBot = createLineBotMock.mock.results[0]?.value as {
      handleWebhook: ReturnType<typeof vi.fn>;
    };
    const secondBot = createLineBotMock.mock.results[1]?.value as {
      handleWebhook: ReturnType<typeof vi.fn>;
    };
    expect(res.statusCode).toBe(401);
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: "Ambiguous webhook target" }));
    expect(firstBot.handleWebhook).not.toHaveBeenCalled();
    expect(secondBot.handleWebhook).not.toHaveBeenCalled();

    firstMonitor.stop();
    secondMonitor.stop();
  });

  it("rejects webhook requests above the shared in-flight limit before body handling", async () => {
    const limit = WEBHOOK_IN_FLIGHT_DEFAULTS.maxInFlightPerKey;
    const heldRequests: Array<EventEmitter & { destroy: () => void }> = [];

    const monitor = await monitorLineProvider({
      channelAccessToken: "token",
      channelSecret: "secret", // pragma: allowlist secret
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
    });

    const route = requireRegisteredRoute();
    const createHeldPostRequest = () => {
      const req = Object.assign(new EventEmitter(), {
        destroyed: false,
        destroy(this: EventEmitter & { destroyed: boolean }) {
          this.destroyed = true;
          this.emit("close");
        },
      });
      heldRequests.push(req);
      return Object.assign(req, {
        method: "POST",
        headers: { "x-line-signature": "pending" },
      }) as unknown as IncomingMessage;
    };
    const createSignedPostRequest = () => {
      const payload = JSON.stringify({ events: [{ type: "message" }] });
      const signature = crypto.createHmac("SHA256", "secret").update(payload).digest("base64");
      const req = createMockIncomingRequest([payload]);
      return Object.assign(req, {
        method: "POST",
        headers: { "x-line-signature": signature },
      }) as unknown as IncomingMessage;
    };

    const firstRequests = Array.from({ length: limit }, () =>
      route.handler(createHeldPostRequest(), createRouteResponse()),
    );
    await new Promise((resolve) => setImmediate(resolve));

    const overflowResponse = createRouteResponse();
    await route.handler(createSignedPostRequest(), overflowResponse);

    const bot = createLineBotMock.mock.results[0]?.value as {
      handleWebhook: ReturnType<typeof vi.fn>;
    };
    expect(bot.handleWebhook).not.toHaveBeenCalled();
    expect(overflowResponse.statusCode).toBe(429);
    expect(overflowResponse.end).toHaveBeenCalledWith("Too Many Requests");

    heldRequests.splice(0).forEach((req) => req.destroy());
    await Promise.allSettled(firstRequests);
    monitor.stop();
  });
});
