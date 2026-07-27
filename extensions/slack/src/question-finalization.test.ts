// Covers Slack question delivery capture and Block Kit final edit.
import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
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
vi.mock("./send.js", () => ({ updateMessageSlack: hoisted.update }));

import { slackOutbound } from "./outbound-adapter.js";

describe("Slack question finalization", () => {
  it("removes action blocks and appends terminal context", async () => {
    const questionId = "ask_0123456789abcdef0123456789abcdef";
    const payload = {
      channelData: { askUser: { questionId } },
      presentation: {
        blocks: [
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
    const slackData = rendered!.channelData?.slack as {
      renderedPresentationSegments: unknown[];
    };
    slackData.renderedPresentationSegments.unshift({
      kind: "text",
      text: "Preface",
      mrkdwn: false,
    });
    await slackOutbound.afterDeliverPayload?.({
      cfg: {},
      target: { channel: "slack", to: "C123", accountId: "default" },
      payload: rendered!,
      results: [
        { channel: "slack", messageId: "44", channelId: "C123" },
        { channel: "slack", messageId: "55", channelId: "C123" },
      ],
    });

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
  });
});
