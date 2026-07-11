// Slack tests cover replies plugin behavior.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
vi.mock("../send.js", () => ({
  sendMessageSlack: (...args: unknown[]) => sendMock(...args),
}));

const triggerInternalHook = vi.hoisted(() => vi.fn(async () => {}));
const messageHookRunner = vi.hoisted(() => ({
  hasHooks: vi.fn<(name: string) => boolean>(() => false),
  runMessageSent: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/hook-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/hook-runtime")>();
  return {
    ...actual,
    triggerInternalHook,
  };
});

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>();
  return {
    ...actual,
    getGlobalHookRunner: () => messageHookRunner,
  };
});

let deliverReplies: typeof import("./replies.js").deliverReplies;
let createSlackReplyDeliveryPlan: typeof import("./replies.js").createSlackReplyDeliveryPlan;
let resolveDeliveredSlackReplyThreadTs: typeof import("./replies.js").resolveDeliveredSlackReplyThreadTs;
let resolveSlackThreadTs: typeof import("./replies.js").resolveSlackThreadTs;
import { deliverSlackSlashReplies } from "./replies.js";

const SLACK_TEST_CFG = { channels: { slack: { botToken: "xoxb-test" } } };

function baseParams(overrides?: Record<string, unknown>) {
  return {
    cfg: SLACK_TEST_CFG,
    replies: [{ text: "hello" }],
    target: "C123",
    token: "xoxb-test",
    runtime: { log: () => {}, error: () => {}, exit: () => {} },
    textLimit: 4000,
    replyToMode: "off" as const,
    ...overrides,
  };
}

function largePortableTablePresentation() {
  return {
    blocks: [
      {
        type: "table" as const,
        caption: "Large pipeline",
        headers: ["Account"],
        rows: Array.from({ length: 100 }, (_entry, index) => [
          index === 0 ? "<@U123>" : `account-${String(index)} ${"x".repeat(110)}`,
        ]),
      },
    ],
  };
}

function requireSendCall(index = 0) {
  const call = sendMock.mock.calls[index] as [string, string, Record<string, unknown>] | undefined;
  if (!call) {
    throw new Error(`sendMessageSlack call ${index} missing`);
  }
  return call;
}

type SlashTestMessage = {
  text: string;
  blocks?: Array<Record<string, unknown>>;
  mrkdwn?: false;
  response_type?: "ephemeral" | "in_channel";
};

function requireSlashMessage(respond: ReturnType<typeof vi.fn>, index = 0): SlashTestMessage {
  const message = respond.mock.calls[index]?.[0] as SlashTestMessage | undefined;
  if (!message) {
    throw new Error(`Slack response call ${String(index)} missing`);
  }
  return message;
}

function readPlainSectionTexts(message: SlashTestMessage): string[] {
  return (message.blocks ?? []).flatMap((block) => {
    const text = block.text as { type?: unknown; text?: unknown } | undefined;
    return text?.type === "plain_text" && typeof text.text === "string" ? [text.text] : [];
  });
}

