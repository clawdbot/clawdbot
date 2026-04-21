import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../../src/plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../../src/plugins/runtime.js";
import { createRuntimeEnv } from "../../../test/helpers/plugins/runtime-env.js";
import type { PluginRuntime } from "../runtime-api.js";
import {
  createLifecycleMonitorSetup,
  createTextUpdate,
} from "../test-support/lifecycle-test-support.js";
import {
  getUpdatesMock,
  loadLifecycleMonitorModule,
  resetLifecycleTestState,
  sendPhotoMock,
  setLifecycleRuntimeCore,
} from "../test-support/monitor-mocks-test-support.js";

const prepareHostedZaloMediaUrlMock = vi.fn();

vi.mock("./outbound-media.js", async () => {
  const actual = await vi.importActual<typeof import("./outbound-media.js")>("./outbound-media.js");
  return {
    ...actual,
    prepareHostedZaloMediaUrl: (...args: unknown[]) => prepareHostedZaloMediaUrlMock(...args),
  };
});

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

  beforeEach(async () => {
    await resetLifecycleTestState();
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

  afterEach(async () => {
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

    const { monitorZaloProvider } = await loadLifecycleMonitorModule();
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
      await vi.waitFor(() => expect(sendPhotoMock).toHaveBeenCalledTimes(1));

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

    const { monitorZaloProvider } = await loadLifecycleMonitorModule();
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
      await vi.waitFor(() => expect(sendPhotoMock).toHaveBeenCalledTimes(1));

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

  it("re-registers the hosted media route after the active registry swaps", async () => {
    const firstRegistry = createEmptyPluginRegistry();
    setActivePluginRegistry(firstRegistry);
    getUpdatesMock.mockImplementation(() => new Promise(() => {}));

    const { monitorZaloProvider } = await loadLifecycleMonitorModule();
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
      await vi.waitFor(() => expect(firstRegistry.httpRoutes).toHaveLength(1));

      setActivePluginRegistry(secondRegistry);
      secondRun = monitorZaloProvider({
        token: "zalo-token",
        account,
        config,
        runtime: secondRuntime,
        abortSignal: secondAbort.signal,
      });

      await vi.waitFor(() => expect(secondRegistry.httpRoutes).toHaveLength(1));
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
