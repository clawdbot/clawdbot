import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  edit: vi.fn(),
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

vi.mock("./send.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./send.js")>();
  return { ...original, editMessageFeishu: hoisted.edit };
});

import { feishuOutbound } from "./outbound.js";

describe("Feishu question finalization", () => {
  it("removes question buttons and appends terminal status", async () => {
    const questionId = "ask_0123456789abcdef0123456789abcdef";
    const card = {
      schema: "2.0",
      body: {
        elements: [
          { tag: "markdown", content: "Choose an environment" },
          {
            tag: "button",
            text: { tag: "plain_text", content: "Production" },
            behaviors: [
              {
                type: "callback",
                value: {
                  oc: "ocf1",
                  k: "button",
                  a: "feishu.payload.question",
                  m: { questionId, optionValue: "Production" },
                  c: { h: "oc_chat", e: Date.now() + 60_000 },
                },
              },
            ],
          },
        ],
      },
    };

    await feishuOutbound.afterDeliverPayload?.({
      cfg: {},
      target: { channel: "feishu", to: "chat:oc_chat", accountId: "main" },
      payload: {
        channelData: {
          askUser: { questionId },
          feishu: { card },
        },
      },
      results: [{ channel: "feishu", messageId: "om_question", channelId: "oc_chat" }],
    });

    expect(hoisted.registration?.deliveryId).toBe("feishu:main:oc_chat:om_question");
    await hoisted.registration?.finalize("Answered: Production");
    expect(hoisted.edit).toHaveBeenCalledWith({
      cfg: {},
      accountId: "main",
      messageId: "om_question",
      card: expect.objectContaining({
        schema: "2.0",
        body: {
          elements: [
            { tag: "markdown", content: "Choose an environment" },
            {
              tag: "markdown",
              content: "<font color='grey'>Answered: Production</font>",
            },
          ],
        },
      }),
    });
  });
});
