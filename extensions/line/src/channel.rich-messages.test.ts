// Line tests cover typed rich-message boundaries.
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { linePlugin } from "./channel.js";
import { lineOutboundAdapter } from "./outbound.js";
import { createLineQuickReply, lineMessageActions, renderLineCard } from "./rich-messages.js";

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
    const cards = [
      { type: "media_player", title: "Song" },
      { type: "event", title: "Meeting", date: "Monday" },
      { type: "agenda", title: "Today", events: [{ title: "Standup" }] },
      { type: "device", name: "TV" },
      { type: "appletv_remote" },
    ] as const;

    for (const card of cards) {
      expect(renderLineCard(card).contents).toMatchObject({ type: "bubble" });
    }
  });
});
