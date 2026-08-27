// Tlon monitor tests cover authentication, inbound context, and shutdown lifecycle.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setImmediate } from "node:timers/promises";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  authenticateMock,
  buildChannelInboundEnvelopeMock,
  builtInboundContextPayload,
  createChannelInboundEnvelopeBuilderMock,
  formatInboundMediaUnavailableTextMock,
  sleepWithAbortMock,
  saveRemoteMediaMock,
  sseClientMock,
  ingressMock,
  inboundRuntimeMock,
  settingsManagerMock,
  realUrbitFixture,
} = vi.hoisted(() => ({
  authenticateMock: vi.fn(),
  buildChannelInboundEnvelopeMock: vi.fn(),
  builtInboundContextPayload: { kind: "tlon-inbound-context" },
  createChannelInboundEnvelopeBuilderMock: vi.fn(),
  formatInboundMediaUnavailableTextMock: vi.fn(),
  sleepWithAbortMock: vi.fn(),
  saveRemoteMediaMock: vi.fn(),
  sseClientMock: {
    scry: vi.fn().mockResolvedValue({}),
    subscribe: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    stopReceiving: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    poke: vi.fn().mockResolvedValue(undefined),
  },
  ingressMock: {
    receive: vi.fn().mockResolvedValue({ kind: "accepted" }),
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  },
  inboundRuntimeMock: {
    buildContext: vi.fn(),
    dispatch: vi.fn().mockResolvedValue(undefined),
    resolveAgentRoute: vi.fn(() => ({
      accountId: "default",
      agentId: "main",
      dmScope: "main",
      sessionKey: "agent:main:main",
    })),
    resolveEffectiveMessagesConfig: vi.fn(() => ({ responsePrefix: undefined })),
    shouldComputeCommandAuthorized: vi.fn(() => false),
  },
  settingsManagerMock: {
    load: vi.fn().mockResolvedValue({}),
    onChange: vi.fn().mockReturnValue(() => {}),
    startSubscription: vi.fn().mockResolvedValue(undefined),
  },
  realUrbitFixture: {
    enabled: false,
    url: "https://urbit.example.com",
    client: null as {
      stopReceiving: () => void;
      close: () => Promise<void>;
    } | null,
  },
}));

const runningServers: Server[] = [];

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  resolveHumanDelayConfig: vi.fn(() => undefined),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", () => ({
  createChannelInboundEnvelopeBuilder: createChannelInboundEnvelopeBuilderMock,
  formatInboundMediaUnavailableText: formatInboundMediaUnavailableTextMock,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  sleepWithAbort: sleepWithAbortMock,
}));

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  MAX_IMAGE_BYTES: 6 * 1024 * 1024,
  readRemoteMediaBuffer: vi.fn(),
  saveRemoteMedia: saveRemoteMediaMock,
}));

vi.mock("../runtime.js", () => ({
  getTlonRuntime: () => ({
    config: {
      current: () => ({
        channels: {
          tlon: {
            code: "code",
            ship: "~zod",
            url: realUrbitFixture.url,
            network: { dangerouslyAllowPrivateNetwork: true },
            ownerShip: "~nec",
          },
        },
      }),
    },
    logging: {
      getChildLogger: () => ({}),
    },
    channel: {
      commands: {
        shouldComputeCommandAuthorized: inboundRuntimeMock.shouldComputeCommandAuthorized,
      },
      inbound: {
        buildContext: inboundRuntimeMock.buildContext,
        dispatch: inboundRuntimeMock.dispatch,
      },
      reply: {
        resolveEffectiveMessagesConfig: inboundRuntimeMock.resolveEffectiveMessagesConfig,
      },
      routing: {
        resolveAgentRoute: inboundRuntimeMock.resolveAgentRoute,
      },
    },
  }),
}));

vi.mock("../urbit/auth.js", () => ({
  authenticate: authenticateMock,
}));

vi.mock("../urbit/sse-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../urbit/sse-client.js")>();
  return {
    ...actual,
    UrbitSSEClient: vi.fn(function (...args: ConstructorParameters<typeof actual.UrbitSSEClient>) {
      if (!realUrbitFixture.enabled) {
        return sseClientMock;
      }
      const client = new actual.UrbitSSEClient(...args);
      realUrbitFixture.client = client;
      return client;
    }),
  };
});

vi.mock("../settings.js", () => ({
  createSettingsManager: vi.fn(() => settingsManagerMock),
}));

