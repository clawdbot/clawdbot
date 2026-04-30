import { describe, expect, it } from "vitest";
import { buildSlackInteractiveBlocks } from "./blocks-render.js";

describe("buildSlackInteractiveBlocks", () => {
  it("renders shared interactive blocks in authored order", () => {
    expect(
      buildSlackInteractiveBlocks({
        blocks: [
          {
            type: "select",
            placeholder: "Pick one",
            options: [{ label: "Alpha", value: "alpha" }],
          },
          { type: "text", text: "then" },
          { type: "buttons", buttons: [{ label: "Retry", value: "retry" }] },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        type: "actions",
        block_id: "openclaw_reply_select_1",
      }),
      expect.objectContaining({
        type: "section",
        text: expect.objectContaining({ text: "then" }),
      }),
      expect.objectContaining({
        type: "actions",
        block_id: "openclaw_reply_buttons_1",
      }),
    ]);
  });

  it("truncates Slack render strings to Block Kit limits", () => {
    const long = "x".repeat(120);
    const blocks = buildSlackInteractiveBlocks({
      blocks: [
        { type: "text", text: "y".repeat(3100) },
        { type: "select", placeholder: long, options: [{ label: long, value: "valid" }] },
        { type: "buttons", buttons: [{ label: long, value: long }] },
      ],
    });
    const section = blocks[0] as { text?: { text?: string } };
    const selectBlock = blocks[1] as {
      elements?: Array<{ placeholder?: { text?: string } }>;
    };
    const buttonBlock = blocks[2] as {
      elements?: Array<{ value?: string }>;
    };

    expect((section.text?.text ?? "").length).toBeLessThanOrEqual(3000);
    expect((selectBlock.elements?.[0]?.placeholder?.text ?? "").length).toBeLessThanOrEqual(75);
    expect(buttonBlock.elements?.[0]?.value).toBe(long);
  });

  it("preserves original callback payloads for round-tripping", () => {
    const blocks = buildSlackInteractiveBlocks({
      blocks: [
        {
          type: "buttons",
          buttons: [{ label: "Allow", value: "pluginbind:approval-123:o" }],
        },
        {
          type: "select",
          options: [{ label: "Approve", value: "codex:approve:thread-1" }],
        },
      ],
    });

    const buttonBlock = blocks[0] as {
      elements?: Array<{ action_id?: string; value?: string }>;
    };
    const selectBlock = blocks[1] as {
      elements?: Array<{
        action_id?: string;
        options?: Array<{ value?: string }>;
      }>;
    };

    expect(buttonBlock.elements?.[0]?.action_id).toBe("openclaw:reply_button:1:1");
    expect(buttonBlock.elements?.[0]?.value).toBe("pluginbind:approval-123:o");
    expect(selectBlock.elements?.[0]?.action_id).toBe("openclaw:reply_select:1");
    expect(selectBlock.elements?.[0]?.options?.[0]?.value).toBe("codex:approve:thread-1");
  });

  it("drops Slack select options with values beyond Block Kit limits", () => {
    const blocks = buildSlackInteractiveBlocks({
      blocks: [
        {
          type: "select",
          options: [
            { label: "Allowed", value: "a".repeat(150) },
            { label: "Too long", value: "b".repeat(151) },
          ],
        },
      ],
    });

    const selectBlock = blocks[0] as {
      elements?: Array<{ options?: Array<{ value?: string }> }>;
    };

    expect(selectBlock.elements?.[0]?.options).toHaveLength(1);
    expect(selectBlock.elements?.[0]?.options?.[0]?.value).toBe("a".repeat(150));
  });

  it("omits Slack select blocks when every option value exceeds Block Kit limits", () => {
    expect(
      buildSlackInteractiveBlocks({
        blocks: [
          {
            type: "select",
            options: [{ label: "Too long", value: "x".repeat(151) }],
          },
        ],
      }),
    ).toEqual([]);
  });

  it("caps Slack static selects at the Block Kit option limit", () => {
    const blocks = buildSlackInteractiveBlocks({
      blocks: [
        {
          type: "select",
          options: Array.from({ length: 101 }, (_entry, index) => ({
            label: `Option ${index + 1}`,
            value: `v${index + 1}`,
          })),
        },
      ],
    });

    const selectBlock = blocks[0] as {
      elements?: Array<{ options?: Array<{ value?: string }> }>;
    };

    expect(selectBlock.elements?.[0]?.options).toHaveLength(100);
    expect(selectBlock.elements?.[0]?.options?.at(-1)?.value).toBe("v100");
  });

  it("drops value-only Slack buttons with values beyond Block Kit limits", () => {
    const blocks = buildSlackInteractiveBlocks({
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "Allowed", value: "a".repeat(2000) },
            { label: "Too long", value: "b".repeat(2001) },
            { label: "Docs", value: "c".repeat(2001), url: "https://example.com/docs" },
          ],
        },
      ],
    });

    const buttonBlock = blocks[0] as {
      elements?: Array<{ value?: string; url?: string }>;
    };

    expect(buttonBlock.elements).toHaveLength(2);
    expect(buttonBlock.elements?.[0]?.value).toBe("a".repeat(2000));
    expect(buttonBlock.elements?.[1]).toEqual(
      expect.objectContaining({ url: "https://example.com/docs" }),
    );
    expect(buttonBlock.elements?.[1]).not.toHaveProperty("value");
  });

  it("drops Slack button URLs beyond Block Kit limits", () => {
    const validUrl = `https://example.com/${"a".repeat(2980)}`;
    const longUrl = `https://example.com/${"b".repeat(2981)}`;
    const blocks = buildSlackInteractiveBlocks({
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "Allowed", url: validUrl },
            { label: "Too long", url: longUrl },
            { label: "Fallback action", value: "fallback", url: longUrl },
          ],
        },
      ],
    });

    const buttonBlock = blocks[0] as {
      elements?: Array<{ value?: string; url?: string }>;
    };

    expect(validUrl).toHaveLength(3000);
    expect(longUrl).toHaveLength(3001);
    expect(buttonBlock.elements).toHaveLength(2);
    expect(buttonBlock.elements?.[0]?.url).toBe(validUrl);
    expect(buttonBlock.elements?.[1]?.value).toBe("fallback");
    expect(buttonBlock.elements?.[1]).not.toHaveProperty("url");
  });

  it("caps Slack actions blocks at the Block Kit element limit", () => {
    const blocks = buildSlackInteractiveBlocks({
      blocks: [
        {
          type: "buttons",
          buttons: Array.from({ length: 26 }, (_entry, index) => ({
            label: `Option ${index + 1}`,
            value: `v${index + 1}`,
          })),
        },
      ],
    });

    const buttonBlock = blocks[0] as {
      elements?: Array<{ value?: string }>;
    };

    expect(buttonBlock.elements).toHaveLength(25);
    expect(buttonBlock.elements?.at(-1)?.value).toBe("v25");
  });

  it("preserves URL-only buttons as Slack link buttons", () => {
    const blocks = buildSlackInteractiveBlocks({
      blocks: [
        {
          type: "buttons",
          buttons: [{ label: "Docs", url: "https://example.com/docs" }],
        },
      ],
    });

    const buttonBlock = blocks[0] as {
      elements?: Array<{ value?: string; url?: string }>;
    };

    expect(buttonBlock.elements?.[0]).toEqual(
      expect.objectContaining({
        type: "button",
        url: "https://example.com/docs",
      }),
    );
    expect(buttonBlock.elements?.[0]).not.toHaveProperty("value");
  });

  it("maps supported button styles to Slack Block Kit styles", () => {
    const blocks = buildSlackInteractiveBlocks({
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "Approve", value: "approve", style: "primary" },
            { label: "Deny", value: "deny", style: "danger" },
            { label: "Confirm", value: "confirm", style: "success" },
            { label: "Skip", value: "skip", style: "secondary" },
          ],
        },
      ],
    });

    const buttonBlock = blocks[0] as {
      elements?: Array<{ style?: string }>;
    };

    expect(buttonBlock.elements?.[0]?.style).toBe("primary");
    expect(buttonBlock.elements?.[1]?.style).toBe("danger");
    expect(buttonBlock.elements?.[2]?.style).toBe("primary");
    expect(buttonBlock.elements?.[3]).not.toHaveProperty("style");
  });
});
