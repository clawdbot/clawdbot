// Zalo tests cover monitor.polling.media reply plugin behavior.
import type { ServerResponse } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createEmptyPluginRegistry,
  createRuntimeEnv,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../runtime-api.js";
import { setZaloRuntime } from "./runtime.js";
import {
  createLifecycleMonitorSetup,
  createTextUpdate,
  settleAsyncWork,
} from "./test-support/lifecycle-test-support.js";
import {
  getUpdatesMock,
  loadCachedLifecycleMonitorModule,
  resetLifecycleTestState,
  sendPhotoMock,
  setLifecycleRuntimeCore,
} from "./test-support/monitor-mocks-test-support.js";

const prepareHostedZaloMediaUrlMock = vi.fn();

vi.mock("./outbound-media.js", async () => {
  const actual = await vi.importActual<typeof import("./outbound-media.js")>("./outbound-media.js");
  return {
    ...actual,
    prepareHostedZaloMediaUrl: (...args: unknown[]) => prepareHostedZaloMediaUrlMock(...args),
  };
});

import { clearHostedZaloMediaForTest } from "./outbound-media.js";

function installZaloRuntimeForTest(): void {
  setZaloRuntime({
    state: {
      openKeyedStore: <T>(options: OpenKeyedStoreOptions) =>
        createPluginStateKeyedStoreForTests<T>("zalo", options),
    },
  } as unknown as PluginRuntime);
}

async function writeHostedZaloMediaFixture(params: {
  id: string;
  routePath: string;
  token: string;
  buffer: Buffer;
  contentType?: string;
}): Promise<void> {
  const metaStore = createPluginStateKeyedStoreForTests("zalo", {
    namespace: "hosted-outbound-media",
    maxEntries: 80,
  });
  const chunkStore = createPluginStateKeyedStoreForTests("zalo", {
    namespace: "hosted-outbound-media-chunks",
    maxEntries: 16_384,
  });
  await chunkStore.register(`media:${params.id}:chunk:0000`, {
    id: params.id,
    index: 0,
    dataBase64: params.buffer.toString("base64"),
  });
  await metaStore.register(`media:${params.id}:meta`, {
    id: params.id,
    routePath: params.routePath,
    token: params.token,
    ...(params.contentType ? { contentType: params.contentType } : {}),
    expiresAt: Date.now() + 60_000,
    chunkCount: 1,
    byteLength: params.buffer.byteLength,
  });
}

function createHostedMediaResponse() {
  const headers = new Map<string, string>();
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader(name: string, value: string) {
      headers.set(name, value);
    },
    end: vi.fn((body?: unknown) => {
      res.headersSent = true;
      return body;
    }),
  };
  return { headers, res: res as unknown as ServerResponse & { end: ReturnType<typeof vi.fn> } };
}

function countMatching<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  let count = 0;
  for (const item of items) {
    if (predicate(item)) {
      count += 1;
    }
  }
  return count;
}

