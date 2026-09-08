// Root-owned integration combines the public Telegram API with the reply conversation owner.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildTelegramRoutingTarget,
  normalizeTelegramMessagingTarget,
  resolveTelegramGroupRequireMention,
  telegramPlugin,
} from "../extensions/telegram/api.js";
import {
  buildGroupIntro,
  defaultGroupActivation,
  resolveGroupRequireMention,
} from "../src/auto-reply/reply/groups.js";
import { prepareReplyConversation } from "../src/auto-reply/reply/prompt-session-context.js";
import { deriveSessionMetaPatch } from "../src/config/sessions/metadata.js";
import type { SessionEntry } from "../src/config/sessions/types.js";
import { telegramMessagingForTest } from "../src/infra/outbound/targets.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../src/plugins/runtime.js";
import { createTestRegistry } from "../src/test-utils/channel-plugins.js";
import { normalizeSessionDeliveryState } from "../src/utils/delivery-context.shared.js";
import { heartbeatRunnerTelegramPlugin } from "./helpers/infra/heartbeat-runner-channel-plugins.js";

const stored: SessionEntry = {
  sessionId: "conversation",
  updatedAt: 1,
  chatType: "channel",
  groupId: "C123",
  subject: "Operations",
  groupChannel: "#ops",
  space: "workspace",
  groupActivation: "always",
  delivery: normalizeSessionDeliveryState({
    context: { channel: "slack", to: "C123", accountId: "work", threadId: "42" },
    origin: { provider: "slack", surface: "slack", chatType: "channel" },
  }),
};

