import type { webhook } from "@line/bot-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ResolvedLineAccount } from "./types.js";

// Only LINE API calls are replaced; admission and context creation run together.
vi.mock("./send.js", () => ({
  getUserProfile: async () => null,
  getLineGroupName: async () => undefined,
  getUserDisplayName: async (userId: string) => userId,
  pushMessageLine: vi.fn(),
  replyMessageLine: vi.fn(),
}));

let handleLineWebhookEvents: typeof import("./bot-handlers.js").handleLineWebhookEvents;
let recordLineSentMessages: typeof import("./outbound-message-log.js").recordLineSentMessages;

beforeAll(async () => {
  vi.resetModules();
  ({ handleLineWebhookEvents } = await import("./bot-handlers.js"));
  ({ recordLineSentMessages } = await import("./outbound-message-log.js"));
});

afterAll(() => {
  vi.resetModules();
});

type MentionCase = {
  name: string;
  source?: webhook.Source;
  text?: string;
  mention?: webhook.TextMessageContent["mention"];
  quote?: boolean;
  quotedBot?: boolean;
  patterns?: string[];
  requireMention?: boolean;
  eventKind?: "location" | "postback";
  expected: {
    WasMentioned: boolean | undefined;
    ExplicitlyMentionedBot: boolean | undefined;
    GroupRequireMention: boolean | undefined;
    ImplicitMentionKinds: string[] | undefined;
  };
};

const nativeBotMention: webhook.TextMessageContent["mention"] = {
  mentionees: [{ index: 0, length: 4, type: "user", userId: "bot", isSelf: true }],
};

const cases: MentionCase[] = [
  {
    name: "native bot mention in a group",
    text: "@bot hello",
    mention: nativeBotMention,
    expected: {
      WasMentioned: true,
      ExplicitlyMentionedBot: true,
      GroupRequireMention: true,
      ImplicitMentionKinds: [],
    },
  },
  {
    name: "native bot mention in a room",
    source: { type: "room", roomId: "room", userId: "sender" },
    text: "@bot hello",
    mention: nativeBotMention,
    expected: {
      WasMentioned: true,
      ExplicitlyMentionedBot: true,
      GroupRequireMention: true,
      ImplicitMentionKinds: [],
    },
  },
  {
    name: "native all-members mention",
    text: "@all hello",
    mention: { mentionees: [{ index: 0, length: 4, type: "all" }] },
    expected: {
      WasMentioned: true,
      ExplicitlyMentionedBot: true,
      GroupRequireMention: true,
      ImplicitMentionKinds: [],
    },
  },
  {
    name: "configured pattern without a native mention",
    text: "hello helper",
    patterns: ["\\bhelper\\b"],
    expected: {
      WasMentioned: true,
      ExplicitlyMentionedBot: false,
      GroupRequireMention: true,
      ImplicitMentionKinds: [],
    },
  },
  {
    name: "quote of a message the bot sent",
    quote: true,
    expected: {
      WasMentioned: true,
      ExplicitlyMentionedBot: false,
      GroupRequireMention: true,
      ImplicitMentionKinds: ["quoted_bot"],
    },
  },
  {
    name: "disabled quote policy in an always-on group",
    quote: true,
    quotedBot: false,
    requireMention: false,
    expected: {
      WasMentioned: false,
      ExplicitlyMentionedBot: false,
      GroupRequireMention: false,
      ImplicitMentionKinds: ["quoted_bot"],
    },
  },
  {
    name: "ordinary message in an always-on group",
    requireMention: false,
    expected: {
      WasMentioned: false,
      ExplicitlyMentionedBot: false,
      GroupRequireMention: false,
      ImplicitMentionKinds: [],
    },
  },
  {
    name: "mention of another member",
    text: "@pal hello",
    mention: { mentionees: [{ index: 0, length: 4, type: "user", userId: "pal", isSelf: false }] },
    requireMention: false,
    expected: {
      WasMentioned: false,
      ExplicitlyMentionedBot: false,
      GroupRequireMention: false,
      ImplicitMentionKinds: [],
    },
  },
  {
    name: "authorized command bypass",
    text: "/status",
    expected: {
      WasMentioned: true,
      ExplicitlyMentionedBot: false,
      GroupRequireMention: true,
      ImplicitMentionKinds: [],
    },
  },
  {
    name: "non-text message without native mention metadata",
    eventKind: "location",
    expected: {
      WasMentioned: false,
      ExplicitlyMentionedBot: false,
      GroupRequireMention: true,
      ImplicitMentionKinds: [],
    },
  },
  {
    name: "direct message without group mention facts",
    source: { type: "user", userId: "sender" },
    expected: {
      WasMentioned: undefined,
      ExplicitlyMentionedBot: undefined,
      GroupRequireMention: undefined,
      ImplicitMentionKinds: undefined,
    },
  },
  {
    name: "postback without message mention facts",
    eventKind: "postback",
    expected: {
      WasMentioned: undefined,
      ExplicitlyMentionedBot: undefined,
      GroupRequireMention: undefined,
      ImplicitMentionKinds: undefined,
    },
  },
];

describe("LINE admission facts on the dispatched turn", () => {
  it.each(cases)("preserves $name", async (testCase) => {
    await withTempHome(async () => {
      const account: ResolvedLineAccount = {
        accountId: "mention-context",
        enabled: true,
        channelAccessToken: "test-token",
        channelSecret: "test-secret",
        tokenSource: "config",
        config: {
          dmPolicy: "allowlist",
          allowFrom: ["sender"],
          groupPolicy: "allowlist",
          groupAllowFrom: ["sender"],
          groups: { "*": { requireMention: testCase.requireMention ?? true } },
        },
      };
      const cfg: OpenClawConfig = {
        channels: {
          line: account.config,
          defaults: { implicitMentions: { quotedBot: testCase.quotedBot } },
        },
        messages: { groupChat: { mentionPatterns: testCase.patterns ?? [] } },
      };
      const eventBase = {
        source: testCase.source ?? { type: "group" as const, groupId: "group", userId: "sender" },
        replyToken: "reply-token",
        timestamp: 1_700_000_000_000,
        mode: "active" as const,
        webhookEventId: "mention-event",
        deliveryContext: { isRedelivery: false },
      };
      const event: webhook.MessageEvent | webhook.PostbackEvent =
        testCase.eventKind === "postback"
          ? { ...eventBase, type: "postback", postback: { data: "selected" } }
          : {
              ...eventBase,
              type: "message",
              message:
                testCase.eventKind === "location"
                  ? {
                      id: "message",
                      type: "location",
                      title: "Place",
                      address: "Place",
                      latitude: 1,
                      longitude: 1,
                    }
                  : {
                      id: "message",
                      type: "text",
                      text: testCase.text ?? "hello",
                      quoteToken: "quote-token",
                      mention: testCase.mention,
                      quotedMessageId: testCase.quote ? "sent-message" : undefined,
                    },
            };
      if (testCase.quote) {
        recordLineSentMessages(account.accountId, ["sent-message"]);
      }
      const processMessage = vi.fn<Parameters<typeof handleLineWebhookEvents>[1]["processMessage"]>(
        async () => {},
      );
      await handleLineWebhookEvents([event], {
        cfg,
        account,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        mediaMaxBytes: 1,
        processMessage,
      });

      expect(processMessage).toHaveBeenCalledTimes(1);
      expect(processMessage.mock.calls[0]?.[0].ctxPayload).toMatchObject(testCase.expected);
    });
  });
});
