// Googlechat tests cover monitor.reply delivery plugin behavior.
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { GoogleChatApiError } from "./api.js";
import type { GoogleChatCoreRuntime, GoogleChatRuntimeEnv } from "./monitor-types.js";

const mocks = vi.hoisted(() => ({
  deleteGoogleChatMessage: vi.fn(),
  sendGoogleChatMessage: vi.fn(),
  updateGoogleChatMessage: vi.fn(),
}));

vi.mock("./api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api.js")>()),
  deleteGoogleChatMessage: mocks.deleteGoogleChatMessage,
  sendGoogleChatMessage: mocks.sendGoogleChatMessage,
  updateGoogleChatMessage: mocks.updateGoogleChatMessage,
}));

const account = {
  accountId: "default",
  enabled: true,
  credentialSource: "inline",
  config: {},
} as ResolvedGoogleChatAccount;

const config = {} as OpenClawConfig;

function createCore(params?: {
  chunks?: readonly string[];
  media?: { buffer: Buffer; contentType?: string; fileName?: string };
}) {
  return {
    channel: {
      text: {
        resolveChunkMode: vi.fn(() => "markdown"),
        chunkMarkdownTextWithMode: vi.fn((text: string) => params?.chunks ?? [text]),
      },
      media: {
        readRemoteMediaBuffer: vi.fn(async () => params?.media ?? { buffer: Buffer.from("image") }),
      },
    },
  } as unknown as GoogleChatCoreRuntime;
}

function createRuntime() {
  return {
    error: vi.fn(),
    log: vi.fn(),
  } satisfies GoogleChatRuntimeEnv;
}

let createGoogleChatTypingMessage: typeof import("./monitor-reply-delivery.js").createGoogleChatTypingMessage;
let deliverGoogleChatReply: typeof import("./monitor-reply-delivery.js").deliverGoogleChatReply;

beforeEach(async () => {
  vi.clearAllMocks();
  ({ createGoogleChatTypingMessage, deliverGoogleChatReply } =
    await import("./monitor-reply-delivery.js"));
});

afterAll(() => {
  vi.doUnmock("./api.js");
  vi.resetModules();
});