describe("prepared reply conversation", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", source: "test", plugin: telegramPlugin }]),
    );
  });
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });
  it.each([
    { name: "matching topic", topic: 77, account: "work", mention: false, inherits: true },
    { name: "different topic", topic: 88, account: "work", mention: true, inherits: false },
    { name: "different account", topic: 77, account: "personal", mention: true, inherits: false },
  ])(
    "preserves Telegram's native topic policy for $name",
    ({ topic, account, mention, inherits }) => {
      const target = (id: number) =>
        normalizeTelegramMessagingTarget(buildTelegramRoutingTarget(-1001, { scope: "forum", id }));
      const entry: SessionEntry = {
        ...stored,
        chatType: "group",
        groupId: "-1001:topic:77",
        delivery: normalizeSessionDeliveryState({
          context: { channel: "telegram", to: target(77), accountId: "work", threadId: 77 },
        }),
      };
      const conversation = prepareReplyConversation({
        ctx: {
          InternalTurnSource: "exec",
          OriginatingChannel: "telegram",
          OriginatingTo: target(topic),
          AccountId: account,
          MessageThreadId: topic,
          ChatType: "group",
        },
        sessionEntry: entry,
      });
      expect(conversation.fields.OriginatingTo).toBe(`telegram:-1001:topic:${topic}`);
      expect(conversation.group.groupId).toBe(`-1001:topic:${topic}`);
      expect(
        resolveTelegramGroupRequireMention({
          ...conversation.group,
          cfg: {
            channels: {
              telegram: {
                groups: { "*": { requireMention: true } },
                accounts: {
                  work: {
                    groups: {
                      "-1001": {
                        requireMention: true,
                        topics: { "77": { requireMention: false } },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      ).toBe(mention);
      expect(
        buildGroupIntro({ activation: conversation.activation, defaultActivation: "mention" }),
      ).toContain(inherits ? "Activation: always-on" : "Activation: trigger-only");
    },
  );

  it.each([
    {
      name: "split topic 88",
      topic: 88,
      parentMention: false,
      topicMention: true,
      storedTopic: 77,
      storedGroupId: "-1001:topic:77",
      liveRoute: true,
      inherits: false,
      sessionActivation: "always" as const,
    },
    {
      name: "General topic 1",
      topic: 1,
      parentMention: true,
      topicMention: false,
      storedTopic: 77,
      storedGroupId: "-1001:topic:77",
      liveRoute: true,
      inherits: false,
      sessionActivation: "always" as const,
    },
    {
      name: "matched bare topic 88",
      topic: 88,
      parentMention: false,
      topicMention: true,
      storedTopic: 88,
      storedGroupId: "-1001",
      liveRoute: true,
      inherits: true,
      sessionActivation: undefined,
    },
    {
      name: "inherited bare General topic 1",
      topic: 1,
      parentMention: true,
      topicMention: false,
      storedTopic: 1,
      storedGroupId: "-1001",
      liveRoute: false,
      inherits: true,
      sessionActivation: undefined,
    },
    {
      name: "inherited encoded topic with activation override",
      topic: 77,
      parentMention: false,
      topicMention: true,
      storedTopic: 77,
      storedGroupId: "-1001:topic:77",
      liveRoute: false,
      inherits: true,
      sessionActivation: "always" as const,
    },
  ])(
    "resolves Telegram topic policy from separate route metadata for $name",
    async ({
      topic,
      parentMention,
      topicMention,
      storedTopic,
      storedGroupId,
      liveRoute,
      inherits,
      sessionActivation,
    }) => {
      const originatingTo = normalizeTelegramMessagingTarget(
        buildTelegramRoutingTarget(-1001, topic === 1 ? { scope: "forum", id: topic } : undefined),
      );
      expect(originatingTo).toBe("telegram:-1001");
      const persistedTo = buildTelegramRoutingTarget(-1001, { scope: "forum", id: storedTopic });
      const cfg = {
        channels: {
          telegram: {
            accounts: {
              work: {
                groups: {
                  "-1001": {
                    requireMention: parentMention,
                    topics: { [String(topic)]: { requireMention: topicMention } },
                  },
                },
              },
            },
          },
        },
      };
      expect(resolveTelegramGroupRequireMention({ cfg, accountId: "work", groupId: "-1001" })).toBe(
        parentMention,
      );
      expect(
        resolveTelegramGroupRequireMention({
          cfg,
          accountId: "work",
          groupId: `-1001:topic:${topic}`,
        }),
      ).toBe(topicMention);
      const entry: SessionEntry = {
        ...stored,
        chatType: "group",
        groupId: storedGroupId,
        groupActivation: sessionActivation,
        delivery: normalizeSessionDeliveryState({
          context: {
            channel: "telegram",
            to: persistedTo,
            accountId: "work",
            threadId: storedTopic,
          },
        }),
      };
      const metadata = inherits
        ? deriveSessionMetaPatch({
            ctx: {
              Provider: "telegram",
              From: `telegram:group:${storedGroupId}`,
              OriginatingChannel: "telegram",
              OriginatingTo: persistedTo,
              AccountId: "work",
              MessageThreadId: storedTopic,
              ChatType: "group",
              GroupSubject: stored.subject,
            },
            sessionKey: `agent:main:telegram:group:${storedGroupId}`,
            existing: entry,
          })
        : undefined;
      if (inherits) {
        expect(metadata?.groupId).toBe(storedGroupId);
      }
      const conversation = prepareReplyConversation({
        ctx: {
          InternalTurnSource: "exec",
          ...(liveRoute
            ? {
                OriginatingChannel: "telegram",
                OriginatingTo: originatingTo,
                AccountId: "work",
                MessageThreadId: topic,
                ChatType: "group",
              }
            : {}),
        },
        sessionEntry: { ...entry, ...metadata },
      });
      expect(conversation.fields.OriginatingTo).toBe(liveRoute ? originatingTo : persistedTo);
      expect(conversation.fields.MessageThreadId).toBe(topic);
      expect(conversation.fields.GroupSubject).toBe(inherits ? stored.subject : undefined);
      expect(conversation.activation).toBe(inherits ? sessionActivation : undefined);
      const requireMention = resolveTelegramGroupRequireMention({ cfg, ...conversation.group });
      expect(requireMention).toBe(topicMention);
      await expect(resolveGroupRequireMention({ cfg, group: conversation.group })).resolves.toBe(
        topicMention,
      );
      if (requireMention === undefined) {
        throw new Error("Configured Telegram topic policy did not resolve");
      }
      expect(
        buildGroupIntro({
          activation: conversation.activation,
          defaultActivation: defaultGroupActivation(requireMention),
        }),
      ).toContain(
        inherits && sessionActivation === "always"
          ? "Activation: always-on"
          : topicMention
            ? "Activation: trigger-only"
            : "Activation: always-on",
      );
    },
  );

  it.each([
    { name: "bare current and encoded stored", currentEncoded: false },
    { name: "encoded current and bare stored", currentEncoded: true },
  ])("preserves stored Telegram topic context for $name", ({ currentEncoded }) => {
    const bare = normalizeTelegramMessagingTarget(buildTelegramRoutingTarget(-1001));
    const encoded = normalizeTelegramMessagingTarget(
      buildTelegramRoutingTarget(-1001, { scope: "forum", id: 77 }),
    );
    const currentTo = currentEncoded ? encoded : bare;
    const persistedTo = currentEncoded ? bare : encoded;
    const conversation = prepareReplyConversation({
      ctx: {
        InternalTurnSource: "exec",
        OriginatingChannel: "telegram",
        OriginatingTo: currentTo,
        AccountId: "work",
        MessageThreadId: 77,
        ChatType: "group",
      },
      sessionEntry: {
        ...stored,
        subject: "Stored topic",
        chatType: "group",
        groupId: "-1001:topic:77",
        delivery: normalizeSessionDeliveryState({
          context: { channel: "telegram", to: persistedTo, accountId: "work", threadId: 77 },
        }),
      },
    });
    expect(conversation.fields.GroupSubject).toBe("Stored topic");
    expect(conversation.activation).toBe("always");
    expect(conversation.fields.OriginatingTo).toBe(currentTo);
    expect(conversation.fields.MessageThreadId).toBe(77);
    expect(
      buildGroupIntro({ activation: conversation.activation, defaultActivation: "mention" }),
    ).toContain("Activation: always-on");
  });
});

describe("Telegram test target classification", () => {
  it.each([
    { name: "completion topic 42", to: "telegram:-100155462274:topic:42", expected: "group" },
    { name: "moved base topic 88", to: "telegram:-100155462274:topic:88", expected: "group" },
    { name: "basic negative group", to: "-123456789", expected: "group" },
    { name: "positive direct chat", to: "123456789", expected: "direct" },
    { name: "unresolved username", to: "@operations", expected: undefined },
    { name: "nonnumeric negative target", to: "-not-a-number", expected: undefined },
  ])("keeps test fixtures aligned with the public plugin for $name", ({ to, expected }) => {
    const inferTargetChatType = telegramPlugin.messaging?.inferTargetChatType;
    if (!inferTargetChatType) {
      throw new Error("Telegram must provide target chat classification");
    }
    const actual = inferTargetChatType({ to });
    expect(actual).toBe(expected);
    expect(telegramMessagingForTest.inferTargetChatType?.({ to })).toBe(actual);
    expect(heartbeatRunnerTelegramPlugin.messaging?.inferTargetChatType?.({ to })).toBe(actual);
  });
});
