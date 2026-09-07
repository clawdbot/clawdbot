import { expect, it, vi } from "vitest";
import { renderReplyPayloadsToMessages, sendMSTeamsMessages } from "./messenger.js";

it.each([
  { name: "presentation-only", text: undefined },
  { name: "text and presentation", text: "Choose a deployment" },
])("delivers $name normal replies as native Adaptive Cards", async ({ text }) => {
  const presentation = {
    title: "Deployment",
    blocks: [
      { type: "text" as const, text: "Choose an environment" },
      {
        type: "buttons" as const,
        buttons: [
          { label: "Deploy", action: { type: "command" as const, command: "/deploy" } },
          {
            label: "Details",
            action: { type: "url" as const, url: "https://example.test/deploy" },
          },
          { label: "Acknowledge", value: "acknowledge" },
        ],
      },
      {
        type: "select" as const,
        placeholder: "Environment",
        options: [
          {
            label: "Production",
            action: { type: "command" as const, command: "/deploy production" },
          },
        ],
      },
    ],
  };
  const sendActivity = vi.fn(async (_activity: unknown) => ({ id: "adaptive-card" }));
  const messages = renderReplyPayloadsToMessages([{ text, presentation }], {
    textChunkLimit: 4000,
    tableMode: "code",
    chunkText: false,
  });

  const ids = await sendMSTeamsMessages({
    replyStyle: "thread",
    app: {} as never,
    appId: "app123",
    conversationRef: { conversation: { id: "conversation-1", conversationType: "personal" } },
    context: { sendActivity },
    messages,
  });

  expect(ids).toEqual(["adaptive-card"]);
  expect(sendActivity).toHaveBeenCalledTimes(1);
  const activity = sendActivity.mock.calls[0]?.[0] as {
    text?: string;
    attachments: Array<{ contentType: string; content: Record<string, unknown> }>;
  };
  expect(activity.text).toBeUndefined();
  expect(activity.attachments).toEqual([
    {
      contentType: "application/vnd.microsoft.card.adaptive",
      content: expect.objectContaining({
        type: "AdaptiveCard",
        body: expect.arrayContaining([
          expect.objectContaining({ text: "Deployment" }),
          expect.objectContaining({ text: "Choose an environment" }),
          expect.objectContaining({ text: "Environment:\n- Production: `/deploy production`" }),
          ...(text ? [expect.objectContaining({ text })] : []),
        ]),
        actions: [
          { type: "Action.Submit", title: "Deploy", data: "/deploy" },
          {
            type: "Action.OpenUrl",
            title: "Details",
            url: "https://example.test/deploy",
          },
          {
            type: "Action.Submit",
            title: "Acknowledge",
            data: { value: "acknowledge", label: "Acknowledge" },
          },
        ],
      }),
    },
  ]);
});
