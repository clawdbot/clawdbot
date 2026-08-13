// Tlon monitor tests cover authentication, inbound context, and shutdown lifecycle.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import { saveRemoteMedia } from "openclaw/plugin-sdk/media-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  authenticateMock,
  sleepWithAbortMock,
  sseClientMock,
  ingressMock,
  inboundRuntimeMock,
  settingsManagerMock,
  realUrbitFixture,
} = vi.hoisted(() => ({
  authenticateMock: vi.fn(),
  sleepWithAbortMock: vi.fn(),
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

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return {
    ...actual,
    sleepWithAbort: sleepWithAbortMock,
  };
});

vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>();
  return { ...actual, saveRemoteMedia: vi.fn() };
});

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

const saveRemoteMediaMock = vi.mocked(saveRemoteMedia);

beforeEach(() => {
  inboundRuntimeMock.buildContext.mockImplementation(buildChannelInboundEventContext);
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

        expect(inboundRuntimeMock.dispatch).toHaveBeenCalledOnce();
        const dispatchCall = inboundRuntimeMock.dispatch.mock.calls[0];
        if (!dispatchCall) {
          throw new Error("expected inbound dispatch call");
        }
        const [{ ctxPayload, replyOptions }] = dispatchCall;
        expect(ctxPayload.BodyForAgent).toBe(`${originalText}\n\n${expectedNotice}`);
        expect(ctxPayload.RawBody).toBe(originalText);
        expect(ctxPayload.CommandBody).toBe(originalText);
        expect(ctxPayload.BodyForCommands).toBe(originalText);
        expect(ctxPayload.Attachments).toHaveLength(expectedAttachments);
        expect(replyOptions.media).toHaveLength(expectedAttachments);
        expect(replyOptions.media).toEqual(
          Array.from({ length: Math.min(imageCount, 8) }, (_, index) => index)
            .filter((index) => !failedIndexes.includes(index))
            .map((index) => ({
              path: `/tmp/openclaw/media/inbound/photo-${index}.png`,
              contentType: "image/png",
            })),
        );
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
