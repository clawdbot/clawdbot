import { describe, expect, it } from "vitest";
import {
  buildSlackNativeDataDeliveryPlan,
  chunkSlackTextAtHardLimit,
} from "./native-data-fallback.js";

function tableBlock(caption: string) {
  return {
    type: "data_table",
    caption,
    rows: [[{ type: "raw_text", text: "Account" }], [{ type: "raw_text", text: "Acme" }]],
  } as never;
}

function actionBlock(label: string, value: string) {
  return {
    type: "actions",
    elements: [
      {
        type: "button",
        action_id: "openclaw:reply_button",
        text: { type: "plain_text", text: label },
        value,
      },
    ],
  } as never;
}

describe("buildSlackNativeDataDeliveryPlan", () => {
  it("uses the generic accessibility label for non-data blocks without visible text", () => {
    const plan = buildSlackNativeDataDeliveryPlan({ blocks: [{ type: "divider" } as never] });

    expect(plan.accessibilityText).toBe("Shared a Block Kit message");
    expect(plan.skipOriginalBlocks).toBe(false);
  });

  it("packs native-only emergency text at Slack's 40k hard limit", () => {
    const caption = "x".repeat(41_000);
    const plan = buildSlackNativeDataDeliveryPlan({ blocks: [tableBlock(caption)] });

    expect(plan.skipOriginalBlocks).toBe(true);
    expect(plan.fallbackMessages).toHaveLength(2);
    expect(plan.fallbackMessages.every((message) => message.blocks === undefined)).toBe(true);
    expect(plan.fallbackMessages.every((message) => message.text.length <= 40_000)).toBe(true);
    expect(plan.fallbackMessages.map((message) => message.text).join("")).toBe(
      `${caption} (table)\nAccount\nAcme`,
    );
  });

  it("batches survivor controls and replacement sections without changing block order", () => {
    const before = actionBlock("Before", "hidden-before");
    const after = actionBlock("After", "hidden-after");
    const caption = "x".repeat(80_000);
    const plan = buildSlackNativeDataDeliveryPlan({
      baseText: "Intro",
      blocks: [before, tableBlock(caption), after],
    });

    const messages = plan.fallbackMessages;
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => (message.blocks?.length ?? 0) <= 50)).toBe(true);
    expect(messages.every((message) => message.text.length <= 40_000)).toBe(true);
    const blocks = messages.flatMap((message) => message.blocks ?? []);
    expect(blocks[1]).toBe(before);
    expect(blocks.at(-1)).toBe(after);
    const plainText = blocks.flatMap((block) => {
      const text = (block as { text?: { type?: string; text?: string } }).text;
      return text?.type === "plain_text" && text.text ? [text.text] : [];
    });
    expect(plainText.join("")).toBe(`Intro${caption} (table)\nAccount\nAcme`);
    expect(messages.map((message) => message.text).join(" ")).not.toContain("hidden-");
  });

  it("keeps survivor plain text literal when formatting is disabled", () => {
    const plan = buildSlackNativeDataDeliveryPlan({
      blocks: [
        {
          type: "section",
          text: { type: "plain_text", text: "1 < 2 & <@U123>" },
          accessory: {
            type: "button",
            text: { type: "plain_text", text: "Keep <literal>" },
          },
        } as never,
        tableBlock("Pipeline"),
      ],
    });

    expect(plan.fallbackMessages[0]?.mrkdwn).toBe(false);
    expect(plan.fallbackMessages[0]?.text).toContain("1 < 2 & <@U123>");
    expect(plan.fallbackMessages[0]?.text).toContain("Keep <literal>");
    expect(plan.fallbackMessages[0]?.text).not.toContain("&lt;");
  });

  it("does not split astral characters at hard boundaries", () => {
    expect(chunkSlackTextAtHardLimit(`A${"😀".repeat(3)}Z`, 3)).toEqual(["A😀", "😀", "😀Z"]);
  });

  it("keeps a visible failure marker for malformed native-only data with base text", () => {
    const plan = buildSlackNativeDataDeliveryPlan({
      baseText: "Overview",
      blocks: [{ type: "data_table", rows: [] } as never],
    });

    expect(plan.accessibilityText).toBe(
      "Overview\n\nSlack could not render this chart or table data.",
    );
    expect(plan.fallbackMessages).toEqual([{ text: plan.accessibilityText, mrkdwn: false }]);
  });
});
