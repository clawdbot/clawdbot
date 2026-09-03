import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import {
  configureChannelAdmissionEvidenceCollection,
  consumeChannelAdmissionEvidence,
  createHostChannelInboundEventContextBuilder,
  readChannelContextAdmissionEvidence,
  registerChannelIngressHostOwner,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import { describe, expect, it, vi } from "vitest";
import { defaultTelegramBotDeps } from "./bot-deps.js";
import { createTelegramHandlerAuthorization } from "./bot-handlers.inbound-authorization.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";

function createTestParams(
  overrides?: Partial<RegisterTelegramHandlerParams>,
): RegisterTelegramHandlerParams {
  const cfg = { channels: { telegram: { enabled: true } } } as OpenClawConfig;
  return {
    accountId: "default",
    ownerAgentId: "main",
    bot: {} as RegisterTelegramHandlerParams["bot"],
    cfg,
    mediaMaxBytes: 1,
    opts: { token: "test-token" },
    runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
    telegramCfg: cfg.channels?.telegram ?? {},
    telegramDeps: {
      ...defaultTelegramBotDeps,
      getRuntimeConfig: () => cfg,
      readChannelAllowFromStore: async () => [],
    },
    logger: getChildLogger({ module: "telegram/admission-test" }),
    resolveGroupPolicy: () => ({ allowlistEnabled: true, allowed: true }),
    resolveGroupActivation: () => undefined,
    resolveGroupRequireMention: () => false,
    resolveTelegramGroupConfig: () => ({ groupConfig: undefined, topicConfig: undefined }),
    shouldSkipUpdate: () => false,
    processMessage: async () => ({ kind: "completed" as const }),
    ...overrides,
  } as RegisterTelegramHandlerParams;
}

describe("Telegram inbound admission authorization", () => {
  it("binds a forum admission to the finalized parent and topic scope", async () => {
    const chatId = -1001234567890;
    const topicId = 99;
    const participantId = "42";
    const cfg = {
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groupAllowFrom: [participantId],
          groups: {
            [String(chatId)]: { allowFrom: [participantId], groupPolicy: "allowlist" },
          },
        },
      },
    } as OpenClawConfig;
    const params = {
      accountId: "default",
      ownerAgentId: "main",
      bot: {} as RegisterTelegramHandlerParams["bot"],
      cfg,
      mediaMaxBytes: 1,
      opts: { token: "test-token" },
      runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
      telegramCfg: cfg.channels?.telegram ?? {},
      telegramDeps: {
        ...defaultTelegramBotDeps,
        getRuntimeConfig: () => cfg,
        readChannelAllowFromStore: async () => [],
      },
      logger: getChildLogger({ module: "telegram/admission-test" }),
      resolveGroupPolicy: () => ({ allowlistEnabled: true, allowed: true }),
      resolveGroupActivation: () => undefined,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { allowFrom: [participantId], groupPolicy: "allowlist" as const },
        topicConfig: undefined,
      }),
      shouldSkipUpdate: () => false,
      processMessage: async () => ({ kind: "completed" as const }),
    } satisfies RegisterTelegramHandlerParams;
    const gate = await createTelegramHandlerAuthorization(params).authorizeInboundMessage({
      msg: {
        message_id: 7,
        date: 1_700_000_000,
        chat: { id: chatId, type: "supergroup", title: "Forum", is_forum: true },
        from: { id: Number(participantId), is_bot: false, first_name: "Pat" },
        message_thread_id: topicId,
        text: "hello",
      },
      chatId,
      isGroup: true,
      isForum: true,
      senderId: participantId,
      senderUsername: "",
      requireConfiguredGroup: false,
      dmAccess: "silent",
    });
    expect(gate.allowed).toBe(true);
    if (!gate.allowed) {
      throw new Error("expected forum admission");
    }

    const clearCollection = configureChannelAdmissionEvidenceCollection(true);
    const owner = { channelId: "telegram", record: {}, epoch: {}, isLive: () => true };
    const clearOwner = registerChannelIngressHostOwner(owner);
    try {
      const sessionKey = "agent:main:telegram:group:forum:topic:99";
      const ingress = await gate.resolveChannelIngress({
        agentId: "main",
        sessionKey,
        messageId: "7",
        inboundEventKind: "user_request",
      });
      const buildContext = createHostChannelInboundEventContextBuilder(
        buildChannelInboundEventContext,
        owner,
      );
      const context = buildContext({
        channel: "telegram",
        accountId: "default",
        messageId: "7",
        from: `telegram:group:${String(chatId)}:topic:${String(topicId)}`,
        sender: { id: participantId },
        conversation: {
          kind: "group",
          id: String(chatId),
          parentId: String(chatId),
          threadId: String(topicId),
        },
        route: { agentId: "main", routeSessionKey: sessionKey },
        reply: { to: `telegram:${String(chatId)}`, messageThreadId: topicId },
        message: { rawBody: "hello", inboundEventKind: "user_request" },
        channelIngress: ingress,
      });

      expect(
        consumeChannelAdmissionEvidence(readChannelContextAdmissionEvidence(context)),
      ).toMatchObject({
        ingressState: "present",
        invoker: { state: "present", kind: "person" },
        decisionCoverage: "enforced",
      });
    } finally {
      clearOwner();
      clearCollection();
    }
  });
});

