// Line tests cover typed rich-message boundaries.
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { linePlugin } from "./channel.js";
import { createActionCard } from "./flex-templates/basic-cards.js";
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
  it.each([undefined, { blocks: [] }])(
    "preserves a payload without renderable presentation: %j",
    async (presentation) => {
      const payload = {
        text: "",
        presentationTextMode: "fallback" as const,
        presentation,
        replyToId: "original-message",
        mediaUrl: "https://example.com/image.png",
        channelData: { line: { quickReplies: ["Continue"] } },
      };

      expect(await prepareLineReplyPayload(payload)).toEqual(payload);
    },
  );

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

  it("resolves a reply's presentation into LINE controls before delivery reads it", async () => {
    const prepared = await prepareLineReplyPayload({
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

  it.each([
    { name: "exact byte limit", character: "x", extraBytes: 0, fits: true },
    { name: "one byte over", character: "x", extraBytes: 1, fits: false },
    { name: "multibyte overflow", character: "界", extraBytes: 1, fits: false },
  ])(
    "preserves the answer and controls at the Flex $name",
    async ({ character, extraBytes, fits }) => {
      const title = "Size boundary";
      const action = {
        type: "postback",
        label: "Continue",
        data: "next",
        displayText: "Continue",
      } as const;
      const overhead =
        Buffer.byteLength(
          JSON.stringify(createActionCard(title, "x", [{ label: "Continue", action }])),
          "utf8",
        ) - 1;
      const text = character.repeat(
        Math.ceil((30_000 - overhead + extraBytes) / Buffer.byteLength(character, "utf8")),
      );
      const prepared = await prepareLineReplyPayload({
        text: "Full answer:",
        presentation: {
          title,
          blocks: [
            { type: "text", text },
            {
              type: "buttons",
              buttons: [{ label: "Continue", action: { type: "callback", value: "next" } }],
            },
          ],
        },
      });

      expect(prepared.presentation).toBeUndefined();
      if (fits) {
        const line = prepared.channelData?.line as { flexMessage: { contents: unknown } };
        expect(Buffer.byteLength(JSON.stringify(line.flexMessage.contents), "utf8")).toBe(30_000);
        expect(prepared.text).toBe("Full answer:");
      } else {
        expect(prepared.channelData?.line).toBeUndefined();
        expect(prepared.text).toContain("Full answer:");
        expect(prepared.text).toContain(text);
        expect(prepared.text).toContain("Continue");
      }
    },
  );

  it("keeps fallback text when only quick replies render", async () => {
    const prepared = await prepareLineReplyPayload({
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
    // A select alone renders no Flex body. The author's own prose says the same
    // thing the renderer would rebuild, so it stays exactly as written.
    expect(prepared.text).toBe("Agent needs input:\n1. Alpha");
    expect(line?.flexMessage).toBeUndefined();
    expect(line?.quickReplyItems).toHaveLength(1);
  });

  it.each([undefined, "", "   "])(
    "keeps the select prompt when fallback text is %j",
    async (text) => {
      const prepared = await prepareLineReplyPayload({
        text,
        presentationTextMode: "fallback",
        presentation: {
          title: "Choose a deployment",
          blocks: [
            {
              type: "select",
              placeholder: "Which environment should receive this deployment?",
              options: [{ label: "Staging", action: { type: "callback", value: "staging" } }],
            },
          ],
        },
      });

      expect(prepared.text).toBe(
        "Choose a deployment\n\nWhich environment should receive this deployment?",
      );
    },
  );

  it("preserves full select prompts and overflow labels while bounding native labels", async () => {
    const placeholder = "Which region should receive this deployment?";
    const options = Array.from({ length: 8 }, (_, index) => ({
      label: `Deployment region number ${index + 1}`,
      action: { type: "command" as const, command: `/region ${index + 1}` },
    }));
    const prepared = await prepareLineReplyPayload({
      presentation: {
        blocks: [
          { type: "select", placeholder: "Choose the first region", options },
          { type: "select", placeholder, options },
        ],
      },
    });
    const line = prepared.channelData?.line as {
      quickReplyItems: Parameters<typeof createLineQuickReply>[0];
    };

    expect(prepared.text).toBe(
      `Choose the first region\n\n${placeholder}:\n` +
        options
          .slice(5)
          .map((option) => `- ${option.label}: \`${option.action.command}\``)
          .join("\n"),
    );
    const native = createLineQuickReply(line.quickReplyItems);
    expect(native.items).toHaveLength(13);
    expect(native.items?.every((item) => (item.action?.label?.length ?? 0) <= 20)).toBe(true);
    expect(native.items?.at(-1)?.action).toMatchObject({ type: "message", text: "/region 5" });
  });

  it("keeps the words around quick replies when no Flex body carries them", async () => {
    const prepared = await prepareLineReplyPayload({
      text: "Here are the files.",
      presentation: {
        title: "Pick a file",
        blocks: [
          { type: "text", text: "Which file should I open?" },
          {
            type: "select",
            options: [{ label: "notes.md", action: { type: "callback", value: "notes" } }],
          },
        ],
      },
    });

    const line = prepared.channelData?.line as
      | { quickReplyItems?: unknown[]; flexMessage?: unknown }
      | undefined;
    expect(line?.flexMessage).toBeUndefined();
    expect(line?.quickReplyItems).toHaveLength(1);
    expect(prepared.text).toContain("Here are the files.");
    expect(prepared.text).toContain("Pick a file");
    expect(prepared.text).toContain("Which file should I open?");
    // The one option LINE draws natively must not also be listed as prose.
    expect(prepared.text).not.toContain("notes.md");
  });

  it("keeps the options that did not fit LINE's quick reply row", async () => {
    const options = Array.from({ length: 20 }, (_, index) => ({
      label: `Option ${index + 1}`,
      action: { type: "callback" as const, value: `opt-${index + 1}` },
    }));

    const prepared = await prepareLineReplyPayload({
      text: "Here are the files.",
      presentation: { blocks: [{ type: "select", options }] },
    });

    const line = prepared.channelData?.line as { quickReplyItems?: unknown[] } | undefined;
    // LINE accepts 13 quick replies; the rest have to reach the user as text.
    expect(line?.quickReplyItems).toHaveLength(13);
    for (const label of ["Option 14", "Option 20"]) {
      expect(prepared.text).toContain(label);
    }
    expect(prepared.text).not.toContain("Option 1\n");
  });

  it("keeps a select prompt's title when the title is all it carries", async () => {
    const prepared = await prepareLineReplyPayload({
      text: "Here are the files.",
      presentation: {
        title: "Pick a file",
        blocks: [
          {
            type: "select",
            options: [{ label: "notes.md", action: { type: "callback", value: "notes" } }],
          },
        ],
      },
    });

    expect(prepared.text).toBe("Here are the files.\n\nPick a file");
  });

  it("keeps that title on the outbound path, which delivers no fallback text of its own", async () => {
    // Core blanks the text before calling the renderer when the producer marked
    // it as the presentation's fallback, so the title is the only prose left.
    const rendered = await lineOutboundAdapter.renderPresentation?.({
      payload: { text: undefined },
      presentation: {
        title: "Pick a file",
        blocks: [
          {
            type: "select",
            options: [{ label: "notes.md", action: { type: "callback", value: "notes" } }],
          },
        ],
      },
    } as never);

    expect(rendered?.text).toBe("Pick a file");
    const line = rendered?.channelData?.line as { quickReplyItems?: unknown[] } | undefined;
    expect(line?.quickReplyItems).toHaveLength(1);
  });

  it("keeps a select's placeholder when every option became a chip", async () => {
    const presentation = {
      blocks: [
        {
          type: "select" as const,
          placeholder: "Pick a day",
          options: [
            { label: "Mon", action: { type: "callback" as const, value: "mon" } },
            { label: "Tue", action: { type: "callback" as const, value: "tue" } },
          ],
        },
      ],
    };

    const prepared = await prepareLineReplyPayload({ text: "Here you go.", presentation });

    // The placeholder is the prompt for those chips; the fallback renderer drops
    // a select with no options, so it cannot ride along inside the block.
    expect(prepared.text).toBe("Here you go.\n\nPick a day");
    const line = prepared.channelData?.line as { quickReplyItems?: unknown[] } | undefined;
    expect(line?.quickReplyItems).toHaveLength(2);
  });

  it("keeps that placeholder on the outbound path too", async () => {
    const rendered = await lineOutboundAdapter.renderPresentation?.({
      payload: { text: undefined },
      presentation: {
        blocks: [
          {
            type: "select",
            placeholder: "Pick a day",
            options: [{ label: "Mon", action: { type: "callback", value: "mon" } }],
          },
        ],
      },
    } as never);

    expect(rendered?.text).toBe("Pick a day");
  });

  it("keeps each select's own heading over its own leftovers", async () => {
    const block = (placeholder: string, prefix: string) => ({
      type: "select" as const,
      placeholder,
      options: Array.from({ length: 8 }, (_, index) => ({
        label: `${prefix}-${index + 1}`,
        action: { type: "callback" as const, value: `${prefix}-${index + 1}` },
      })),
    });

    const prepared = await prepareLineReplyPayload({
      text: "Choose.",
      presentation: { blocks: [block("Environment", "env"), block("Region", "region")] },
    });

    // The row fills in order, so the first select keeps only its prompt while the
    // second one's leftovers stay under the heading they belong to.
    expect(prepared.text).toBe(
      "Choose.\n\nEnvironment\n\nRegion:\n- region-6\n- region-7\n- region-8",
    );
  });

  it("keeps the options two select blocks push past LINE's one-message limit", async () => {
    const block = (prefix: string) => ({
      type: "select" as const,
      options: Array.from({ length: 8 }, (_, index) => ({
        label: `${prefix}-${index + 1}`,
        action: { type: "callback" as const, value: `${prefix}-${index + 1}` },
      })),
    });

    const prepared = await prepareLineReplyPayload({
      text: "Pick an environment and a region.",
      presentation: { blocks: [block("env"), block("region")] },
    });

    const line = prepared.channelData?.line as { quickReplyItems?: Array<{ label: string }> };
    // Each block fits on its own; together they exceed what one message carries.
    expect(line.quickReplyItems).toHaveLength(13);
    expect(line.quickReplyItems?.at(-1)?.label).toBe("region-5");
    for (const label of ["region-6", "region-7", "region-8"]) {
      expect(prepared.text).toContain(label);
    }
    // The thirteen LINE draws must not also be listed as prose.
    expect(prepared.text).not.toContain("env-1");
  });

  it("keeps the overflow options beside a Flex card without repeating the card", async () => {
    const block = (prefix: string) => ({
      type: "select" as const,
      options: Array.from({ length: 8 }, (_, index) => ({
        label: `${prefix}-${index + 1}`,
        action: { type: "callback" as const, value: `${prefix}-${index + 1}` },
      })),
    });

    const prepared = await prepareLineReplyPayload({
      text: "Choose a target.",
      presentation: {
        title: "Deploy",
        blocks: [
          { type: "text", text: "Staging is green." },
          {
            type: "buttons",
            buttons: [{ label: "Deploy", action: { type: "command", command: "/deploy" } }],
          },
          block("env"),
          block("region"),
        ],
      },
    });

    const line = prepared.channelData?.line as {
      flexMessage?: unknown;
      quickReplyItems?: unknown[];
    };
    expect(line.flexMessage).toBeDefined();
    expect(line.quickReplyItems).toHaveLength(13);
    expect(prepared.text).toContain("region-8");
    // The card already carries the title and the text block; the text must not repeat them.
    expect(prepared.text).not.toContain("Staging is green.");
    expect(prepared.text).not.toContain("Deploy");
  });

  it("keeps a table beside a select instead of dropping it", async () => {
    const prepared = await prepareLineReplyPayload({
      text: "Here is this week's usage.",
      presentation: {
        blocks: [
          { type: "table", caption: "Runs", headers: ["Day", "Runs"], rows: [["Mon", "12"]] },
          {
            type: "select",
            options: [{ label: "Mon", action: { type: "callback", value: "mon" } }],
          },
        ],
      },
    });

    expect(prepared.text).toContain("Here is this week's usage.");
    expect(prepared.text).toContain("Runs");
    expect(prepared.text).toContain("12");
  });

  it("replaces fallback text once a Flex body renders the same controls", async () => {
    const prepared = await prepareLineReplyPayload({
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

  it("keeps a presentation LINE has no native controls for in the visible text", async () => {
    const prepared = await prepareLineReplyPayload({
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
