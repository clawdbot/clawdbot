// Slack tests cover outbound payload plugin behavior.
import { installChannelOutboundPayloadContractSuite } from "openclaw/plugin-sdk/channel-contract-testing";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import { createSlackOutboundPayloadHarness as createHarness, slackOutbound } from "../test-api.js";
import { createSlackSendTestClient } from "./blocks.test-helpers.js";
import type { SlackReplyBlockSegment } from "./reply-blocks.js";
import { sendMessageSlack } from "./send.js";

type MockWithCalls = { mock: { calls: unknown[][] } };

type SlackTestBlock = {
  block_id?: string;
  elements?: Array<{ action_id?: string }>;
  text?: { text?: string };
  type?: string;
};

type SlackSendOptions = {
  authoredTextPlacement?: "none" | "blocks" | "outside-blocks";
  blocks?: SlackTestBlock[];
  mediaUrl?: string;
  nativeDataFallbackBaseText?: string;
  textIsSlackPlainText?: boolean;
};

type PostedSlackMessage = Pick<SlackSendOptions, "blocks"> & {
  mrkdwn?: boolean;
  text?: string;
};

function sentSlackMessage(sendMock: MockWithCalls, index: number) {
  const call = sendMock.mock.calls[index];
  if (!call) {
    throw new Error(`expected Slack send call ${index}`);
  }
  const options = call[2];
  if (!options) {
    throw new Error("Expected Slack send options");
  }
  return {
    options: options as SlackSendOptions,
    text: call[1],
    to: call[0],
  };
}

function postedSlackMessage(
  client: ReturnType<typeof createSlackSendTestClient>,
  index: number,
): PostedSlackMessage {
  const message = client.chat.postMessage.mock.calls[index]?.[0];
  if (!message) {
    throw new Error(`expected Slack postMessage call ${index}`);
  }
  return message as PostedSlackMessage;
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

async function renderPresentation(payload: ReplyPayload, text = ""): Promise<ReplyPayload> {
  const rendered = await slackOutbound.renderPresentation?.({
    payload,
    presentation: payload.presentation!,
    ctx: { cfg: {}, to: "C12345", text, payload },
  });
  if (!rendered) {
    throw new Error("Expected rendered Slack presentation");
  }
  return rendered;
}

async function renderPayloadForSend(payload: ReplyPayload, text = ""): Promise<ReplyPayload> {
  const { presentation: _presentation, ...payloadForSend } = await renderPresentation(
    payload,
    text,
  );
  return payloadForSend;
}

async function sendThroughRealSlack(params: {
  payload: ReplyPayload;
  rejectFirstNativeBlocks?: boolean;
  renderText?: string;
  deliveryQueueId?: string;
  onPlatformSendDispatch?: () => Promise<void>;
}) {
  const payload = await renderPayloadForSend(params.payload, params.renderText);
  const client = createSlackSendTestClient();
  if (params.rejectFirstNativeBlocks) {
    client.chat.postMessage.mockRejectedValueOnce({ data: { error: "invalid_blocks" } });
  }
  const cfg = { channels: { slack: { botToken: "xoxb-test" } } };
  const capturedSendOptions: Array<NonNullable<Parameters<typeof sendMessageSlack>[2]>> = [];
  const sendSlack: typeof sendMessageSlack = async (to, text, opts) => {
    capturedSendOptions.push(opts);
    return await sendMessageSlack(to, text, { ...opts, cfg, token: "xoxb-test", client });
  };

  await slackOutbound.sendPayload?.({
    cfg,
    to: "channel:C123",
    text: "",
    payload,
    deps: { sendSlack },
    deliveryQueueId: params.deliveryQueueId,
    onPlatformSendDispatch: params.onPlatformSendDispatch,
  });
  return { capturedSendOptions, client };
}

function valueButtons(label: string, value: string) {
  return { type: "buttons" as const, buttons: [{ label, value }] };
}

function interactiveButtons(label: string, value: string) {
  return { blocks: [valueButtons(label, value)] };
}

function createPipelineTablePayload(rowHeaderColumnIndex?: number): ReplyPayload {
  return {
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
          ...(rowHeaderColumnIndex === undefined ? {} : { rowHeaderColumnIndex }),
        },
      ],
    },
  };
}

