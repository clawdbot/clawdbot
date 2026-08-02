// Native Slack question controls must finalize the exact delivered Block Kit message.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildSlackBlocksFallbackText } from "../blocks-fallback.js";

type QuestionDeliveryRegistration = {
  questionId: string;
  deliveryId: string;
  finalize: (statusLine: string) => void | Promise<void>;
};

type SlackQuestionUpdate = {
  text: string;
  blocks: Array<{
    type?: string;
    elements?: Array<{ type?: string; text: string }>;
  }>;
};

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  update: vi.fn(),
  writeClient: vi.fn(),
  registrations: [] as QuestionDeliveryRegistration[],
}));

vi.mock("./send.runtime.js", () => ({
  sendMessageSlack: async (...args: unknown[]) => {
    const result = await mocks.send(...args);
    const options = args[2] as {
      blocks?: Array<{ type?: string }>;
      onQuestionControlDelivery?: (delivery: {
        channelId: string;
        messageId: string;
        text: string;
        blocks: Array<{ type?: string }>;
      }) => void;
    };
    if (options.blocks?.some((block) => block.type === "actions")) {
      const controlResult =
        (result.controlDelivery as { channelId: string; messageId: string } | undefined) ?? result;
      options.onQuestionControlDelivery?.({
        channelId: controlResult.channelId,
        messageId: controlResult.messageId,
        text:
          typeof args[1] === "string" && args[1]
            ? args[1]
            : buildSlackBlocksFallbackText(options.blocks),
        blocks: options.blocks,
      });
    }
    return result;
  },
}));

vi.mock("../client.js", () => ({
  getSlackWriteClient: (...args: unknown[]) => mocks.writeClient(...args),
}));

vi.mock("openclaw/plugin-sdk/question-gateway-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/question-gateway-runtime")>();
  return {
    ...actual,
    questionGatewayRuntime: {
      ...actual.questionGatewayRuntime,
      registerChannelDelivery: (registration: QuestionDeliveryRegistration) => {
        mocks.registrations.push(registration);
      },
    },
  };
});

import { deliverReplies } from "./replies.js";

const QUESTION_ID = "ask_0123456789abcdef0123456789abcdef";
const QUESTION_THREAD_TS = "1712345678.000001";

function buildQuestionPayload(options?: { mediaUrl?: string; splitPresentation?: boolean }) {
  const questionBlocks = [
    { type: "text" as const, text: "Where should this deploy?" },
    {
      type: "buttons" as const,
      buttons: ["Staging", "Production"].map((label) => ({
        label,
        action: { type: "question" as const, questionId: QUESTION_ID, optionValue: label },
      })),
    },
  ];
  const headers = Array.from({ length: 21 }, (_entry, index) => `Column ${String(index)}`);
  return {
    text: "Choose a deploy target",
    ...(options?.mediaUrl ? { mediaUrl: options.mediaUrl } : {}),
    channelData: { askUser: { questionId: QUESTION_ID } },
    presentation: {
      blocks: options?.splitPresentation
        ? [
            {
              type: "table" as const,
              caption: "Deployment metadata",
              headers,
              rows: [headers.map((_header, index) => `Value ${String(index)}`)],
            },
            ...questionBlocks,
          ]
        : questionBlocks,
    },
  };
}

function buildParams(overrides?: Record<string, unknown>) {
  return {
    cfg: { channels: { slack: { botToken: "xoxb-test" } } },
    replies: [buildQuestionPayload()],
    target: "C123",
    token: "xoxp-authoring-user",
    accountId: "work",
    runtime: { log: () => {}, error: () => {}, exit: () => {} },
    textLimit: 4000,
    replyThreadTs: QUESTION_THREAD_TS,
    replyToMode: "all" as const,
    ...overrides,
  };
}

function requireQuestionRegistration(): QuestionDeliveryRegistration {
  expect(mocks.registrations).toHaveLength(1);
  const registration = mocks.registrations[0];
  if (!registration) {
    throw new Error("native Slack question delivery was not registered");
  }
  return registration;
}

