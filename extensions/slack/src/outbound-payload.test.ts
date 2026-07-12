// Slack tests cover outbound payload plugin behavior.
import { installChannelOutboundPayloadContractSuite } from "openclaw/plugin-sdk/channel-contract-testing";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import { createSlackOutboundPayloadHarness, slackOutbound } from "../test-api.js";
import { createSlackSendTestClient } from "./blocks.test-helpers.js";
import type { SlackReplyBlockSegment } from "./reply-blocks.js";
import { sendMessageSlack } from "./send.js";

function createHarness(params: {
  payload: ReplyPayload;
  sendResults?: Array<{ messageId: string }>;
}) {
  return createSlackOutboundPayloadHarness(params);
}

type MockWithCalls = {
  mock: { calls: unknown[][] };
};

function sendCall(sendMock: MockWithCalls, index: number): unknown[] {
  const call = sendMock.mock.calls[index];
  if (!call) {
    throw new Error(`expected Slack send call ${index}`);
  }
  return call;
}

function sendOptions(call: unknown[]): {
  authoredTextPlacement?: "none" | "blocks" | "outside-blocks";
  blocks?: Array<{
    block_id?: string;
    elements?: Array<{ action_id?: string }>;
    type?: string;
  }>;
  mediaUrl?: string;
  nativeDataFallbackBaseText?: string;
  textIsSlackPlainText?: boolean;
} {
  const options = call?.[2];
  if (!options) {
    throw new Error("Expected Slack send options");
  }
  return options as {
    authoredTextPlacement?: "none" | "blocks" | "outside-blocks";
    blocks?: Array<{
      block_id?: string;
      elements?: Array<{ action_id?: string }>;
      type?: string;
    }>;
    mediaUrl?: string;
    nativeDataFallbackBaseText?: string;
    textIsSlackPlainText?: boolean;
  };
}

function renderedPresentationSegments(payload: ReplyPayload | null | undefined) {
  const value = (
    payload?.channelData?.slack as { renderedPresentationSegments?: unknown } | undefined
  )?.renderedPresentationSegments;
  if (!Array.isArray(value)) {
    throw new Error("Expected rendered Slack presentation segments");
  }
  return value as SlackReplyBlockSegment[];
}

function createMixedPresentationPayload(): ReplyPayload {
  const headers = Array.from({ length: 21 }, (_entry, index) => `Column ${String(index)}`);
  return {
    text: "Summary",
    presentation: {
      blocks: [
        {
          type: "chart",
          chartType: "bar",
          title: "Pipeline",
          categories: ["Open"],
          series: [{ name: "Issues", values: [5] }],
        },
        {
          type: "table",
          caption: "Wide pipeline",
          headers,
          rows: [headers.map((_header, index) => `Value ${String(index)}`)],
        },
        { type: "buttons", buttons: [{ label: "Stage", value: "stage" }] },
      ],
    },
  };
}