vi.mock("./ingress.js", () => ({
  createTlonIngressMonitor: vi.fn(() => ingressMock),
}));

import { monitorTlonProvider } from "./index.js";
import { extractMessageText } from "./utils.js";

beforeEach(() => {
  createChannelInboundEnvelopeBuilderMock.mockReturnValue(buildChannelInboundEnvelopeMock);
  buildChannelInboundEnvelopeMock.mockReturnValue("tlon-envelope");
  formatInboundMediaUnavailableTextMock.mockReturnValue("formatted-inbound-body");
  inboundRuntimeMock.buildContext.mockReturnValue(builtInboundContextPayload);
});

afterEach(async () => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
  const realClient = realUrbitFixture.client;
  if (realClient) {
    realClient.stopReceiving();
    await realClient.close().catch(() => undefined);
  }
  realUrbitFixture.enabled = false;
  realUrbitFixture.url = "https://urbit.example.com";
  realUrbitFixture.client = null;
  await Promise.all(
    runningServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

describe("monitorTlonProvider authentication retry", () => {
  it("uses the shared abort-aware sleep for retry backoff", async () => {
    const controller = new AbortController();
    const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } satisfies RuntimeEnv;
    authenticateMock.mockRejectedValueOnce(new Error("login failed"));
    sleepWithAbortMock.mockRejectedValueOnce(new Error("aborted"));

    await expect(
      monitorTlonProvider({
        abortSignal: controller.signal,
        runtime,
      }),
    ).rejects.toThrow("aborted");

    expect(authenticateMock).toHaveBeenCalledTimes(1);
    expect(sleepWithAbortMock).toHaveBeenCalledWith(1_000, controller.signal);
  });
});

it("awaits cumulative Tlon discovery persistence and retries failed writes", async () => {
  const controller = new AbortController();
  const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } satisfies RuntimeEnv;
  authenticateMock.mockResolvedValueOnce("urbauth-~zod=proof");
  settingsManagerMock.load.mockResolvedValueOnce({
    groupChannels: ["chat/~zod/base"],
    autoAcceptGroupInvites: true,
  });

  const monitor = monitorTlonProvider({ abortSignal: controller.signal, runtime });
  try {
    await vi.waitFor(() => expect(sseClientMock.connect).toHaveBeenCalledOnce());
    const groupSubscription = sseClientMock.subscribe.mock.calls
      .map(([subscription]) => subscription)
      .find(({ app, path }) => app === "groups" && path === "/groups/ui");
    if (!groupSubscription) {
      throw new Error("expected groups-ui subscription");
    }

    const firstResult = groupSubscription.event({
      channels: {
        "chat/~zod/a": {},
        "chat/~zod/b": {},
        "chat/~zod/base": {},
      },
      join: { channels: ["chat/~zod/b", "chat/~zod/c", "heap/~zod/no"] },
    });
    expect.soft(firstResult).toBeInstanceOf(Promise);
    await firstResult;
    await setImmediate();

    sseClientMock.poke.mockRejectedValueOnce(new Error("settings write failed"));
    const retryEvent = { join: { channels: ["chat/~zod/retry"] } };
    await Promise.resolve(groupSubscription.event(retryEvent)).catch(() => undefined);
    await setImmediate();
    await groupSubscription.event(retryEvent);

    expect(sseClientMock.poke).toHaveBeenCalledTimes(3);
    expect(sseClientMock.poke.mock.calls[2]?.[0]).toMatchObject({
      json: {
        "put-entry": {
          value: ["chat/~zod/base", "chat/~zod/a", "chat/~zod/b", "chat/~zod/c", "chat/~zod/retry"],
        },
      },
    });
  } finally {
    controller.abort();
    await monitor;
  }
});