describe("deliverReplies identity passthrough", () => {
  beforeAll(async () => {
    ({
      createSlackReplyDeliveryPlan,
      deliverReplies,
      resolveDeliveredSlackReplyThreadTs,
      resolveSlackThreadTs,
    } = await import("./replies.js"));
  });

  beforeEach(() => {
    sendMock.mockReset();
    messageHookRunner.hasHooks.mockReset();
    messageHookRunner.hasHooks.mockReturnValue(false);
    messageHookRunner.runMessageSent.mockReset();
    triggerInternalHook.mockReset();
  });
  it("passes identity to sendMessageSlack for text replies", async () => {
    sendMock.mockResolvedValue(undefined);
    const identity = { username: "Bot", iconEmoji: ":robot:" };
    await deliverReplies(baseParams({ identity }));

    expect(sendMock).toHaveBeenCalledOnce();
    const options = requireSendCall()[2];
    expect(options.identity).toBe(identity);
  });

  it("passes identity to sendMessageSlack for media replies", async () => {
    sendMock.mockResolvedValue(undefined);
    const identity = { username: "Bot", iconUrl: "https://example.com/icon.png" };
    await deliverReplies(
      baseParams({
        identity,
        replies: [{ text: "caption", mediaUrls: ["https://example.com/img.png"] }],
      }),
    );

    expect(sendMock).toHaveBeenCalledOnce();
    const options = requireSendCall()[2];
    expect(options.identity).toBe(identity);
  });

  it("routes non-native portable tables through complete Slack-safe text delivery", async () => {
    sendMock.mockResolvedValue({ messageId: "table-ts", channelId: "C123" });

    await deliverReplies(
      baseParams({
        textLimit: 8000,
        replies: [
          {
            presentation: largePortableTablePresentation(),
            interactive: {
              blocks: [
                {
                  type: "buttons",
                  buttons: [{ label: "Refresh", value: "refresh" }],
                },
              ],
            },
          },
        ],
      }),
    );

    expect(sendMock).toHaveBeenCalledTimes(2);
    const [_textTarget, text, textOptions] = requireSendCall(0);
    expect(text).toContain("- Account: <@U123>");
    expect(text).toContain("- Account: account-99");
    expect(text.length).toBeGreaterThan(8000);
    expect(textOptions.textIsSlackPlainText).toBe(true);
    expect(textOptions.blocks).toBeUndefined();

    const [_blockTarget, blockText, blockOptions] = requireSendCall(1);
    expect(blockText).toBe("");
    expect(blockOptions.blocks).toEqual([
      expect.objectContaining({
        type: "actions",
        elements: [expect.objectContaining({ type: "button", value: "refresh" })],
      }),
    ]);
  });

  it("delivers media before native chart blocks with the same reply context", async () => {
    messageHookRunner.hasHooks.mockImplementation((name: string) => name === "message_sent");
    sendMock
      .mockResolvedValueOnce({ messageId: "media-ts", channelId: "C123" })
      .mockResolvedValueOnce({ messageId: "chart-ts", channelId: "C123" });
    const identity = { username: "Bot", iconEmoji: ":chart_with_upwards_trend:" };
    const metadata = { event_type: "openclaw_test", event_payload: { source: "chart" } };
    const listenerClient = { chat: { postMessage: vi.fn() } } as never;
    const eventScope = {
      apiAppId: "A1",
      enterpriseId: "E1",
      isEnterpriseInstall: true as const,
      teamId: "T1",
      client: listenerClient,
    };
    const enterpriseCfg = { channels: { slack: { enterpriseOrgInstall: true } } };

    const result = await deliverReplies(
      baseParams({
        cfg: enterpriseCfg,
        accountId: "work",
        identity,
        metadata,
        eventScope,
        mediaMaxBytes: 1024,
        replyThreadTs: "thread-ts",
        replies: [
          {
            text: "Revenue summary",
            mediaUrl: "https://example.com/report.png",
            presentation: {
              blocks: [
                {
                  type: "chart",
                  chartType: "pie",
                  title: "Revenue mix",
                  segments: [
                    { label: "Product", value: 60 },
                    { label: "Services", value: 40 },
                  ],
                },
              ],
            },
          },
        ],
      }),
    );

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock).toHaveBeenNthCalledWith(1, "C123", "Revenue summary", {
      cfg: enterpriseCfg,
      token: "xoxb-test",
      mediaUrl: "https://example.com/report.png",
      threadTs: "thread-ts",
      accountId: "work",
      client: listenerClient,
      enterpriseEventScope: eventScope,
      textLimit: 4000,
      mediaMaxBytes: 1024,
      identity,
      metadata,
    });
    expect(sendMock).toHaveBeenNthCalledWith(2, "C123", "", {
      cfg: enterpriseCfg,
      token: "xoxb-test",
      threadTs: "thread-ts",
      accountId: "work",
      client: listenerClient,
      enterpriseEventScope: eventScope,
      textLimit: 4000,
      mediaMaxBytes: 1024,
      blocks: [
        {
          type: "data_visualization",
          title: "Revenue mix",
          chart: {
            type: "pie",
            segments: [
              { label: "Product", value: 60 },
              { label: "Services", value: 40 },
            ],
          },
        },
      ],
      authoredTextPlacement: "none",
      identity,
      metadata,
    });
    expect(result).toEqual({ messageId: "chart-ts", channelId: "C123" });
    expect(messageHookRunner.runMessageSent).toHaveBeenCalledOnce();
    const event = messageHookRunner.runMessageSent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event).toMatchObject({
      to: "C123",
      content: "Revenue summary\n\nRevenue mix (pie chart)\n- Product: 60\n- Services: 40",
      success: true,
    });
    expect(event).not.toHaveProperty("messageId");
  });

  it("omits identity key when not provided", async () => {
    sendMock.mockResolvedValue(undefined);
    await deliverReplies(baseParams());

    expect(sendMock).toHaveBeenCalledOnce();
    const options = requireSendCall()[2];
    expect(options).not.toHaveProperty("identity");
  });

  it("forwards the validated Enterprise event scope and exact listener client", async () => {
    sendMock.mockResolvedValue({ messageId: "123.456", channelId: "C123" });
    const listenerClient = { chat: { postMessage: vi.fn() } } as never;
    const eventScope = {
      apiAppId: "A1",
      enterpriseId: "E1",
      isEnterpriseInstall: true as const,
      teamId: "T1",
      client: listenerClient,
    };

    await deliverReplies(
      baseParams({
        cfg: { channels: { slack: { enterpriseOrgInstall: true } } },
        eventScope,
        mediaMaxBytes: 1024,
      }),
    );

    const options = requireSendCall()[2];
    expect(options.client).toBe(listenerClient);
    expect(options.enterpriseEventScope).toBe(eventScope);
    expect(options.textLimit).toBe(4000);
    expect(options.mediaMaxBytes).toBe(1024);
  });

  it("delivers block-only replies through to sendMessageSlack", async () => {
    sendMock.mockResolvedValue(undefined);
    const blocks = [
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "openclaw:reply_button",
            text: { type: "plain_text", text: "Option A" },
            value: "reply_1_option_a",
          },
        ],
      },
    ];

    await deliverReplies(
      baseParams({
        replies: [
          {
            text: "",
            channelData: {
              slack: {
                blocks,
              },
            },
          },
        ],
      }),
    );

    expect(sendMock).toHaveBeenCalledOnce();
    const [target, text, options] = requireSendCall();
    expect(target).toBe("C123");
    expect(text).toBe("");
    expect(options.blocks).toStrictEqual(blocks);
  });

  it("renders interactive replies into Slack blocks during delivery", async () => {
    sendMock.mockResolvedValue(undefined);

    await deliverReplies(
      baseParams({
        replies: [
          {
            text: "Choose",
            interactive: {
              blocks: [
                { type: "text", text: "Choose" },
                {
                  type: "buttons",
                  buttons: [{ label: "Approve", value: "approve", style: "primary" }],
                },
              ],
            },
          },
        ],
      }),
    );

    expect(sendMock).toHaveBeenCalledOnce();
    const options = requireSendCall()[2];
    const blocks = options.blocks as Array<{
      type?: string;
      elements?: Array<{ action_id?: string; style?: string; value?: string }>;
    }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.type).toBe("section");
    expect(blocks[1]?.type).toBe("actions");
    expect(blocks[1]?.elements).toHaveLength(1);
    expect(blocks[1]?.elements?.[0]?.action_id).toBe("openclaw:reply_button:1:1");
    expect(blocks[1]?.elements?.[0]?.style).toBe("primary");
    expect(blocks[1]?.elements?.[0]?.value).toBe("approve");
  });

  it("rolls ordered reply blocks into another Slack message at the platform limit", async () => {
    sendMock.mockResolvedValue(undefined);

    await deliverReplies(
      baseParams({
        replies: [
          {
            text: "Choose",
            channelData: {
              slack: {
                blocks: Array.from({ length: 50 }, () => ({ type: "divider" })),
              },
            },
            interactive: {
              blocks: [{ type: "buttons", buttons: [{ label: "Retry", value: "retry" }] }],
            },
          },
        ],
      }),
    );

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(requireSendCall(0)[2].blocks as unknown[]).toHaveLength(50);
    expect(requireSendCall(1)[2].blocks).toEqual([
      expect.objectContaining({ type: "section" }),
      expect.objectContaining({ type: "actions" }),
    ]);
  });
});

