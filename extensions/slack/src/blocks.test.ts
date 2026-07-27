// Slack tests cover blocks plugin behavior.
import { describe, expect, it } from "vitest";
import { buildSlackBlocksFallbackText, renderSlackBlockFallbackText } from "./blocks-fallback.js";
import { parseSlackBlocksInput } from "./blocks-input.js";
import { parseSlackModalPrivateMetadata } from "./modal-metadata.js";

describe("buildSlackBlocksFallbackText", () => {
  it("prefers header text", () => {
    expect(
      buildSlackBlocksFallbackText([
        { type: "header", text: { type: "plain_text", text: "Deploy status" } },
      ] as never),
    ).toBe("Deploy status");
  });

  it("uses image alt text", () => {
    expect(
      buildSlackBlocksFallbackText([
        { type: "image", image_url: "https://example.com/image.png", alt_text: "Latency chart" },
      ] as never),
    ).toBe("Latency chart");
  });

  it("uses complete data visualization text", () => {
    expect(
      buildSlackBlocksFallbackText([
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
      ] as never),
    ).toBe("Revenue mix (pie chart)\n- Product: 60\n- Services: 40");
  });

  it("uses complete data table text", () => {
    expect(
      buildSlackBlocksFallbackText([
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
              { type: "raw_number", value: 125000, text: "125000" },
            ],
          ],
        },
      ] as never),
    ).toBe("Pipeline report (table)\n- Account: Acme; ARR: 125000");
  });

  it("uses only visible action labels and select placeholders", () => {
    const fallback = buildSlackBlocksFallbackText([
      {
        type: "actions",
        block_id: "private-block-id",
        elements: [
          {
            type: "button",
            action_id: "private-action-id",
            text: { type: "plain_text", text: "Approve" },
            value: "private-button-value",
          },
          {
            type: "static_select",
            action_id: "private-select-id",
            placeholder: { type: "plain_text", text: "Choose owner" },
            options: [
              { text: { type: "plain_text", text: "Secret option" }, value: "private-option" },
            ],
          },
        ],
      },
    ] as never);

    expect(fallback).toBe("Approve\nChoose owner");
    expect(fallback).not.toMatch(/private|Secret option/u);
  });

  it("renders section text and fields together", () => {
    expect(
      renderSlackBlockFallbackText({
        type: "section",
        text: { type: "mrkdwn", text: "Deploy status" },
        fields: [
          { type: "mrkdwn", text: "*Region*\nus-east-1" },
          { type: "plain_text", text: "Healthy" },
        ],
      }),
    ).toBe("Deploy status\n*Region*\nus-east-1\nHealthy");
  });

  it("includes section accessory labels without hidden values", () => {
    expect(
      renderSlackBlockFallbackText({
        type: "section",
        text: { type: "mrkdwn", text: "Deploy status" },
        accessory: {
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          value: "secret-approval-token",
        },
      }),
    ).toBe("Deploy status\nApprove");
  });

  it("renders rich text and context without hidden metadata", () => {
    const richText = renderSlackBlockFallbackText({
      type: "rich_text",
      block_id: "private-block-id",
      elements: [
        {
          type: "rich_text_section",
          elements: [
            { type: "text", text: "Ask " },
            { type: "user", user_id: "U123" },
            { type: "text", text: " <!channel> in " },
            { type: "channel", channel_id: "C123" },
            { type: "text", text: " " },
            { type: "emoji", name: "wave" },
          ],
        },
        {
          type: "rich_text_list",
          elements: [
            { type: "rich_text_section", elements: [{ type: "text", text: "First" }] },
            {
              type: "rich_text_section",
              elements: [
                {
                  type: "link",
                  url: "https://example.com/private-target",
                  text: "Second",
                },
              ],
            },
          ],
        },
      ],
    });
    const context = renderSlackBlockFallbackText({
      type: "context",
      elements: [
        { type: "mrkdwn", text: "Updated now" },
        { type: "image", alt_text: "Green status", image_url: "https://example.com/secret" },
      ],
    });

    expect(richText).toBe(
      "Ask &lt;@U123&gt; &lt;!channel&gt; in &lt;#C123&gt; :wave:\nFirst\nSecond",
    );
    expect(richText).not.toContain("private-block-id");
    expect(richText).not.toContain("private-target");
    expect(context).toBe("Updated now Green status");
    expect(context).not.toContain("secret");
  });

  it("selects plain or mrkdwn-safe native data text explicitly", () => {
    const table = {
      type: "data_table",
      caption: "<!channel> pipeline",
      rows: [[{ type: "raw_text", text: "Owner" }], [{ type: "raw_text", text: "<@U123>" }]],
    };

    expect(renderSlackBlockFallbackText(table, { nativeDataFormat: "plain" })).toBe(
      "<!channel> pipeline (table)\n- Owner: <@U123>",
    );
    expect(renderSlackBlockFallbackText(table, { nativeDataFormat: "mrkdwn-safe" })).toBe(
      "&lt;!channel&gt; pipeline (table)\n- Owner: &lt;@U123&gt;",
    );
  });

  it("uses generic defaults for file and unknown blocks", () => {
    expect(
      buildSlackBlocksFallbackText([
        { type: "file", source: "remote", external_id: "F123" },
      ] as never),
    ).toBe("Shared a file");
    expect(buildSlackBlocksFallbackText([{ type: "divider" }] as never)).toBe(
      "Shared a Block Kit message",
    );
    expect(renderSlackBlockFallbackText({ type: "video" })).toBe("Shared a video");
  });
});

