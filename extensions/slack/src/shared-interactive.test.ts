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
        { type: "select", placeholder: long, options: [{ label: long, value: long }] },
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
