// Covers Slack question delivery capture and Block Kit final edit.
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import type { OutboundDeliveryResult } from "openclaw/plugin-sdk/channel-send-result";
import {
  createTestRegistry,
  resetGlobalHookRunner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSendTestClient } from "./blocks.test-helpers.js";

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
vi.mock("./send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send.js")>()),
  updateMessageSlack: hoisted.update,
}));

import { slackPlugin } from "./channel.js";
import { slackOutbound } from "./outbound-adapter.js";
import { SLACK_QUESTION_FINALIZATION_BLOCKS } from "./reply-action-ids.js";
import { sendMessageSlack } from "./send.js";

function jsonRoundTrip<T>(value: T): T {
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- This test exercises JSON transport.
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("Slack question finalization", () => {
  beforeEach(() => {
    hoisted.update.mockReset();
    hoisted.registration = undefined;
  });

  afterEach(() => {
    resetGlobalHookRunner();
    resetPluginRuntimeStateForTest();
  });

  it("removes action blocks and appends terminal context", async () => {
    const questionId = "ask_0123456789abcdef0123456789abcdef";
    const headers = Array.from({ length: 21 }, (_value, index) => `Column ${String(index)}`);
    const payload = {
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
      "text",
      "blocks",
    ]);
    await slackOutbound.afterDeliverPayload?.({
      cfg: {},
      target: {
        channel: "slack",
        to: "team:T123:channel:C123",
        accountId: "default",
      },
      payload: renderedAfterTransport!,
      results: [
        {
          channel: "slack",
          messageId: "44",
          target: { kind: "channel", id: "C123" },
        },
        {
          channel: "slack",
          messageId: "55",
          target: { kind: "channel", id: "C123" },
          meta: {
            slackQuestionActionIds: ["openclaw:question_button:1:1"],
            [SLACK_QUESTION_FINALIZATION_BLOCKS]: [],
          },
        },
      ],
    });

    await hoisted.registration?.finalize("Answered: <!channel>");
    expect(hoisted.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C123",
        teamId: "T123",
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

  it("finalizes the delivered question card after uploads, text chunks, and other cards", async () => {
    const questionId = "ask_0123456789abcdef0123456789abcdef";
    const questionActionId = "openclaw:question_button:1:1";
    const payload = {
      text: "Pick one",
      mediaUrl: "https://example.invalid/question-context.png",
      channelData: { askUser: { questionId } },
      presentation: {
        blocks: [
          {
            type: "buttons" as const,
            buttons: [
              {
                label: "One",
                action: { type: "question" as const, questionId, optionValue: "One" },
              },
            ],
          },
        ],
      },
    };
    const rendered = await slackOutbound.renderPresentation?.({
      payload,
      presentation: payload.presentation,
      ctx: { cfg: {}, to: "C123", text: payload.text, payload },
    });
    expect(JSON.stringify(rendered)).toContain(questionActionId);

    await slackOutbound.afterDeliverPayload?.({
      cfg: {},
      target: { channel: "slack", to: "C123", accountId: "default" },
      payload: jsonRoundTrip(rendered)!,
      results: [
        {
          channel: "slack",
          messageId: "upload",
          target: { kind: "channel", id: "C123" },
        },
        {
          channel: "slack",
          messageId: "preface-1",
          target: { kind: "channel", id: "C123" },
        },
        {
          channel: "slack",
          messageId: "preface-2",
          target: { kind: "channel", id: "C123" },
        },
        {
          channel: "slack",
          messageId: "another-question",
          target: { kind: "channel", id: "C123" },
          meta: { slackQuestionActionIds: ["openclaw:question_button:9:1"] },
        },
        {
          channel: "slack",
          messageId: "actual-question",
          target: { kind: "channel", id: "C123" },
          meta: {
            slackQuestionActionIds: [questionActionId],
            [SLACK_QUESTION_FINALIZATION_BLOCKS]: [],
          },
        },
      ],
    });

    await hoisted.registration?.finalize("Answered: One");

    expect(hoisted.registration?.deliveryId).toBe("slack:default:C123:actual-question");
    expect(hoisted.update).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "C123", messageTs: "actual-question" }),
    );
  });

  it("carries the real WebClient question-card identity through upload and chunk progress", async () => {
    const questionId = "ask_0123456789abcdef0123456789abcdef";
    const headers = Array.from({ length: 21 }, (_value, index) => `Column ${String(index)}`);
    const payload = {
      text: "Pick one",
      mediaUrl: "https://example.invalid/question-context.png",
      channelData: { askUser: { questionId } },
      presentation: {
        blocks: [
          {
            type: "table" as const,
            caption: "Option metadata",
            headers,
            rows: [headers.map((_header, index) => `Value ${String(index)}`)],
          },
          {
            type: "buttons" as const,
            buttons: [
              {
                label: "One",
                action: { type: "question" as const, questionId, optionValue: "One" },
              },
            ],
          },
        ],
      },
    };
    const cfg = { channels: { slack: { botToken: "xoxb-test" } } };
    const rendered = await slackOutbound.renderPresentation?.({
      payload,
      presentation: payload.presentation,
      ctx: { cfg, to: "C123", text: payload.text, payload },
    });
    if (!rendered) {
      throw new Error("Expected rendered Slack question presentation");
    }

    const client = createSlackSendTestClient();
    let messageCount = 0;
    client.chat.postMessage = vi.fn(async () => ({
      ok: true,
      ts: `171234.${String(++messageCount).padStart(3, "0")}`,
    }));
    const results: OutboundDeliveryResult[] = [];
    const sendSlack: typeof sendMessageSlack = async (to, text, options) => {
      if (options.mediaUrl) {
        const upload = {
          messageId: "F001",
          channelId: "C123",
          receipt: {
            platformMessageIds: ["F001"],
            parts: [{ platformMessageId: "F001", kind: "media" as const, index: 0 }],
            sentAt: Date.now(),
          },
        };
        await options.onDeliveryResult?.(upload);
        return upload;
      }
      return await sendMessageSlack(to, text, {
        ...options,
        cfg,
        token: "xoxb-test",
        client,
        textLimit: 32,
      });
    };

    await slackOutbound.sendPayload?.({
      cfg,
      to: "channel:C123",
      text: payload.text,
      payload: rendered,
      deps: { sendSlack },
      onDeliveryResult: (result) => {
        results.push(result);
      },
    });
    const questionDelivery = results.find((result) => result.meta?.slackQuestionActionIds);
    expect(results.map((result) => result.receipt?.parts[0]?.kind)).toEqual(
      expect.arrayContaining(["media", "text", "card"]),
    );
    expect(questionDelivery?.messageId).not.toBe("F001");

    await slackOutbound.afterDeliverPayload?.({
      cfg,
      target: { channel: "slack", to: "C123", accountId: "default" },
      payload: rendered,
      results,
    });
    await hoisted.registration?.finalize("Answered: One");

    expect(hoisted.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C123",
        messageTs: questionDelivery?.messageId,
      }),
    );
  });

  it("keeps the actual fallback question card through durable result reconciliation", async () => {
    const questionId = "ask_0123456789abcdef0123456789abcdef";
    const cfg = { channels: { slack: { botToken: "xoxb-test" } } };
    const payload = {
      text: "Pick one",
      channelData: { askUser: { questionId } },
      presentation: {
        blocks: [
          {
            type: "table" as const,
            caption: "Choices",
            headers: ["Label"],
            rows: [["A useful answer"]],
          },
          {
            type: "buttons" as const,
            buttons: [
              {
                label: "One",
                action: { type: "question" as const, questionId, optionValue: "One" },
              },
            ],
          },
          {
            type: "text" as const,
            text: "Trailing context intentionally arrives after the question card.",
          },
        ],
      },
    };
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          plugin: slackPlugin,
          source: "test",
        },
      ]),
    );

    const client = createSlackSendTestClient();
    let messageCount = 0;
    let questionMessageId: string | undefined;
    let acceptedQuestionBlocks: Array<{ elements?: unknown[]; type?: string }> | undefined;
    let trailingMessageId: string | undefined;
    client.chat.postMessage = vi.fn(async (request: unknown) => {
      const blocks = (request as { blocks?: Array<{ elements?: unknown[]; type?: string }> })
        .blocks;
      if (blocks?.some((block) => block.type === "data_table")) {
        throw Object.assign(new Error("invalid_blocks"), { data: { error: "invalid_blocks" } });
      }
      const ts = `171234.${String(++messageCount).padStart(3, "0")}`;
      const hasQuestion = blocks?.some(
        (block) =>
          block.type === "actions" &&
          block.elements?.some((element) =>
            String((element as { action_id?: string }).action_id).startsWith(
              "openclaw:question_button",
            ),
          ),
      );
      if (hasQuestion) {
        questionMessageId = ts;
        acceptedQuestionBlocks = blocks;
      } else if (questionMessageId) {
        trailingMessageId = ts;
      }
      return { ok: true, channel: "C123", ts };
    });
    const sendSlack: typeof sendMessageSlack = async (to, text, options) =>
      await sendMessageSlack(to, text, {
        ...options,
        cfg,
        token: "xoxb-test",
        client,
        textLimit: 72,
      });

    const batch = await sendDurableMessageBatch({
      cfg,
      channel: "slack",
      to: "C123",
      accountId: "default",
      payloads: [payload],
      deps: { sendSlack },
    });

    if (batch.status !== "sent") {
      throw batch.status === "failed"
        ? batch.error
        : new Error("Expected the Slack question fallback to be delivered");
    }
    expect(questionMessageId).toBeDefined();
    expect(trailingMessageId).toBeDefined();
    expect(trailingMessageId).not.toBe(questionMessageId);
    expect(batch.results).toHaveLength(1);
    expect(batch.results[0]).toMatchObject({
      messageId: trailingMessageId,
      meta: {
        slackQuestionActionIds: ["openclaw:question_button:1:1"],
        slackQuestionMessageId: questionMessageId,
      },
    });
    expect(hoisted.registration?.deliveryId).toBe(`slack:default:C123:${questionMessageId}`);

    await hoisted.registration?.finalize("Answered: One");

    expect(hoisted.update).toHaveBeenCalledOnce();
    expect(hoisted.update).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "C123", messageTs: questionMessageId }),
    );
    expect(hoisted.update.mock.calls[0]?.[0]?.blocks).toEqual([
      ...(acceptedQuestionBlocks ?? []).filter((block) => block.type !== "actions"),
      { type: "context", elements: [{ type: "mrkdwn", text: "Answered: One" }] },
    ]);
    expect(
      client.chat.postMessage.mock.calls.filter(([request]) =>
        (request as { blocks?: Array<{ elements?: Array<{ action_id?: string }> }> }).blocks?.some(
          (block) =>
            block.elements?.some((element) => element.action_id?.startsWith("openclaw:question_")),
        ),
      ),
    ).toHaveLength(2);
  });
});
