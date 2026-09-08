/** Reusable group-intro prompt assertions shared by auto-reply trigger tests. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCfg } from "../../test/helpers/auto-reply/trigger-handling-test-harness.js";
import {
  captureActivePluginRegistrySnapshot,
  resetPluginRuntimeStateForTest,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { buildGroupChatContext, buildGroupIntro } from "./reply/groups.js";

type GetReplyFromConfig = typeof import("./reply/get-reply.js").getReplyFromConfig;
type InboundMessage = Parameters<GetReplyFromConfig>[0];

export function registerGroupIntroPromptCases(): void {
  describe("group intro prompts", () => {
    let previousPluginRegistry: ReturnType<typeof captureActivePluginRegistrySnapshot>;

    beforeEach(() => {
      previousPluginRegistry = captureActivePluginRegistrySnapshot();
      resetPluginRuntimeStateForTest();
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "telegram",
            source: "test",
            plugin: {
              ...createChannelTestPluginBase({ id: "telegram" }),
              messaging: { defaultMarkdownTableMode: "block" },
            },
          },
        ]),
      );
    });
    afterEach(() => {
      resetPluginRuntimeStateForTest();
      restoreActivePluginRegistrySnapshot(previousPluginRegistry);
    });

    type GroupIntroCase = {
      name: string;
      message: InboundMessage;
      expected: string[];
      forbidden?: string[];
      defaultActivation?: "always" | "mention";
      setup?: (cfg: ReturnType<typeof makeCfg>) => void;
    };
    const groupParticipationNote =
      "Be a good group participant: mostly lurk and follow the conversation; reply only when directly addressed or you can add clear value. Emoji reactions are welcome when available. Write like a human. Avoid Markdown tables. Minimize empty lines and use normal chat conventions, not document-style spacing. Don't type literal \\n sequences; use real line breaks sparingly.";
    const telegramGroupParticipationNote =
      "Be a good group participant: mostly lurk and follow the conversation; reply only when directly addressed or you can add clear value. Emoji reactions are welcome when available. Write like a human. Minimize empty lines and use normal chat conventions, not document-style spacing. Don't type literal \\n sequences; use real line breaks sparingly.";
    const groupSilentNote =
      'If no text reply is needed, including after a reaction or other action, reply with exactly "NO_REPLY" as the entire final answer, without commentary, punctuation, or formatting.';
    const automaticGroupDeliveryGuidance = [
      "Your text replies are automatically sent to this group chat unless the current-turn context says final replies stay private.",
      "For ordinary text, do not use the message tool to send to this same destination unless the current-turn context asks for visible output via message(action=send).",
      "Use message(action=send) only when you need to send files, images, or other attachments to this same group/topic.",
    ];
    const automaticChannelDeliveryGuidance = [
      "Your text replies are automatically sent to this channel unless the current-turn context says final replies stay private.",
      "For ordinary text, do not use the message tool to send to this same destination unless the current-turn context asks for visible output via message(action=send).",
      "Use message(action=send) only when you need to send files, images, or other attachments to this same channel/thread.",
    ];
    const cases: GroupIntroCase[] = [
      {
        name: "discord",
        message: {
          Body: "status update",
          From: "discord:group:dev",
          To: "+1888",
          ChatType: "group",
          GroupSubject: "Release Squad",
          GroupMembers: "Alice, Bob",
          Provider: "discord",
        },
        expected: [
          "You are in a Discord group chat.",
          groupParticipationNote,
          groupSilentNote,
          "Activation: trigger-only (you are invoked only when explicitly mentioned; recent context may be included). Address the specific sender noted in the message context.",
        ],
      },
      {
        name: "whatsapp",
        message: {
          Body: "ping",
          From: "123@g.us",
          To: "+1999",
          ChatType: "group",
          GroupSubject: "Ops",
          Provider: "whatsapp",
        },
        expected: [
          "You are in a WhatsApp group chat.",
          ...automaticGroupDeliveryGuidance,
          groupParticipationNote,
          groupSilentNote,
          "Activation: trigger-only (you are invoked only when explicitly mentioned; recent context may be included). Address the specific sender noted in the message context.",
        ],
      },
      {
        name: "telegram",
        message: {
          Body: "ping",
          From: "telegram:group:tg",
          To: "+1777",
          ChatType: "group",
          GroupSubject: "Dev Chat",
          Provider: "telegram",
        },
        expected: [
          "You are in a Telegram group chat.",
          telegramGroupParticipationNote,
          groupSilentNote,
          "Activation: trigger-only (you are invoked only when explicitly mentioned; recent context may be included). Address the specific sender noted in the message context.",
        ],
        forbidden: ["Avoid Markdown tables"],
      },
      {
        name: "mattermost-channel",
        message: {
          Body: "release status",
          From: "mattermost:channel:town-square",
          To: "channel:town-square",
          ChatType: "channel",
          GroupSubject: "Town Square",
          Provider: "mattermost",
        },
        expected: [
          "You are in a Mattermost channel.",
          ...automaticChannelDeliveryGuidance,
          groupParticipationNote,
          groupSilentNote,
          "Activation: trigger-only (you are invoked only when explicitly mentioned; recent context may be included). Address the specific sender noted in the message context.",
        ],
        forbidden: ["Mattermost group chat"],
      },
      {
        name: "whatsapp-always-on",
        setup: (cfg) => {
          cfg.channels ??= {};
          cfg.channels.whatsapp = {
            ...cfg.channels.whatsapp,
            allowFrom: ["*"],
            groups: { "*": { requireMention: false } },
          };
          cfg.messages = {
            ...cfg.messages,
            groupChat: {},
          };
        },
        message: {
          Body: "hello group",
          From: "123@g.us",
          To: "+2000",
          ChatType: "group",
          Provider: "whatsapp",
          SenderE164: "+2000",
          GroupSubject: "Test Group",
          GroupMembers: "Alice (+1), Bob (+2)",
        },
        expected: [
          "You are in a WhatsApp group chat.",
          "Activation: always-on (you receive every group message). You see every message; most need no response. When you do reply, address the specific sender noted in the message context.",
          groupSilentNote,
        ],
        defaultActivation: "always",
      },
    ];

    for (const testCase of cases) {
      it(`labels group chats using channel-specific metadata: ${testCase.name}`, async () => {
        const cfg = makeCfg(`/tmp/group-intro-${testCase.name}`);
        testCase.setup?.(cfg);
        const extraSystemPrompt = [
          buildGroupChatContext({
            sessionCtx: testCase.message,
            silentReplyPolicy: "allow",
            silentToken: "NO_REPLY",
          }),
          buildGroupIntro({
            defaultActivation: testCase.defaultActivation ?? "mention",
          }),
        ]
          .filter(Boolean)
          .join("\n\n");

        for (const expectedFragment of testCase.expected) {
          expect(extraSystemPrompt, `${testCase.name}:${expectedFragment}`).toContain(
            expectedFragment,
          );
        }
        for (const forbiddenFragment of testCase.forbidden ?? []) {
          expect(extraSystemPrompt, `${testCase.name}:${forbiddenFragment}`).not.toContain(
            forbiddenFragment,
          );
        }
      });
    }
  });
}
