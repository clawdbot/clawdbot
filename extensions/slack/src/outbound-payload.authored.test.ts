import { describe, expect, it } from "vitest";
import {
  postedSlackMessage,
  sendThroughRealSlack,
  valueButtons,
} from "./outbound-payload.test-helpers.js";

describe("Slack authored presentation delivery", () => {
  it.each([
    {
      name: "portable text",
      text: "Overview",
      presentation: { blocks: [{ type: "text" as const, text: "Overview" }] },
      blockTypes: ["section"],
      posts: 1,
      authoredSection: undefined,
    },
    {
      name: "equivalent rendered Markdown",
      text: "**Overview**",
      presentation: { blocks: [{ type: "text" as const, text: "*Overview*" }] },
      blockTypes: ["section"],
      posts: 1,
      authoredSection: undefined,
    },
    ...[false, true].flatMap((fallback) =>
      [true, false].map((escaped) => {
        const title = fallback
          ? "Overview with a title too long for Slack native chart rendering"
          : "Overview";
        return {
          name: `${fallback ? "literal fallback" : "native chart"}, escaped list: ${String(escaped)}`,
          text: `${title} (pie chart)\n${escaped ? "\\-" : "-"} Open: 5`,
          presentation: {
            blocks: [
              {
                type: "chart" as const,
                chartType: "pie" as const,
                title,
                segments: [{ label: "Open", value: 5 }],
              },
            ],
          },
          blockTypes: [
            ...(escaped ? [] : ["section"]),
            ...(fallback ? [] : ["data_visualization"]),
          ],
          posts: fallback && !escaped ? 2 : 1,
          authoredSection: escaped ? undefined : `${title} (pie chart)\n\n• Open: 5`,
        };
      }),
    ),
  ])(
    "preserves authored rendering beside $name",
    async ({ text, presentation, blockTypes, posts, authoredSection }) => {
      const { client } = await sendThroughRealSlack({
        payload: { text, presentation },
        renderText: text,
      });

      expect(client.chat.postMessage).toHaveBeenCalledTimes(posts);
      const messages = client.chat.postMessage.mock.calls.map((_, index) =>
        postedSlackMessage(client, index),
      );
      expect(
        messages
          .map((message) => message.text)
          .join("\n")
          .match(/Overview/gu),
      ).toHaveLength(authoredSection ? 2 : 1);
      const blocks = messages.flatMap((message) => message.blocks ?? []);
      expect(blocks.map((block) => block.type)).toEqual(blockTypes);
      if (authoredSection) {
        expect(blocks.find((block) => block.type === "section")?.text?.text).toBe(authoredSection);
      }
      const chart = presentation.blocks[0];
      if (chart?.type === "chart") {
        if (blockTypes.includes("data_visualization")) {
          expect(blocks.at(-1)).toEqual({
            type: "data_visualization",
            title: chart.title,
            chart: { type: "pie", segments: [{ label: "Open", value: 5 }] },
          });
        } else {
          expect(messages.at(-1)).toMatchObject({
            text: `${chart.title} (pie chart)\n- Open: 5`,
            mrkdwn: false,
          });
        }
      }
    },
  );

  it("recognizes rendered authored Markdown split across native sections", async () => {
    const text = "**First** Second";
    const { client } = await sendThroughRealSlack({
      payload: {
        text,
        channelData: {
          slack: {
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: "*First*" } },
              { type: "section", text: { type: "mrkdwn", text: "Second" } },
            ],
          },
        },
      },
      renderText: text,
    });
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(postedSlackMessage(client, 0).blocks?.map((block) => block.text?.text)).toEqual([
      "*First*",
      "Second",
    ]);
  });

  it.each(
    ["*", "**"].flatMap((marker) =>
      [
        [
          {
            name: `literal fallback (${marker})`,
            payload: {
              text: `**${"x".repeat(151)}**`,
              presentation: { title: `${marker}${"x".repeat(151)}${marker}`, blocks: [] },
            },
            authoredSection: `*${"x".repeat(151)}*`,
            posts: 2,
          },
          {
            name: `plain_text header (${marker})`,
            payload: {
              text: "**Overview**",
              presentation: { title: `${marker}Overview${marker}`, blocks: [] },
            },
            authoredSection: "*Overview*",
            posts: 1,
          },
        ],
        ["section", "context"].map((type) => ({
          name: `plain_text ${type} (${marker})`,
          payload: {
            text: "**Overview**",
            channelData: {
              slack: {
                blocks: [
                  type === "section"
                    ? { type, text: { type: "plain_text", text: `${marker}Overview${marker}` } }
                    : {
                        type,
                        elements: [{ type: "plain_text", text: `${marker}Overview${marker}` }],
                      },
                ],
              },
            },
          },
          authoredSection: "*Overview*",
          posts: 1,
        })),
        [false, true].map((represented) => ({
          name: `mixed context with mrkdwn: ${String(represented)} (${marker})`,
          payload: {
            text: "Ready **Overview**",
            channelData: {
              slack: {
                blocks: [
                  {
                    type: "context",
                    elements: [
                      { type: "plain_text", text: "Ready" },
                      {
                        type: represented ? "mrkdwn" : "plain_text",
                        text: `${marker}Overview${marker}`,
                      },
                    ],
                  },
                ],
              },
            },
          },
          authoredSection: represented && marker === "*" ? undefined : "Ready *Overview*",
          posts: 1,
        })),
      ].flat(),
    ),
  )("preserves authored formatting beside $name", async ({ payload, authoredSection, posts }) => {
    const { client } = await sendThroughRealSlack({ payload, renderText: payload.text });
    expect(client.chat.postMessage).toHaveBeenCalledTimes(posts);
    const sections = client.chat.postMessage.mock.calls.flatMap((_, index) =>
      (postedSlackMessage(client, index).blocks ?? [])
        .filter((block) => block.type === "section" && block.text?.type === "mrkdwn")
        .map((block) => block.text?.text),
    );
    expect(sections).toEqual(authoredSection ? [authoredSection] : []);
  });

  it("recognizes whitespace at actual portable chunk boundaries", async () => {
    const text = "a ".repeat(100) + "x".repeat(5_799) + " z";
    const { client } = await sendThroughRealSlack({
      payload: { text, presentation: { blocks: [{ type: "text", text }] } },
      renderText: text,
    });
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    const sections = postedSlackMessage(client, 0).blocks?.map((block) => block.text?.text);
    expect(sections).toHaveLength(3);
    expect(sections?.join("")).toBe(text);
  });

  it.each(
    [
      { name: "bold", authoredMarker: "**", marker: "*" },
      { name: "italic", authoredMarker: "*", marker: "_" },
      { name: "strike", authoredMarker: "~~", marker: "~" },
    ].flatMap((style) => (["text", "context"] as const).map((type) => ({ style, type }))),
  )(
    "preserves long $style.name in portable $type chunks",
    async ({ style: { authoredMarker, marker }, type }) => {
      const content = "x".repeat(3_001);
      const text = `${authoredMarker}${content}${authoredMarker}`;
      const { client } = await sendThroughRealSlack({
        payload: {
          text,
          presentation: { blocks: [{ type, text: `${marker}${content}${marker}` }] },
        },
        renderText: text,
      });
      expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
      const blocks = postedSlackMessage(client, 0).blocks ?? [];
      const fragments = blocks.flatMap((block) =>
        block.type === "context"
          ? (block.elements?.map((element) => element.text) ?? [])
          : [block.text?.text],
      );
      expect(fragments).toHaveLength(2);
      for (const fragment of fragments) {
        expect(fragment?.startsWith(marker)).toBe(true);
        expect(fragment?.endsWith(marker)).toBe(true);
        expect(fragment?.length).toBeLessThanOrEqual(3_000);
      }
      expect(
        fragments.map((fragment) => fragment?.slice(marker.length, -marker.length)).join(""),
      ).toBe(content);
    },
  );

  it.each([
    { style: "bold", authored: "**Overview**" },
    { style: "italic", authored: "*Overview*" },
    { style: "strike", authored: "~~Overview~~" },
    { style: "code", authored: "`Overview`" },
  ])(
    "recognizes native rich-text $style without duplicating authored text",
    async ({ style, authored }) => {
      const block = {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [{ type: "text", text: "Overview", style: { [style]: true } }],
          },
        ],
      };
      const { client } = await sendThroughRealSlack({
        payload: { text: authored, channelData: { slack: { blocks: [block] } } },
        renderText: authored,
      });
      expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
      expect(postedSlackMessage(client, 0).blocks).toEqual([block]);
    },
  );

  it.each(["*", "_"])("preserves literal native %s markers at chunk boundaries", async (marker) => {
    const text = `prefix${marker}${"x".repeat(3_001)}${marker}suffix`;
    const { client } = await sendThroughRealSlack({
      payload: { presentation: { blocks: [{ type: "text", text }] } },
    });
    const fragments = postedSlackMessage(client, 0).blocks?.map((block) => block.text?.text);
    expect(fragments?.join("")).toBe(text);
  });

  it("preserves a valid long span after a literal delimiter", async () => {
    const prefix = "cost * 2 ";
    const content = "x".repeat(3_001);
    const { client } = await sendThroughRealSlack({
      payload: { presentation: { blocks: [{ type: "text", text: `${prefix}*${content}*` }] } },
    });
    const fragments = postedSlackMessage(client, 0).blocks?.map((block) => block.text?.text) ?? [];
    expect(fragments).toHaveLength(2);
    expect(fragments[0]?.startsWith(prefix)).toBe(true);
    const styled = [fragments[0]?.slice(prefix.length), fragments[1]];
    for (const fragment of styled) {
      expect(fragment?.startsWith("*")).toBe(true);
      expect(fragment?.endsWith("*")).toBe(true);
    }
    expect(styled.map((fragment) => fragment?.slice(1, -1)).join("")).toBe(content);
  });

  it.each([
    {
      name: "code link",
      authored: "`<https://example.com|Overview>`",
      elements: [
        { type: "link", text: "Overview", url: "https://example.com", style: { code: true } },
      ],
    },
    {
      name: "code reference",
      authored: "`<@U123>`",
      elements: [{ type: "user", user_id: "U123", style: { code: true } }],
    },
    {
      name: "color",
      authored: "First Second",
      elements: [
        { type: "text", text: "First " },
        { type: "color", value: "#00ff00" },
        { type: "text", text: "Second" },
      ],
    },
    {
      name: "team",
      authored: "First Second",
      elements: [
        { type: "text", text: "First " },
        { type: "team", team_id: "T123" },
        { type: "text", text: "Second" },
      ],
    },
    {
      name: "date",
      authored: "First fallbackSecond",
      elements: [
        { type: "text", text: "First " },
        { type: "date", timestamp: 1725019200, format: "{date_long}", fallback: "fallback" },
        { type: "text", text: "Second" },
      ],
    },
    {
      name: "inline code delimiter",
      authored: "`a`b`",
      elements: [{ type: "text", text: "a`b", style: { code: true } }],
    },
    {
      name: "fenced code delimiter",
      authored: "```\na```b\n```",
      type: "rich_text_preformatted",
      elements: [{ type: "text", text: "a```b\n" }],
    },
  ])("retains authored text beside opaque native $name", async ({ authored, elements, type }) => {
    const block = {
      type: "rich_text",
      elements: [{ type: type ?? "rich_text_section", elements }],
    };
    const { client } = await sendThroughRealSlack({
      payload: { text: authored, channelData: { slack: { blocks: [block] } } },
      renderText: authored,
    });
    expect(postedSlackMessage(client, 0).blocks).toEqual([
      block,
      { type: "section", text: { type: "mrkdwn", text: authored, verbatim: true } },
    ]);
  });

  it.each([
    ...[{}, { unicode: "1f44b-1f3ff" }, { url: "https://emoji.example.com/wave.gif" }].map(
      (metadata, index) => ({
        name: `emoji metadata ${index}`,
        authored: ":wave:",
        rendered: index > 0 ? ":wave:" : undefined,
        elements: [
          { type: "rich_text_section", elements: [{ type: "emoji", name: "wave", ...metadata }] },
        ],
      }),
    ),
    ...[
      { style: "bold", marker: "*" },
      { style: "italic", marker: "_" },
      { style: "strike", marker: "~" },
    ].map(({ style, marker }) => ({
      name: `whitespace-bounded ${style}`,
      authored: `\\${marker} Overview \\${marker}`,
      rendered: `${marker} Overview ${marker}`,
      elements: [
        {
          type: "rich_text_section",
          elements: [{ type: "text", text: " Overview ", style: { [style]: true } }],
        },
      ],
    })),
    {
      name: "nested intraword styles",
      authored: "\\*A\\_B\\_\\*",
      rendered: "*A_B_*",
      elements: [
        {
          type: "rich_text_section",
          elements: [
            { type: "text", text: "A", style: { bold: true } },
            { type: "text", text: "B", style: { bold: true, italic: true } },
          ],
        },
      ],
    },
    {
      name: "crossing style ranges",
      authored: "\\*A\\_BC\\_",
      rendered: "*A_BC_",
      elements: [
        {
          type: "rich_text_section",
          elements: [
            { type: "text", text: "A", style: { bold: true } },
            { type: "text", text: "B", style: { bold: true, italic: true } },
            { type: "text", text: "C", style: { italic: true } },
          ],
        },
      ],
    },
    {
      name: "link label whitespace",
      authored: "First[Second](https://example.com)",
      rendered: "First<https://example.com|Second>",
      elements: [
        {
          type: "rich_text_section",
          elements: [
            { type: "text", text: "First" },
            { type: "link", text: " Second", url: "https://example.com" },
          ],
        },
      ],
    },
    {
      name: "adjacent bold leaves",
      authored: "**Overview**",
      elements: [
        {
          type: "rich_text_section",
          elements: [
            { type: "text", text: "Over", style: { bold: true } },
            { type: "text", text: "view", style: { bold: true } },
          ],
        },
      ],
    },
    {
      name: "mixed section styles",
      authored: "See **Overview**",
      elements: [
        {
          type: "rich_text_section",
          elements: [
            { type: "text", text: "See " },
            { type: "text", text: "Overview", style: { bold: true } },
          ],
        },
      ],
    },
    {
      name: "combined styles",
      authored: "***Overview***",
      elements: [
        {
          type: "rich_text_section",
          elements: [{ type: "text", text: "Overview", style: { bold: true, italic: true } }],
        },
      ],
    },
    {
      name: "matching link",
      authored: "[Overview](https://example.com)",
      elements: [
        {
          type: "rich_text_section",
          elements: [{ type: "link", text: "Overview", url: "https://example.com" }],
        },
      ],
    },
    {
      name: "different link",
      authored: "[Overview](https://other.example.com)",
      rendered: "<https://other.example.com|Overview>",
      elements: [
        {
          type: "rich_text_section",
          elements: [{ type: "link", text: "Overview", url: "https://example.com" }],
        },
      ],
    },
    {
      name: "literal markers",
      authored: "**Overview**",
      rendered: "*Overview*",
      elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "*Overview*" }] }],
    },
    {
      name: "opaque style barrier",
      authored: "First Second",
      rendered: "First Second",
      elements: [
        { type: "rich_text_section", elements: [{ type: "text", text: "First" }] },
        {
          type: "rich_text_section",
          elements: [{ type: "text", text: "hidden", style: { underline: true } }],
        },
        { type: "rich_text_section", elements: [{ type: "text", text: "Second" }] },
      ],
    },
    {
      name: "preformatted whitespace",
      authored: "```\na  b\n```",
      elements: [{ type: "rich_text_preformatted", elements: [{ type: "text", text: "a  b\n" }] }],
    },
    {
      name: "native quote layout",
      authored: "First",
      rendered: "First",
      elements: [{ type: "rich_text_quote", elements: [{ type: "text", text: "First" }] }],
    },
  ])("preserves structured rich-text $name", async ({ authored, rendered, elements }) => {
    const block = { type: "rich_text", elements };
    const { client } = await sendThroughRealSlack({
      payload: { text: authored, channelData: { slack: { blocks: [block] } } },
      renderText: authored,
    });
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(postedSlackMessage(client, 0).blocks).toEqual([
      block,
      ...(rendered
        ? [{ type: "section", text: { type: "mrkdwn", text: rendered, verbatim: true } }]
        : []),
    ]);
  });

  it.each(["x".repeat(2_997) + " *y*", "*" + "x".repeat(2_997) + " y*"])(
    "preserves valid native emphasis at a full chunk boundary %#",
    async (text) => {
      const { client } = await sendThroughRealSlack({
        payload: { presentation: { blocks: [{ type: "text", text }] } },
      });
      const fragments =
        postedSlackMessage(client, 0).blocks?.map((block) => block.text?.text ?? "") ?? [];
      expect(fragments.map((fragment) => fragment.replaceAll("*", "")).join("")).toBe(
        text.replaceAll("*", ""),
      );
      for (const fragment of fragments) {
        expect(fragment.length).toBeLessThanOrEqual(3_000);
        expect(fragment).not.toContain("**");
        for (const span of fragment.matchAll(/\*([^*]*)\*/gu)) {
          expect(span[1]?.trim()).toBe(span[1]);
        }
      }
    },
  );

  it.each([
    {
      name: "inline code",
      authored: "`printf 'a  b'`",
      rendered: "`printf 'a  b'`",
      fragments: ["`printf 'a", "b'`"],
    },
    {
      name: "fenced code",
      authored: "```\nprintf 'a  b'\n```",
      rendered: "```\nprintf 'a  b'\n```",
      fragments: ["```\nprintf 'a", "b'\n```"],
    },
    {
      name: "bold",
      authored: "**First Second**",
      rendered: "*First Second*",
      fragments: ["*First", "Second*"],
    },
    {
      name: "italic",
      authored: "*First Second*",
      rendered: "_First Second_",
      fragments: ["_First", "Second_"],
    },
    {
      name: "strikethrough",
      authored: "~~First Second~~",
      rendered: "~First Second~",
      fragments: ["~First", "Second~"],
    },
    {
      name: "link",
      authored: "[First Second](https://example.com)",
      rendered: "<https://example.com|First Second>",
      fragments: ["<https://example.com|First", "Second>"],
    },
    {
      name: "closed code",
      authored: "`code` Next",
      rendered: undefined,
      fragments: ["`code`", "Next"],
    },
    {
      name: "unmatched literal",
      authored: "cost * 2 Next",
      rendered: undefined,
      fragments: ["cost * 2", "Next"],
    },
  ])("respects native field boundaries for $name", async ({ authored, rendered, fragments }) => {
    const { client } = await sendThroughRealSlack({
      payload: {
        text: authored,
        presentation: { blocks: fragments.map((text) => ({ type: "text", text })) },
      },
      renderText: authored,
    });
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(postedSlackMessage(client, 0).blocks?.map((block) => block.text?.text)).toEqual([
      ...(rendered ? [rendered] : []),
      ...fragments,
    ]);
  });

  it.each([
    {
      name: "context bold",
      type: "context",
      authored: "**First Second**",
      rendered: "*First Second*",
      fragments: ["*First", "Second*"],
    },
    {
      name: "context code",
      type: "context",
      authored: "`a b`",
      rendered: "`a b`",
      fragments: ["`a", "b`"],
    },
    {
      name: "section code",
      type: "section",
      authored: "```\na\nb\n```",
      rendered: "```\na\nb\n```",
      fragments: ["```\na", "b\n```"],
    },
    {
      name: "section bold",
      type: "section",
      authored: "**First\nSecond**",
      rendered: "*First\nSecond*",
      fragments: ["*First", "Second*"],
    },
    {
      name: "complete context formatting",
      type: "context",
      authored: "**First** Second",
      rendered: undefined,
      fragments: ["*First*", "Second"],
    },
    {
      name: "complete section code",
      type: "section",
      authored: "`a`\nb",
      rendered: undefined,
      fragments: ["`a`", "b"],
    },
  ])(
    "preserves text-object boundaries inside $name",
    async ({ type, authored, rendered, fragments }) => {
      const objects = fragments.map((text) => ({ type: "mrkdwn", text }));
      const block = type === "context" ? { type, elements: objects } : { type, fields: objects };
      const { client } = await sendThroughRealSlack({
        payload: { text: authored, channelData: { slack: { blocks: [block] } } },
        renderText: authored,
      });
      expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
      expect(postedSlackMessage(client, 0).blocks).toEqual([
        block,
        ...(rendered
          ? [{ type: "section", text: { type: "mrkdwn", text: rendered, verbatim: true } }]
          : []),
      ]);
    },
  );

  it.each(["inline", "fenced"])("preserves distinct authored %s code whitespace", async (kind) => {
    const wrap = (text: string) => (kind === "inline" ? `\`${text}\`` : `\`\`\`\n${text}\n\`\`\``);
    const authored = wrap("printf 'a  b'");
    const presented = wrap("printf 'a b'");
    const { client } = await sendThroughRealSlack({
      payload: { text: authored, presentation: { blocks: [{ type: "text", text: presented }] } },
      renderText: authored,
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(postedSlackMessage(client, 0).blocks?.map((block) => block.text?.text)).toEqual([
      authored,
      presented,
    ]);
  });

  it("sends authored text represented by adjacent fallbacks once", async () => {
    const title = "x".repeat(151);
    const { client } = await sendThroughRealSlack({
      payload: {
        text: title,
        presentation: {
          title,
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Status", action: { type: "command", command: "/status" } }],
            },
          ],
        },
      },
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(postedSlackMessage(client, 0)).toMatchObject({
      text: `${title}\n\n- Status: \`/status\``,
      mrkdwn: false,
    });
    expect(postedSlackMessage(client, 0).blocks).toBeUndefined();
  });

  it("packs represented authored text once at the native block limit", async () => {
    const { client } = await sendThroughRealSlack({
      payload: {
        text: "Overview",
        channelData: { slack: { blocks: Array.from({ length: 49 }, () => ({ type: "divider" })) } },
        presentation: {
          blocks: [{ type: "text", text: "Overview" }, valueButtons("Refresh", "refresh")],
        },
      },
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(postedSlackMessage(client, 0).blocks).toHaveLength(50);
    expect(postedSlackMessage(client, 1).blocks?.map((block) => block.type)).toEqual(["actions"]);
    const text = client.chat.postMessage.mock.calls
      .map((_, index) => postedSlackMessage(client, index).text ?? "")
      .join("\n");
    expect(text.match(/Overview/gu)).toHaveLength(1);
  });
});
