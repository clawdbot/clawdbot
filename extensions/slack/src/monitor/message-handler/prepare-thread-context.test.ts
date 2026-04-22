import type { App } from "@slack/bolt";
import { resolveEnvelopeFormatOptions } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../../types.js";
import { resolveSlackThreadContextData } from "./prepare-thread-context.js";
import {
  createInboundSlackTestContext,
  createSlackSessionStoreFixture,
  createSlackTestAccount,
} from "./prepare.test-helpers.js";

describe("resolveSlackThreadContextData", () => {
  const storeFixture = createSlackSessionStoreFixture("openclaw-slack-thread-context-");

  beforeAll(() => {
    storeFixture.setup();
  });

  afterAll(() => {
    storeFixture.cleanup();
  });

  function createThreadContext(params: { replies: unknown }) {
    return createInboundSlackTestContext({
      cfg: {
        channels: { slack: { enabled: true, replyToMode: "all", groupPolicy: "open" } },
      } as OpenClawConfig,
      appClient: { conversations: { replies: params.replies } } as App["client"],
      defaultRequireMention: false,
      replyToMode: "all",
    });
  }

  function createThreadMessage(overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
    return {
      channel: "C123",
      channel_type: "channel",
      user: "U1",
      text: "current message",
      ts: "101.000",
      thread_ts: "100.000",
      ...overrides,
    } as SlackMessageEvent;
  }

  async function resolveAllowlistedThreadContext(params: {
    repliesMessages: Array<Record<string, string>>;
    threadStarter: { text: string; userId?: string; ts: string; botId?: string };
    allowFromLower: string[];
    allowNameMatching: boolean;
  }) {
    const { storePath } = storeFixture.makeTmpStorePath();
    const replies = vi.fn().mockResolvedValue({
      messages: params.repliesMessages,
      response_metadata: { next_cursor: "" },
    });
    const ctx = createThreadContext({ replies });
    ctx.botUserId = "U_BOT";
    ctx.botId = "B1";
    ctx.resolveUserName = async (id: string) => ({
      name: id === "U1" ? "Alice" : "Mallory",
    });

    const result = await resolveSlackThreadContextData({
      ctx,
      account: createSlackTestAccount({ thread: { initialHistoryLimit: 20 } }),
      message: createThreadMessage(),
      isThreadReply: true,
      threadTs: "100.000",
      threadStarter: params.threadStarter,
      roomLabel: "#general",
      storePath,
      sessionKey: "thread-session",
      allowFromLower: params.allowFromLower,
      allowNameMatching: params.allowNameMatching,
      contextVisibilityMode: "allowlist",
      envelopeOptions: resolveEnvelopeFormatOptions({} as OpenClawConfig),
      effectiveDirectMedia: null,
    });

    return { replies, result };
  }

  it("omits non-allowlisted starter text and thread history messages", async () => {
    const { replies, result } = await resolveAllowlistedThreadContext({
      repliesMessages: [
        { text: "starter secret", user: "U2", ts: "100.000" },
        { text: "assistant reply", bot_id: "B1", ts: "100.500" },
        { text: "blocked follow-up", user: "U2", ts: "100.700" },
        { text: "allowed follow-up", user: "U1", ts: "100.800" },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      threadStarter: {
        text: "starter secret",
        userId: "U2",
        ts: "100.000",
      },
      allowFromLower: ["u1"],
      allowNameMatching: false,
    });

    expect(result.threadStarterBody).toBeUndefined();
    expect(result.threadLabel).toBe("Slack thread #general");
    expect(result.threadHistoryBody).toContain("allowed follow-up");
    expect(result.threadHistoryBody).not.toContain("assistant reply");
    expect(result.threadHistoryBody).not.toContain("starter secret");
    expect(result.threadHistoryBody).not.toContain("blocked follow-up");
    expect(result.threadHistoryBody).not.toContain("current message");
    expect(replies).toHaveBeenCalledTimes(1);
  });

  it("keeps starter text and history when allowNameMatching authorizes the sender", async () => {
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [
        { text: "starter from Alice", user: "U1", ts: "100.000" },
        { text: "blocked follow-up", user: "U2", ts: "100.700" },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      threadStarter: {
        text: "starter from Alice",
        userId: "U1",
        ts: "100.000",
      },
      allowFromLower: ["alice"],
      allowNameMatching: true,
    });

    expect(result.threadStarterBody).toBe("starter from Alice");
    expect(result.threadLabel).toContain("starter from Alice");
    expect(result.threadHistoryBody).toContain("starter from Alice");
    expect(result.threadHistoryBody).not.toContain("blocked follow-up");
  });

  it("omits bot-authored starter text and history from a new thread session", async () => {
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [
        { text: "bot starter", bot_id: "B1", ts: "100.000" },
        { text: "allowed follow-up", user: "U1", ts: "100.800" },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      threadStarter: {
        text: "bot starter",
        botId: "B1",
        ts: "100.000",
      },
      allowFromLower: ["u1"],
      allowNameMatching: false,
    });

    expect(result.threadStarterBody).toBeUndefined();
    expect(result.threadLabel).toBe("Slack thread #general");
    expect(result.threadHistoryBody).toContain("allowed follow-up");
    expect(result.threadHistoryBody).not.toContain("bot starter");
    expect(result.threadHistoryBody).not.toContain("current message");
  });

  it("keeps third-party bot starter text in a new thread session", async () => {
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [
        { text: "other bot starter", bot_id: "B2", ts: "100.000" },
        { text: "allowed follow-up", user: "U1", ts: "100.800" },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      threadStarter: {
        text: "other bot starter",
        botId: "B2",
        ts: "100.000",
      },
      allowFromLower: ["u1"],
      allowNameMatching: false,
    });

    expect(result.threadStarterBody).toBe("other bot starter");
    expect(result.threadLabel).toContain("other bot starter");
    expect(result.threadHistoryBody).toContain("other bot starter");
    expect(result.threadHistoryBody).toContain("Bot (B2) (assistant)");
    expect(result.threadHistoryBody).toContain("allowed follow-up");
    expect(result.threadHistoryBody).not.toContain("Unknown (user)");
  });

  it("omits self-authored starter text when identified by bot user id", async () => {
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [
        { text: "self starter", user: "U_BOT", ts: "100.000" },
        { text: "allowed follow-up", user: "U1", ts: "100.800" },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      threadStarter: {
        text: "self starter",
        userId: "U_BOT",
        ts: "100.000",
      },
      allowFromLower: ["u1"],
      allowNameMatching: false,
    });

    expect(result.threadStarterBody).toBeUndefined();
    expect(result.threadHistoryBody).toContain("allowed follow-up");
    expect(result.threadHistoryBody).not.toContain("self starter");
  });
});