it.each([
  { name: "owner", ship: "~nec", settings: {} },
  {
    name: "allowlisted",
    ship: "~bus",
    settings: { autoAcceptGroupInvites: true, groupInviteAllowlist: ["~bus"] },
  },
])("awaits $name group invite acceptance and retries failed writes", async ({ ship, settings }) => {
  const controller = new AbortController();
  const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } satisfies RuntimeEnv;
  authenticateMock.mockResolvedValueOnce("urbauth-~zod=proof");
  settingsManagerMock.load.mockResolvedValueOnce(settings);

  const monitor = monitorTlonProvider({ abortSignal: controller.signal, runtime });
  try {
    await vi.waitFor(() => expect(sseClientMock.connect).toHaveBeenCalledOnce());
    const foreignsSubscription = sseClientMock.subscribe.mock.calls
      .map(([subscription]) => subscription)
      .find(({ app, path }) => app === "groups" && path === "/v1/foreigns");
    if (!foreignsSubscription) {
      throw new Error("expected foreigns subscription");
    }
    sseClientMock.poke.mockClear();

    let releaseWrite = () => {};
    sseClientMock.poke.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseWrite = resolve;
        }),
    );
    let settled = false;
    const firstResult = foreignsSubscription.event({
      [`${ship}/first`]: { invites: [{ valid: true, from: ship }] },
    });
    expect(firstResult).toBeInstanceOf(Promise);
    const firstProcessing = Promise.resolve(firstResult).then(() => {
      settled = true;
    });
    await setImmediate();
    expect(sseClientMock.poke).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    releaseWrite();
    await firstProcessing;
    expect(settled).toBe(true);

    sseClientMock.poke.mockRejectedValueOnce(new Error("group join failed"));
    const retryEvent = {
      [`${ship}/retry`]: { invites: [{ valid: true, from: ship }] },
    };
    await expect(foreignsSubscription.event(retryEvent)).rejects.toThrow("group join failed");
    await foreignsSubscription.event(retryEvent);

    expect(sseClientMock.poke).toHaveBeenCalledTimes(3);
    expect(sseClientMock.poke.mock.calls[2]?.[0]).toMatchObject({
      app: "groups",
      mark: "group-join",
      json: { flag: `${ship}/retry`, "join-all": true },
    });
  } finally {
    controller.abort();
    await monitor;
  }
});

it.each([
  { name: "owner", ship: "~nec", settings: {} },
  {
    name: "allowlisted",
    ship: "~bus",
    settings: { autoAcceptDmInvites: true, dmAllowlist: ["~bus"] },
  },
])(
  "retries failed $name DM invite acceptance before acknowledgement",
  async ({ ship, settings }) => {
    const controller = new AbortController();
    const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } satisfies RuntimeEnv;
    authenticateMock.mockResolvedValueOnce("urbauth-~zod=proof");
    settingsManagerMock.load.mockResolvedValueOnce(settings);

    const monitor = monitorTlonProvider({ abortSignal: controller.signal, runtime });
    try {
      await vi.waitFor(() => expect(sseClientMock.connect).toHaveBeenCalledOnce());
      const chatSubscription = sseClientMock.subscribe.mock.calls
        .map(([subscription]) => subscription)
        .find(({ app, path }) => app === "chat" && path === "/v3");
      if (!chatSubscription) {
        throw new Error("expected chat subscription");
      }
      sseClientMock.poke.mockClear();
      ingressMock.receive
        .mockResolvedValueOnce({ kind: "ignored" })
        .mockResolvedValueOnce({ kind: "ignored" });

      const inviteEvent = [{ ship }];
      sseClientMock.poke.mockRejectedValueOnce(new Error("DM invite write failed"));
      await expect(chatSubscription.event(inviteEvent)).rejects.toThrow("DM invite write failed");
      await chatSubscription.event(inviteEvent);

      expect(sseClientMock.poke).toHaveBeenCalledTimes(2);
      expect(sseClientMock.poke.mock.calls[1]?.[0]).toMatchObject({
        app: "chat",
        mark: "chat-dm-rsvp",
        json: { ship, ok: true },
      });
    } finally {
      controller.abort();
      await monitor;
    }
  },
);

it("persists group invite approval before notification and acknowledgement", async () => {
  const controller = new AbortController();
  const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } satisfies RuntimeEnv;
  authenticateMock.mockResolvedValueOnce("urbauth-~zod=proof");

  const monitor = monitorTlonProvider({ abortSignal: controller.signal, runtime });
  try {
    await vi.waitFor(() => expect(sseClientMock.connect).toHaveBeenCalledOnce());
    const foreignsSubscription = sseClientMock.subscribe.mock.calls
      .map(([subscription]) => subscription)
      .find(({ app, path }) => app === "groups" && path === "/v1/foreigns");
    if (!foreignsSubscription) {
      throw new Error("expected foreigns subscription");
    }
    sseClientMock.poke.mockClear();

    const inviteEvent = {
      "~bus/private": { invites: [{ valid: true, from: "~bus" }] },
    };
    sseClientMock.poke.mockRejectedValueOnce(new Error("approval save failed"));
    await expect(foreignsSubscription.event(inviteEvent)).rejects.toThrow("approval save failed");
    await foreignsSubscription.event(inviteEvent);

    const pendingWrites = sseClientMock.poke.mock.calls.filter(
      ([payload]) => payload.json?.["put-entry"]?.["entry-key"] === "pendingApprovals",
    );
    expect(pendingWrites).toHaveLength(2);
    expect(sseClientMock.poke).toHaveBeenCalledTimes(3);
    expect(sseClientMock.poke.mock.calls[2]?.[0]).toMatchObject({
      app: "chat",
      mark: "chat-dm-action",
    });
  } finally {
    controller.abort();
    await monitor;
  }
});

