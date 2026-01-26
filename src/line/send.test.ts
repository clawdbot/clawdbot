import { describe, expect, it } from "vitest";
import {
  createFlexMessage,
  createQuickReplyItems,
  createTextMessageWithQuickReplies,
} from "./send.js";

describe("createFlexMessage", () => {
  it("creates a flex message with alt text and contents", () => {
    const contents = {
      type: "bubble" as const,
      body: {
        type: "box" as const,
        layout: "vertical" as const,
        contents: [],
      },
    };

    const message = createFlexMessage("Alt text for flex", contents);

    expect(message.type).toBe("flex");
    expect(message.altText).toBe("Alt text for flex");
    expect(message.contents).toBe(contents);
  });
});

describe("createQuickReplyItems", () => {
  it("creates quick reply items from labels", () => {
    const quickReply = createQuickReplyItems(["Option 1", "Option 2", "Option 3"]);

    expect(quickReply.items).toHaveLength(3);
    expect(quickReply.items[0].type).toBe("action");
    expect((quickReply.items[0].action as { label: string }).label).toBe("Option 1");
    expect((quickReply.items[0].action as { text: string }).text).toBe("Option 1");
  });

  it("limits items to 13 (LINE maximum)", () => {
    const labels = Array.from({ length: 20 }, (_, i) => `Option ${i + 1}`);
    const quickReply = createQuickReplyItems(labels);

    expect(quickReply.items).toHaveLength(13);
  });

  it("truncates labels to 20 characters", () => {
    const quickReply = createQuickReplyItems([
      "This is a very long option label that exceeds the limit",
    ]);

    expect((quickReply.items[0].action as { label: string }).label).toBe("This is a very long ");
    // Text is not truncated
    expect((quickReply.items[0].action as { text: string }).text).toBe(
      "This is a very long option label that exceeds the limit",
    );
  });

  it("creates message actions for each item", () => {
    const quickReply = createQuickReplyItems(["A", "B"]);

    expect((quickReply.items[0].action as { type: string }).type).toBe("message");
    expect((quickReply.items[1].action as { type: string }).type).toBe("message");
  });
});

describe("createTextMessageWithQuickReplies", () => {
  it("creates a text message with quick replies attached", () => {
    const message = createTextMessageWithQuickReplies("Choose an option:", ["Yes", "No"]);

    expect(message.type).toBe("text");
    expect(message.text).toBe("Choose an option:");
    expect(message.quickReply).toBeDefined();
    expect(message.quickReply.items).toHaveLength(2);
  });

  it("preserves text content", () => {
    const longText =
      "This is a longer message that asks the user to select from multiple options below.";
    const message = createTextMessageWithQuickReplies(longText, ["A", "B", "C"]);

    expect(message.text).toBe(longText);
  });

  it("handles empty quick replies array", () => {
    const message = createTextMessageWithQuickReplies("No options", []);

    expect(message.quickReply.items).toHaveLength(0);
  });

  it("quick replies use label as both label and text", () => {
    const message = createTextMessageWithQuickReplies("Pick one:", ["Apple", "Banana"]);

    const firstAction = message.quickReply.items[0].action as { label: string; text: string };
    expect(firstAction.label).toBe("Apple");
    expect(firstAction.text).toBe("Apple");
  });
});
