// Googlechat tests cover monitor.reply delivery plugin behavior.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import type { GoogleChatCoreRuntime, GoogleChatRuntimeEnv } from "./monitor-types.js";

const mocks = vi.hoisted(() => ({
  deleteGoogleChatMessage: vi.fn(),
  sendGoogleChatMessage: vi.fn(),
  updateGoogleChatMessage: vi.fn(),
}));

vi.mock("./api.js", () => ({
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

let deliverGoogleChatReply: typeof import("./monitor-reply-delivery.js").deliverGoogleChatReply;

beforeEach(async () => {
  vi.clearAllMocks();
  ({ deliverGoogleChatReply } = await import("./monitor-reply-delivery.js"));
});

afterAll(() => {
  vi.doUnmock("./api.js");
  vi.resetModules();
});

describe("Google Chat reply delivery", () => {
  it("resends the first text chunk as a new message when typing update fails", async () => {
    const core = createCore({ chunks: ["first chunk", "second chunk"] });
    const runtime = createRuntime();
    const statusSink = vi.fn();
    mocks.updateGoogleChatMessage.mockRejectedValueOnce(new Error("message not found"));
    mocks.sendGoogleChatMessage.mockResolvedValue({ messageName: "spaces/AAA/messages/fallback" });

    await deliverGoogleChatReply({
      payload: { text: "first chunk\n\nsecond chunk", replyToId: "spaces/AAA/threads/root" },
      account,
      spaceId: "spaces/AAA",
      runtime,
      core,
      config,
      statusSink,
      typingMessage: {
        name: "spaces/AAA/messages/typing",
        thread: "spaces/AAA/threads/root",
      },
    });

    expect(mocks.updateGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: "spaces/AAA/messages/typing",
      text: "first chunk",
    });
    expect(mocks.sendGoogleChatMessage).toHaveBeenCalledTimes(2);
    expect(mocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(1, {
      account,
      space: "spaces/AAA",
      text: "first chunk",
      thread: "spaces/AAA/threads/root",
    });
    expect(mocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(2, {
      account,
      space: "spaces/AAA",
      text: "second chunk",
      thread: "spaces/AAA/threads/root",
    });
    expect(statusSink).toHaveBeenCalledTimes(2);
    expect(runtime.error).toHaveBeenCalledWith(
      "Google Chat message send failed: Error: message not found",
    );
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
        name: "spaces/AAA/messages/typing",
        thread: "spaces/AAA/threads/root",
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
        name: "spaces/AAA/messages/typing",
        thread: "spaces/AAA/threads/root",
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
          name: "spaces/AAA/messages/typing",
          thread: "spaces/AAA/threads/root",
        },
      }),
    ).rejects.toThrow(
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
