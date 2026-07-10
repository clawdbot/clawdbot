// Covers outbound delivery routing: a reply to a top-level message must post to
// the main channel as a quote-reply, not open a per-reply thread.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendClickClackText } from "./outbound.js";
import type { CoreConfig } from "./types.js";

const createChannelMessage = vi.hoisted(() => vi.fn(async () => ({ id: "msg_out" })));
const createThreadReply = vi.hoisted(() => vi.fn(async () => ({ id: "msg_out" })));
const createDirectMessage = vi.hoisted(() => vi.fn(async () => ({ id: "msg_out" })));
const createDirectConversation = vi.hoisted(() => vi.fn(async () => ({ id: "dm_1" })));
const createClientOptions = vi.hoisted(() => vi.fn());

vi.mock("./accounts.js", () => ({
  resolveClickClackAccount: () => ({
    baseUrl: "https://clickclack.example",
    token: "test-token",
    workspace: "wsp_1",
  }),
}));

vi.mock("./http-client.js", () => ({
  createClickClackClient: (options: unknown) => {
    createClientOptions(options);
    return {
      createChannelMessage,
      createThreadReply,
      createDirectMessage,
      createDirectConversation,
    };
  },
}));

vi.mock("./resolve.js", () => ({
  resolveWorkspaceId: async () => "wsp_1",
  resolveChannelId: async (_client: unknown, _workspaceId: string, id: string) => id,
}));

const cfg = {} as CoreConfig;

describe("sendClickClackText routing", () => {
  beforeEach(() => {
    createChannelMessage.mockClear();
    createThreadReply.mockClear();
    createDirectMessage.mockClear();
    createDirectConversation.mockClear();
    createClientOptions.mockClear();
  });

  it("delivers a reply to a top-level channel message as an in-channel quote-reply", async () => {
    await sendClickClackText({
      cfg,
      to: "channel:general",
      text: "hi",
      replyToId: "msg_root",
    });

    expect(createChannelMessage).toHaveBeenCalledTimes(1);
    expect(createChannelMessage).toHaveBeenCalledWith(
      "general",
      "hi",
      expect.objectContaining({ quotedMessageId: "msg_root" }),
    );
    expect(createThreadReply).not.toHaveBeenCalled();
  });

  it("posts a plain channel message when there is no reply context", async () => {
    await sendClickClackText({ cfg, to: "channel:general", text: "hi" });

    expect(createChannelMessage).toHaveBeenCalledWith(
      "general",
      "hi",
      expect.objectContaining({ quotedMessageId: undefined }),
    );
    expect(createThreadReply).not.toHaveBeenCalled();
  });

  it("uses the inbound correlation id for outbound ClickClack HTTP calls", async () => {
    await sendClickClackText({
      cfg,
      to: "channel:general",
      text: "hi",
      correlationId: "fakeco.case_1",
    });

    expect(createClientOptions).toHaveBeenCalledWith({
      baseUrl: "https://clickclack.example",
      token: "test-token",
      correlationId: "fakeco.case_1",
    });
  });

  it("keeps replies inside a genuine thread (explicit threadId)", async () => {
    await sendClickClackText({
      cfg,
      to: "channel:general",
      text: "hi",
      threadId: "msg_thread_root",
      replyToId: "msg_root",
    });

    expect(createThreadReply).toHaveBeenCalledWith("msg_thread_root", "hi", expect.anything());
    expect(createChannelMessage).not.toHaveBeenCalled();
  });

  it("threads when the target itself names a thread", async () => {
    await sendClickClackText({ cfg, to: "thread:msg_root", text: "hi" });

    expect(createThreadReply).toHaveBeenCalledWith("msg_root", "hi", expect.anything());
    expect(createChannelMessage).not.toHaveBeenCalled();
  });

  it("delivers a DM reply as a quote-reply in the same conversation", async () => {
    await sendClickClackText({
      cfg,
      to: "dm:usr_1",
      text: "hi",
      replyToId: "msg_root",
    });

    expect(createDirectMessage).toHaveBeenCalledWith(
      "dm_1",
      "hi",
      expect.objectContaining({ quotedMessageId: "msg_root" }),
    );
    expect(createThreadReply).not.toHaveBeenCalled();
  });
});
