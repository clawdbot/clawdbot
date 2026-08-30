// Msteams tests cover delivering a reply's portable presentation.
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredConversationReference } from "./conversation-store.js";
import { renderReplyPayloadsToMessages, sendMSTeamsMessages } from "./messenger.js";
import { setMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsApp } from "./sdk.js";

const chunkMarkdownText = (text: string, limit: number) => {
  if (!text) {
    return [];
  }
  if (limit <= 0 || text.length <= limit) {
    return [text];
  }
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += limit) {
    chunks.push(text.slice(index, index + limit));
  }
  return chunks;
};

const runtimeStub = {
  config: { loadConfig: () => ({}) },
  channel: {
    text: {
      chunkMarkdownText,
      chunkMarkdownTextWithMode: chunkMarkdownText,
      resolveMarkdownTableMode: () => "code",
      convertMarkdownTables: (text: string) => text,
    },
  },
} as unknown as PluginRuntime;

const conversationRef: StoredConversationReference = {
  activityId: "activity123",
  user: { id: "user123", name: "User" },
  agent: { id: "bot123", name: "Bot" },
  conversation: { id: "19:abc@thread.tacv2" },
  channelId: "msteams",
  serviceUrl: "https://smba.trafficmanager.net/amer/",
};

const approvalButtons = {
  type: "buttons" as const,
  buttons: [
    { label: "Approve", action: { type: "callback" as const, value: "approve" } },
    { label: "Deny", action: { type: "callback" as const, value: "deny" } },
  ],
};

function render(payload: Parameters<typeof renderReplyPayloadsToMessages>[0][number]) {
  return renderReplyPayloadsToMessages([payload], { textChunkLimit: 4000, tableMode: "code" });
}

/** Sends one rendered message and returns the activity handed to the Bot Framework SDK. */
async function captureActivity(
  message: Parameters<typeof sendMSTeamsMessages>[0]["messages"][number],
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  const app = {
    client: { request: vi.fn() },
    tokenManager: {
      getBotToken: async () => ({ toString: () => "bot-token" }),
      getGraphToken: async () => ({ toString: () => "graph-token" }),
    },
    send: async (_conversationId: string, activity: unknown) => {
      captured = activity as Record<string, unknown>;
      return { id: "captured" };
    },
    activitySender: {
      send: async (activity: unknown) => {
        captured = activity as Record<string, unknown>;
        return { id: "captured" };
      },
    },
    reply: async (_conversationId: string, _messageId: string, activity: unknown) => {
      captured = activity as Record<string, unknown>;
      return { id: "captured" };
    },
    api: {
      serviceUrl: "https://smba.trafficmanager.net/amer",
      conversations: {
        activities: () => ({
          create: async (activity: unknown) => {
            captured = activity as Record<string, unknown>;
            return { id: "captured" };
          },
          update: async () => ({ id: "updated" }),
          delete: async () => {},
        }),
      },
    },
  } as unknown as MSTeamsApp;
  await sendMSTeamsMessages({
    replyStyle: "top-level",
    app,
    appId: "app123",
    conversationRef,
    messages: [message],
  });
  if (!captured) {
    throw new Error("expected a Teams activity to be sent");
  }
  return captured;
}

describe("msteams reply presentation", () => {
  beforeEach(() => {
    setMSTeamsRuntime(runtimeStub);
  });

  it("delivers the controls a reply offers as a card", () => {
    const messages = render({
      text: "Deploy to production?",
      presentation: {
        blocks: [{ type: "text", text: "Deploy to production?" }, approvalButtons],
      },
    });

    expect(messages).toHaveLength(1);
    const card = messages[0]?.card as
      | { actions?: Array<{ title?: string }>; body?: Array<{ text?: string }> }
      | undefined;
    expect(card?.actions?.map((action) => action.title)).toEqual(["Approve", "Deny"]);
    expect(card?.body?.some((block) => block.text === "Deploy to production?")).toBe(true);
  });

  it("still reaches Teams when the controls are the whole reply", () => {
    // Without a card this payload has neither text nor media, so nothing was sent.
    const messages = render({ presentation: { blocks: [approvalButtons] } });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.card).toBeDefined();
  });

  it("states the controls in prose when the reply also carries media", () => {
    // A Teams activity carries a card or an attachment, never both.
    const messages = render({
      text: "Here it is",
      mediaUrl: "https://example.com/a.png",
      presentation: { blocks: [approvalButtons] },
    });

    expect(messages.some((message) => message.card)).toBe(false);
    expect(messages[0]?.text).toContain("Approve");
    expect(messages.some((message) => message.mediaUrl === "https://example.com/a.png")).toBe(true);
  });

  it("keeps authored prose when the presentation only restates it", () => {
    // `/status` ships its own plain rendering plus a table Teams cannot render natively.
    const authored = "Status: ok\n\n| agent | state |\n| --- | --- |\n| main | idle |";
    const messages = renderReplyPayloadsToMessages(
      [
        {
          text: authored,
          presentationTextMode: "fallback",
          presentation: {
            blocks: [
              {
                type: "table",
                caption: "Agents",
                headers: ["agent", "state"],
                rows: [["main", "idle"]],
              },
            ],
          },
        },
      ],
      { textChunkLimit: 4000, tableMode: "off" },
    );

    expect(messages.some((message) => message.card)).toBe(false);
    expect(messages[0]?.text).toBe(authored);
  });

  it("puts the controls on the wire as an adaptive-card attachment", async () => {
    // Whole send path: render -> buildActivity -> sendMSTeamsMessages.
    const [message] = render({
      text: "Deploy to production?",
      presentation: { blocks: [approvalButtons] },
    });
    const activity = await captureActivity(message!);

    const attachments = activity.attachments as Array<{
      contentType?: string;
      content?: { actions?: Array<{ title?: string }> };
    }>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(attachments[0]?.content?.actions?.map((action) => action.title)).toEqual([
      "Approve",
      "Deny",
    ]);
  });
});
