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
import { resolveTelegramCommandAuthorization } from "./bot/helpers.js";

describe("Telegram inbound admission authorization", () => {
  it("gives opaque model callbacks the same current owner authority as short callbacks", async () => {
    const senderId = "42";
    const chatId = 42;
    const cfg = {
      commands: { ownerAllowFrom: [`telegram:${senderId}`] },
      channels: { telegram: { dmPolicy: "pairing", allowFrom: [] } },
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
      logger: getChildLogger({ module: "telegram/model-callback-auth-test" }),
      resolveGroupPolicy: () => ({ allowlistEnabled: false, allowed: true }),
      resolveGroupActivation: () => undefined,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({}),
      shouldSkipUpdate: () => false,
      processMessage: async () => ({ kind: "completed" as const }),
    } satisfies RegisterTelegramHandlerParams;
    const threadSpec = { scope: "none" as const };
    const shortCallbackAuthority = resolveTelegramCommandAuthorization({
      cfg,
      accountId: "default",
      chatId,
      isGroup: false,
      threadSpec,
      senderId,
      senderUsername: "owner",
    });
    const authorization = createTelegramHandlerAuthorization(params);
    const context = await authorization.resolveTelegramEventAuthorizationContext({
      cfg,
      chatId,
      isGroup: false,
      senderId,
      threadSpec,
    });

    expect(shortCallbackAuthority.senderIsOwner).toBe(true);
    await expect(
      authorization.authorizeTelegramEventSender({
        chatId,
        isGroup: false,
        senderId,
        senderUsername: "owner",
        mode: "callback-allowlist",
        context,
      }),
    ).resolves.toBe(false);
    const modelCallbackAuthorization =
      await authorization.resolveTelegramModelCallbackAuthorization({
        chatId,
        isGroup: false,
        senderId,
        senderUsername: "owner",
        context,
      });
    expect(modelCallbackAuthorization).toEqual({
      authorized: true,
      ownerAccess: expect.objectContaining({ senderIsOwner: true }),
    });
  });

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
