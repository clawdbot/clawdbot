import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { WEBHOOK_IN_FLIGHT_DEFAULTS } from "openclaw/plugin-sdk/webhook-request-guards";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type LineNodeWebhookHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const {
  createLineBotMock,
  createLineNodeWebhookHandlerMock,
  registerPluginHttpRouteMock,
  unregisterHttpMock,
} = vi.hoisted(() => ({
  createLineBotMock: vi.fn(() => ({
    account: { accountId: "default" },
    handleWebhook: vi.fn(),
  })),
  createLineNodeWebhookHandlerMock: vi.fn<() => LineNodeWebhookHandler>(() =>
    vi.fn<LineNodeWebhookHandler>(async () => {}),
  ),
  registerPluginHttpRouteMock: vi.fn(),
  unregisterHttpMock: vi.fn(),
}));

let monitorLineProvider: typeof import("./monitor.js").monitorLineProvider;
let getLineRuntimeState: typeof import("./monitor.js").getLineRuntimeState;
let clearLineRuntimeStateForTests: typeof import("./monitor.js").clearLineRuntimeStateForTests;
let innerLineWebhookHandlerMock: ReturnType<typeof vi.fn<LineNodeWebhookHandler>>;

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

vi.mock("openclaw/plugin-sdk/channel-reply-pipeline", () => ({
  createChannelReplyPipeline: vi.fn(() => ({})),
}));

vi.mock("openclaw/plugin-sdk/webhook-ingress", () => ({
  normalizePluginHttpPath: (_path: string | undefined, fallback: string) => fallback,
  registerPluginHttpRoute: registerPluginHttpRouteMock,
}));

vi.mock("./webhook-node.js", () => ({
  createLineNodeWebhookHandler: createLineNodeWebhookHandlerMock,
}));

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

  beforeEach(() => {
    clearLineRuntimeStateForTests();
    createLineBotMock.mockReset();
    createLineBotMock.mockReturnValue({
      account: { accountId: "default" },
      handleWebhook: vi.fn(),
    });
    innerLineWebhookHandlerMock = vi.fn<LineNodeWebhookHandler>(async () => {});
    createLineNodeWebhookHandlerMock
      .mockReset()
      .mockImplementation(() => innerLineWebhookHandlerMock);
    unregisterHttpMock.mockReset();
    registerPluginHttpRouteMock.mockReset().mockReturnValue(unregisterHttpMock);
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

    expect(registerPluginHttpRouteMock).toHaveBeenCalledTimes(1);
    expect(registerPluginHttpRouteMock).toHaveBeenCalledWith(
      expect.objectContaining({ auth: "plugin" }),
    );
    expect(resolved).toBe(false);

    abort.abort();
    await task;
    expect(unregisterHttpMock).toHaveBeenCalledTimes(1);
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

    expect(getLineRuntimeState("work")).toEqual(
      expect.objectContaining({
        running: true,
      }),
    );
    expect(getLineRuntimeState("default")).toBeUndefined();

    monitor.stop();
  });

  it("rejects webhook requests above the shared in-flight limit before body handling", async () => {
    const limit = WEBHOOK_IN_FLIGHT_DEFAULTS.maxInFlightPerKey;
    const releaseRequests: Array<() => void> = [];
    let reachLimit!: () => void;
    const reachedLimit = new Promise<void>((resolve) => {
      reachLimit = resolve;
    });

    innerLineWebhookHandlerMock.mockImplementation(
      async (_req: IncomingMessage, res: ServerResponse) => {
        if (releaseRequests.length === limit - 1) {
          reachLimit();
        }
        await new Promise<void>((resolve) => {
          releaseRequests.push(resolve);
        });
        res.statusCode = 200;
        res.end();
      },
    );

    const monitor = await monitorLineProvider({
      channelAccessToken: "token",
      channelSecret: "secret", // pragma: allowlist secret
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
    });

    const route = registerPluginHttpRouteMock.mock.calls[0]?.[0] as
      | { handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }
      | undefined;
    expect(route).toBeDefined();
    const createPostRequest = () =>
      ({
        method: "POST",
        headers: {},
      }) as IncomingMessage;

    const firstRequests = Array.from({ length: limit }, () =>
      route!.handler(createPostRequest(), createRouteResponse()),
    );
    await reachedLimit;

    const overflowResponse = createRouteResponse();
    await route!.handler(createPostRequest(), overflowResponse);

    expect(innerLineWebhookHandlerMock).toHaveBeenCalledTimes(limit);
    expect(overflowResponse.statusCode).toBe(429);
    expect(overflowResponse.end).toHaveBeenCalledWith("Too Many Requests");

    releaseRequests.splice(0).forEach((release) => release());
    await Promise.all(firstRequests);
    monitor.stop();
  });
});
