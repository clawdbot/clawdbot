import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { webhook } from "@line/bot-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { __testing as sessionBindingTesting } from "openclaw/plugin-sdk/conversation-runtime";
import {
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lineBindingsAdapter } from "./bindings.js";
import { buildLineMessageContext, buildLinePostbackContext } from "./bot-message-context.js";
import type { ResolvedLineAccount } from "./types.js";

type MessageEvent = webhook.MessageEvent;
type PostbackEvent = webhook.PostbackEvent;

const lineBindingsPlugin = {
  id: "line",
  bindings: lineBindingsAdapter,
  conversationBindings: {
    defaultTopLevelPlacement: "current",
    supportsCurrentConversationBinding: true,
  },
};

describe("buildLineMessageContext", () => {
  let tmpDir: string;
  let storePath: string;
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

  const createPostbackEvent = (
    source: PostbackEvent["source"],
    overrides?: Partial<PostbackEvent>,
  ): PostbackEvent =>
    ({
      type: "postback",
      postback: { data: "action=select" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source,
      mode: "active",
      webhookEventId: "evt-2",
      deliveryContext: { isRedelivery: false },
      ...overrides,
    }) as PostbackEvent;

  beforeEach(async () => {
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
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-line-context-"));
    storePath = path.join(tmpDir, "sessions.json");
    cfg = { session: { store: storePath } };
  });

  afterEach(async () => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    await fs.rm(tmpDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  });

  it("routes group message replies to the group id", async () => {
    const event = createMessageEvent({ type: "group", groupId: "group-1", userId: "user-1" });

    const context = await buildLineMessageContext({
      event,
      allMedia: [],
      cfg,
      account,
      commandAuthorized: true,
    });
    expect(context).not.toBeNull();
    if (!context) {
      throw new Error("context missing");
    }

    expect(context.ctxPayload.OriginatingTo).toBe("line:group:group-1");
    expect(context.ctxPayload.To).toBe("line:group:group-1");
  });

  it("routes group postback replies to the group id", async () => {
    const event = createPostbackEvent({ type: "group", groupId: "group-2", userId: "user-2" });

    const context = await buildLinePostbackContext({
      event,
      cfg,
      account,
      commandAuthorized: true,
    });

    expect(context?.ctxPayload.OriginatingTo).toBe("line:group:group-2");
    expect(context?.ctxPayload.To).toBe("line:group:group-2");
  });

  it("routes room postback replies to the room id", async () => {
    const event = createPostbackEvent({ type: "room", roomId: "room-1", userId: "user-3" });

    const context = await buildLinePostbackContext({
      event,
      cfg,
      account,
      commandAuthorized: true,
    });

    expect(context?.ctxPayload.OriginatingTo).toBe("line:room:room-1");
    expect(context?.ctxPayload.To).toBe("line:room:room-1");
  });

  it("resolves prefixed-only group config through the inbound message context", async () => {
    const event = createMessageEvent({ type: "group", groupId: "group-1", userId: "user-1" });

    const context = await buildLineMessageContext({
      event,
      allMedia: [],
      cfg,
      account: {
        ...account,
        config: {
          groups: {
            "group:group-1": {
              systemPrompt: "Use the prefixed group config",
            },
          },
        },
      },
      commandAuthorized: true,
    });

    expect(context?.ctxPayload.GroupSystemPrompt).toBe("Use the prefixed group config");
  });

  it("resolves prefixed-only room config through the inbound message context", async () => {
    const event = createMessageEvent({ type: "room", roomId: "room-1", userId: "user-1" });

    const context = await buildLineMessageContext({
      event,
      allMedia: [],
      cfg,
      account: {
        ...account,
        config: {
          groups: {
            "room:room-1": {
              systemPrompt: "Use the prefixed room config",
            },
          },
        },
      },
      commandAuthorized: true,
    });

    expect(context?.ctxPayload.GroupSystemPrompt).toBe("Use the prefixed room config");
  });

  it("keeps non-text message contexts fail-closed for command auth", async () => {
    const event = createMessageEvent(
      { type: "user", userId: "user-audio" },
      {
        message: { id: "audio-1", type: "audio", duration: 1000 } as MessageEvent["message"],
      },
    );

    const context = await buildLineMessageContext({
      event,
      allMedia: [],
      cfg,
      account,
      commandAuthorized: false,
    });

    expect(context).not.toBeNull();
    expect(context?.ctxPayload.CommandAuthorized).toBe(false);
  });

  it("sets CommandAuthorized=true when authorized", async () => {
    const event = createMessageEvent({ type: "user", userId: "user-auth" });

    const context = await buildLineMessageContext({
      event,
      allMedia: [],
      cfg,
      account,
      commandAuthorized: true,
    });

    expect(context?.ctxPayload.CommandAuthorized).toBe(true);
  });

  it("sets CommandAuthorized=false when not authorized", async () => {
    const event = createMessageEvent({ type: "user", userId: "user-noauth" });

    const context = await buildLineMessageContext({
      event,
      allMedia: [],
      cfg,
      account,
      commandAuthorized: false,
    });

    expect(context?.ctxPayload.CommandAuthorized).toBe(false);
  });

  it("sets CommandAuthorized on postback context", async () => {
    const event = createPostbackEvent({ type: "user", userId: "user-pb" });

    const context = await buildLinePostbackContext({
      event,
      cfg,
      account,
      commandAuthorized: true,
    });

    expect(context?.ctxPayload.CommandAuthorized).toBe(true);
  });

  it("group peer binding matches raw groupId without prefix (#21907)", async () => {
    const groupId = "Cc7e3bece1234567890abcdef"; // pragma: allowlist secret
    const bindingCfg: OpenClawConfig = {
      session: { store: storePath },
      agents: {
        list: [{ id: "main" }, { id: "line-group-agent" }],
      },
      bindings: [
        {
          agentId: "line-group-agent",
          match: { channel: "line", peer: { kind: "group", id: groupId } },
        },
      ],
    };

    const event = {
      type: "message",
      message: { id: "msg-1", type: "text", text: "hello" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "group", groupId, userId: "user-1" },
      mode: "active",
      webhookEventId: "evt-1",
      deliveryContext: { isRedelivery: false },
    } as MessageEvent;

    const context = await buildLineMessageContext({
      event,
      allMedia: [],
      cfg: bindingCfg,
      account,
      commandAuthorized: true,
    });
    expect(context).not.toBeNull();
    expect(context!.route.agentId).toBe("line-group-agent");
    expect(context!.route.matchedBy).toBe("binding.peer");
  });

  it("room peer binding matches raw roomId without prefix (#21907)", async () => {
    const roomId = "Rr1234567890abcdef";
    const bindingCfg: OpenClawConfig = {
      session: { store: storePath },
      agents: {
        list: [{ id: "main" }, { id: "line-room-agent" }],
      },
      bindings: [
        {
          agentId: "line-room-agent",
          match: { channel: "line", peer: { kind: "group", id: roomId } },
        },
      ],
    };

    const event = {
      type: "message",
      message: { id: "msg-2", type: "text", text: "hello" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "room", roomId, userId: "user-2" },
      mode: "active",
      webhookEventId: "evt-2",
      deliveryContext: { isRedelivery: false },
    } as MessageEvent;

    const context = await buildLineMessageContext({
      event,
      allMedia: [],
      cfg: bindingCfg,
      account,
      commandAuthorized: true,
    });
    expect(context).not.toBeNull();
    expect(context!.route.agentId).toBe("line-room-agent");
    expect(context!.route.matchedBy).toBe("binding.peer");
  });

  it("normalizes LINE ACP binding conversation ids through the plugin bindings surface", async () => {
    const compiled = lineBindingsAdapter.compileConfiguredBinding({
      conversationId: "line:user:U1234567890abcdef1234567890abcdef",
    });

    expect(compiled).toEqual({
      conversationId: "U1234567890abcdef1234567890abcdef",
    });
    expect(
      lineBindingsAdapter.matchInboundConversation({
        compiledBinding: compiled!,
        conversationId: "U1234567890abcdef1234567890abcdef",
      }),
    ).toEqual({
      conversationId: "U1234567890abcdef1234567890abcdef",
      matchPriority: 2,
    });
  });

  it("normalizes canonical LINE targets through the plugin bindings surface", async () => {
    const compiled = lineBindingsAdapter.compileConfiguredBinding({
      conversationId: "line:U1234567890abcdef1234567890abcdef",
    });

    expect(compiled).toEqual({
      conversationId: "U1234567890abcdef1234567890abcdef",
    });
    expect(
      lineBindingsAdapter.resolveCommandConversation({
        originatingTo: "line:U1234567890abcdef1234567890abcdef",
      }),
    ).toEqual({
      conversationId: "U1234567890abcdef1234567890abcdef",
    });
    expect(
      lineBindingsAdapter.matchInboundConversation({
        compiledBinding: compiled!,
        conversationId: "U1234567890abcdef1234567890abcdef",
      }),
    ).toEqual({
      conversationId: "U1234567890abcdef1234567890abcdef",
      matchPriority: 2,
    });
  });

  it("routes LINE conversations through active ACP session bindings", async () => {
    const userId = "U1234567890abcdef1234567890abcdef";
    await getSessionBindingService().bind({
      targetSessionKey: "agent:codex:acp:binding:line:default:test123",
      targetKind: "session",
      conversation: {
        channel: "line",
        accountId: "default",
        conversationId: userId,
      },
      placement: "current",
      metadata: {
        agentId: "codex",
      },
    });

    const event = createMessageEvent({ type: "user", userId });
    const context = await buildLineMessageContext({
      event,
      allMedia: [],
      cfg,
      account,
      commandAuthorized: true,
    });

    expect(context).not.toBeNull();
    expect(context!.route.agentId).toBe("codex");
    expect(context!.route.sessionKey).toBe("agent:codex:acp:binding:line:default:test123");
    expect(context!.route.matchedBy).toBe("binding.channel");
  });
});