describe("resolveDeliveredSlackReplyThreadTs", () => {
  beforeAll(async () => {
    ({ resolveDeliveredSlackReplyThreadTs } = await import("./replies.js"));
  });

  it("prefers explicit reply targets when reply tags are enabled", () => {
    expect(
      resolveDeliveredSlackReplyThreadTs({
        replyToMode: "first",
        payloadReplyToId: "explicit-thread",
        replyThreadTs: "planned-thread",
      }),
    ).toBe("explicit-thread");
  });

  it("ignores explicit reply tags when replyToMode is off", () => {
    expect(
      resolveDeliveredSlackReplyThreadTs({
        replyToMode: "off",
        payloadReplyToId: "explicit-thread",
        replyThreadTs: "planned-thread",
      }),
    ).toBe("planned-thread");
  });

  it("falls back to the planned reply thread when no explicit reply tag exists", () => {
    expect(
      resolveDeliveredSlackReplyThreadTs({
        replyToMode: "batched",
        replyThreadTs: "planned-thread",
      }),
    ).toBe("planned-thread");
  });
});

describe("resolveSlackThreadTs fallback classification", () => {
  const threadTs = "1234567890.123456";
  const messageTs = "9999999999.999999";

  it("keeps legacy thread-stickiness for genuine replies when callers omit isThreadReply", () => {
    expect(
      resolveSlackThreadTs({
        replyToMode: "off",
        incomingThreadTs: threadTs,
        messageTs,
        hasReplied: false,
      }),
    ).toBe(threadTs);
  });

  it("respects replyToMode for auto-created top-level thread_ts when callers omit isThreadReply", () => {
    expect(
      resolveSlackThreadTs({
        replyToMode: "off",
        incomingThreadTs: messageTs,
        messageTs,
        hasReplied: false,
      }),
    ).toBeUndefined();

    expect(
      resolveSlackThreadTs({
        replyToMode: "first",
        incomingThreadTs: messageTs,
        messageTs,
        hasReplied: false,
      }),
    ).toBe(messageTs);

    expect(
      resolveSlackThreadTs({
        replyToMode: "batched",
        incomingThreadTs: messageTs,
        messageTs,
        hasReplied: true,
      }),
    ).toBeUndefined();
  });
});

describe("createSlackReplyDeliveryPlan", () => {
  it("lets draft previews inspect first thread targets without consuming them", () => {
    const hasRepliedRef = { value: false };
    const plan = createSlackReplyDeliveryPlan({
      replyToMode: "first",
      incomingThreadTs: undefined,
      messageTs: "9999999999.999999",
      hasRepliedRef,
      isThreadReply: false,
    });

    expect(plan.peekThreadTs()).toBe("9999999999.999999");
    expect(plan.peekThreadTs()).toBe("9999999999.999999");
    expect(hasRepliedRef.value).toBe(false);

    plan.markSent();

    expect(hasRepliedRef.value).toBe(true);
    expect(plan.peekThreadTs()).toBeUndefined();
    expect(plan.nextThreadTs()).toBeUndefined();
  });
});