it("continues startup after an initial group invite write fails", async () => {
  const controller = new AbortController();
  const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } satisfies RuntimeEnv;
  authenticateMock.mockResolvedValueOnce("urbauth-~zod=proof");
  settingsManagerMock.load.mockResolvedValueOnce({
    autoAcceptGroupInvites: true,
    autoDiscoverChannels: true,
  });
  sseClientMock.scry.mockImplementation(async (path) =>
    path === "/groups-ui/v6/init.json"
      ? {
          foreigns: {
            "~nec/startup": { invites: [{ valid: true, from: "~nec" }] },
          },
        }
      : {},
  );
  sseClientMock.poke.mockImplementation(async (payload) => {
    if (payload.mark === "group-join") {
      throw new Error("initial group join failed");
    }
  });

  const monitor = monitorTlonProvider({ abortSignal: controller.signal, runtime });
  try {
    await vi.waitFor(() => expect(sseClientMock.connect).toHaveBeenCalledOnce());
    expect(sseClientMock.subscribe.mock.calls.map(([subscription]) => subscription)).toEqual(
      expect.arrayContaining([expect.objectContaining({ app: "groups", path: "/v1/foreigns" })]),
    );
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("initial group join failed"),
    );
  } finally {
    controller.abort();
    await monitor;
    sseClientMock.scry.mockReset().mockResolvedValue({});
    sseClientMock.poke.mockReset().mockResolvedValue(undefined);
  }
});