describe("parseSlackBlocksInput", () => {
  it("returns undefined when blocks are missing", () => {
    expect(parseSlackBlocksInput(undefined)).toBeUndefined();
    expect(parseSlackBlocksInput(null)).toBeUndefined();
  });

  it("accepts blocks arrays", () => {
    const parsed = parseSlackBlocksInput([{ type: "divider" }]);
    expect(parsed).toEqual([{ type: "divider" }]);
  });

  it("accepts JSON blocks strings", () => {
    const parsed = parseSlackBlocksInput(
      '[{"type":"section","text":{"type":"mrkdwn","text":"hi"}}]',
    );
    expect(parsed).toEqual([{ type: "section", text: { type: "mrkdwn", text: "hi" } }]);
  });

  it("rejects invalid block payloads", () => {
    const cases = [
      {
        name: "invalid JSON",
        input: "{bad-json",
        expectedMessage: /valid JSON/i,
      },
      {
        name: "non-array payload",
        input: { type: "divider" },
        expectedMessage: /must be an array/i,
      },
      {
        name: "empty array",
        input: [],
        expectedMessage: /at least one block/i,
      },
      {
        name: "non-object block",
        input: ["not-a-block"],
        expectedMessage: /must be an object/i,
      },
      {
        name: "missing block type",
        input: [{}],
        expectedMessage: /non-empty string type/i,
      },
    ] as const;

    for (const testCase of cases) {
      expect(() => parseSlackBlocksInput(testCase.input), testCase.name).toThrow(
        testCase.expectedMessage,
      );
    }
  });
});

describe("parseSlackModalPrivateMetadata", () => {
  it("returns empty object for missing or invalid values", () => {
    expect(parseSlackModalPrivateMetadata(undefined)).toStrictEqual({});
    expect(parseSlackModalPrivateMetadata("")).toStrictEqual({});
    expect(parseSlackModalPrivateMetadata("{bad-json")).toStrictEqual({});
  });

  it("parses known metadata fields", () => {
    expect(
      parseSlackModalPrivateMetadata(
        JSON.stringify({
          sessionKey: "agent:main:slack:channel:C1",
          channelId: "D123",
          channelType: "im",
          userId: "U123",
          pluginInteractiveData: "dean.contract:confirm",
          ignored: "x",
        }),
      ),
    ).toEqual({
      sessionKey: "agent:main:slack:channel:C1",
      channelId: "D123",
      channelType: "im",
      userId: "U123",
      pluginInteractiveData: "dean.contract:confirm",
    });
  });
});