describe("Google Chat reply delivery", () => {
  it("does not resend the first chunk when the typing update result is ambiguous", async () => {
    const core = createCore({ chunks: ["first chunk", "second chunk"] });
    const runtime = createRuntime();
    const statusSink = vi.fn();
    const updateError = new Error("response lost");
    mocks.updateGoogleChatMessage.mockRejectedValueOnce(updateError);

    await expect(
      deliverGoogleChatReply({
        payload: { text: "first chunk\n\nsecond chunk", replyToId: "spaces/AAA/threads/root" },
        account,
        spaceId: "spaces/AAA",
        runtime,
        core,
        config,
        statusSink,
        typingMessage: {
          placement: "thread",
          name: "spaces/AAA/messages/typing",
          requestedThreadName: "spaces/AAA/threads/root",
          deliveredThreadName: "spaces/AAA/threads/root",
        },
      }),
    ).rejects.toBe(updateError);

    expect(mocks.updateGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: "spaces/AAA/messages/typing",
      text: "first chunk",
    });
    expect(mocks.sendGoogleChatMessage).not.toHaveBeenCalled();
    expect(statusSink).not.toHaveBeenCalled();
  });

  it("sends the first chunk after a confirmed missing typing placeholder", async () => {
    const core = createCore({ chunks: ["first chunk", "second chunk"] });
    mocks.updateGoogleChatMessage.mockRejectedValueOnce(
      new GoogleChatApiError(404, "Google Chat API 404: message not found"),
    );

    await deliverGoogleChatReply({
      payload: { text: "two chunks", replyToId: "spaces/AAA/threads/root" },
      account,
      spaceId: "spaces/AAA",
      runtime: createRuntime(),
      core,
      config,
      typingMessage: createGoogleChatTypingMessage({
        messageName: "spaces/AAA/messages/typing",
        requestedThreadName: "spaces/AAA/threads/root",
        deliveredThreadName: "spaces/AAA/threads/root",
      }),
    });

    expect(mocks.sendGoogleChatMessage.mock.calls.map((call) => call[0]?.text)).toEqual([
      "first chunk",
      "second chunk",
    ]);
  });

  it("continues later chunks in the provider fallback thread", async () => {
    const core = createCore({ chunks: ["first chunk", "second chunk"] });
    const runtime = createRuntime();
    mocks.sendGoogleChatMessage
      .mockResolvedValueOnce({
        messageName: "spaces/AAA/messages/first",
        threadName: "spaces/AAA/threads/fallback",
      })
      .mockResolvedValueOnce({
        messageName: "spaces/AAA/messages/second",
        threadName: "spaces/AAA/threads/fallback",
      });

    await deliverGoogleChatReply({
      payload: { text: "two chunks", replyToId: "spaces/AAA/threads/requested" },
      account,
      spaceId: "spaces/AAA",
      runtime,
      core,
      config,
    });

    expect(mocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(1, {
      account,
      space: "spaces/AAA",
      text: "first chunk",
      thread: "spaces/AAA/threads/requested",
    });
    expect(mocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(2, {
      account,
      space: "spaces/AAA",
      text: "second chunk",
      thread: "spaces/AAA/threads/fallback",
    });
  });

  it("continues after a fallback typing placeholder in its delivered thread", async () => {
    const core = createCore({ chunks: ["first chunk", "second chunk"] });
    const runtime = createRuntime();
    mocks.sendGoogleChatMessage.mockResolvedValueOnce({
      messageName: "spaces/AAA/messages/second",
      threadName: "spaces/AAA/threads/fallback",
    });

    await deliverGoogleChatReply({
      payload: { text: "two chunks", replyToId: "spaces/AAA/threads/requested" },
      account,
      spaceId: "spaces/AAA",
      runtime,
      core,
      config,
      typingMessage: createGoogleChatTypingMessage({
        messageName: "spaces/AAA/messages/typing",
        requestedThreadName: "spaces/AAA/threads/requested",
        deliveredThreadName: "spaces/AAA/threads/fallback",
      }),
    });

    expect(mocks.updateGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: "spaces/AAA/messages/typing",
      text: "first chunk",
    });
    expect(mocks.sendGoogleChatMessage).toHaveBeenCalledOnce();
    expect(mocks.sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/AAA",
      text: "second chunk",
      thread: "spaces/AAA/threads/fallback",
    });
  });

  it("keeps the requested thread when the provider omits thread metadata", async () => {
    const core = createCore({ chunks: ["first chunk", "second chunk"] });
    const runtime = createRuntime();
    mocks.sendGoogleChatMessage.mockResolvedValue({
      messageName: "spaces/AAA/messages/sent",
    });

    await deliverGoogleChatReply({
      payload: { text: "two chunks", replyToId: "spaces/AAA/threads/requested" },
      account,
      spaceId: "spaces/AAA",
      runtime,
      core,
      config,
    });

    expect(mocks.sendGoogleChatMessage).toHaveBeenCalledTimes(2);
    for (const call of mocks.sendGoogleChatMessage.mock.calls) {
      expect(call[0]?.thread).toBe("spaces/AAA/threads/requested");
    }
  });

  it("keeps top-level chunks top-level when Google returns a thread name", async () => {
    const core = createCore({ chunks: ["first chunk", "second chunk"] });
    const runtime = createRuntime();
    mocks.sendGoogleChatMessage.mockResolvedValue({
      messageName: "spaces/AAA/messages/sent",
      threadName: "spaces/AAA/threads/provider-created",
    });

    await deliverGoogleChatReply({
      payload: { text: "two top-level chunks" },
      account,
      spaceId: "spaces/AAA",
      runtime,
      core,
      config,
    });

    expect(mocks.sendGoogleChatMessage).toHaveBeenCalledTimes(2);
    for (const call of mocks.sendGoogleChatMessage.mock.calls) {
      expect(call[0]?.thread).toBeUndefined();
    }
  });

  it("rejects when a later text chunk send fails instead of dropping it silently", async () => {
    const core = createCore({ chunks: ["first chunk", "second chunk", "third chunk"] });
    const runtime = createRuntime();
    const sendError = new Error("API 500");
    mocks.sendGoogleChatMessage
      .mockResolvedValueOnce({ messageName: "spaces/AAA/messages/one" })
      .mockRejectedValueOnce(sendError);

    await expect(
      deliverGoogleChatReply({
        payload: { text: "three chunks", replyToId: "spaces/AAA/threads/root" },
        account,
        spaceId: "spaces/AAA",
        runtime,
        core,
        config,
      }),
    ).rejects.toBe(sendError);

    expect(mocks.sendGoogleChatMessage).toHaveBeenCalledTimes(2);
  });

  it("replaces a typing message when the final reply target changed", async () => {
    const core = createCore();
    const runtime = createRuntime();
    mocks.sendGoogleChatMessage.mockResolvedValue({ messageName: "spaces/AAA/messages/reply" });

    await deliverGoogleChatReply({
      payload: { text: "top-level reply" },
      account,
      spaceId: "spaces/AAA",
      runtime,
      core,
      config,
      typingMessage: {
        placement: "thread",
        name: "spaces/AAA/messages/typing",
        requestedThreadName: "spaces/AAA/threads/root",
        deliveredThreadName: "spaces/AAA/threads/root",
      },
    });

    expect(mocks.deleteGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: "spaces/AAA/messages/typing",
    });
    expect(mocks.updateGoogleChatMessage).not.toHaveBeenCalled();
    expect(mocks.sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/AAA",
      text: "top-level reply",
      thread: undefined,
    });
  });

  it("uses text fallback without loading outbound media", async () => {
    const core = createCore({
      media: { buffer: Buffer.from("image"), contentType: "image/png", fileName: "reply.png" },
    });
    const runtime = createRuntime();

    await deliverGoogleChatReply({
      payload: {
        text: "caption",
        mediaUrl: "https://example.invalid/reply.png",
        replyToId: "spaces/AAA/threads/root",
      },
      account,
      spaceId: "spaces/AAA",
      runtime,
      core,
      config,
      typingMessage: {
        placement: "thread",
        name: "spaces/AAA/messages/typing",
        requestedThreadName: "spaces/AAA/threads/root",
        deliveredThreadName: "spaces/AAA/threads/root",
      },
    });

    expect(mocks.updateGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: "spaces/AAA/messages/typing",
      text: "caption",
    });
    expect(core.channel.media.readRemoteMediaBuffer).not.toHaveBeenCalled();
    expect(mocks.deleteGoogleChatMessage).not.toHaveBeenCalled();
    expect(mocks.sendGoogleChatMessage).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      "Google Chat outbound attachments require user OAuth and are not supported by this service-account channel; sending text fallback only.",
    );
  });

  it("cleans up typing and rejects media-only replies without provider upload access", async () => {
    const core = createCore();
    const runtime = createRuntime();

    await expect(
      deliverGoogleChatReply({
        payload: {
          mediaUrl: "https://example.invalid/reply.png",
          replyToId: "spaces/AAA/threads/root",
        },
        account,
        spaceId: "spaces/AAA",
        runtime,
        core,
        config,
        typingMessage: {
          placement: "thread",
          name: "spaces/AAA/messages/typing",
          requestedThreadName: "spaces/AAA/threads/root",
          deliveredThreadName: "spaces/AAA/threads/root",
        },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof PlatformMessageNotDispatchedError &&
        !error.retryable &&
        error.message ===
          "Google Chat outbound attachments require user OAuth and no text fallback is available.",
    );

    expect(mocks.deleteGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: "spaces/AAA/messages/typing",
    });
    expect(core.channel.media.readRemoteMediaBuffer).not.toHaveBeenCalled();
    expect(mocks.updateGoogleChatMessage).not.toHaveBeenCalled();
    expect(mocks.sendGoogleChatMessage).not.toHaveBeenCalled();
  });
});