describe("monitorTlonProvider inbound media truth", () => {
  it.each([
    {
      name: "a failed download beside successful images",
      imageCount: 3,
      failedIndexes: [1],
      expectedAttachments: 2,
      expectedNotice: "[tlon attachment unavailable]",
    },
    {
      name: "images beyond the eight-image cap",
      imageCount: 10,
      failedIndexes: [],
      expectedAttachments: 8,
      expectedNotice: "[tlon 2 attachments unavailable]",
    },
  ])(
    "reports $name to the model without changing command text",
    async ({ imageCount, failedIndexes, expectedAttachments, expectedNotice }) => {
      const controller = new AbortController();
      const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } satisfies RuntimeEnv;
      authenticateMock.mockResolvedValueOnce("urbauth-~zod=proof");
      ingressMock.receive.mockResolvedValueOnce({ kind: "ignored" });
      saveRemoteMediaMock.mockImplementation(async ({ url }) => {
        const index = Number(new URL(url).pathname.slice(1, -4));
        if (failedIndexes.includes(index)) {
          throw new Error("download failed");
        }
        return {
          id: `photo-${index}.png`,
          path: `/tmp/openclaw/media/inbound/photo-${index}.png`,
          size: 10,
          contentType: "image/png",
        };
      });
      const content = [
        { inline: ["/status"] },
        ...Array.from({ length: imageCount }, (_, index) => ({
          block: { image: { src: `https://example.com/${index}.png` } },
        })),
      ];
      const originalText = extractMessageText(content);
      const expectedMedia = Array.from({ length: Math.min(imageCount, 8) }, (_, index) => index)
        .filter((index) => !failedIndexes.includes(index))
        .map((index) => ({
          path: `/tmp/openclaw/media/inbound/photo-${index}.png`,
          contentType: "image/png",
        }));
      const expectedMediaPrompt = [
        ...expectedMedia.map(
          ({ path, contentType }) => `[media attached: ${path} (${contentType}) | ${path}]`,
        ),
        originalText,
      ].join("\n");

      const monitor = monitorTlonProvider({ abortSignal: controller.signal, runtime });
      try {
        await vi.waitFor(() => expect(sseClientMock.connect).toHaveBeenCalledOnce());
        const chatSubscription = sseClientMock.subscribe.mock.calls
          .map(([subscription]) => subscription)
          .find((subscription) => subscription.app === "chat");
        if (!chatSubscription) {
          throw new Error("expected chat subscription");
        }
        await chatSubscription.event({
          whom: "~nec",
          id: `dm-media-${imageCount}`,
          response: {
            add: {
              essay: {
                author: "~nec",
                content,
                sent: 1_700_000_000_000,
              },
            },
          },
        });

        expect(createChannelInboundEnvelopeBuilderMock).toHaveBeenCalledOnce();
        expect(createChannelInboundEnvelopeBuilderMock).toHaveBeenCalledWith({
          cfg: {
            channels: {
              tlon: {
                code: "code",
                network: { dangerouslyAllowPrivateNetwork: true },
                ownerShip: "~nec",
                ship: "~zod",
                url: "https://urbit.example.com",
              },
            },
          },
          route: {
            accountId: "default",
            agentId: "main",
            dmScope: "main",
            sessionKey: "agent:main:main",
          },
        });
        expect(buildChannelInboundEnvelopeMock).toHaveBeenCalledOnce();
        expect(buildChannelInboundEnvelopeMock).toHaveBeenCalledWith({
          body: expectedMediaPrompt,
          channel: "Tlon",
          from: "~nec [owner]",
          timestamp: 1_700_000_000_000,
        });
        expect(formatInboundMediaUnavailableTextMock).toHaveBeenCalledWith({
          body: originalText,
          notice: expectedNotice,
        });
        expect(inboundRuntimeMock.buildContext).toHaveBeenCalledOnce();
        const buildContextCall = inboundRuntimeMock.buildContext.mock.calls[0];
        if (!buildContextCall) {
          throw new Error("expected inbound context call");
        }
        const [contextInput] = buildContextCall;
        expect(contextInput.message).toMatchObject({
          body: "tlon-envelope",
          bodyForAgent: "formatted-inbound-body",
          commandBody: originalText,
          rawBody: originalText,
        });
        expect(contextInput.extra.Attachments).toHaveLength(expectedAttachments);
        expect(contextInput.extra.Attachments).toEqual(expectedMedia);

        expect(inboundRuntimeMock.dispatch).toHaveBeenCalledOnce();
        const dispatchCall = inboundRuntimeMock.dispatch.mock.calls[0];
        if (!dispatchCall) {
          throw new Error("expected inbound dispatch call");
        }
        const [{ ctxPayload, replyOptions }] = dispatchCall;
        expect(contextInput).not.toBe(builtInboundContextPayload);
        expect(ctxPayload).toBe(builtInboundContextPayload);
        expect(replyOptions.media).toHaveLength(expectedAttachments);
        expect(replyOptions.media).toEqual(expectedMedia);
      } finally {
        controller.abort();
        await monitor;
      }
    },
  );
});

