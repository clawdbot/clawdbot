// Line tests cover what an inbound quote reaches the agent as.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { webhook } from "@line/bot-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { testing as sessionBindingTesting } from "openclaw/plugin-sdk/conversation-runtime";
import {
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lineBindingsAdapter } from "./bindings.js";
import { buildLineMessageContext } from "./bot-message-context.js";
import { recordLineAgentVisibleMessage, recordLineSentMessages } from "./quoted-messages.js";
import type { ResolvedLineAccount } from "./types.js";

// Mirrors getUserProfile: the id decides the answer, so a test can name one
// profile per user the context asks about.
const getUserProfileMock = vi.hoisted(() =>
  vi.fn(async (_userId: string) => null as { displayName: string } | null),
);
const getLineGroupNameMock = vi.hoisted(() => vi.fn(async () => undefined as string | undefined));

vi.mock("./send.js", () => ({
  getUserProfile: getUserProfileMock,
  getLineGroupName: getLineGroupNameMock,
}));

type MessageEvent = webhook.MessageEvent;

const lineBindingsPlugin = {
  id: "line",
  bindings: lineBindingsAdapter,
  conversationBindings: {
    defaultTopLevelPlacement: "current",
    supportsCurrentConversationBinding: true,
  },
};

describe("buildLineMessageContext quotes", () => {
  let tmpDir: string;
  let cfg: OpenClawConfig;
  const account: ResolvedLineAccount = {
    accountId: "default",
    enabled: true,
    channelAccessToken: "token",
    channelSecret: "secret",
    tokenSource: "config",
    config: {},
  };

  const createMessageEvent = (
    source: MessageEvent["source"],
    overrides?: Partial<MessageEvent>,
  ): MessageEvent =>
    ({
      type: "message",
      message: { id: "1", type: "text", text: "hello" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source,
      mode: "active",
      webhookEventId: "evt-1",
      deliveryContext: { isRedelivery: false },
      ...overrides,
    }) as MessageEvent;

  beforeEach(async () => {
    // mockClear keeps the implementation, so a display name set by one test would
    // leak into every later one and make the suite order-dependent.
    getUserProfileMock.mockReset();
    getUserProfileMock.mockImplementation(async () => null);
    getLineGroupNameMock.mockReset();
    getLineGroupNameMock.mockImplementation(async () => undefined);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: lineBindingsPlugin.id,
          plugin: lineBindingsPlugin,
          source: "test",
        },
      ]),
    );
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-line-quotes-"));
    cfg = { session: { store: path.join(tmpDir, "sessions.json") } };
  });

  afterEach(async () => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const quotingEvent = (quotedMessageId: string, text: string) =>
    createMessageEvent({ type: "group", groupId: "group-quote", userId: "user-asking" }, {
      message: { id: "m-quoting", type: "text", text, quotedMessageId },
    } as Partial<MessageEvent>);

  it("answers a quote with the message it points at", async () => {
    getUserProfileMock.mockImplementation(async (userId: string) =>
      userId === "U-teammate" ? { displayName: "Mika" } : null,
    );
    recordLineAgentVisibleMessage(account.accountId, {
      id: "m-quoted",
      conversationId: "group-quote",
      body: "staging is on 10.0.0.5",
      senderId: "U-teammate",
    });

    const context = await buildLineMessageContext({
      groupPolicy: "open",
      groupAllowFrom: [],
      event: quotingEvent("m-quoted", "ping this one"),
      allMedia: [],
      cfg,
      account,
      commandAuthorized: true,
    });

    expect(context?.ctxPayload.ReplyToId).toBe("m-quoted");
    expect(context?.ctxPayload.ReplyToIsQuote).toBe(true);
    expect(context?.ctxPayload.ReplyToBody).toBe("staging is on 10.0.0.5");
    expect(context?.ctxPayload.ReplyToSender).toBe("Mika");
  });

  it("names the quoted author by raw id when LINE will not name them", async () => {
    getUserProfileMock.mockImplementation(async () => null);
    recordLineAgentVisibleMessage(account.accountId, {
      id: "m-quoted",
      conversationId: "group-quote",
      body: "staging is on 10.0.0.5",
      senderId: "U-teammate",
    });

    const context = await buildLineMessageContext({
      groupPolicy: "open",
      groupAllowFrom: [],
      event: quotingEvent("m-quoted", "ping this one"),
      allMedia: [],
      cfg,
      account,
      commandAuthorized: true,
    });

    expect(context?.ctxPayload.ReplyToSender).toBe("user:U-teammate");
  });

  it("hides a quote body once its sender left the group allowlist", async () => {
    recordLineAgentVisibleMessage(account.accountId, {
      id: "m-quoted",
      conversationId: "group-quote",
      body: "staging is on 10.0.0.5",
      senderId: "U-teammate",
    });

    const context = await buildLineMessageContext({
      // The stored message was seen while U-teammate was allowed; the allowlist
      // in force now no longer names them.
      groupPolicy: "allowlist",
      groupAllowFrom: ["user-asking"],
      event: quotingEvent("m-quoted", "what about this?"),
      allMedia: [],
      cfg: { ...cfg, channels: { defaults: { contextVisibility: "allowlist" } } },
      account,
      commandAuthorized: true,
    });

    // Read through the turn that was actually built: `context?.` alone would also
    // be satisfied by a null context, which is a different bug wearing this result.
    expect(context?.ctxPayload.RawBody).toBe("what about this?");
    expect(context?.ctxPayload.ReplyToBody).toBeUndefined();
    expect(context?.ctxPayload.ReplyToId).toBeUndefined();
  });

  it("keeps a quote from a sender named only through a static access group", async () => {
    recordLineAgentVisibleMessage(account.accountId, {
      id: "m-quoted",
      conversationId: "group-quote",
      body: "staging is on 10.0.0.5",
      senderId: "U-teammate",
    });

    const context = await buildLineMessageContext({
      groupPolicy: "allowlist",
      // The allowlist names a group, never the author directly. Admission
      // expands that for the asking sender, so the quoted author must get the
      // same expansion or their message reads as coming from a stranger.
      groupAllowFrom: ["accessGroup:oncall", "user-asking"],
      event: quotingEvent("m-quoted", "what about this?"),
      allMedia: [],
      cfg: {
        ...cfg,
        accessGroups: {
          oncall: { type: "message.senders", members: { line: ["U-teammate"] } },
        },
        channels: { defaults: { contextVisibility: "allowlist" } },
      },
      account,
      commandAuthorized: true,
    });

    expect(context?.ctxPayload.ReplyToBody).toBe("staging is on 10.0.0.5");
  });

  it("hides a quote from a sender no access group names", async () => {
    recordLineAgentVisibleMessage(account.accountId, {
      id: "m-quoted",
      conversationId: "group-quote",
      body: "staging is on 10.0.0.5",
      senderId: "U-stranger",
    });

    const context = await buildLineMessageContext({
      groupPolicy: "allowlist",
      groupAllowFrom: ["accessGroup:oncall", "user-asking"],
      event: quotingEvent("m-quoted", "what about this?"),
      allMedia: [],
      cfg: {
        ...cfg,
        accessGroups: {
          oncall: { type: "message.senders", members: { line: ["U-teammate"] } },
        },
        channels: { defaults: { contextVisibility: "allowlist" } },
      },
      account,
      commandAuthorized: true,
    });

    expect(context?.ctxPayload.RawBody).toBe("what about this?");
    expect(context?.ctxPayload.ReplyToBody).toBeUndefined();
  });

  it("reads contextVisibility from the LINE channel, not only from the defaults", async () => {
    recordLineAgentVisibleMessage(account.accountId, {
      id: "m-quoted",
      conversationId: "group-quote",
      body: "staging is on 10.0.0.5",
      senderId: "U-teammate",
    });

    const context = await buildLineMessageContext({
      groupPolicy: "allowlist",
      groupAllowFrom: ["user-asking"],
      event: quotingEvent("m-quoted", "what about this?"),
      allMedia: [],
      // The permissive default would keep the body; only the channel-scoped key
      // can hide it, so this fails if LINE reads the wrong scope.
      cfg: {
        ...cfg,
        channels: {
          defaults: { contextVisibility: "all" },
          line: { contextVisibility: "allowlist" },
        },
      },
      account,
      commandAuthorized: true,
    });

    expect(context?.ctxPayload.RawBody).toBe("what about this?");
    expect(context?.ctxPayload.ReplyToBody).toBeUndefined();
  });

  it("keeps a quote body from a sender the group allowlist still names", async () => {
    getUserProfileMock.mockImplementation(async (userId: string) =>
      userId === "U-teammate" ? { displayName: "Mika" } : null,
    );
    recordLineAgentVisibleMessage(account.accountId, {
      id: "m-quoted",
      conversationId: "group-quote",
      body: "staging is on 10.0.0.5",
      senderId: "U-teammate",
    });

    const context = await buildLineMessageContext({
      groupPolicy: "allowlist",
      groupAllowFrom: ["U-teammate", "user-asking"],
      event: quotingEvent("m-quoted", "what about this?"),
      allMedia: [],
      cfg: { ...cfg, channels: { defaults: { contextVisibility: "allowlist" } } },
      account,
      commandAuthorized: true,
    });

    expect(context?.ctxPayload.ReplyToBody).toBe("staging is on 10.0.0.5");
    expect(context?.ctxPayload.ReplyToSender).toBe("Mika");
  });

  it("keeps a quoted body from a sender the allowlist has since dropped", async () => {
    // The reachable shape of allowlist_quote here: the store only ever holds a
    // message that passed admission, so the sender was allowlisted when this was
    // recorded and was removed afterwards. A sender who was never admitted has
    // nothing stored, and no visibility mode can recover their text.
    recordLineAgentVisibleMessage(account.accountId, {
      id: "m-quoted",
      conversationId: "group-quote",
      body: "staging is on 10.0.0.5",
      senderId: "U-teammate",
    });

    const context = await buildLineMessageContext({
      groupPolicy: "allowlist",
      groupAllowFrom: ["user-asking"],
      event: quotingEvent("m-quoted", "what about this?"),
      allMedia: [],
      cfg: { ...cfg, channels: { defaults: { contextVisibility: "allowlist_quote" } } },
      account,
      commandAuthorized: true,
    });

    expect(context?.ctxPayload.ReplyToBody).toBe("staging is on 10.0.0.5");
  });

  it("still answers a quote of its own message under a strict allowlist", async () => {
    recordLineSentMessages(account.accountId, ["m-sent"]);

    const context = await buildLineMessageContext({
      groupPolicy: "allowlist",
      groupAllowFrom: ["user-asking"],
      event: quotingEvent("m-sent", "redo that in English"),
      allMedia: [],
      cfg: { ...cfg, channels: { defaults: { contextVisibility: "allowlist" } } },
      account,
      commandAuthorized: true,
    });

    expect(context?.ctxPayload.ReplyToId).toBe("m-sent");
  });

  it("keeps the quote linkage when the quoted message is no longer held", async () => {
    const context = await buildLineMessageContext({
      groupPolicy: "open",
      groupAllowFrom: [],
      event: quotingEvent("m-evicted", "and this one?"),
      allMedia: [],
      cfg,
      account,
      commandAuthorized: true,
    });

    expect(context?.ctxPayload.ReplyToId).toBe("m-evicted");
    expect(context?.ctxPayload.ReplyToIsQuote).toBe(true);
    expect(context?.ctxPayload.ReplyToBody).toBeUndefined();
  });

  it("does not repeat the bot's own message back to it", async () => {
    recordLineSentMessages(account.accountId, ["m-sent"]);

    const context = await buildLineMessageContext({
      groupPolicy: "open",
      groupAllowFrom: [],
      event: quotingEvent("m-sent", "redo that in English"),
      allMedia: [],
      cfg,
      account,
      commandAuthorized: true,
    });

    expect(context?.ctxPayload.ReplyToId).toBe("m-sent");
    expect(context?.ctxPayload.ReplyToBody).toBeUndefined();
  });

  it("leaves a message that quotes nothing without reply-target metadata", async () => {
    const context = await buildLineMessageContext({
      groupPolicy: "open",
      groupAllowFrom: [],
      event: createMessageEvent({ type: "group", groupId: "group-quote", userId: "user-asking" }),
      allMedia: [],
      cfg,
      account,
      commandAuthorized: true,
    });

    expect(context?.ctxPayload.RawBody).toBe("hello");
    expect(context?.ctxPayload.ReplyToId).toBeUndefined();
    expect(context?.ctxPayload.ReplyToIsQuote).toBeUndefined();
  });
});