describe("slackOutbound sendPayload", () => {
  it("renders presentation blocks", async () => {
    const { run, sendMock, to } = createHarness({
      payload: {
        text: "Fallback summary",
        presentation: { blocks: [{ type: "divider" }] },
      },
    });

    const result = await run();

    expect(sendMock).toHaveBeenCalledTimes(1);
    const call = sendCall(sendMock, 0);
    expect(call[0]).toBe(to);
    expect(call[1]).toBe("Fallback summary");
    expect(sendOptions(call).blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "Fallback summary", verbatim: true } },
      { type: "divider" },
    ]);
    expect(result.channel).toBe("slack");
    expect(result.messageId).toBe("sl-1");
  });

  it("keeps Markdown-authored text placed in its compiled section", async () => {
    const payload: ReplyPayload = {
      text: "**Overview**",
      presentation: { blocks: [{ type: "divider" }] },
    };
    const rendered = await slackOutbound.renderPresentation?.({
      payload,
      presentation: payload.presentation!,
      ctx: { cfg: {}, to: "C12345", text: payload.text ?? "", payload },
    });
    if (!rendered) {
      throw new Error("Expected rendered Slack segments");
    }
    const { presentation: _presentation, ...payloadForSend } = rendered;
    const { run, sendMock } = createHarness({ payload: payloadForSend });

    await run();

    const call = sendCall(sendMock, 0);
    expect(call[1]).toBe("*Overview*");
    expect(sendOptions(call).authoredTextPlacement).toBe("blocks");
    expect(sendOptions(call).blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "*Overview*", verbatim: true } },
      { type: "divider" },
    ]);
  });

  it("renders native charts with complete top-level accessibility text", async () => {
    const { run, sendMock } = createHarness({
      payload: {
        text: "Revenue summary",
        presentation: {
          blocks: [
            {
              type: "chart",
              chartType: "bar",
              title: "Quarterly revenue",
              categories: ["Q1", "Q2"],
              series: [{ name: "Revenue", values: [120, 145] }],
              xLabel: "Quarter",
            },
          ],
        },
      },
    });

    await run();

    const call = sendCall(sendMock, 0);
    expect(call[1]).toBe(
      [
        "Revenue summary",
        "",
        "Quarterly revenue (bar chart)",
        "X axis: Quarter",
        "- Revenue: Q1: 120; Q2: 145",
      ].join("\n"),
    );
    expect(sendOptions(call).blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "Revenue summary", verbatim: true } },
      {
        type: "data_visualization",
        title: "Quarterly revenue",
        chart: {
          type: "bar",
          series: [
            {
              name: "Revenue",
              data: [
                { label: "Q1", value: 120 },
                { label: "Q2", value: 145 },
              ],
            },
          ],
          axis_config: { categories: ["Q1", "Q2"], x_label: "Quarter" },
        },
      },
    ]);
    expect(sendOptions(call).authoredTextPlacement).toBe("blocks");
    expect(sendOptions(call).nativeDataFallbackBaseText).toBeUndefined();
  });

  it("renders native tables with complete top-level accessibility text", async () => {
    const { run, sendMock } = createHarness({
      payload: {
        text: "Pipeline summary",
        presentation: {
          blocks: [
            {
              type: "table",
              caption: "Open pipeline",
              headers: ["Account", "ARR"],
              rows: [
                ["Acme", 125000],
                ["Globex", 82000],
              ],
              rowHeaderColumnIndex: 0,
            },
          ],
        },
      },
    });

    await run();

    const call = sendCall(sendMock, 0);
    expect(call[1]).toBe(
      [
        "Pipeline summary",
        "",
        "Open pipeline (table)",
        "Account\tARR",
        "Acme\t125000",
        "Globex\t82000",
      ].join("\n"),
    );
    expect(sendOptions(call).blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "Pipeline summary", verbatim: true } },
      {
        type: "data_table",
        caption: "Open pipeline",
        row_header_column_index: 0,
        rows: [
          [
            { type: "raw_text", text: "Account" },
            { type: "raw_text", text: "ARR" },
          ],
          [
            { type: "raw_text", text: "Acme" },
            { type: "raw_number", value: 125000, text: "125000" },
          ],
          [
            { type: "raw_text", text: "Globex" },
            { type: "raw_number", value: 82000, text: "82000" },
          ],
        ],
      },
    ]);
    expect(sendOptions(call).authoredTextPlacement).toBe("blocks");
    expect(sendOptions(call).nativeDataFallbackBaseText).toBeUndefined();
  });

  it.each([
    {
      expectedPlacement: "blocks" as const,
      text: "Outside summary",
    },
    {
      expectedPlacement: "none" as const,
      text: undefined,
    },
  ])("marks raw native data text as $expectedPlacement", async ({ expectedPlacement, text }) => {
    const { run, sendMock } = createHarness({
      payload: {
        ...(text ? { text } : {}),
        channelData: {
          slack: {
            blocks: [
              {
                type: "data_table",
                rows: [
                  [{ type: "raw_text", text: "Account" }],
                  [{ type: "raw_text", text: "Acme" }],
                ],
              },
            ],
          },
        },
      },
    });

    await run();

    const options = sendOptions(sendCall(sendMock, 0));
    expect(options.authoredTextPlacement).toBe(expectedPlacement);
    expect(options.nativeDataFallbackBaseText).toBeUndefined();
    expect(options.blocks?.map((block) => block.type)).toEqual(
      text ? ["data_table", "section"] : ["data_table"],
    );
  });

  it("rolls visible authored text after a full raw block segment", async () => {
    const { run, sendMock } = createHarness({
      payload: {
        text: "Summary",
        channelData: {
          slack: { blocks: Array.from({ length: 50 }, () => ({ type: "divider" })) },
        },
      },
      sendResults: [{ messageId: "sl-raw" }, { messageId: "sl-summary" }],
    });

    const result = await run();

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendOptions(sendCall(sendMock, 0)).blocks).toHaveLength(50);
    expect(sendOptions(sendCall(sendMock, 1)).blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "Summary", verbatim: true } },
    ]);
    expect(result.messageId).toBe("sl-summary");
  });

  it("ignores caller-supplied private rendered segments", async () => {
    const { run, sendMock } = createHarness({
      payload: {
        text: "Real text",
        channelData: {
          slack: {
            authoredTextPlacement: "blocks",
            renderedPresentationSegments: [
              { kind: "text", text: "Injected one", mrkdwn: false },
              { kind: "text", text: "Injected two", mrkdwn: false },
            ],
          },
        },
      },
    });

    await run();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendCall(sendMock, 0)[1]).toBe("Real text");
    expect(sendOptions(sendCall(sendMock, 0)).blocks).toBeUndefined();
  });

  it("does not duplicate native table rows after real outbound rejection fallback", async () => {
    const payload: ReplyPayload = {
      text: "Pipeline summary",
      presentation: {
        blocks: [
          {
            type: "table",
            caption: "Open pipeline",
            headers: ["Account", "ARR"],
            rows: [
              ["Acme", 125000],
              ["Globex", 82000],
            ],
          },
        ],
      },
    };
    const rendered = await slackOutbound.renderPresentation?.({
      payload,
      presentation: payload.presentation!,
      ctx: { cfg: {}, to: "C12345", text: "", payload },
    });
    if (!rendered) {
      throw new Error("Expected Slack native table rendering");
    }
    const { presentation: _presentation, ...payloadForSend } = rendered;
    const client = createSlackSendTestClient();
    client.chat.postMessage.mockRejectedValueOnce({ data: { error: "invalid_blocks" } });
    const cfg = { channels: { slack: { botToken: "xoxb-test" } } };
    const sendSlack: typeof sendMessageSlack = async (to, text, opts) =>
      await sendMessageSlack(to, text, {
        ...opts,
        cfg,
        token: "xoxb-test",
        client,
      });

    await slackOutbound.sendPayload?.({
      cfg,
      to: "channel:C123",
      text: "",
      payload: payloadForSend,
      deps: { sendSlack },
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    const fallback = client.chat.postMessage.mock.calls[1]?.[0] as
      | { blocks?: unknown; mrkdwn?: boolean; text?: string }
      | undefined;
    expect(fallback).toMatchObject({
      mrkdwn: false,
      text: [
        "Pipeline summary",
        "",
        "Open pipeline (table)",
        "Account\tARR",
        "Acme\t125000",
        "Globex\t82000",
      ].join("\n"),
    });
    expect(fallback?.blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "Pipeline summary", verbatim: true } },
      {
        type: "section",
        text: {
          type: "plain_text",
          text: "Open pipeline (table)\nAccount\tARR\nAcme\t125000\nGlobex\t82000",
        },
      },
    ]);
    expect(fallback?.text?.match(/Acme/gu)).toHaveLength(1);
    expect(fallback?.text).not.toContain("- Account: Acme");
  });

  it("posts Slack-safe text when a portable table cannot render natively", async () => {
    const payload: ReplyPayload = {
      channelData: {
        slack: {
          blocks: [
            {
              type: "section",
              text: { type: "mrkdwn", text: "Existing raw block only" },
            },
          ],
        },
      },
      interactive: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Refresh", value: "refresh" }],
          },
          {
            type: "select",
            placeholder: "Window",
            options: [{ label: "Recent", value: "recent" }],
          },
        ],
      },
      presentation: {
        title: "Pipeline <!channel>",
        blocks: [
          {
            type: "table",
            caption: "Accounts",
            headers: ["Owner"],
            rows: Array.from({ length: 100 }, (_entry, index) => [
              index === 0 ? "<@U123>" : `owner-${String(index)} ${"x".repeat(110)}`,
            ]),
          },
          {
            type: "buttons",
            buttons: [{ label: "Stage", value: "stage" }],
          },
          {
            type: "select",
            placeholder: "Lane",
            options: [{ label: "Production", value: "production" }],
          },
        ],
      },
    };

    const rendered = await slackOutbound.renderPresentation?.({
      payload,
      presentation: payload.presentation!,
      ctx: { cfg: {}, to: "C12345", text: "", payload },
    });
    if (!rendered) {
      throw new Error("Expected Slack to render a table fallback");
    }
    const { presentation: _presentation, ...payloadForSend } = rendered;
    const client = createSlackSendTestClient();
    const cfg = { channels: { slack: { botToken: "xoxb-test" } } };
    const capturedSendOptions: Array<NonNullable<Parameters<typeof sendMessageSlack>[2]>> = [];
    const onPlatformSendDispatch = vi.fn(async () => {});
    const sendSlack: typeof sendMessageSlack = async (to, text, opts) => {
      capturedSendOptions.push(opts ?? {});
      return await sendMessageSlack(to, text, {
        ...opts,
        cfg,
        token: "xoxb-test",
        client,
      });
    };

    await slackOutbound.sendPayload?.({
      cfg,
      to: "channel:C123",
      text: "",
      payload: payloadForSend,
      deps: { sendSlack },
      deliveryQueueId: "queue-1",
      onPlatformSendDispatch,
    });

    expect(client.chat.postMessage.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(capturedSendOptions).not.toHaveLength(0);
    expect(capturedSendOptions.every((opts) => opts.deliveryQueueId === undefined)).toBe(true);
    expect(capturedSendOptions.every((opts) => opts.onPlatformSendDispatch === undefined)).toBe(
      true,
    );
    expect(client.chat.postMessage.mock.calls[0]?.[0]).toMatchObject({
      text: expect.stringContaining("Pipeline <!channel>"),
      mrkdwn: false,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "Existing raw block only" },
        },
        {
          type: "header",
          text: { type: "plain_text", text: "Pipeline <!channel>", emoji: true },
        },
      ],
    });
    const fallbackCalls = client.chat.postMessage.mock.calls.slice(1, -1);
    expect(
      fallbackCalls.every(
        ([raw]) =>
          (raw as { blocks?: unknown; mrkdwn?: boolean }).blocks === undefined &&
          (raw as { mrkdwn?: boolean }).mrkdwn === false,
      ),
    ).toBe(true);
    const fallbackText = fallbackCalls
      .map(([raw]) => (raw as { text?: string }).text ?? "")
      .join("");
    expect(fallbackText).toContain("- Owner: <@U123>");
    expect(fallbackText).toContain("- Owner: owner-99");
    expect(client.chat.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
      mrkdwn: false,
      blocks: [
        {
          type: "actions",
          block_id: "openclaw_reply_buttons_1",
          elements: [expect.objectContaining({ value: "stage" })],
        },
        {
          type: "actions",
          block_id: "openclaw_reply_select_1",
          elements: [expect.objectContaining({ action_id: "openclaw:reply_select:1" })],
        },
        {
          type: "actions",
          block_id: "openclaw_reply_buttons_2",
          elements: [expect.objectContaining({ value: "refresh" })],
        },
        {
          type: "actions",
          block_id: "openclaw_reply_select_2",
          elements: [expect.objectContaining({ action_id: "openclaw:reply_select:2" })],
        },
      ],
    });
  });

  it("keeps the full portable fallback when any control cannot render natively", async () => {
    const payload: ReplyPayload = {
      text: "Fallback",
      presentation: {
        title: "Actions",
        blocks: [
          { type: "text", text: "Choose an action" },
          {
            type: "buttons",
            buttons: [{ label: "Status", action: { type: "command", command: "/status" } }],
          },
        ],
      },
    };

    const rendered = await slackOutbound.renderPresentation?.({
      payload,
      presentation: payload.presentation!,
      ctx: {
        cfg: {},
        to: "C12345",
        text: "",
        payload,
      },
    });

    const segments = renderedPresentationSegments(rendered);
    expect(segments.map((segment) => segment.kind)).toEqual(["blocks", "text"]);
    expect(segments[1]).toEqual({ kind: "text", text: "- Status: `/status`", mrkdwn: false });
  });

  it("renders the portable fallback visibly when native Slack blocks survive", async () => {
    const payload: ReplyPayload = {
      channelData: { slack: { blocks: [{ type: "divider" }] } },
      presentation: {
        title: "Actions",
        blocks: [
          { type: "text", text: "Choose an action" },
          {
            type: "buttons",
            buttons: [{ label: "Status", action: { type: "command", command: "/status" } }],
          },
        ],
      },
    };

    const rendered = await slackOutbound.renderPresentation?.({
      payload,
      presentation: payload.presentation!,
      ctx: { cfg: {}, to: "C12345", text: "", payload },
    });

    const segments = renderedPresentationSegments(rendered);
    expect(segments.map((segment) => segment.kind)).toEqual(["blocks", "text"]);
    expect(segments[0]).toMatchObject({
      kind: "blocks",
      blocks: [
        { type: "divider" },
        { type: "header", text: { text: "Actions" } },
        { type: "section", text: { text: "Choose an action" } },
      ],
    });
    expect(segments[1]).toEqual({ kind: "text", text: "- Status: `/status`", mrkdwn: false });
  });

  it("renders typed URL and web-app buttons as native Slack links", async () => {
    const payload: ReplyPayload = {
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Launch",
                action: { type: "web-app", url: "https://example.com/app" },
              },
              { label: "View", action: { type: "url", url: "https://example.com/view" } },
            ],
          },
        ],
      },
    };

    const rendered = await slackOutbound.renderPresentation?.({
      payload,
      presentation: payload.presentation!,
      ctx: { cfg: {}, to: "C12345", text: "", payload },
    });

    const [segment] = renderedPresentationSegments(rendered);
    expect(segment).toMatchObject({
      kind: "blocks",
      blocks: [
        expect.objectContaining({
          type: "actions",
          elements: [
            expect.objectContaining({
              type: "button",
              action_id: "openclaw:reply_link:1:1",
              url: "https://example.com/app",
            }),
            expect.objectContaining({
              type: "button",
              action_id: "openclaw:reply_link:1:2",
              url: "https://example.com/view",
            }),
          ],
        }),
      ],
    });
    const linkButton =
      segment?.kind === "blocks"
        ? (segment.blocks[0] as { elements?: Array<Record<string, unknown>> }).elements?.[0]
        : undefined;
    expect(linkButton).not.toHaveProperty("value");
  });

  it.each([
    {
      name: "title",
      presentation: { title: "x".repeat(151), blocks: [] },
    },
    {
      name: "text block",
      presentation: { blocks: [{ type: "text", text: "x".repeat(3001) }] },
    },
    {
      name: "context block",
      presentation: { blocks: [{ type: "context", text: "x".repeat(3001) }] },
    },
  ] satisfies Array<{
    name: string;
    presentation: NonNullable<ReplyPayload["presentation"]>;
  }>)("keeps the portable fallback for an oversized $name", async ({ presentation }) => {
    const payload: ReplyPayload = { presentation };

    const rendered = await slackOutbound.renderPresentation?.({
      payload,
      presentation,
      ctx: { cfg: {}, to: "C12345", text: "", payload },
    });

    const segments = renderedPresentationSegments(rendered);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ kind: "text", mrkdwn: false });
  });

  it("starts a new segment when presentation content crosses Slack's block limit", async () => {
    const payload: ReplyPayload = {
      channelData: {
        slack: {
          blocks: Array.from({ length: 49 }, () => ({ type: "divider" })),
        },
      },
      presentation: { title: "Deploy status", blocks: [{ type: "divider" }] },
      interactive: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Allow", value: "pluginbind:approval-123:o" }],
          },
        ],
      },
    };

    const rendered = await slackOutbound.renderPresentation?.({
      payload,
      presentation: payload.presentation!,
      ctx: { cfg: {}, to: "C12345", text: "", payload },
    });

    const segments = renderedPresentationSegments(rendered);
    expect(segments.map((segment) => segment.kind)).toEqual(["blocks", "blocks"]);
    expect(segments[0]?.kind === "blocks" ? segments[0].blocks : []).toHaveLength(50);
    expect(segments[1]).toMatchObject({
      kind: "blocks",
      blocks: [{ type: "divider" }, { type: "actions" }],
    });
  });

  it("uses the full ordered table fallback when preserved siblings exceed the block limit", async () => {
    const headers = Array.from({ length: 21 }, (_entry, index) => `Column ${String(index)}`);
    const payload: ReplyPayload = {
      channelData: {
        slack: { blocks: Array.from({ length: 49 }, () => ({ type: "divider" })) },
      },
      presentation: {
        blocks: [
          {
            type: "table",
            caption: "Wide pipeline",
            headers,
            rows: [headers.map((_header, index) => `Value ${String(index)}`)],
          },
          {
            type: "buttons",
            buttons: [{ label: "Stage", value: "stage" }],
          },
        ],
      },
      interactive: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Refresh", value: "refresh" }],
          },
        ],
      },
    };

    const rendered = await slackOutbound.renderPresentation?.({
      payload,
      presentation: payload.presentation!,
      ctx: { cfg: {}, to: "C12345", text: "", payload },
    });
    if (!rendered) {
      throw new Error("Expected Slack to render a full table fallback");
    }
    const segments = renderedPresentationSegments(rendered);
    expect(segments.map((segment) => segment.kind)).toEqual(["blocks", "text", "blocks"]);
    expect(segments[0]?.kind === "blocks" ? segments[0].blocks : []).toHaveLength(49);
    const fallback = segments[1]?.kind === "text" ? segments[1].text : "";
    expect(fallback).toContain("Wide pipeline (table)");
    expect(fallback).toContain("Column 20: Value 20");
    expect(segments[2]).toMatchObject({
      kind: "blocks",
      blocks: [{ block_id: "openclaw_reply_buttons_1" }, { block_id: "openclaw_reply_buttons_2" }],
    });

    const { run, sendMock } = createHarness({
      payload: rendered,
      sendResults: [
        { messageId: "sl-before" },
        { messageId: "sl-fallback" },
        { messageId: "sl-after" },
      ],
    });
    await expect(run()).resolves.toMatchObject({ messageId: "sl-after" });
    expect(sendMock).toHaveBeenCalledTimes(3);
    expect(sendOptions(sendCall(sendMock, 0)).blocks).toHaveLength(49);
    expect(sendCall(sendMock, 1)[1]).toBe(fallback);
    expect(sendOptions(sendCall(sendMock, 1)).blocks).toBeUndefined();
    expect(sendOptions(sendCall(sendMock, 2)).blocks).toHaveLength(2);
  });

  it("counts legacy interactive blocks compiled after presentation rendering", async () => {
    const payload: ReplyPayload = {
      text: "Question [[slack_buttons: OK:ok]]",
      channelData: {
        slack: {
          blocks: Array.from({ length: 48 }, () => ({ type: "divider" })),
        },
      },
      presentation: { title: "Deploy status", blocks: [{ type: "divider" }] },
    };

    const rendered = await slackOutbound.renderPresentation?.({
      payload,
      presentation: payload.presentation!,
      ctx: {
        cfg: {
          channels: {
            slack: {
              botToken: "xoxb-test",
              appToken: "xapp-test",
              capabilities: { interactiveReplies: true },
            },
          },
        },
        accountId: "default",
        to: "C12345",
        text: payload.text ?? "",
        payload,
      },
    });

    const segments = renderedPresentationSegments(rendered);
    expect(segments.map((segment) => segment.kind)).toEqual(["blocks", "blocks"]);
    expect(segments[0]?.kind === "blocks" ? segments[0].blocks : []).toHaveLength(50);
    expect(segments[1]).toMatchObject({
      kind: "blocks",
      blocks: [{ type: "section" }, { type: "actions" }],
    });
  });

  it("does not duplicate text compiled around inline legacy controls", async () => {
    const payload: ReplyPayload = {
      text: "Before [[slack_buttons: OK:ok]] after",
      presentation: { blocks: [{ type: "divider" }] },
    };

    const rendered = await slackOutbound.renderPresentation?.({
      payload,
      presentation: payload.presentation!,
      ctx: {
        cfg: {
          channels: {
            slack: {
              botToken: "xoxb-test",
              appToken: "xapp-test",
              capabilities: { interactiveReplies: true },
            },
          },
        },
        accountId: "default",
        to: "C12345",
        text: payload.text ?? "",
        payload,
      },
    });

    expect(rendered?.channelData?.slack).toMatchObject({ authoredTextPlacement: "blocks" });
    const segments = renderedPresentationSegments(rendered);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      kind: "blocks",
      blocks: [
        { type: "divider" },
        { type: "section", text: { text: "Before" } },
        { type: "actions" },
        { type: "section", text: { text: "after" } },
      ],
    });
    expect(rendered?.interactive?.blocks).toEqual([
      { type: "text", text: "Before" },
      { type: "buttons", buttons: [{ label: "OK", value: "ok" }] },
      { type: "text", text: "after" },
    ]);
  });

  it("marks inline legacy text as represented when native data is compiled with it", async () => {
    const payload: ReplyPayload = {
      text: "Before [[slack_buttons: OK:ok]] after",
      presentation: {
        blocks: [
          {
            type: "table",
            caption: "Accounts",
            headers: ["Account"],
            rows: [["Acme"]],
          },
        ],
      },
    };
    const cfg = {
      channels: {
        slack: {
          botToken: "xoxb-test",
          appToken: "xapp-test",
          capabilities: { interactiveReplies: true },
        },
      },
    };
    const rendered = await slackOutbound.renderPresentation?.({
      payload,
      presentation: payload.presentation!,
      ctx: {
        cfg,
        accountId: "default",
        to: "C12345",
        text: payload.text ?? "",
        payload,
      },
    });
    if (!rendered) {
      throw new Error("Expected Slack native table rendering");
    }

    expect(rendered.channelData?.slack).toMatchObject({
      authoredTextPlacement: "blocks",
    });
    const { presentation: _presentation, ...payloadForSend } = rendered;
    const { run, sendMock } = createHarness({ payload: payloadForSend });

    await run();

    const options = sendOptions(sendCall(sendMock, 0));
    expect(options.authoredTextPlacement).toBe("blocks");
    expect(options.nativeDataFallbackBaseText).toBeUndefined();
    expect(options.blocks?.map((block) => block.type)).toEqual([
      "data_table",
      "section",
      "actions",
      "section",
    ]);
  });

  it("preserves mixed chart, table fallback, and control order after presentation stripping", async () => {
    const payload = createMixedPresentationPayload();
    const rendered = await slackOutbound.renderPresentation?.({
      payload,
      presentation: payload.presentation!,
      ctx: { cfg: {}, to: "C12345", text: payload.text ?? "", payload },
    });
    if (!rendered) {
      throw new Error("Expected rendered Slack segments");
    }
    const { presentation: _presentation, ...payloadForSend } = rendered;
    const { run, sendMock } = createHarness({
      payload: payloadForSend,
      sendResults: [
        { messageId: "sl-chart" },
        { messageId: "sl-table" },
        { messageId: "sl-controls" },
      ],
    });

    const result = await run();

    expect(sendMock).toHaveBeenCalledTimes(3);
    expect(sendOptions(sendCall(sendMock, 0)).blocks?.map((block) => block.type)).toEqual([
      "section",
      "data_visualization",
    ]);
    expect(sendCall(sendMock, 1)[1]).toContain("Column 20: Value 20");
    expect(sendOptions(sendCall(sendMock, 1)).blocks).toBeUndefined();
    expect(sendOptions(sendCall(sendMock, 1)).textIsSlackPlainText).toBe(true);
    expect(sendOptions(sendCall(sendMock, 2)).blocks?.map((block) => block.type)).toEqual([
      "actions",
    ]);
    expect(result.messageId).toBe("sl-controls");
  });

  it("keeps mixed segment order when Slack rejects the native chart", async () => {
    const payload = createMixedPresentationPayload();
    const rendered = await slackOutbound.renderPresentation?.({
      payload,
      presentation: payload.presentation!,
      ctx: { cfg: {}, to: "C12345", text: payload.text ?? "", payload },
    });
    if (!rendered) {
      throw new Error("Expected rendered Slack segments");
    }
    const { presentation: _presentation, ...payloadForSend } = rendered;
    const client = createSlackSendTestClient();
    client.chat.postMessage.mockRejectedValueOnce({ data: { error: "invalid_blocks" } });
    const cfg = { channels: { slack: { botToken: "xoxb-test" } } };
    const sendSlack: typeof sendMessageSlack = async (to, text, opts) =>
      await sendMessageSlack(to, text, { ...opts, cfg, token: "xoxb-test", client });

    await slackOutbound.sendPayload?.({
      cfg,
      to: "channel:C123",
      text: "",
      payload: payloadForSend,
      deps: { sendSlack },
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(4);
    const firstFallbackRequest = client.chat.postMessage.mock.calls[1]?.[0] as
      | { blocks?: Array<{ type?: string }> }
      | undefined;
    expect(firstFallbackRequest?.blocks?.map((block) => block.type)).toEqual([
      "section",
      "section",
    ]);
    expect(client.chat.postMessage.mock.calls[2]?.[0]).toMatchObject({
      mrkdwn: false,
      text: expect.stringContaining("Column 20: Value 20"),
    });
    const secondFallbackRequest = client.chat.postMessage.mock.calls[2]?.[0] as
      | { blocks?: unknown }
      | undefined;
    expect(secondFallbackRequest?.blocks).toBeUndefined();
    const finalFallbackRequest = client.chat.postMessage.mock.calls[3]?.[0] as
      | { blocks?: Array<{ type?: string }> }
      | undefined;
    expect(finalFallbackRequest?.blocks?.map((block) => block.type)).toEqual(["actions"]);
  });

  it("does not duplicate authored text already represented by a raw block", async () => {
    const payload: ReplyPayload = {
      text: "Overview",
      channelData: {
        slack: {
          blocks: [{ type: "section", text: { type: "mrkdwn", text: "Overview" } }],
        },
      },
      presentation: {
        blocks: [
          {
            type: "chart",
            chartType: "bar",
            title: "Pipeline",
            categories: ["Open"],
            series: [{ name: "Issues", values: [5] }],
          },
        ],
      },
    };
    const rendered = await slackOutbound.renderPresentation?.({
      payload,
      presentation: payload.presentation!,
      ctx: { cfg: {}, to: "C12345", text: payload.text ?? "", payload },
    });
    if (!rendered) {
      throw new Error("Expected rendered Slack segments");
    }
    const { presentation: _presentation, ...payloadForSend } = rendered;
    const client = createSlackSendTestClient();
    client.chat.postMessage.mockRejectedValueOnce({ data: { error: "invalid_blocks" } });
    const cfg = { channels: { slack: { botToken: "xoxb-test" } } };
    const sendSlack: typeof sendMessageSlack = async (to, text, opts) =>
      await sendMessageSlack(to, text, { ...opts, cfg, token: "xoxb-test", client });

    await slackOutbound.sendPayload?.({
      cfg,
      to: "channel:C123",
      text: "",
      payload: payloadForSend,
      deps: { sendSlack },
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    const fallback = client.chat.postMessage.mock.calls[1]?.[0] as {
      blocks?: Array<{ text?: { text?: string }; type?: string }>;
      text?: string;
    };
    expect(fallback.text?.match(/Overview/gu)).toHaveLength(1);
    expect(fallback.blocks?.filter((block) => block.text?.text === "Overview")).toHaveLength(1);
  });

  it("sends media before a separate interactive blocks message", async () => {
    const { run, sendMock, to } = createHarness({
      payload: {
        text: "Approval required",
        mediaUrl: "https://example.com/image.png",
        interactive: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Allow", value: "pluginbind:approval-123:o" }],
            },
          ],
        },
      },
      sendResults: [{ messageId: "sl-media" }, { messageId: "sl-controls" }],
    });

    const result = await run();

    expect(sendMock).toHaveBeenCalledTimes(2);
    const mediaCall = sendCall(sendMock, 0);
    expect(mediaCall[0]).toBe(to);
    expect(mediaCall[1]).toBe("");
    expect(sendOptions(mediaCall).mediaUrl).toBe("https://example.com/image.png");
    expect(mediaCall[2]).not.toHaveProperty("blocks");
    const controlsCall = sendCall(sendMock, 1);
    expect(controlsCall[0]).toBe(to);
    expect(controlsCall[1]).toBe("Approval required\n\nAllow");
    expect(sendOptions(controlsCall).blocks?.map((block) => block.type)).toEqual([
      "section",
      "actions",
    ]);
    expect(result.channel).toBe("slack");
    expect(result.messageId).toBe("sl-controls");
  });

  it("rolls over authored blocks instead of dropping over-limit content", async () => {
    const { run, sendMock } = createHarness({
      payload: {
        channelData: {
          slack: { blocks: Array.from({ length: 50 }, () => ({ type: "divider" })) },
        },
        presentation: {
          blocks: [{ type: "table", caption: "Accounts", headers: ["Account"], rows: [["Acme"]] }],
        },
        interactive: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Allow", value: "pluginbind:approval-123:o" }],
            },
          ],
        },
      },
    });

    await expect(run()).resolves.toMatchObject({ messageId: "sl-1" });
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendOptions(sendCall(sendMock, 0)).blocks).toHaveLength(50);
    expect(sendOptions(sendCall(sendMock, 1)).blocks?.map((block) => block.type)).toEqual([
      "data_table",
      "actions",
    ]);
  });

  it("offsets presentation controls against native Slack blocks before standalone interactive controls", async () => {
    const { run, sendMock, to } = createHarness({
      payload: {
        text: "Deploy?",
        channelData: {
          slack: {
            blocks: [
              {
                type: "actions",
                block_id: "openclaw_reply_buttons_1",
                elements: [],
              },
            ],
          },
        },
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Stage", value: "stage" }],
            },
          ],
        },
        interactive: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Approve", value: "approve" }],
            },
          ],
        },
      },
    });

    await run();

    expect(sendMock).toHaveBeenCalledTimes(1);
    const call = sendCall(sendMock, 0);
    expect(call[0]).toBe(to);
    expect(call[1]).toBe("Deploy?\n\nStage\n\nApprove");
    const blocks = sendOptions(call).blocks;
    expect(blocks?.[0]?.block_id).toBe("openclaw_reply_buttons_1");
    expect(blocks?.[1]?.type).toBe("section");
    expect(blocks?.[2]?.block_id).toBe("openclaw_reply_buttons_2");
    expect(blocks?.[2]?.elements?.[0]?.action_id).toBe("openclaw:reply_button:2:1");
    expect(blocks?.[3]?.block_id).toBe("openclaw_reply_buttons_3");
    expect(blocks?.[3]?.elements?.[0]?.action_id).toBe("openclaw:reply_button:3:1");
  });
});

describe("Slack outbound payload contract", () => {
  installChannelOutboundPayloadContractSuite({
    channel: "slack",
    chunking: { mode: "passthrough", longTextLength: 5000 },
    createHarness: createSlackOutboundPayloadHarness,
  });
});
