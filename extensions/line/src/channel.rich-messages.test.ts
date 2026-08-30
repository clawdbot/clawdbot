// Line tests cover typed rich-message boundaries.
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { linePlugin } from "./channel.js";
import { lineOutboundAdapter } from "./outbound.js";
import {
  createLineQuickReply,
  lineMessageActions,
  prepareLineReplyPayload,
  renderLineCard,
} from "./rich-messages.js";
import type { LineRichCard } from "./types.js";

function resolveChannelDataSchema() {
  const discovery = lineMessageActions.describeMessageTool({
    cfg: {
      channels: {
        line: {
          enabled: true,
          channelAccessToken: "token",
          channelSecret: "secret",
        },
      },
    },
  } as never);
  const contribution = Array.isArray(discovery?.schema) ? discovery.schema[0] : discovery?.schema;
  const schema = contribution?.properties.channelData;
  if (!schema) {
    throw new Error("expected LINE channelData schema");
  }
  return schema;
}

describe("LINE rich-message boundaries", () => {
  it("leaves legacy marker text unchanged", () => {
    const payload = { text: "Choose: [[buttons: Menu | Pick one | A:a, B:b]]" };

    const result = linePlugin.messaging?.transformReplyPayload?.({ payload } as never) ?? payload;

    expect(result).toEqual(payload);
  });

  it("maps portable buttons and options to Flex actions and quick replies", async () => {
    const result = await lineOutboundAdapter.renderPresentation?.({
      payload: { text: "Choose one" },
      presentation: {
        title: "Menu",
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Status", action: { type: "command", command: "/status" } },
              { label: "Site", action: { type: "url", url: "https://example.com" } },
            ],
          },
          {
            type: "select",
            placeholder: "Pick one",
            options: [
              { label: "Alpha", action: { type: "callback", value: "alpha" } },
              { label: "Help", action: { type: "command", command: "/help" } },
            ],
          },
        ],
      },
      ctx: {} as never,
    });

    const line = result?.channelData?.line as {
      flexMessage?: { contents?: { footer?: { contents?: Array<{ action?: unknown }> } } };
      quickReplyItems?: unknown[];
    };
    expect(line.flexMessage?.contents?.footer?.contents).toMatchObject([
      { action: { type: "message", text: "/status" } },
      { action: { type: "uri", uri: "https://example.com" } },
    ]);
    expect(createLineQuickReply(line.quickReplyItems as never)).toMatchObject({
      items: [
        { action: { type: "postback", data: "alpha" } },
        { action: { type: "message", text: "/help" } },
      ],
    });
  });

  it("resolves a reply's presentation into LINE controls before delivery reads it", () => {
    const prepared = prepareLineReplyPayload({
      text: "Approve this run?",
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Approve", action: { type: "callback", value: "approve" } }],
          },
          {
            type: "select",
            options: [{ label: "Deny", action: { type: "callback", value: "deny" } }],
          },
        ],
      },
    });

    expect(prepared.presentation).toBeUndefined();
    expect(prepared.text).toBe("Approve this run?");
    const line = prepared.channelData?.line as {
      flexMessage?: { contents?: { footer?: { contents?: Array<{ action?: unknown }> } } };
      quickReplyItems?: unknown[];
    };
    expect(line.flexMessage?.contents?.footer?.contents).toMatchObject([
      { action: { type: "postback", data: "approve" } },
    ]);
    expect(createLineQuickReply(line.quickReplyItems as never)).toMatchObject({
      items: [{ action: { type: "postback", data: "deny" } }],
    });
  });

  it("turns an ask_user question into tappable LINE options", () => {
    const prepared = prepareLineReplyPayload({
      text: "Agent needs input:\n\nWhich environment?\n1. Staging\n2. Production",
      presentationTextMode: "fallback",
      channelData: {
        askUser: {
          questionId: "ask_3d8dbe55be452a9a39add7c909beb119",
          optionValues: ["Staging", "Production"],
        },
      },
      presentation: {
        blocks: [
          { type: "text", text: "Which environment?" },
          {
            type: "buttons",
            buttons: [
              {
                label: "Staging",
                action: {
                  type: "question",
                  questionId: "ask_3d8dbe55be452a9a39add7c909beb119",
                  optionValue: "Staging",
                },
              },
              {
                label: "Production",
                action: {
                  type: "question",
                  questionId: "ask_3d8dbe55be452a9a39add7c909beb119",
                  optionValue: "Production",
                },
              },
            ],
          },
        ],
      },
    });

    const line = prepared.channelData?.line as {
      flexMessage?: {
        contents?: { footer?: { contents?: Array<{ action?: { data?: string } }> } };
      };
    };
    // The Gateway owns option order, so the tap carries an index, never the label.
    expect(
      line.flexMessage?.contents?.footer?.contents?.map((button) => button.action?.data),
    ).toEqual([
      "line.question=ask_3d8dbe55be452a9a39add7c909beb119&line.option=0",
      "line.question=ask_3d8dbe55be452a9a39add7c909beb119&line.option=1",
    ]);
  });

  it("keeps fallback text when only quick replies render", () => {
    const prepared = prepareLineReplyPayload({
      text: "Agent needs input:\n1. Alpha",
      presentationTextMode: "fallback",
      presentation: {
        blocks: [
          {
            type: "select",
            options: [{ label: "Alpha", action: { type: "callback", value: "alpha" } }],
          },
        ],
      },
    });

    const line = prepared.channelData?.line as
      | { quickReplyItems?: unknown[]; flexMessage?: unknown }
      | undefined;
    // A select alone renders no Flex body, so the prose is still the only thing
    // carrying the question. Clearing it delivers bare option labels.
    expect(prepared.text).toBe("Agent needs input:\n1. Alpha");
    expect(line?.flexMessage).toBeUndefined();
    expect(line?.quickReplyItems).toHaveLength(1);
  });

  it("replaces fallback text once a Flex body renders the same controls", () => {
    const prepared = prepareLineReplyPayload({
      text: "Agent needs input:\n1. Approve",
      presentationTextMode: "fallback",
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Approve", action: { type: "callback", value: "approve" } }],
          },
        ],
      },
    });

    const line = prepared.channelData?.line as { flexMessage?: unknown } | undefined;
    expect(line?.flexMessage).toBeDefined();
    expect(prepared.text).toBeUndefined();
  });

  it("keeps a presentation LINE has no native controls for in the visible text", () => {
    const prepared = prepareLineReplyPayload({
      text: "Here are today's runs",
      presentation: {
        blocks: [
          // Nothing here maps to a Flex action or a quick reply.
          { type: "table", caption: "Runs", headers: ["Agent"], rows: [["main"]] },
        ],
      },
    });

    expect(prepared.channelData?.line).toBeUndefined();
    expect(prepared.presentation).toBeUndefined();
    expect(prepared.text).toContain("Here are today's runs");
    expect(prepared.text).toContain("main");
  });

  it.each([
    {
      kind: "command",
      action: { type: "command", command: "/status" },
      expected: { type: "message", text: "/status" },
    },
    {
      kind: "callback",
      action: { type: "callback", value: "action=status" },
      expected: { type: "postback", data: "action=status" },
    },
    {
      kind: "url",
      action: { type: "url", url: "https://example.com/status" },
      expected: { type: "uri", uri: "https://example.com/status" },
    },
    {
      kind: "web-app",
      action: { type: "web-app", url: "https://example.com/app" },
      expected: { type: "uri", uri: "https://example.com/app" },
    },
  ] as const)(
    "preserves 40-character Flex $kind labels while quick replies stay bounded",
    async ({ action, expected }) => {
      const label = "x".repeat(40);
      const result = await lineOutboundAdapter.renderPresentation?.({
        payload: { text: "Choose one" },
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                { label, action },
                { label: `${label}y`, action },
              ],
            },
            {
              type: "select",
              options: [{ label, action: { type: "callback", value: "quick" } }],
            },
          ],
        },
        ctx: {} as never,
      });
      const line = result?.channelData?.line as {
        flexMessage: { contents: { footer: { contents: Array<{ action: { label: string } }> } } };
        quickReplyItems: unknown[];
      };

      expect(line.flexMessage.contents.footer.contents).toMatchObject([
        { action: { ...expected, label } },
        { action: { ...expected, label } },
      ]);
      expect(createLineQuickReply(line.quickReplyItems as never)).toMatchObject({
        items: [{ action: { type: "postback", data: "quick", label: "x".repeat(20) } }],
      });
    },
  );

  it("validates every typed LINE-specific rich-message shape", () => {
    const schema = resolveChannelDataSchema();
    const valid = [
      {
        line: {
          location: { title: "Office", address: "1 Main St", latitude: 35.6, longitude: 139.7 },
        },
      },
      { line: { card: { type: "media_player", title: "Song", status: "playing" } } },
      { line: { card: { type: "event", title: "Meeting", date: "Monday" } } },
      {
        line: {
          card: { type: "agenda", title: "Today", events: [{ title: "Standup", time: "9:00" }] },
        },
      },
      {
        line: {
          card: {
            type: "device",
            name: "TV",
            controls: [{ label: "Play", action: "play" }],
          },
        },
      },
      { line: { card: { type: "appletv_remote", name: "Living Room" } } },
    ];

    for (const channelData of valid) {
      expect(Value.Check(schema, channelData), JSON.stringify(channelData)).toBe(true);
    }
    expect(
      Value.Check(schema, { line: { location: { title: "Bad", address: "X", latitude: 91 } } }),
    ).toBe(false);
    expect(Value.Check(schema, { line: { card: { type: "event", title: "Missing date" } } })).toBe(
      false,
    );
    expect(Value.Check(schema, { line: { flexMessage: { altText: "raw", contents: {} } } })).toBe(
      false,
    );
  });

  it("renders each typed card through its existing LINE Flex path", () => {
    const cards: LineRichCard[] = [
      { type: "media_player", title: "Song" },
      { type: "event", title: "Meeting", date: "Monday" },
      { type: "agenda", title: "Today", events: [{ title: "Standup" }] },
      { type: "device", name: "TV" },
      { type: "appletv_remote" },
    ];

    for (const card of cards) {
      expect(renderLineCard(card).contents).toMatchObject({ type: "bubble" });
    }
  });
});