describe("Telegram inbound preparation rejection records", () => {
  it("records channel-disabled rejections", async () => {
    const params = createTestParams();
    const info = vi.spyOn(params.logger, "info").mockImplementation(() => undefined);
    const gate = await createTelegramHandlerAuthorization(params).authorizeInboundMessage({
      msg: {
        message_id: 1,
        date: 1_700_000_000,
        chat: { id: -100, type: "supergroup", title: "X" },
        from: { id: 1, is_bot: false, first_name: "U" },
        text: "hi",
      } as import("grammy/types").Message,
      chatId: -100,
      isGroup: true,
      isForum: false,
      senderId: "1",
      senderUsername: "",
      requireConfiguredGroup: true,
      dmAccess: "silent",
    });
    expect(gate.allowed).toBe(false);
    expect(info).toHaveBeenCalledExactlyOnceWith(
      {
        provider: "telegram",
        accountId: "default",
        chatId: -100,
        senderId: "1",
        reason: "channel-disabled",
      },
      "Telegram inbound event rejected during preparation",
    );
  });

  it("records group-disabled rejections", async () => {
    const params = createTestParams({
      resolveTelegramGroupConfig: () => ({
        groupConfig: { enabled: false } as TelegramGroupConfig,
        topicConfig: undefined,
      }),
    });
    const info = vi.spyOn(params.logger, "info").mockImplementation(() => undefined);
    const gate = await createTelegramHandlerAuthorization(params).authorizeInboundMessage({
      msg: {
        message_id: 2,
        date: 1_700_000_000,
        chat: { id: -100, type: "supergroup", title: "X" },
        from: { id: 1, is_bot: false, first_name: "U" },
        text: "hi",
      } as import("grammy/types").Message,
      chatId: -100,
      isGroup: true,
      isForum: false,
      senderId: "1",
      senderUsername: "",
      requireConfiguredGroup: false,
      dmAccess: "silent",
    });
    expect(gate.allowed).toBe(false);
    expect(info).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ reason: "group-disabled" }),
      "Telegram inbound event rejected during preparation",
    );
  });

  it("records dm-disabled rejections", async () => {
    const cfg = { channels: { telegram: { enabled: true, dmPolicy: "disabled" as const } } };
    const params = createTestParams({
      cfg: cfg as unknown as OpenClawConfig,
      telegramDeps: {
        ...defaultTelegramBotDeps,
        getRuntimeConfig: () => cfg as unknown as OpenClawConfig,
        readChannelAllowFromStore: async () => [],
      },
    });
    const info = vi.spyOn(params.logger, "info").mockImplementation(() => undefined);
    const gate = await createTelegramHandlerAuthorization(params).authorizeInboundMessage({
      msg: {
        message_id: 3,
        date: 1_700_000_000,
        chat: { id: 1, type: "private" },
        from: { id: 1, is_bot: false, first_name: "U" },
        text: "hi",
      } as import("grammy/types").Message,
      chatId: 1,
      isGroup: false,
      isForum: false,
      senderId: "1",
      senderUsername: "",
      requireConfiguredGroup: false,
      dmAccess: "silent",
    });
    expect(gate.allowed).toBe(false);
    expect(info).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ reason: "dm-disabled" }),
      "Telegram inbound event rejected during preparation",
    );
  });

  it("records dm-unauthorized rejections", async () => {
    const cfg = { channels: { telegram: { enabled: true, dmPolicy: "closed" as const } } };
    const params = createTestParams({
      cfg: cfg as unknown as OpenClawConfig,
      telegramDeps: {
        ...defaultTelegramBotDeps,
        getRuntimeConfig: () => cfg as unknown as OpenClawConfig,
        readChannelAllowFromStore: async () => [],
      },
    });
    const info = vi.spyOn(params.logger, "info").mockImplementation(() => undefined);
    const gate = await createTelegramHandlerAuthorization(params).authorizeInboundMessage({
      msg: {
        message_id: 4,
        date: 1_700_000_000,
        chat: { id: 1, type: "private" },
        from: { id: 1, is_bot: false, first_name: "U" },
        text: "hi",
      } as import("grammy/types").Message,
      chatId: 1,
      isGroup: false,
      isForum: false,
      senderId: "1",
      senderUsername: "",
      requireConfiguredGroup: false,
      dmAccess: "silent",
    });
    expect(gate.allowed).toBe(false);
    expect(info).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ reason: "dm-unauthorized" }),
      "Telegram inbound event rejected during preparation",
    );
  });
});
