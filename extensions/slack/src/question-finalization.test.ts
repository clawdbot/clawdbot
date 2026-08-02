// Covers Slack question delivery capture and Block Kit final edit.
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  send: vi.fn(),
  update: vi.fn(),
  registration: undefined as
    | { finalize: (statusLine: string) => void | Promise<void>; deliveryId: string }
    | undefined,
}));
vi.mock("openclaw/plugin-sdk/question-gateway-runtime", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("openclaw/plugin-sdk/question-gateway-runtime")>();
  return {
    ...original,
    questionGatewayRuntime: {
      ...original.questionGatewayRuntime,
      registerChannelDelivery: (registration: typeof hoisted.registration) => {
        hoisted.registration = registration;
      },
    },
  };
});
vi.mock("./send.js", () => ({
  reconcileSlackUnknownSend: vi.fn(),
  resolveSlackDmChannelId: vi.fn(),
  sendMessageSlack: hoisted.send,
  updateMessageSlack: hoisted.update,
}));

import { slackOutbound } from "./outbound-adapter.js";

function jsonRoundTrip<T>(value: T): T {
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- This test exercises JSON transport.
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("Slack question finalization", () => {
  beforeEach(() => {
    hoisted.send.mockReset();
    hoisted.update.mockReset();
    hoisted.registration = undefined;
  });

  it.each([
    {
      name: "split text and controls",
      mediaUrl: undefined,
      messageIds: ["33", "44", "55"],
      trailingFallback: false,
    },
    {
      name: "uploaded media, split text, and controls",
      mediaUrl: "https://example.com/options.png",
      messageIds: ["F123UPLOAD", "33", "44", "55"],
      trailingFallback: false,
    },
    {
      name: "uploaded media and controls followed by a native-data fallback",
      mediaUrl: "https://example.com/options.png",
      messageIds: ["F123UPLOAD", "33", "44", "55", "66"],
      trailingFallback: true,
    },
  ])(
    "finalizes the actual controls message after $name",
    async ({ mediaUrl, messageIds, trailingFallback }) => {
      const questionId = "ask_0123456789abcdef0123456789abcdef";
      const headers = Array.from({ length: 21 }, (_value, index) => `Column ${String(index)}`);
      const payload = {
        text: "Pick one",
        ...(mediaUrl ? { mediaUrl } : {}),
        channelData: { askUser: { questionId } },
        presentation: {
          blocks: [
            {
              type: "table" as const,
              caption: "Option metadata",
              headers,
              rows: [headers.map((_header, index) => `Value ${String(index)}`)],
            },
            { type: "text" as const, text: "Pick one" },
            {
              type: "buttons" as const,
              buttons: ["One", "Two"].map((label) => ({
                label,
                action: { type: "question" as const, questionId, optionValue: label },
              })),
            },
          ],
        },
      };
      const rendered = await slackOutbound.renderPresentation?.({
        payload,
        presentation: payload.presentation,
        ctx: { cfg: {}, to: "C123", text: "Pick one", payload },
      });
      expect(rendered).not.toBeNull();
      const renderedAfterTransport = jsonRoundTrip(rendered);
      const renderedSegments = (
        renderedAfterTransport?.channelData?.slack as
          | { renderedPresentationSegments?: unknown[] }
          | undefined
      )?.renderedPresentationSegments;
      expect(renderedSegments?.map((segment) => (segment as { kind?: unknown }).kind)).toEqual([
        "blocks",
        "text",
        "blocks",
      ]);
      let nextMessageIndex = 0;
      const requireNextMessageId = () => {
        const messageId = messageIds[nextMessageIndex++];
        if (!messageId) {
          throw new Error("Slack question test is missing a real delivery receipt");
        }
        return messageId;
      };
      const reportedResults: string[] = [];
      hoisted.send.mockImplementation(
        async (
          _to: string,
          _text: string,
          options: {
            blocks?: Array<{ type?: string }>;
            onDeliveryResult?: (result: unknown) => Promise<void>;
            onQuestionControlDelivery?: (delivery: {
              channelId: string;
              messageId: string;
              text: string;
              blocks: Array<{ type?: string }>;
            }) => void;
          },
        ) => {
          const messageId = requireNextMessageId();
          const result = { messageId, channelId: "C123" };
          await options.onDeliveryResult?.(result);
          if (options.blocks?.some((block) => block.type === "actions")) {
            options.onQuestionControlDelivery?.({
              ...result,
              text: _text,
              blocks: options.blocks,
            });
            if (trailingFallback) {
              const trailingResult = {
                messageId: requireNextMessageId(),
                channelId: "C123",
              };
              await options.onDeliveryResult?.(trailingResult);
              return trailingResult;
            }
          }
          return result;
        },
      );
      await slackOutbound.sendPayload?.({
        cfg: { channels: { slack: { botToken: "xoxb-test" } } },
        to: "C123",
        accountId: "default",
        text: payload.text,
        payload: renderedAfterTransport!,
        deps: { sendSlack: hoisted.send },
        onDeliveryResult: async (result) => {
          reportedResults.push(result.messageId);
        },
      });

      expect(reportedResults).toEqual(messageIds);
      expect(hoisted.registration?.deliveryId).toBe("slack:default:C123:55");
      await hoisted.registration?.finalize("Answered: <!channel>");
      expect(hoisted.update).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: "C123",
          messageTs: "55",
          text: expect.stringContaining("Answered: &lt;!channel&gt;"),
          blocks: expect.arrayContaining([
            {
              type: "context",
              elements: [{ type: "mrkdwn", text: "Answered: &lt;!channel&gt;" }],
            },
          ]),
        }),
      );
      const blocks = hoisted.update.mock.calls[0]?.[0]?.blocks as Array<{ type?: string }>;
      expect(blocks.some((block) => block.type === "actions")).toBe(false);
    },
  );
});