describe("Zalo polling media replies", () => {
  const finalizeInboundContextMock = vi.fn((ctx: Record<string, unknown>) => ctx);
  const recordInboundSessionMock = vi.fn(async () => undefined);
  const resolveAgentRouteMock = vi.fn(() => ({
    agentId: "main",
    channel: "zalo",
    accountId: "acct-zalo-polling-media",
    sessionKey: "agent:main:zalo:direct:dm-chat-1",
    mainSessionKey: "agent:main:main",
    matchedBy: "default",
  }));
  const dispatchReplyWithBufferedBlockDispatcherMock = vi.fn();

  beforeAll(async () => {
    await loadCachedLifecycleMonitorModule("zalo-polling-media-reply");
  });

  beforeEach(async () => {
    await resetLifecycleTestState();
    await clearHostedZaloMediaForTest();
    resetPluginStateStoreForTests();
    installZaloRuntimeForTest();
    prepareHostedZaloMediaUrlMock.mockReset();
    prepareHostedZaloMediaUrlMock.mockResolvedValue(
      "https://example.com/hooks/zalo/media/abc123abc123abc123abc123?token=secret",
    );
    dispatchReplyWithBufferedBlockDispatcherMock.mockReset();
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementation(
      async (params: {
        dispatcherOptions: {
          deliver: (payload: { text: string; mediaUrl: string }) => Promise<void>;
        };
      }) => {
        await params.dispatcherOptions.deliver({
          text: "caption text",
          mediaUrl: "https://example.com/reply-image.png",
        });
      },
    );
    setLifecycleRuntimeCore({
      routing: {
        resolveAgentRoute:
          resolveAgentRouteMock as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
      },
      reply: {
        finalizeInboundContext:
          finalizeInboundContextMock as unknown as PluginRuntime["channel"]["reply"]["finalizeInboundContext"],
        dispatchReplyWithBufferedBlockDispatcher:
          dispatchReplyWithBufferedBlockDispatcherMock as unknown as PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"],
      },
      session: {
        recordInboundSession:
          recordInboundSessionMock as unknown as PluginRuntime["channel"]["session"]["recordInboundSession"],
      },
    });
  });

  afterAll(async () => {
    await clearHostedZaloMediaForTest();
    await resetLifecycleTestState();
  });

  it("hosts and sends media replies while polling when a webhook URL is configured", async () => {
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);
    getUpdatesMock
      .mockResolvedValueOnce({
        ok: true,
        result: createTextUpdate({
          messageId: "polling-media-1",
          userId: "user-1",
          userName: "User One",
          chatId: "dm-chat-1",
          text: "send media",
        }),
      })
      .mockImplementation(() => new Promise(() => {}));

    const { monitorZaloProvider } = await loadCachedLifecycleMonitorModule(
      "zalo-polling-media-reply",
    );
    const abort = new AbortController();
    const runtime = createRuntimeEnv();
    const { account, config } = createLifecycleMonitorSetup({
      accountId: "acct-zalo-polling-media",
      dmPolicy: "open",
      webhookUrl: "https://example.com/hooks/zalo",
    });
    const run = monitorZaloProvider({
      token: "zalo-token",
      account,
      config,
      runtime,
      abortSignal: abort.signal,
    });

    try {
      await settleAsyncWork();
      expect(sendPhotoMock).toHaveBeenCalledTimes(1);

      expect(registry.httpRoutes).toHaveLength(1);
      expect(prepareHostedZaloMediaUrlMock).toHaveBeenCalledWith({
        mediaUrl: "https://example.com/reply-image.png",
        webhookUrl: "https://example.com/hooks/zalo",
        webhookPath: "/hooks/zalo",
        maxBytes: 5 * 1024 * 1024,
        proxyUrl: undefined,
      });
      expect(sendPhotoMock).toHaveBeenCalledWith(
        "zalo-token",
        {
          chat_id: "dm-chat-1",
          photo: "https://example.com/hooks/zalo/media/abc123abc123abc123abc123?token=secret",
          caption: "caption text",
        },
        undefined,
      );
    } finally {
      abort.abort();
      await run;
    }

    expect(registry.httpRoutes).toHaveLength(0);
  });

  it("sends media replies directly when webhook hosting is not configured", async () => {
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);
    getUpdatesMock
      .mockResolvedValueOnce({
        ok: true,
        result: createTextUpdate({
          messageId: "polling-media-2",
          userId: "user-2",
          userName: "User Two",
          chatId: "dm-chat-2",
          text: "send media directly",
        }),
      })
      .mockImplementation(() => new Promise(() => {}));

    const { monitorZaloProvider } = await loadCachedLifecycleMonitorModule(
      "zalo-polling-media-reply",
    );
    const abort = new AbortController();
    const runtime = createRuntimeEnv();
    const { account, config } = createLifecycleMonitorSetup({
      accountId: "acct-zalo-polling-direct-media",
      dmPolicy: "open",
      webhookUrl: "",
    });
    const run = monitorZaloProvider({
      token: "zalo-token",
      account,
      config,
      runtime,
      abortSignal: abort.signal,
    });

    try {
      await settleAsyncWork();
      expect(sendPhotoMock).toHaveBeenCalledTimes(1);

      expect(prepareHostedZaloMediaUrlMock).not.toHaveBeenCalled();
      expect(sendPhotoMock).toHaveBeenCalledWith(
        "zalo-token",
        {
          chat_id: "dm-chat-2",
          photo: "https://example.com/reply-image.png",
          caption: "caption text",
        },
        undefined,
      );
    } finally {
      abort.abort();
      await run;
    }
  });

  it("shares one hosted media route across accounts on the same path", async () => {
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);
    getUpdatesMock.mockImplementation(() => new Promise(() => {}));

    const { monitorZaloProvider } = await loadCachedLifecycleMonitorModule(
      "zalo-polling-media-reply",
    );
    const firstAbort = new AbortController();
    const firstRuntime = createRuntimeEnv();
    const firstSetup = createLifecycleMonitorSetup({
      accountId: "acct-zalo-polling-media-one",
      dmPolicy: "open",
      webhookUrl: "https://example.com/hooks/zalo",
    });
    const firstRun = monitorZaloProvider({
      token: "zalo-token-one",
      account: firstSetup.account,
      config: firstSetup.config,
      runtime: firstRuntime,
      abortSignal: firstAbort.signal,
    });

    const secondAbort = new AbortController();
    let secondRun: Promise<void> | undefined;

    try {
      await settleAsyncWork();
      const firstHostedMediaRoutes = registry.httpRoutes.filter(
        (route) => route.source === "zalo-hosted-media",
      );
      expect(firstHostedMediaRoutes).toHaveLength(1);
      const hostedMediaRoute = expectDefined(firstHostedMediaRoutes[0], "Zalo hosted-media route");
      expect(hostedMediaRoute?.path).toBe("/hooks/zalo/media");
      expect(hostedMediaRoute?.pluginId).toBe("zalo");
      expect(hostedMediaRoute?.source).toBe("zalo-hosted-media");
      expect(hostedMediaRoute?.handler).toBeTypeOf("function");

      const secondRuntime = createRuntimeEnv();
      const secondSetup = createLifecycleMonitorSetup({
        accountId: "acct-zalo-polling-media-two",
        dmPolicy: "open",
        webhookUrl: "https://example.com/hooks/zalo",
      });
      secondRun = monitorZaloProvider({
        token: "zalo-token-two",
        account: secondSetup.account,
        config: secondSetup.config,
        runtime: secondRuntime,
        abortSignal: secondAbort.signal,
      });

      await settleAsyncWork();
      const hostedMediaRoutes = registry.httpRoutes.filter(
        (route) => route.source === "zalo-hosted-media",
      );
      expect(hostedMediaRoutes).toHaveLength(1);
      expect(hostedMediaRoutes[0]).toBe(hostedMediaRoute);

      await writeHostedZaloMediaFixture({
        id: "abc123abc123abc123abc123",
        routePath: "/hooks/zalo/media/",
        token: "route-token-one",
        buffer: Buffer.from("first-image-bytes"),
        contentType: "image/png",
      });
      const firstFetch = createHostedMediaResponse();
      await hostedMediaRoute.handler(
        {
          method: "GET",
          url: "/hooks/zalo/media/abc123abc123abc123abc123?token=route-token-one",
        } as never,
        firstFetch.res as never,
      );
      expect(firstFetch.res.statusCode).toBe(200);
      expect(firstFetch.headers.get("Content-Type")).toBe("image/png");
      expect(firstFetch.headers.get("Cache-Control")).toBe("no-store");
      expect(firstFetch.res.end).toHaveBeenCalledWith(Buffer.from("first-image-bytes"));

      firstAbort.abort();
      await firstRun;
      expect(registry.httpRoutes.find((route) => route.source === "zalo-hosted-media")).toEqual(
        hostedMediaRoute,
      );
      expect(
        countMatching(registry.httpRoutes, (route) => route.source === "zalo-hosted-media"),
      ).toBe(1);

      await writeHostedZaloMediaFixture({
        id: "def456def456def456def456",
        routePath: "/hooks/zalo/media/",
        token: "route-token-two",
        buffer: Buffer.from("second-image-bytes"),
        contentType: "image/jpeg",
      });
      const secondFetch = createHostedMediaResponse();
      await hostedMediaRoute.handler(
        {
          method: "GET",
          url: "/hooks/zalo/media/def456def456def456def456?token=route-token-two",
        } as never,
        secondFetch.res as never,
      );
      expect(secondFetch.res.statusCode).toBe(200);
      expect(secondFetch.headers.get("Content-Type")).toBe("image/jpeg");
      expect(secondFetch.res.end).toHaveBeenCalledWith(Buffer.from("second-image-bytes"));
    } finally {
      firstAbort.abort();
      secondAbort.abort();
      await firstRun;
      await secondRun;
    }

    expect(
      registry.httpRoutes.filter((route) => route.source === "zalo-hosted-media"),
    ).toHaveLength(0);
  });

  it("re-registers the hosted media route after the active registry swaps", async () => {
    const firstRegistry = createEmptyPluginRegistry();
    setActivePluginRegistry(firstRegistry);
    getUpdatesMock.mockImplementation(() => new Promise(() => {}));

    const { monitorZaloProvider } = await loadCachedLifecycleMonitorModule(
      "zalo-polling-media-reply",
    );
    const firstAbort = new AbortController();
    const firstRuntime = createRuntimeEnv();
    const { account, config } = createLifecycleMonitorSetup({
      accountId: "acct-zalo-polling-media",
      dmPolicy: "open",
      webhookUrl: "https://example.com/hooks/zalo",
    });
    const firstRun = monitorZaloProvider({
      token: "zalo-token",
      account,
      config,
      runtime: firstRuntime,
      abortSignal: firstAbort.signal,
    });

    const secondRegistry = createEmptyPluginRegistry();
    const secondAbort = new AbortController();
    const secondRuntime = createRuntimeEnv();
    let secondRun: Promise<void> | undefined;

    try {
      await settleAsyncWork();
      expect(firstRegistry.httpRoutes).toHaveLength(1);

      setActivePluginRegistry(secondRegistry);
      secondRun = monitorZaloProvider({
        token: "zalo-token",
        account,
        config,
        runtime: secondRuntime,
        abortSignal: secondAbort.signal,
      });

      await settleAsyncWork();
      expect(secondRegistry.httpRoutes).toHaveLength(1);
    } finally {
      firstAbort.abort();
      secondAbort.abort();
      await firstRun;
      await secondRun;
    }

    expect(firstRegistry.httpRoutes).toHaveLength(0);
    expect(secondRegistry.httpRoutes).toHaveLength(0);
  });
});
