// Covers webchat reply-target hydration into the channel-agnostic ReplyTo*
// envelope fields consumed by inbound-meta reply context blocks.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  applyChatSendReplyContextFields,
  resolveChatSendReplyContext,
} from "./chat-send-reply-context.js";

const readSessionMessageByIdAsyncMock = vi.fn();
const resolveAssistantIdentityMock = vi.fn((..._args: unknown[]) => ({
  agentId: "main",
  name: "Molty",
  avatar: "M",
}));

vi.mock("../session-transcript-readers.js", () => ({
  readSessionMessageByIdAsync: (...args: unknown[]) => readSessionMessageByIdAsyncMock(...args),
}));
vi.mock("../assistant-identity.js", () => ({
  resolveAssistantIdentity: (...args: unknown[]) => resolveAssistantIdentityMock(...args),
}));

const cfg = {} as OpenClawConfig;

function baseParams(overrides: Partial<Parameters<typeof resolveChatSendReplyContext>[0]> = {}) {
  return {
    replyToId: "msg-1",
    cfg,
    agentId: "main",
    sessionKey: "agent:main:webchat",
    sessionEntry: { sessionFile: "session.jsonl", sessionId: "session-1" },
    storePath: "/tmp/sessions.json",
    ...overrides,
  };
}

describe("resolveChatSendReplyContext", () => {
  beforeEach(() => {
    readSessionMessageByIdAsyncMock.mockReset();
  });

  it("returns no fields without a reply id", async () => {
    expect(await resolveChatSendReplyContext(baseParams({ replyToId: undefined }))).toEqual({});
    expect(await resolveChatSendReplyContext(baseParams({ replyToId: "  " }))).toEqual({});
    expect(readSessionMessageByIdAsyncMock).not.toHaveBeenCalled();
  });

  it("hydrates assistant reply targets with the assistant identity label", async () => {
    readSessionMessageByIdAsyncMock.mockResolvedValue({
      found: true,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "the replied-to answer" }],
        __openclaw: { id: "msg-1" },
      },
    });

    const fields = await resolveChatSendReplyContext(baseParams());

    expect(readSessionMessageByIdAsyncMock).toHaveBeenCalledWith(
      {
        agentId: "main",
        sessionEntry: { sessionFile: "session.jsonl", sessionId: "session-1" },
        sessionId: "session-1",
        sessionKey: "agent:main:webchat",
        storePath: "/tmp/sessions.json",
      },
      "msg-1",
      { allowResetArchiveFallback: true },
    );
    expect(fields).toEqual({
      ReplyToId: "msg-1",
      ReplyToBody: "the replied-to answer",
      ReplyToSender: "Molty",
    });
  });

  it("labels user reply targets with the client display name", async () => {
    readSessionMessageByIdAsyncMock.mockResolvedValue({
      found: true,
      message: { role: "user", content: "an earlier question" },
    });

    const fields = await resolveChatSendReplyContext(baseParams({ userSenderLabel: "Ada" }));

    expect(fields).toEqual({
      ReplyToId: "msg-1",
      ReplyToBody: "an earlier question",
      ReplyToSender: "Ada",
    });
  });

  it("keeps only the reply id when the target message is missing", async () => {
    readSessionMessageByIdAsyncMock.mockResolvedValue({ found: false });

    expect(await resolveChatSendReplyContext(baseParams())).toEqual({ ReplyToId: "msg-1" });
  });

  it("keeps only the reply id when no session exists yet", async () => {
    expect(await resolveChatSendReplyContext(baseParams({ sessionEntry: undefined }))).toEqual({
      ReplyToId: "msg-1",
    });
    expect(readSessionMessageByIdAsyncMock).not.toHaveBeenCalled();
  });

  it("tolerates read failures and reports them through warn", async () => {
    readSessionMessageByIdAsyncMock.mockRejectedValue(new Error("transcript unavailable"));
    const warn = vi.fn();

    expect(await resolveChatSendReplyContext(baseParams({ warn }))).toEqual({
      ReplyToId: "msg-1",
    });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("hydrates only display-visible content, not raw transcript payloads", async () => {
    readSessionMessageByIdAsyncMock.mockResolvedValue({
      found: true,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "visible answer" },
          { type: "text", text: '<tool_call>{"name":"exec","arguments":{}}</tool_call>' },
        ],
        __openclaw: { id: "msg-1" },
      },
    });

    const fields = await resolveChatSendReplyContext(baseParams());

    expect(fields.ReplyToBody).toContain("visible answer");
    expect(fields.ReplyToBody).not.toContain("tool_call");
  });

  it("strips inbound envelope wrappers from user reply targets", async () => {
    readSessionMessageByIdAsyncMock.mockResolvedValue({
      found: true,
      message: {
        role: "user",
        content: "[Sat 2026-07-18 11:31 MDT] Which stage runs the integration tests?",
      },
    });

    const fields = await resolveChatSendReplyContext(baseParams({ userSenderLabel: "Ada" }));

    expect(fields.ReplyToBody).toBe("Which stage runs the integration tests?");
  });

  it("keeps only the reply id when the target is not display-visible", async () => {
    readSessionMessageByIdAsyncMock.mockResolvedValue({
      found: true,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "NO_REPLY" }],
        __openclaw: { id: "msg-1" },
      },
    });

    expect(await resolveChatSendReplyContext(baseParams())).toEqual({ ReplyToId: "msg-1" });
  });

  it("bounds oversized reply bodies", async () => {
    readSessionMessageByIdAsyncMock.mockResolvedValue({
      found: true,
      message: { role: "user", content: "x".repeat(5000) },
    });

    const fields = await resolveChatSendReplyContext(baseParams());

    expect(fields.ReplyToBody?.length).toBeLessThanOrEqual(2000);
  });
});

describe("applyChatSendReplyContextFields", () => {
  it("assigns only hydrated fields", () => {
    const ctx = { Body: "hi" } as MsgContext;
    applyChatSendReplyContextFields(ctx, { ReplyToId: "msg-1", ReplyToBody: "quoted" });

    expect(ctx.ReplyToId).toBe("msg-1");
    expect(ctx.ReplyToBody).toBe("quoted");
    expect("ReplyToSender" in ctx).toBe(false);
  });
});
