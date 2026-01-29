import { beforeEach, describe, expect, it, vi } from "vitest";

import { HISTORY_CONTEXT_MARKER } from "../auto-reply/reply/history.js";
import { resetInboundDedupe } from "../auto-reply/reply/inbound-dedupe.js";
import { CURRENT_MESSAGE_MARKER } from "../auto-reply/reply/mentions.js";
import {
  defaultSlackTestConfig,
  flush,
  getSlackTestState,
  getSlackClient,
  getSlackHandlers,
  resetSlackTestState,
  waitForSlackEvent,
} from "./monitor.test-helpers.js";
import { monitorSlackProvider } from "./monitor.js";

const slackTestState = getSlackTestState();
const { sendMock, replyMock } = slackTestState;

beforeEach(() => {
  resetInboundDedupe();
  resetSlackTestState(defaultSlackTestConfig());
});

describe("monitorSlackProvider tool results", () => {
  it("skips tool summaries with responsePrefix", async () => {
    replyMock.mockResolvedValue({ text: "final reply" });

    const controller = new AbortController();
    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
    });

    await waitForSlackEvent("message");
    const handler = getSlackHandlers()?.get("message");
    if (!handler) throw new Error("Slack message handler not registered");

    await handler({
      event: {
        type: "message",
        user: "U1",
        text: "hello",
        ts: "123",
        channel: "C1",
        channel_type: "im",
      },
    });

    await flush();
    controller.abort();
    await run;

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][1]).toBe("PFX final reply");
  });

  it("drops events with mismatched api_app_id", async () => {
    const client = getSlackClient();
    if (!client) throw new Error("Slack client not registered");
    (client.auth as { test: ReturnType<typeof vi.fn> }).test.mockResolvedValue({
      user_id: "bot-user",
      team_id: "T1",
      api_app_id: "A1",
    });

    const controller = new AbortController();
    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "xapp-1-A1-abc",
      abortSignal: controller.signal,
    });

    await waitForSlackEvent("message");
    const handler = getSlackHandlers()?.get("message");
    if (!handler) throw new Error("Slack message handler not registered");

    await handler({
      body: { api_app_id: "A2", team_id: "T1" },
      event: {
        type: "message",
        user: "U1",
        text: "hello",
        ts: "123",
        channel: "C1",
        channel_type: "im",
      },
    });

    await flush();
    controller.abort();
    await run;

    expect(sendMock).not.toHaveBeenCalled();
    expect(replyMock).not.toHaveBeenCalled();
  });

  it("does not derive responsePrefix from routed agent identity when unset", async () => {
    slackTestState.config = {
      agents: {
        list: [
          {
            id: "main",
            default: true,
            identity: { name: "Mainbot", theme: "space lobster", emoji: "🦞" },
          },
          {
            id: "rich",
            identity: { name: "Richbot", theme: "lion bot", emoji: "🦁" },
          },
        ],
      },
      bindings: [
        {
          agentId: "rich",
          match: { channel: "slack", peer: { kind: "dm", id: "U1" } },
        },
      ],
      messages: {
        ackReaction: "👀",
        ackReactionScope: "group-mentions",
      },
      channels: {
        slack: { dm: { enabled: true, policy: "open", allowFrom: ["*"] } },
      },
    };

    replyMock.mockResolvedValue({ text: "final reply" });

    const controller = new AbortController();
    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
    });

    await waitForSlackEvent("message");
    const handler = getSlackHandlers()?.get("message");
    if (!handler) throw new Error("Slack message handler not registered");

    await handler({
      event: {
        type: "message",
        user: "U1",
        text: "hello",
        ts: "123",
        channel: "C1",
        channel_type: "im",
      },
    });

    await flush();
    controller.abort();
    await run;

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][1]).toBe("final reply");
  });

  it("preserves RawBody without injecting processed room history", async () => {
    slackTestState.config = {
      messages: { ackReactionScope: "group-mentions" },
      channels: {
        slack: {
          historyLimit: 5,
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          channels: { "*": { requireMention: false } },
        },
      },
    };

    let capturedCtx: { Body?: string; RawBody?: string; CommandBody?: string } = {};
    replyMock.mockImplementation(async (ctx) => {
      capturedCtx = ctx ?? {};
      return undefined;
    });

    const controller = new AbortController();
    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
    });

    await waitForSlackEvent("message");
    const handler = getSlackHandlers()?.get("message");
    if (!handler) throw new Error("Slack message handler not registered");

    await handler({
      event: {
        type: "message",
        user: "U1",
        text: "first",
        ts: "123",
        channel: "C1",
        channel_type: "channel",
      },
    });

    await handler({
      event: {
        type: "message",
        user: "U2",
        text: "second",
        ts: "124",
        channel: "C1",
        channel_type: "channel",
      },
    });

    await flush();
    controller.abort();
    await run;

    expect(replyMock).toHaveBeenCalledTimes(2);
    expect(capturedCtx.Body).not.toContain(HISTORY_CONTEXT_MARKER);
    expect(capturedCtx.Body).not.toContain(CURRENT_MESSAGE_MARKER);
    expect(capturedCtx.Body).not.toContain("first");
    expect(capturedCtx.RawBody).toBe("second");
    expect(capturedCtx.CommandBody).toBe("second");
  });

  it("scopes thread history to the thread by default", async () => {
    slackTestState.config = {
      messages: { ackReactionScope: "group-mentions" },
      channels: {
        slack: {
          historyLimit: 5,
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          channels: { C1: { allow: true, requireMention: true } },
        },
      },
    };

    const capturedCtx: Array<{ Body?: string }> = [];
    replyMock.mockImplementation(async (ctx) => {
      capturedCtx.push(ctx ?? {});
      return undefined;
    });

    const controller = new AbortController();
    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
    });

    await waitForSlackEvent("message");
    const handler = getSlackHandlers()?.get("message");
    if (!handler) throw new Error("Slack message handler not registered");

    await handler({
      event: {
        type: "message",
        user: "U1",
        text: "thread-a-one",
        ts: "200",
        thread_ts: "100",
        channel: "C1",
        channel_type: "channel",
      },
    });

    await handler({
      event: {
        type: "message",
        user: "U1",
        text: "<@bot-user> thread-a-two",
        ts: "201",
        thread_ts: "100",
        channel: "C1",
        channel_type: "channel",
      },
    });

    await handler({
      event: {
        type: "message",
        user: "U2",
        text: "<@bot-user> thread-b-one",
        ts: "301",
        thread_ts: "300",
        channel: "C1",
        channel_type: "channel",
      },
    });

    await flush();
    controller.abort();
    await run;

    expect(replyMock).toHaveBeenCalledTimes(2);
    expect(capturedCtx[0]?.Body).toContain("thread-a-one");
    expect(capturedCtx[1]?.Body).not.toContain("thread-a-one");
    expect(capturedCtx[1]?.Body).not.toContain("thread-a-two");
  });

  it("updates assistant thread status when replies start", async () => {
    replyMock.mockImplementation(async (_ctx, opts) => {
      await opts?.onReplyStart?.();
      return { text: "final reply" };
    });

    const controller = new AbortController();
    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
    });

    await waitForSlackEvent("message");
    const handler = getSlackHandlers()?.get("message");
    if (!handler) throw new Error("Slack message handler not registered");

    await handler({
      event: {
        type: "message",
        user: "U1",
        text: "hello",
        ts: "123",
        channel: "C1",
        channel_type: "im",
      },
    });

    await flush();
    controller.abort();
    await run;

    const client = getSlackClient() as {
      assistant?: { threads?: { setStatus?: ReturnType<typeof vi.fn> } };
    };
    const setStatus = client.assistant?.threads?.setStatus;
    expect(setStatus).toHaveBeenCalledTimes(2);
    expect(setStatus).toHaveBeenNthCalledWith(1, {
      token: "bot-token",
      channel_id: "C1",
      thread_ts: "123",
      status: "is typing...",
    });
    expect(setStatus).toHaveBeenNthCalledWith(2, {
      token: "bot-token",
      channel_id: "C1",
      thread_ts: "123",
      status: "",
    });
  });

  it("accepts channel messages when mentionPatterns match", async () => {
    slackTestState.config = {
      messages: {
        responsePrefix: "PFX",
        groupChat: { mentionPatterns: ["\\bclawd\\b"] },
      },
      channels: {
        slack: {
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          channels: { C1: { allow: true, requireMention: true } },
        },
      },
    };
    replyMock.mockResolvedValue({ text: "hi" });

    const controller = new AbortController();
    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
    });

    await waitForSlackEvent("message");
    const handler = getSlackHandlers()?.get("message");
    if (!handler) throw new Error("Slack message handler not registered");

    await handler({
      event: {
        type: "message",
        user: "U1",
        text: "clawd: hello",
        ts: "123",
        channel: "C1",
        channel_type: "channel",
      },
    });

    await flush();
    controller.abort();
    await run;

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(replyMock.mock.calls[0][0].WasMentioned).toBe(true);
  });

  it("accepts channel messages when mentionPatterns match even if another user is mentioned", async () => {
    slackTestState.config = {
      messages: {
        responsePrefix: "PFX",
        groupChat: { mentionPatterns: ["\\bclawd\\b"] },
      },
      channels: {
        slack: {
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          channels: { C1: { allow: true, requireMention: true } },
        },
      },
    };
    replyMock.mockResolvedValue({ text: "hi" });

    const controller = new AbortController();
    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
    });

    await waitForSlackEvent("message");
    const handler = getSlackHandlers()?.get("message");
    if (!handler) throw new Error("Slack message handler not registered");

    await handler({
      event: {
        type: "message",
        user: "U1",
        text: "clawd: hello <@U2>",
        ts: "123",
        channel: "C1",
        channel_type: "channel",
      },
    });

    await flush();
    controller.abort();
    await run;

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(replyMock.mock.calls[0][0].WasMentioned).toBe(true);
  });

  it("treats replies to bot threads as implicit mentions", async () => {
    slackTestState.config = {
      channels: {
        slack: {
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          channels: { C1: { allow: true, requireMention: true } },
        },
      },
    };
    replyMock.mockResolvedValue({ text: "hi" });

    const controller = new AbortController();
    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
    });

    await waitForSlackEvent("message");
    const handler = getSlackHandlers()?.get("message");
    if (!handler) throw new Error("Slack message handler not registered");

    await handler({
      event: {
        type: "message",
        user: "U1",
        text: "following up",
        ts: "124",
        thread_ts: "123",
        parent_user_id: "bot-user",
        channel: "C1",
        channel_type: "channel",
      },
    });

    await flush();
    controller.abort();
    await run;

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(replyMock.mock.calls[0][0].WasMentioned).toBe(true);
  });

  it("accepts channel messages without mention when channels.slack.requireMention is false", async () => {
    slackTestState.config = {
      channels: {
        slack: {
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          groupPolicy: "open",
          requireMention: false,
        },
      },
    };
    replyMock.mockResolvedValue({ text: "hi" });

    const controller = new AbortController();
    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
    });

    await waitForSlackEvent("message");
    const handler = getSlackHandlers()?.get("message");
    if (!handler) throw new Error("Slack message handler not registered");

    await handler({
      event: {
        type: "message",
        user: "U1",
        text: "hello",
        ts: "123",
        channel: "C1",
        channel_type: "channel",
      },
    });

    await flush();
    controller.abort();
    await run;

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(replyMock.mock.calls[0][0].WasMentioned).toBe(false);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("treats control commands as mentions for group bypass", async () => {
    replyMock.mockResolvedValue({ text: "ok" });

    const controller = new AbortController();
    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
    });

    await waitForSlackEvent("message");
    const handler = getSlackHandlers()?.get("message");
    if (!handler) throw new Error("Slack message handler not registered");

    await handler({
      event: {
        type: "message",
        user: "U1",
        text: "/elevated off",
        ts: "123",
        channel: "C1",
        channel_type: "channel",
      },
    });

    await flush();
    controller.abort();
    await run;

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(replyMock.mock.calls[0][0].WasMentioned).toBe(true);
  });

  it("threads replies when incoming message is in a thread", async () => {
    replyMock.mockResolvedValue({ text: "thread reply" });
    slackTestState.config = {
      messages: {
        responsePrefix: "PFX",
        ackReaction: "👀",
        ackReactionScope: "group-mentions",
      },
      channels: {
        slack: {
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          replyToMode: "off",
        },
      },
    };

    const controller = new AbortController();
    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
    });

    await waitForSlackEvent("message");
    const handler = getSlackHandlers()?.get("message");
    if (!handler) throw new Error("Slack message handler not registered");

    await handler({
      event: {
        type: "message",
        user: "U1",
        text: "hello",
        ts: "123",
        thread_ts: "456",
        channel: "C1",
        channel_type: "im",
      },
    });

    await flush();
    controller.abort();
    await run;

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][2]).toMatchObject({ threadTs: "456" });
  });
});