function requireQuestionUpdate(): SlackQuestionUpdate {
  const update = mocks.update.mock.calls[0]?.[0] as SlackQuestionUpdate | undefined;
  if (!update) {
    throw new Error("native Slack question terminal edit was not delivered");
  }
  return update;
}

describe("native Slack question delivery finalization", () => {
  beforeEach(() => {
    mocks.send.mockReset();
    mocks.update.mockReset();
    mocks.writeClient.mockReset();
    mocks.writeClient.mockReturnValue({ chat: { update: mocks.update } });
    mocks.registrations.length = 0;
  });

  it.each([
    ["answered", "Answered: <!channel>", "Answered: &lt;!channel&gt;"],
    ["expired", "Expired", "Expired"],
    ["cancelled", "Cancelled", "Cancelled"],
  ])(
    "removes delivered question buttons when the question is %s",
    async (_phase, status, expected) => {
      mocks.send.mockResolvedValue({ messageId: "1712345678.000010", channelId: "C123" });

      await deliverReplies(buildParams());

      const registration = requireQuestionRegistration();
      expect(registration).toMatchObject({
        questionId: QUESTION_ID,
        deliveryId: "slack:work:C123:1712345678.000010",
      });
      expect(mocks.send.mock.calls[0]?.[2]).toMatchObject({ threadTs: QUESTION_THREAD_TS });

      await registration.finalize(status);

      expect(mocks.writeClient).toHaveBeenCalledWith("xoxp-authoring-user");
      expect(mocks.update).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "C123",
          ts: "1712345678.000010",
          text: expect.stringContaining(expected),
          blocks: expect.arrayContaining([
            { type: "context", elements: [{ type: "mrkdwn", text: expected }] },
          ]),
        }),
      );
      const { blocks } = requireQuestionUpdate();
      expect(blocks.some((block) => block.type === "actions")).toBe(false);
    },
  );

  it("finalizes a valid maximum Gateway answer within Slack context element limits", async () => {
    const questions = Array.from({ length: 3 }, (_question, questionIndex) => ({
      questionId: `question_${String(questionIndex)}`,
      header: `Choice ${String(questionIndex)}`,
      question: "Which options should run?",
      multiSelect: true,
      options: Array.from({ length: 4 }, (_option, optionIndex) => ({
        label: `${"&".repeat(63)}${String(optionIndex)}`,
      })),
    }));
    const selectedLabels = questions.flatMap((question) =>
      question.options.map((option) => option.label),
    );
    const status = `Answered: ${selectedLabels.join(", ")}`;
    const escapedStatus = `Answered: ${selectedLabels
      .map((label) => label.replaceAll("&", "&amp;"))
      .join(", ")}`;
    expect(questions).toHaveLength(3);
    expect(questions.every((question) => question.options.length === 4)).toBe(true);
    expect(
      questions.every(
        (question) => new Set(question.options.map((option) => option.label)).size === 4,
      ),
    ).toBe(true);
    expect(selectedLabels.every((label) => Array.from(label).length === 64)).toBe(true);
    expect(escapedStatus).toHaveLength(3_824);

    mocks.send.mockResolvedValue({ messageId: "1712345678.000026", channelId: "C123" });
    mocks.update.mockImplementation(
      async (message: {
        blocks: Array<{ type?: string; elements?: Array<{ text?: string }> }>;
      }) => {
        for (const block of message.blocks) {
          if (block.type !== "context") {
            continue;
          }
          if (
            (block.elements?.length ?? 0) > 10 ||
            block.elements?.some((element) => {
              const text = element.text ?? "";
              return (
                Array.from(text).length > 3_000 ||
                text
                  .replaceAll("&amp;", "")
                  .replaceAll("&lt;", "")
                  .replaceAll("&gt;", "")
                  .includes("&")
              );
            })
          ) {
            throw new Error("invalid_blocks");
          }
        }
      },
    );

    await deliverReplies(buildParams());
    await expect(requireQuestionRegistration().finalize(status)).resolves.toBeUndefined();

    const update = requireQuestionUpdate();
    const contextBlocks = update.blocks.filter((block) => block.type === "context");
    const contextElements = contextBlocks.flatMap((block) => block.elements ?? []);
    expect(contextBlocks).toHaveLength(1);
    expect(contextElements).toHaveLength(2);
    expect(contextElements.every((element) => Array.from(element.text).length <= 3_000)).toBe(true);
    expect(contextElements.map((element) => element.text).join("")).toBe(escapedStatus);
    expect(Buffer.byteLength(update.text, "utf8")).toBeLessThanOrEqual(4_000);
    expect(update.text.endsWith(`\n\n${escapedStatus}`)).toBe(true);
    expect(update.blocks.some((block) => block.type === "actions")).toBe(false);
    expect(mocks.writeClient).toHaveBeenCalledWith("xoxp-authoring-user");
  });

  it.each([
    {
      name: "an exact 3,000-character boundary",
      status: `Answered: ${"a".repeat(2_990)}`,
      expectedLengths: [3_000],
    },
    {
      name: "an astral character at the exact Unicode boundary",
      status: `Answered: ${"a".repeat(2_989)}😀`,
      expectedLengths: [3_000],
    },
    {
      name: "an astral character beyond the Unicode boundary",
      status: `Answered: ${"a".repeat(2_990)}😀`,
      expectedLengths: [3_000, 1],
    },
    {
      name: "an escaped entity and mention across the Unicode boundary",
      status: `Answered: ${"a".repeat(2_988)}&😀<!channel>`,
      expectedLengths: [2_998, 22],
    },
  ])("keeps complete Slack context text at $name", async ({ status, expectedLengths }) => {
    mocks.send.mockResolvedValue({ messageId: "1712345678.000027", channelId: "C123" });

    await deliverReplies(buildParams());
    await requireQuestionRegistration().finalize(status);

    const update = requireQuestionUpdate();
    const elements = update.blocks
      .filter((block) => block.type === "context")
      .flatMap((block) => block.elements ?? []);
    expect(elements.map((element) => Array.from(element.text).length)).toEqual(expectedLengths);
    expect(elements.map((element) => element.text).join("")).toBe(
      update.text.slice(update.text.lastIndexOf("\n\n") + 2),
    );
    expect(elements.every((element) => !element.text.includes("�"))).toBe(true);
    expect(Buffer.byteLength(update.text, "utf8")).toBeLessThanOrEqual(4_000);
    if (status.includes("<!channel>")) {
      expect(elements[1]?.text).toBe("&amp;😀&lt;!channel&gt;");
      expect(update.text).not.toContain("<!channel>");
    }
  });

  it("binds the actual control message after a media upload and split text segment", async () => {
    mocks.send
      .mockResolvedValueOnce({ messageId: "F123UPLOAD", channelId: "C123" })
      .mockResolvedValueOnce({ messageId: "1712345678.000011", channelId: "C123" })
      .mockResolvedValueOnce({ messageId: "1712345678.000012", channelId: "C123" });

    await deliverReplies(
      buildParams({
        replies: [
          buildQuestionPayload({
            mediaUrl: "https://example.com/deploy.png",
            splitPresentation: true,
          }),
        ],
      }),
    );

    expect(mocks.send).toHaveBeenCalledTimes(3);
    const registration = requireQuestionRegistration();
    expect(registration.deliveryId).toBe("slack:work:C123:1712345678.000012");

    await registration.finalize("Expired");

    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C123", ts: "1712345678.000012" }),
    );
  });

  it("keeps the actual controls receipt when provider fallback returns a later message", async () => {
    mocks.send.mockResolvedValue({
      messageId: "1712345678.000041",
      channelId: "C123",
      controlDelivery: { messageId: "1712345678.000040", channelId: "C123" },
    });

    await deliverReplies(buildParams());

    expect(requireQuestionRegistration().deliveryId).toBe("slack:work:C123:1712345678.000040");
    await requireQuestionRegistration().finalize("Expired");
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C123", ts: "1712345678.000040" }),
    );
  });

  it("finalizes Enterprise Grid questions through the original scoped listener client", async () => {
    const updateScopedMessage = vi.fn();
    const listenerClient = { chat: { update: updateScopedMessage } };
    mocks.send.mockResolvedValue({ messageId: "1712345678.000020", channelId: "C456" });

    await deliverReplies(
      buildParams({
        cfg: { channels: { slack: { enterpriseOrgInstall: true } } },
        target: "C456",
        eventScope: {
          apiAppId: "A123",
          enterpriseId: "E123",
          isEnterpriseInstall: true,
          teamId: "T123",
          client: listenerClient,
        },
      }),
    );

    await requireQuestionRegistration().finalize("Cancelled");

    expect(mocks.writeClient).not.toHaveBeenCalled();
    expect(updateScopedMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C456", ts: "1712345678.000020" }),
    );
  });

  it.each([
    {
      name: "answered",
      originalText: "😀".repeat(1_000),
      status: "Answered: <!channel> & résumé 😀",
      expectedStatus: "Answered: &lt;!channel&gt; &amp; résumé 😀",
    },
    {
      name: "cancelled",
      originalText: `${"😀".repeat(999)}éé`,
      status: "Cancelled",
      expectedStatus: "Cancelled",
    },
  ])(
    "preserves the complete $name terminal suffix for a delivered 4,000-byte card",
    async ({ originalText, status, expectedStatus }) => {
      mocks.send.mockImplementation(
        async (
          _channel: string,
          _text: string,
          options: { blocks?: Array<{ type?: string }> },
        ) => ({
          messageId: options.blocks?.some((block) => block.type === "actions")
            ? "1712345678.000025"
            : "1712345678.000024",
          channelId: "C123",
        }),
      );
      const payload = buildQuestionPayload();

      await deliverReplies(
        buildParams({
          replies: [
            {
              ...payload,
              text: originalText,
              presentation: {
                blocks: payload.presentation.blocks.slice(1),
              },
            },
          ],
        }),
      );

      expect(mocks.send).toHaveBeenCalledTimes(1);
      const controlsDelivery = mocks.send.mock.calls.find((call) => {
        const options = call[2] as { blocks?: Array<{ type?: string }> } | undefined;
        return options?.blocks?.some((block) => block.type === "actions");
      });
      if (!controlsDelivery) {
        throw new Error("the 4,000-byte Slack question controls were not delivered");
      }
      const sentOptions = controlsDelivery[2] as { blocks: Array<{ type?: string }> };
      expect(sentOptions.blocks.map((block) => block.type)).toEqual(["section", "actions"]);
      const controlsFallback = buildSlackBlocksFallbackText(sentOptions.blocks);
      expect(controlsFallback).toBe(originalText);
      expect(Buffer.byteLength(controlsFallback, "utf8")).toBe(4_000);

      const registration = requireQuestionRegistration();
      expect(registration.deliveryId).toBe("slack:work:C123:1712345678.000025");
      await registration.finalize(status);

      const update = requireQuestionUpdate();
      expect(Buffer.byteLength(update.text, "utf8")).toBeLessThanOrEqual(4_000);
      expect(update.text.endsWith(`\n\n${expectedStatus}`)).toBe(true);
      expect(update.text).not.toContain("�");
      expect(update.blocks).toContainEqual({
        type: "context",
        elements: [{ type: "mrkdwn", text: expectedStatus }],
      });
      expect(update.blocks.some((block) => block.type === "actions")).toBe(false);
      expect(mocks.writeClient).toHaveBeenCalledWith("xoxp-authoring-user");
    },
  );

  it("preserves terminal update failures for Gateway-owned finalization reporting", async () => {
    mocks.send.mockResolvedValue({ messageId: "1712345678.000030", channelId: "C123" });
    mocks.update.mockRejectedValue(new Error("question update failed"));

    await deliverReplies(buildParams());

    await expect(requireQuestionRegistration().finalize("Expired")).rejects.toThrow(
      "question update failed",
    );
  });
});