describe("deliverSlackSlashReplies chunking", () => {
  beforeEach(() => {
    messageHookRunner.hasHooks.mockReset();
    messageHookRunner.hasHooks.mockReturnValue(false);
    messageHookRunner.runMessageSent.mockReset();
    triggerInternalHook.mockReset();
  });

  it("keeps a 4205-character reply in a single slash response by default", async () => {
    const respond = vi.fn(async () => undefined);
    const text = "a".repeat(4205);

    await deliverSlackSlashReplies({
      replies: [{ text }],
      respond,
      ephemeral: true,
      textLimit: 8000,
    });

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith({
      text,
      response_type: "ephemeral",
    });
  });

  it("sends block-only slash replies instead of dropping them", async () => {
    const respond = vi.fn(async () => undefined);
    const blocks = [{ type: "divider" }];

    await deliverSlackSlashReplies({
      replies: [
        {
          channelData: {
            slack: {
              blocks,
            },
          },
        },
      ],
      respond,
      ephemeral: false,
      textLimit: 8000,
    });

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith({
      text: "Shared a Block Kit message",
      blocks,
      mrkdwn: false,
      response_type: "in_channel",
    });
  });

  it("splits non-native blocks before slash accessibility text exceeds 40k", async () => {
    const respond = vi.fn(async () => undefined);
    const blocks = Array.from({ length: 20 }, (_entry, index) => ({
      type: "section",
      text: { type: "plain_text", text: `${String(index)}-${"x".repeat(2_990)}` },
    }));

    await deliverSlackSlashReplies({
      replies: [{ channelData: { slack: { blocks } } }],
      respond,
      ephemeral: true,
      textLimit: 8000,
    });

    expect(respond).toHaveBeenCalledTimes(2);
    const messages = respond.mock.calls.map((_call, index) => requireSlashMessage(respond, index));
    expect(messages.every((message) => message.text.length <= 40_000)).toBe(true);
    expect(messages.every((message) => message.mrkdwn === false)).toBe(true);
    expect(messages.flatMap((message) => message.blocks ?? [])).toEqual(blocks);
  });

  it("replaces rejected native data in place without duplicating authored text", async () => {
    const respond = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce({ response: { data: { error: "invalid_blocks" } } });
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: "Overview" } },
      {
        type: "data_visualization",
        title: "Revenue mix",
        chart: {
          type: "pie",
          segments: [
            { label: "Product", value: 60 },
            { label: "Services", value: 40 },
          ],
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "openclaw:reply_button",
            text: { type: "plain_text", text: "Refresh" },
            value: "refresh",
          },
        ],
      },
      {
        type: "data_table",
        caption: "Pipeline report",
        rows: [
          [
            { type: "raw_text", text: "Account" },
            { type: "raw_text", text: "ARR" },
          ],
          [
            { type: "raw_text", text: "Acme" },
            { type: "raw_number", value: 125000, text: "$125k" },
          ],
        ],
      },
    ];

    await deliverSlackSlashReplies({
      replies: [
        {
          text: "Overview",
          channelData: { slack: { blocks } },
        },
      ],
      respond,
      ephemeral: true,
      textLimit: 8000,
    });

    expect(respond).toHaveBeenCalledTimes(2);
    const native = requireSlashMessage(respond, 0);
    const fallback = requireSlashMessage(respond, 1);
    expect(native.blocks?.map((block) => block.type)).toEqual([
      "section",
      "data_visualization",
      "actions",
      "data_table",
    ]);
    expect(fallback.blocks?.map((block) => block.type)).toEqual([
      "section",
      "section",
      "actions",
      "section",
    ]);
    expect(readPlainSectionTexts(fallback)).toEqual([
      "Revenue mix (pie chart)\n- Product: 60\n- Services: 40",
      "Pipeline report (table)\nAccount\tARR\nAcme\t$125k",
    ]);
    expect(fallback.text).toBe(
      [
        "Overview",
        "Revenue mix (pie chart)\n- Product: 60\n- Services: 40",
        "Refresh",
        "Pipeline report (table)\nAccount\tARR\nAcme\t$125k",
      ].join("\n\n"),
    );
    expect(fallback.text.match(/Overview/gu)).toHaveLength(1);
    expect(fallback.mrkdwn).toBe(false);
  });

  it("uses complete 40k blockless chunks for oversized native-only fallback", async () => {
    const respond = vi.fn(async () => undefined);
    const caption = "c".repeat(41_000);
    const blocks = [
      {
        type: "data_table",
        caption,
        rows: [[{ type: "raw_text", text: "Account" }], [{ type: "raw_text", text: "Acme" }]],
      },
    ] as never;

    await deliverSlackSlashReplies({
      replies: [{ channelData: { slack: { blocks } } }],
      respond,
      ephemeral: true,
      textLimit: 8000,
    });

    expect(respond).toHaveBeenCalledTimes(2);
    const messages = respond.mock.calls.map((_call, index) => requireSlashMessage(respond, index));
    expect(messages.every((message) => message.blocks === undefined)).toBe(true);
    expect(messages.every((message) => message.mrkdwn === false)).toBe(true);
    expect(messages.every((message) => message.text.length <= 40_000)).toBe(true);
    expect(messages.map((message) => message.text).join("")).toBe(
      `${caption} (table)\nAccount\nAcme`,
    );
  });

  it("batches in-place native fallback at 50 blocks without losing content", async () => {
    const respond = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce({ response: { data: { error: "invalid_blocks" } } });
    const caption = "c".repeat(9_000);
    const action = {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "openclaw:reply_button",
          text: { type: "plain_text", text: "Refresh" },
          value: "refresh",
        },
      ],
    };
    const blocks = [
      ...Array.from({ length: 48 }, () => ({ type: "divider" })),
      action,
      {
        type: "data_table",
        caption,
        rows: [[{ type: "raw_text", text: "Account" }], [{ type: "raw_text", text: "Acme" }]],
      },
    ] as never;

    await deliverSlackSlashReplies({
      replies: [{ channelData: { slack: { blocks } } }],
      respond,
      ephemeral: true,
      textLimit: 8000,
    });

    expect(respond).toHaveBeenCalledTimes(3);
    const fallback = [requireSlashMessage(respond, 1), requireSlashMessage(respond, 2)];
    expect(fallback.every((message) => (message.blocks?.length ?? 0) <= 50)).toBe(true);
    expect(fallback.every((message) => message.text.length <= 40_000)).toBe(true);
    expect(fallback.every((message) => message.mrkdwn === false)).toBe(true);
    expect(fallback[0]?.blocks?.[48]?.type).toBe("actions");
    expect(fallback.flatMap(readPlainSectionTexts).join("")).toBe(
      `${caption} (table)\nAccount\nAcme`,
    );
    expect(fallback.map((message) => message.text).join("\n")).toContain("Refresh");
  });

  it("preserves chart, unrenderable table, control, and media order", async () => {
    const respond = vi.fn(async () => undefined);

    await deliverSlackSlashReplies({
      replies: [
        {
          presentation: {
            blocks: [
              {
                type: "chart",
                chartType: "pie",
                title: "Revenue mix",
                segments: [
                  { label: "Product", value: 60 },
                  { label: "Services", value: 40 },
                ],
              },
              ...largePortableTablePresentation().blocks,
              {
                type: "buttons",
                buttons: [{ label: "Refresh", value: "secret-refresh-token" }],
              },
            ],
          },
          mediaUrls: ["https://example.com/report.png"],
        },
      ],
      respond,
      ephemeral: true,
      textLimit: 8000,
    });

    expect(respond).toHaveBeenCalledTimes(4);
    const messages = respond.mock.calls.map((_call, index) => requireSlashMessage(respond, index));
    expect(messages[0]?.blocks?.map((block) => block.type)).toEqual(["data_visualization"]);
    expect(messages[0]?.text).toContain("Revenue mix (pie chart)");
    expect(messages[1]?.blocks).toBeUndefined();
    expect(messages[1]?.text).toContain("Large pipeline (table)");
    expect(messages[1]?.text).toContain("- Account: <@U123>");
    expect(messages[1]?.text).toContain("- Account: account-99");
    expect(messages[2]?.blocks?.map((block) => block.type)).toEqual(["actions"]);
    expect(messages[2]?.text).toBe("Refresh");
    expect(messages[3]).toMatchObject({
      text: "https://example.com/report.png",
      mrkdwn: false,
    });
    expect(messages.map((message) => message.text).join("\n")).not.toContain(
      "secret-refresh-token",
    );
  });

  it("fails before content when the real response_url five-call budget is exceeded", async () => {
    const respond = vi.fn(async () => undefined);

    await expect(
      deliverSlackSlashReplies({
        replies: Array.from({ length: 6 }, (_entry, index) => ({
          text: `reply-${String(index)}`,
        })),
        respond,
        ephemeral: false,
        textLimit: 8000,
      }),
    ).rejects.toThrow("response_url delivery budget");

    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith({
      text: "This Slack response is too large to deliver within the remaining response window.",
      response_type: "ephemeral",
    });
  });

  it("allows more than five follow-ups for uncapped Web API delivery", async () => {
    const respond = vi.fn(async () => undefined);
    const responseBudget = {
      respond,
      remaining: () => undefined,
    };

    await deliverSlackSlashReplies({
      replies: Array.from({ length: 6 }, (_entry, index) => ({ text: `reply-${String(index)}` })),
      respond,
      responseBudget,
      ephemeral: false,
      textLimit: 8000,
    });

    expect(respond).toHaveBeenCalledTimes(6);
    expect(
      Array.from({ length: 6 }, (_entry, index) => requireSlashMessage(respond, index).text),
    ).toEqual(["reply-0", "reply-1", "reply-2", "reply-3", "reply-4", "reply-5"]);
  });

  it("suppresses reasoning payloads in slash replies", async () => {
    const respond = vi.fn(async () => undefined);

    await deliverSlackSlashReplies({
      replies: [{ text: "Let me think...", isReasoning: true }, { text: "final answer" }],
      respond,
      ephemeral: false,
      textLimit: 8000,
    });

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith({
      text: "final answer",
      response_type: "in_channel",
    });
  });

  it("emits terminal hooks for successful slash responses", async () => {
    const respond = vi.fn(async () => undefined);
    messageHookRunner.hasHooks.mockImplementation((name: string) => name === "message_sent");

    await deliverSlackSlashReplies({
      replies: [{ text: "final answer" }],
      respond,
      ephemeral: false,
      textLimit: 8000,
      messageSentHookTarget: "user:U1",
      accountId: "default",
      sessionKeyForInternalHooks: "agent:main:slack:slash:u1",
    });

    const event = messageHookRunner.runMessageSent.mock.calls[0]?.[0] as Record<string, unknown>;
    const context = messageHookRunner.runMessageSent.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(event).toMatchObject({
      to: "user:U1",
      content: "final answer",
      success: true,
      sessionKey: "agent:main:slack:slash:u1",
    });
    expect(context).toMatchObject({
      conversationId: "user:U1",
      sessionKey: "agent:main:slack:slash:u1",
    });
    expect(triggerInternalHook).toHaveBeenCalledOnce();
  });

  it("emits one terminal hook for a multi-part slash reply", async () => {
    const respond = vi.fn(async () => undefined);
    messageHookRunner.hasHooks.mockImplementation((name: string) => name === "message_sent");

    await deliverSlackSlashReplies({
      replies: [{ text: "first\nsecond" }],
      respond,
      ephemeral: true,
      textLimit: 8,
      chunkMode: "newline",
      messageSentHookTarget: "user:U1",
    });

    expect(respond).toHaveBeenCalledTimes(2);
    expect(messageHookRunner.runMessageSent).toHaveBeenCalledOnce();
    const event = messageHookRunner.runMessageSent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event).toMatchObject({
      to: "user:U1",
      content: "first\nsecond",
      success: true,
    });
  });

  it("emits only failure when a later slash response chunk throws", async () => {
    const respond = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("response_url_expired"));
    messageHookRunner.hasHooks.mockImplementation((name: string) => name === "message_sent");

    await expect(
      deliverSlackSlashReplies({
        replies: [{ text: "first\nsecond" }],
        respond,
        ephemeral: true,
        textLimit: 8,
        chunkMode: "newline",
        messageSentHookTarget: "user:U1",
      }),
    ).rejects.toThrow(/response_url_expired/);

    expect(messageHookRunner.runMessageSent).toHaveBeenCalledOnce();
    const event = messageHookRunner.runMessageSent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event).toMatchObject({
      to: "user:U1",
      content: "first\nsecond",
      success: false,
    });
    expect(String(event.error)).toMatch(/response_url_expired/);
  });

  it("reports spoken text for media-only TTS slash replies", async () => {
    const respond = vi.fn(async () => undefined);
    messageHookRunner.hasHooks.mockImplementation((name: string) => name === "message_sent");

    await deliverSlackSlashReplies({
      replies: [
        {
          mediaUrl: "https://example.com/tts.mp3",
          audioAsVoice: true,
          spokenText: "Spoken slash answer",
        },
      ],
      respond,
      ephemeral: true,
      textLimit: 8000,
      messageSentHookTarget: "user:U1",
    });

    expect(respond).toHaveBeenCalledWith({
      text: "https://example.com/tts.mp3",
      response_type: "ephemeral",
    });
    const event = messageHookRunner.runMessageSent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event).toMatchObject({
      content: "Spoken slash answer",
      success: true,
    });
  });
});

