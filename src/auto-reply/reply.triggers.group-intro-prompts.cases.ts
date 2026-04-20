import { describe, expect, it } from "vitest";
import { makeCfg } from "../../test/helpers/auto-reply/trigger-handling-test-harness.js";
import { buildGroupChatContext, buildGroupIntro } from "./reply/groups.js";

type GetReplyFromConfig = typeof import("./reply.js").getReplyFromConfig;
type InboundMessage = Parameters<GetReplyFromConfig>[0];

export function registerGroupIntroPromptCases(): void {
  describe("group intro prompts", () => {
    type GroupIntroCase = {
      name: string;
      message: InboundMessage;
      expected: string[];
      defaultActivation?: "always" | "mention";
      setup?: (cfg: ReturnType<typeof makeCfg>) => void;
    };
    const groupParticipationNote =
      "Be a good group participant: mostly lurk and follow the conversation; reply only when directly addressed or you can add clear value. Emoji reactions are welcome when available. Write like a human. Avoid Markdown tables. Minimize empty lines and use normal chat conventions, not document-style spacing. Don't type literal \\n sequences; use real line breaks sparingly.";
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
          `You are in the Discord group chat "Release Squad". Participants: Alice, Bob.`,
          `Activation: trigger-only (you are invoked only when explicitly mentioned; recent context may be included). ${groupParticipationNote} Address the specific sender noted in the message context.`,
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
          `You are in the WhatsApp group chat "Ops". Your replies are automatically sent to this group chat. Do not use the message tool to send to this same group - just reply normally.`,
          `Activation: trigger-only (you are invoked only when explicitly mentioned; recent context may be included). ${groupParticipationNote} Address the specific sender noted in the message context.`,
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
          `You are in the Telegram group chat "Dev Chat".`,
          `Activation: trigger-only (you are invoked only when explicitly mentioned; recent context may be included). ${groupParticipationNote} Address the specific sender noted in the message context.`,
        ],
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
          `You are in the WhatsApp group chat "Test Group". Participants: Alice (+1), Bob (+2).`,
          "Activation: always-on (you receive every group message).",
        ],
        defaultActivation: "always",
      },
    ];

    for (const testCase of cases) {
      it(`labels group chats using channel-specific metadata: ${testCase.name}`, async () => {
        const cfg = makeCfg(`/tmp/group-intro-${testCase.name}`);
        testCase.setup?.(cfg);
        const extraSystemPrompt = [
          buildGroupChatContext({ sessionCtx: testCase.message }),
          buildGroupIntro({
            cfg,
            sessionCtx: testCase.message,
            defaultActivation: testCase.defaultActivation ?? "mention",
            silentToken: "NO_REPLY",
          }),
        ]
          .filter(Boolean)
          .join("\n\n");

        for (const expectedFragment of testCase.expected) {
          expect(extraSystemPrompt, `${testCase.name}:${expectedFragment}`).toContain(
            expectedFragment,
          );
        }
      });
    }
  });
}
