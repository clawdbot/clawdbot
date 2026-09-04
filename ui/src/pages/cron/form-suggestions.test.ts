import { describe, expect, it, onTestFinished } from "vitest";
import { createChannelCapability } from "../../lib/channels/index.ts";
import { createInitialConfigState } from "../../lib/config/config-state-model.ts";
import { createInitialCronState } from "../../lib/cron/index.ts";
import { buildCronSuggestions, resolveConversationTargetSuggestions } from "./form-suggestions.ts";
import { createCronViewJob } from "./view.test-support.ts";

describe("buildCronSuggestions", () => {
  const telegramTarget = "-1001234567890";
  const webhookTarget = "https://example.test/hooks/saved";
  const accountUrl = "https://example.test/account-name";
  const telegramAccounts = ["default", telegramTarget, "work", accountUrl];

  it.each([
    {
      channel: "telegram",
      mode: "announce",
      recipients: [telegramTarget, webhookTarget],
      accounts: telegramAccounts,
    },
    {
      channel: "last",
      mode: "announce",
      recipients: [telegramTarget, webhookTarget],
      accounts: [...telegramAccounts, "discord-account", "Discord account"],
    },
    {
      channel: "telegram",
      mode: "webhook",
      recipients: [webhookTarget],
      accounts: telegramAccounts,
    },
  ] as const)("keeps $channel $mode recipients separate from account options", (scenario) => {
    const channels = createChannelCapability({
      snapshot: { client: null, phase: "stopped" },
      subscribe: () => () => undefined,
    });
    onTestFinished(() => channels.dispose());
    channels.state.channelsSnapshot = {
      ts: 0,
      channelOrder: ["telegram", "discord"],
      channelLabels: { telegram: "Telegram", discord: "Discord" },
      channels: {},
      channelAccounts: {
        telegram: [
          { accountId: "default", name: telegramTarget },
          { accountId: "work", name: accountUrl },
        ],
        discord: [{ accountId: "discord-account", name: "Discord account" }],
      },
      channelDefaultAccountId: { telegram: "default", discord: "discord-account" },
    };
    const cron = createInitialCronState();
    cron.cronForm.deliveryChannel = scenario.channel;
    cron.cronForm.deliveryMode = scenario.mode;
    cron.cronJobs = [
      createCronViewJob("telegram-job", {
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "Daily summary" },
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: telegramTarget,
          accountId: "default",
        },
      }),
      createCronViewJob("webhook-job", {
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "Daily summary" },
        delivery: { mode: "webhook", to: webhookTarget },
      }),
    ];

    const suggestions = buildCronSuggestions({
      channels: channels.state,
      runtimeConfig: createInitialConfigState(),
      cron,
      agentsList: null,
      modelSuggestions: [],
      conversationTargets: ["-1009876543210", "https://example.test/conversation-shaped-url"],
    });

    expect(suggestions.deliveryToSuggestions).toEqual(
      scenario.mode === "webhook"
        ? scenario.recipients
        : [
            ...scenario.recipients,
            "-1009876543210",
            "https://example.test/conversation-shaped-url",
          ].toSorted(),
    );
    expect(suggestions.accountTargets).toEqual(scenario.accounts);
  });
});

describe("resolveConversationTargetSuggestions", () => {
  const conversations = [
    {
      conversationRef: "conv_personal",
      channel: "telegram",
      accountId: "personal",
      kind: "group" as const,
      target: "-100personal",
      firstSeenAt: 0,
      lastSeenAt: 0,
    },
    {
      conversationRef: "conv_work",
      channel: "telegram",
      accountId: "work",
      kind: "group" as const,
      target: "-100work",
      firstSeenAt: 0,
      lastSeenAt: 0,
    },
    {
      conversationRef: "conv_work_topic",
      channel: "telegram",
      accountId: "work",
      kind: "group" as const,
      target: "-100work",
      threadId: "42",
      firstSeenAt: 0,
      lastSeenAt: 0,
    },
  ];

  it("requires an explicit account before exposing routeable target suggestions", () => {
    expect(resolveConversationTargetSuggestions(conversations, " work ")).toEqual(["-100work"]);
    expect(resolveConversationTargetSuggestions(conversations, "")).toEqual([]);
  });
});