describe("monitorTlonProvider shutdown", () => {
  it("does not authenticate when the shutdown signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } satisfies RuntimeEnv;

    await expect(monitorTlonProvider({ abortSignal: controller.signal, runtime })).rejects.toThrow(
      "Aborted while waiting to authenticate",
    );

    expect(authenticateMock).not.toHaveBeenCalled();
    expect(ingressMock.start).not.toHaveBeenCalled();
  });

  it("settles and runs cleanup when abort fires while api.connect() is pending", async () => {
    // Cancellation during async startup must replay when the SSE connection settles.
    const controller = new AbortController();
    const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } satisfies RuntimeEnv;
    authenticateMock.mockResolvedValueOnce("urbauth-~zod=proof");

    let resolveConnect!: (value: undefined) => void;
    sseClientMock.connect.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          resolveConnect = resolve;
        }),
    );

    const monitor = monitorTlonProvider({ abortSignal: controller.signal, runtime });
    await vi.waitFor(() => expect(sseClientMock.connect).toHaveBeenCalledOnce());
    controller.abort();
    resolveConnect(undefined);

    await expect(monitor).resolves.toBeUndefined();
    expect(sseClientMock.stopReceiving).toHaveBeenCalledOnce();
    expect(sseClientMock.close).toHaveBeenCalledOnce();
    expect(ingressMock.stop).toHaveBeenCalledOnce();
  });

  it("settles and cleans up when startup aborts before the shutdown listener is registered", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } satisfies RuntimeEnv;
    authenticateMock.mockResolvedValueOnce("urbauth-~zod=proof");
    sseClientMock.connect.mockImplementationOnce(async () => {
      controller.abort();
    });

    let settled = false;
    const monitor = monitorTlonProvider({ abortSignal: controller.signal, runtime }).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(sseClientMock.connect).toHaveBeenCalledOnce();
    expect(ingressMock.start).toHaveBeenCalledOnce();
    expect(settled).toBe(true);
    expect(sseClientMock.stopReceiving).toHaveBeenCalledOnce();
    expect(ingressMock.stop).toHaveBeenCalledOnce();
    expect(sseClientMock.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await monitor;
  });

  it("cleans up when the active SSE monitor is aborted after startup", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } satisfies RuntimeEnv;
    authenticateMock.mockResolvedValueOnce("urbauth-~zod=proof");

    let settled = false;
    const monitor = monitorTlonProvider({ abortSignal: controller.signal, runtime }).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(sseClientMock.connect).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(true);
    expect(sseClientMock.stopReceiving).toHaveBeenCalledOnce();
    expect(ingressMock.stop).toHaveBeenCalledOnce();
    expect(sseClientMock.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await monitor;
  });

  it.each([
    { name: "abort during the SSE handshake", abortDuringHandshake: true },
    { name: "normal abort after the SSE connection", abortDuringHandshake: false },
  ])("cleans up real Urbit HTTP and SSE after $name", async ({ abortDuringHandshake }) => {
    const controller = new AbortController();
    const requests: string[] = [];
    const subscriptions: unknown[][] = [];
    const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } satisfies RuntimeEnv;
    const server = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      requests.push(`${req.method ?? "GET"} ${pathname}`);

      if (req.method === "POST" && pathname === "/~/login") {
        res.writeHead(200, {
          "Content-Type": "text/plain",
          "Set-Cookie": "urbauth-~zod=proof; Path=/",
        });
        res.end("ok");
        return;
      }
      if (req.method === "GET" && pathname.startsWith("/~/scry/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      if (req.method === "PUT" && pathname.startsWith("/~/channel/")) {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (part: string) => {
          body += part;
        });
        req.on("end", () => {
          subscriptions.push(JSON.parse(body) as unknown[]);
          res.writeHead(204);
          res.end();
        });
        return;
      }
      if (req.method === "GET" && pathname.startsWith("/~/channel/")) {
        if (abortDuringHandshake) {
          controller.abort();
        }
        res.writeHead(200, {
          "Cache-Control": "no-cache",
          "Content-Type": "text/event-stream",
        });
        res.write(": connected\n\n");
        return;
      }
      if (req.method === "DELETE" && pathname.startsWith("/~/channel/")) {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    runningServers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    realUrbitFixture.url = `http://127.0.0.1:${address.port}`;
    realUrbitFixture.enabled = true;
    const actualAuth = await vi.importActual<typeof import("../urbit/auth.js")>("../urbit/auth.js");
    authenticateMock.mockImplementationOnce(actualAuth.authenticate);

    const pollIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const monitor = monitorTlonProvider({ abortSignal: controller.signal, runtime });
    if (!abortDuringHandshake) {
      await vi.waitFor(() => expect(ingressMock.start).toHaveBeenCalledOnce());
      controller.abort();
    }

    let deadline: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      monitor.then(() => "settled" as const),
      new Promise<"timed out">((resolve) => {
        deadline = setTimeout(() => resolve("timed out"), 1_500);
      }),
    ]);
    clearTimeout(deadline);
    if (outcome === "timed out") {
      for (const [index, [, delay]] of pollIntervalSpy.mock.calls.entries()) {
        if (delay === 120_000) {
          clearInterval(pollIntervalSpy.mock.results[index]?.value);
        }
      }
      const realClient = realUrbitFixture.client;
      if (realClient) {
        realClient.stopReceiving();
        await realClient.close();
        realUrbitFixture.client = null;
      }
    } else {
      realUrbitFixture.client = null;
    }
    expect(requests).toContain("POST /~/login");
    expect(requests.some((request) => request.startsWith("GET /~/scry/"))).toBe(true);
    expect(requests.some((request) => request.startsWith("GET /~/channel/"))).toBe(true);
    expect(requests.some((request) => request.startsWith("DELETE /~/channel/"))).toBe(true);
    expect(subscriptions.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "subscribe", app: "channels" }),
        expect.objectContaining({ action: "subscribe", app: "chat" }),
      ]),
    );
    expect(ingressMock.start).toHaveBeenCalledOnce();
    if (outcome === "settled") {
      expect(ingressMock.stop).toHaveBeenCalledOnce();
    }
    expect(outcome).toBe("settled");
    pollIntervalSpy.mockRestore();
  });
});