function createWidePipelineTable() {
  const headers = Array.from({ length: 21 }, (_entry, index) => `Column ${String(index)}`);
  return {
    type: "table" as const,
    caption: "Wide pipeline",
    headers,
    rows: [headers.map((_header, index) => `Value ${String(index)}`)],
  };
}

function createPipelineChart() {
  return {
    type: "chart" as const,
    chartType: "bar" as const,
    title: "Pipeline",
    categories: ["Open"],
    series: [{ name: "Issues", values: [5] }],
  };
}

const COMMAND_FALLBACK_PRESENTATION = {
  title: "Actions",
  blocks: [
    { type: "text" as const, text: "Choose an action" },
    {
      type: "buttons" as const,
      buttons: [{ label: "Status", action: { type: "command" as const, command: "/status" } }],
    },
  ],
};
const PIPELINE_TABLE_TEXT =
  "Pipeline summary\n\nOpen pipeline (table)\nAccount\tARR\nAcme\t125000\nGlobex\t82000";

function createMixedPresentationPayload(): ReplyPayload {
  return {
    text: "Summary",
    presentation: {
      blocks: [createPipelineChart(), createWidePipelineTable(), valueButtons("Stage", "stage")],
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
    const sent = sentSlackMessage(sendMock, 0);
    expect(sent.to).toBe(to);
    expect(sent.text).toBe("Fallback summary");
    expect(sent.options.blocks).toEqual([
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
    const payloadForSend = await renderPayloadForSend(payload, payload.text);
    const { run, sendMock } = createHarness({ payload: payloadForSend });

    await run();

    const sent = sentSlackMessage(sendMock, 0);
    expect(sent.text).toBe("*Overview*");
    expect(sent.options.authoredTextPlacement).toBe("blocks");
    expect(sent.options.blocks).toEqual([
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

    const sent = sentSlackMessage(sendMock, 0);
    expect(sent.text).toBe(
      [
        "Revenue summary",
        "",
        "Quarterly revenue (bar chart)",
        "X axis: Quarter",
        "- Revenue: Q1: 120; Q2: 145",
      ].join("\n"),
    );
    expect(sent.options.blocks).toEqual([
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
    expect(sent.options.authoredTextPlacement).toBe("blocks");
    expect(sent.options.nativeDataFallbackBaseText).toBeUndefined();
  });

  it("renders native tables with complete top-level accessibility text", async () => {
    const { run, sendMock } = createHarness({
      payload: createPipelineTablePayload(0),
    });

    await run();

    const sent = sentSlackMessage(sendMock, 0);
    expect(sent.text).toBe(PIPELINE_TABLE_TEXT);
    expect(sent.options.blocks).toEqual([
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
    expect(sent.options.authoredTextPlacement).toBe("blocks");
    expect(sent.options.nativeDataFallbackBaseText).toBeUndefined();
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

    const { options } = sentSlackMessage(sendMock, 0);
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
    expect(sentSlackMessage(sendMock, 0).options.blocks).toHaveLength(50);
    expect(sentSlackMessage(sendMock, 1).options.blocks).toEqual([
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
    const sent = sentSlackMessage(sendMock, 0);
    expect(sent.text).toBe("Real text");
    expect(sent.options.blocks).toBeUndefined();
  });

  it("does not duplicate native table rows after real outbound rejection fallback", async () => {
    const { client } = await sendThroughRealSlack({
      payload: createPipelineTablePayload(),
      rejectFirstNativeBlocks: true,
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    const fallback = postedSlackMessage(client, 1);
    expect(fallback).toMatchObject({
      mrkdwn: false,
      text: PIPELINE_TABLE_TEXT,
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
          valueButtons("Refresh", "refresh"),
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
          valueButtons("Stage", "stage"),
          {
            type: "select",
            placeholder: "Lane",
            options: [{ label: "Production", value: "production" }],
          },
        ],
      },
    };

    const onPlatformSendDispatch = vi.fn(async () => {});
    const { capturedSendOptions, client } = await sendThroughRealSlack({
      payload,
      deliveryQueueId: "queue-1",
      onPlatformSendDispatch,
    });

    expect(client.chat.postMessage.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(capturedSendOptions).not.toHaveLength(0);
    expect(capturedSendOptions.every((opts) => opts.deliveryQueueId === undefined)).toBe(true);
    expect(capturedSendOptions.every((opts) => opts.onPlatformSendDispatch === undefined)).toBe(
      true,
    );
    expect(postedSlackMessage(client, 0)).toMatchObject({
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
      presentation: COMMAND_FALLBACK_PRESENTATION,
    };

    const segments = renderedPresentationSegments(await renderPresentation(payload));
    expect(segments.map((segment) => segment.kind)).toEqual(["blocks", "text"]);
    expect(segments[1]).toEqual({ kind: "text", text: "- Status: `/status`", mrkdwn: false });
  });

  it("renders the portable fallback visibly when native Slack blocks survive", async () => {
    const payload: ReplyPayload = {
      channelData: { slack: { blocks: [{ type: "divider" }] } },
      presentation: COMMAND_FALLBACK_PRESENTATION,
    };

    const segments = renderedPresentationSegments(await renderPresentation(payload));
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
                action: {
                  type: "web-app",
                  url: "https://node.tailnet.ts.net/__openclaw__/mcp-app#opaque-ticket",
                },
              },
              { label: "View", action: { type: "url", url: "https://example.com/view" } },
            ],
          },
        ],
      },
    };

    const [segment] = renderedPresentationSegments(await renderPresentation(payload));
    expect(segment).toMatchObject({
      kind: "blocks",
      blocks: [
        expect.objectContaining({
          type: "actions",
          elements: [
            expect.objectContaining({
              type: "button",
              action_id: "openclaw:reply_link:1:1",
              url: "https://node.tailnet.ts.net/__openclaw__/mcp-app#opaque-ticket",
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

    const segments = renderedPresentationSegments(await renderPresentation(payload));
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
      interactive: interactiveButtons("Allow", "pluginbind:approval-123:o"),
    };

    const segments = renderedPresentationSegments(await renderPresentation(payload));
    expect(segments.map((segment) => segment.kind)).toEqual(["blocks", "blocks"]);
    expect(segments[0]?.kind === "blocks" ? segments[0].blocks : []).toHaveLength(50);
    expect(segments[1]).toMatchObject({
      kind: "blocks",
      blocks: [{ type: "divider" }, { type: "actions" }],
    });
  });

  it("uses the full ordered table fallback when preserved siblings exceed the block limit", async () => {
    const payload: ReplyPayload = {
      channelData: {
        slack: { blocks: Array.from({ length: 49 }, () => ({ type: "divider" })) },
      },
      presentation: {
        blocks: [createWidePipelineTable(), valueButtons("Stage", "stage")],
      },
      interactive: interactiveButtons("Refresh", "refresh"),
    };

    const rendered = await renderPresentation(payload);
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
    expect(sentSlackMessage(sendMock, 0).options.blocks).toHaveLength(49);
    const fallbackSent = sentSlackMessage(sendMock, 1);
    expect(fallbackSent.text).toBe(fallback);
    expect(fallbackSent.options.blocks).toBeUndefined();
    expect(sentSlackMessage(sendMock, 2).options.blocks).toHaveLength(2);
  });

  it("sends an exact mirrored portable control row once", async () => {
    const buttons = [{ label: "Approve", action: { type: "callback" as const, value: "approve" } }];
    const { run, sendMock } = createHarness({
      payload: {
        text: "Deploy?",
        presentation: { blocks: [{ type: "buttons", buttons }] },
        interactive: { blocks: [{ type: "buttons", buttons }] },
      },
    });

    await run();

    const actions = sentSlackMessage(sendMock, 0).options.blocks?.filter(
      (block) => block.type === "actions",
    );
    expect(actions).toHaveLength(1);
  });

  it("preserves mixed chart, table fallback, and control order after presentation stripping", async () => {
    const payload = createMixedPresentationPayload();
    const payloadForSend = await renderPayloadForSend(payload, payload.text);
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
    expect(sentSlackMessage(sendMock, 0).options.blocks?.map((block) => block.type)).toEqual([
      "section",
      "data_visualization",
    ]);
    const fallbackSent = sentSlackMessage(sendMock, 1);
    expect(fallbackSent.text).toContain("Column 20: Value 20");
    expect(fallbackSent.options.blocks).toBeUndefined();
    expect(fallbackSent.options.textIsSlackPlainText).toBe(true);
    expect(sentSlackMessage(sendMock, 2).options.blocks?.map((block) => block.type)).toEqual([
      "actions",
    ]);
    expect(result.messageId).toBe("sl-controls");
  });

  it("keeps mixed segment order when Slack rejects the native chart", async () => {
    const payload = createMixedPresentationPayload();
    const { client } = await sendThroughRealSlack({
      payload,
      rejectFirstNativeBlocks: true,
      renderText: payload.text,
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(4);
    const firstFallbackRequest = postedSlackMessage(client, 1);
    expect(firstFallbackRequest?.blocks?.map((block) => block.type)).toEqual([
      "section",
      "section",
    ]);
    expect(postedSlackMessage(client, 2)).toMatchObject({
      mrkdwn: false,
      text: expect.stringContaining("Column 20: Value 20"),
    });
    const secondFallbackRequest = postedSlackMessage(client, 2);
    expect(secondFallbackRequest?.blocks).toBeUndefined();
    const finalFallbackRequest = postedSlackMessage(client, 3);
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
      presentation: { blocks: [createPipelineChart()] },
    };
    const { client } = await sendThroughRealSlack({
      payload,
      rejectFirstNativeBlocks: true,
      renderText: payload.text,
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    const fallback = postedSlackMessage(client, 1);
    expect(fallback.text?.match(/Overview/gu)).toHaveLength(1);
    expect(fallback.blocks?.filter((block) => block.text?.text === "Overview")).toHaveLength(1);
  });

  it("sends media before a separate interactive blocks message", async () => {
    const { run, sendMock, to } = createHarness({
      payload: {
        text: "Approval required",
        mediaUrl: "https://example.com/image.png",
        interactive: interactiveButtons("Allow", "pluginbind:approval-123:o"),
      },
      sendResults: [{ messageId: "sl-media" }, { messageId: "sl-controls" }],
    });

    const result = await run();

    expect(sendMock).toHaveBeenCalledTimes(2);
    const mediaSent = sentSlackMessage(sendMock, 0);
    expect(mediaSent.to).toBe(to);
    expect(mediaSent.text).toBe("");
    expect(mediaSent.options.mediaUrl).toBe("https://example.com/image.png");
    expect(mediaSent.options).not.toHaveProperty("blocks");
    const controlsSent = sentSlackMessage(sendMock, 1);
    expect(controlsSent.to).toBe(to);
    expect(controlsSent.text).toBe("Approval required\n\nAllow");
    expect(controlsSent.options.blocks?.map((block) => block.type)).toEqual(["section", "actions"]);
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
        interactive: interactiveButtons("Allow", "pluginbind:approval-123:o"),
      },
    });

    await expect(run()).resolves.toMatchObject({ messageId: "sl-1" });
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sentSlackMessage(sendMock, 0).options.blocks).toHaveLength(50);
    expect(sentSlackMessage(sendMock, 1).options.blocks?.map((block) => block.type)).toEqual([
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
        presentation: { blocks: [valueButtons("Stage", "stage")] },
        interactive: interactiveButtons("Approve", "approve"),
      },
    });

    await run();

    expect(sendMock).toHaveBeenCalledTimes(1);
    const sent = sentSlackMessage(sendMock, 0);
    expect(sent.to).toBe(to);
    expect(sent.text).toBe("Deploy?\n\nStage\n\nApprove");
    const blocks = sent.options.blocks;
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
    createHarness,
  });
});