describe("deliverReplies reasoning suppression", () => {
  beforeAll(async () => {
    ({ deliverReplies } = await import("./replies.js"));
  });

  beforeEach(() => {
    sendMock.mockReset();
  });

  it("suppresses reasoning payloads and delivers only non-reasoning replies", async () => {
    sendMock.mockResolvedValue(undefined);

    await deliverReplies(
      baseParams({
        replies: [{ text: "Reasoning:\n_hidden_", isReasoning: true }, { text: "visible answer" }],
      }),
    );

    expect(sendMock).toHaveBeenCalledOnce();
    const [, text] = requireSendCall();
    expect(text).toBe("visible answer");
  });

  it("delivers nothing when all payloads are reasoning", async () => {
    sendMock.mockResolvedValue(undefined);

    await deliverReplies(
      baseParams({
        replies: [
          { text: "Let me think about this...", isReasoning: true },
          { text: "I need to consider...", isReasoning: true },
        ],
      }),
    );

    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("deliverReplies message_sent hook", () => {
  beforeAll(async () => {
    ({ deliverReplies } = await import("./replies.js"));
  });

  beforeEach(() => {
    sendMock.mockReset();
    messageHookRunner.hasHooks.mockReset();
    messageHookRunner.hasHooks.mockReturnValue(false);
    messageHookRunner.runMessageSent.mockReset();
    triggerInternalHook.mockReset();
  });

  it("emits message_sent with success=true after a text reply is delivered", async () => {
    messageHookRunner.hasHooks.mockImplementation((name: string) => name === "message_sent");
    sendMock.mockResolvedValue({ messageId: "1700000000.000100", channelId: "C123" });

    const result = await deliverReplies(baseParams({ replies: [{ text: "shipped" }] }));

    expect(sendMock).toHaveBeenCalledOnce();
    expect(result).toEqual({ messageId: "1700000000.000100", channelId: "C123" });
    expect(messageHookRunner.runMessageSent).toHaveBeenCalledOnce();
    const event = messageHookRunner.runMessageSent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event).toMatchObject({
      to: "C123",
      content: "shipped",
      success: true,
      messageId: "1700000000.000100",
    });
    const context = messageHookRunner.runMessageSent.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(context).toMatchObject({ channelId: "slack" });
  });

  it("reports the trimmed content sent for text-only replies", async () => {
    messageHookRunner.hasHooks.mockImplementation((name: string) => name === "message_sent");
    sendMock.mockResolvedValue({ messageId: "ts", channelId: "C123" });

    await deliverReplies(baseParams({ replies: [{ text: "  shipped  " }] }));

    expect(sendMock).toHaveBeenCalledWith("C123", "shipped", expect.anything());
    const event = messageHookRunner.runMessageSent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event).toMatchObject({ content: "shipped", success: true });
  });

  it("threads the session key into the message_sent plugin context for correlation", async () => {
    messageHookRunner.hasHooks.mockImplementation((name: string) => name === "message_sent");
    sendMock.mockResolvedValue({ messageId: "1700000000.000200", channelId: "C123" });

    await deliverReplies(
      baseParams({
        replies: [{ text: "correlated" }],
        sessionKeyForInternalHooks: "slack:C123:U1",
      }),
    );

    expect(messageHookRunner.runMessageSent).toHaveBeenCalledOnce();
    const event = messageHookRunner.runMessageSent.mock.calls[0]?.[0] as Record<string, unknown>;
    const context = messageHookRunner.runMessageSent.mock.calls[0]?.[1] as Record<string, unknown>;
    // Plugins observing both `message_sending` and `message_sent` must see the
    // same `sessionKey` (mirrors the shared outbound emitter contract).
    expect(event).toMatchObject({ sessionKey: "slack:C123:U1" });
    expect(context).toMatchObject({ sessionKey: "slack:C123:U1" });
  });

  it("uses the logical hook target while delivering to a physical DM channel", async () => {
    messageHookRunner.hasHooks.mockImplementation((name: string) => name === "message_sent");
    sendMock.mockResolvedValue({ messageId: "ts", channelId: "D123" });

    await deliverReplies(
      baseParams({
        replies: [{ text: "direct reply" }],
        target: "channel:D123",
        messageSentHookTarget: "user:U123",
      }),
    );

    expect(sendMock).toHaveBeenCalledWith("channel:D123", "direct reply", expect.anything());
    const event = messageHookRunner.runMessageSent.mock.calls[0]?.[0] as Record<string, unknown>;
    const context = messageHookRunner.runMessageSent.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(event).toMatchObject({ to: "user:U123" });
    expect(context).toMatchObject({ conversationId: "user:U123" });
  });

  it("emits message_sent with success=false when delivery throws", async () => {
    messageHookRunner.hasHooks.mockImplementation((name: string) => name === "message_sent");
    sendMock.mockRejectedValue(new Error("channel_not_found"));

    await expect(deliverReplies(baseParams({ replies: [{ text: "boom" }] }))).rejects.toThrow(
      /channel_not_found/,
    );

    expect(messageHookRunner.runMessageSent).toHaveBeenCalledOnce();
    const event = messageHookRunner.runMessageSent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event).toMatchObject({ success: false, content: "boom" });
    expect(String(event.error)).toMatch(/channel_not_found/);
  });

  it("defers both success and failure hooks for caller-owned terminal delivery", async () => {
    messageHookRunner.hasHooks.mockImplementation((name: string) => name === "message_sent");
    sendMock.mockResolvedValueOnce({ messageId: "ts", channelId: "C123" });

    await deliverReplies(
      baseParams({
        replies: [{ text: "deferred success" }],
        sessionKeyForInternalHooks: "slack:C123:U1",
        deferMessageSentHooks: true,
      }),
    );

    sendMock.mockRejectedValueOnce(new Error("deferred failure"));
    await expect(
      deliverReplies(
        baseParams({
          replies: [{ text: "deferred failure" }],
          sessionKeyForInternalHooks: "slack:C123:U1",
          deferMessageSentHooks: true,
        }),
      ),
    ).rejects.toThrow(/deferred failure/);

    expect(messageHookRunner.runMessageSent).not.toHaveBeenCalled();
    expect(triggerInternalHook).not.toHaveBeenCalled();
  });

  it("emits one message_sent event after a multi-media reply succeeds", async () => {
    messageHookRunner.hasHooks.mockImplementation((name: string) => name === "message_sent");
    sendMock
      .mockResolvedValueOnce({ messageId: "media-1", channelId: "C123" })
      .mockResolvedValueOnce({ messageId: "media-2", channelId: "C123" });

    await deliverReplies(
      baseParams({
        replies: [
          {
            text: "two attachments",
            mediaUrls: ["https://example.com/one.png", "https://example.com/two.png"],
          },
        ],
      }),
    );

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(messageHookRunner.runMessageSent).toHaveBeenCalledTimes(1);
    const event = messageHookRunner.runMessageSent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event).toMatchObject({
      content: "two attachments",
      success: true,
    });
    expect(event).not.toHaveProperty("messageId");
  });

  it("reports spoken text for media-only TTS supplements", async () => {
    messageHookRunner.hasHooks.mockImplementation((name: string) => name === "message_sent");
    sendMock.mockResolvedValue({ messageId: "tts-1", channelId: "C123" });

    await deliverReplies(
      baseParams({
        replies: [
          {
            mediaUrl: "https://example.com/tts.mp3",
            spokenText: "Spoken answer",
            ttsSupplement: { spokenText: "Spoken answer" },
          },
        ],
      }),
    );

    expect(messageHookRunner.runMessageSent).toHaveBeenCalledOnce();
    const event = messageHookRunner.runMessageSent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event).toMatchObject({
      content: "Spoken answer",
      success: true,
    });
    expect(event).not.toHaveProperty("messageId");
  });

  it("reports spoken text for explicit media-only TTS replies", async () => {
    messageHookRunner.hasHooks.mockImplementation((name: string) => name === "message_sent");
    sendMock.mockResolvedValue({ messageId: "tts-2", channelId: "C123" });

    await deliverReplies(
      baseParams({
        replies: [
          {
            mediaUrl: "https://example.com/tts.mp3",
            audioAsVoice: true,
            spokenText: "  Explicit spoken answer  ",
          },
        ],
      }),
    );

    const event = messageHookRunner.runMessageSent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event).toMatchObject({
      content: "Explicit spoken answer",
      success: true,
    });
    expect(event).not.toHaveProperty("messageId");
  });

  it("keeps visible media captions ahead of hidden spoken text", async () => {
    messageHookRunner.hasHooks.mockImplementation((name: string) => name === "message_sent");
    sendMock.mockResolvedValue({ messageId: "tts-3", channelId: "C123" });

    await deliverReplies(
      baseParams({
        replies: [
          {
            text: "Visible caption",
            mediaUrl: "https://example.com/tts.mp3",
            audioAsVoice: true,
            spokenText: "Hidden spoken answer",
          },
        ],
      }),
    );

    const event = messageHookRunner.runMessageSent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event).toMatchObject({
      content: "Visible caption",
      success: true,
    });
    expect(event).not.toHaveProperty("messageId");
  });

  it("emits only failure when a later attachment in the payload fails", async () => {
    messageHookRunner.hasHooks.mockImplementation((name: string) => name === "message_sent");
    sendMock
      .mockResolvedValueOnce({ messageId: "media-1", channelId: "C123" })
      .mockRejectedValueOnce(new Error("second_upload_failed"));

    await expect(
      deliverReplies(
        baseParams({
          replies: [
            {
              text: "two attachments",
              mediaUrls: ["https://example.com/one.png", "https://example.com/two.png"],
            },
          ],
        }),
      ),
    ).rejects.toThrow(/second_upload_failed/);

    expect(messageHookRunner.runMessageSent).toHaveBeenCalledTimes(1);
    const event = messageHookRunner.runMessageSent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event).toMatchObject({
      content: "two attachments",
      success: false,
    });
  });

  it("does not emit the plugin hook when no listener observes message_sent", async () => {
    messageHookRunner.hasHooks.mockReturnValue(false);
    sendMock.mockResolvedValue({ messageId: "ts", channelId: "C123" });

    await deliverReplies(baseParams({ replies: [{ text: "quiet" }] }));

    expect(sendMock).toHaveBeenCalledOnce();
    expect(messageHookRunner.runMessageSent).not.toHaveBeenCalled();
  });

  it("fires the internal message:sent hook when a session key is supplied", async () => {
    messageHookRunner.hasHooks.mockReturnValue(false);
    sendMock.mockResolvedValue({ messageId: "ts", channelId: "C123" });

    await deliverReplies(
      baseParams({
        replies: [{ text: "internal" }],
        sessionKeyForInternalHooks: "slack:C123:U1",
      }),
    );

    expect(triggerInternalHook).toHaveBeenCalledOnce();
  });

  it("threads group context into the internal message:sent hook when isGroup is set", async () => {
    messageHookRunner.hasHooks.mockReturnValue(false);
    sendMock.mockResolvedValue({ messageId: "ts", channelId: "C123" });

    await deliverReplies(
      baseParams({
        replies: [{ text: "in a channel" }],
        sessionKeyForInternalHooks: "slack:C123:U1",
        isGroup: true,
        groupId: "C123",
      }),
    );

    expect(triggerInternalHook).toHaveBeenCalledOnce();
    const internalCalls = triggerInternalHook.mock.calls as unknown as Array<
      [{ context?: Record<string, unknown> }]
    >;
    expect(internalCalls[0]?.[0]?.context).toMatchObject({ isGroup: true, groupId: "C123" });
  });
});
