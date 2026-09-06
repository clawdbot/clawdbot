import { describe, expect, it } from "vitest";
import { augmentChatHistoryWithCanvasBlocks } from "./chat-display-projection.canvas.js";

describe("augmentChatHistoryWithCanvasBlocks batches", () => {
  it.each(["next-renderable", "last-renderable", "last-assistant"] as const)(
    "preserves first-accepted previews and original messages on the %s target",
    (placement) => {
      const baseContent = [
        { type: "text", text: "Canvas results" },
        { type: "canvas", preview: { viewId: "existing", url: "/existing" } },
        { type: "canvas", preview: { viewId: "", url: "" } },
        ...(placement === "last-assistant" ? [{ type: "toolCall", name: "canvas" }] : []),
      ];
      Object.freeze(baseContent);
      const target = Object.freeze({ role: "assistant", content: baseContent, timestamp: 42 });
      const toolAssistant = { role: "assistant", content: [{ type: "toolCall", name: "canvas" }] };
      const tools = [
        ["existing", "/rejected-id-url"],
        ["first", "/rejected-id-url"],
        ["first", "/later-url"],
        ["second", "/later-url"],
        ["url-duplicate", "/existing"],
        [undefined, "/url-only"],
        [undefined, "/url-only"],
      ].map(([id, url]) => ({
        role: "toolResult",
        toolName: "canvas",
        content: JSON.stringify({ kind: "canvas", view: { ...(id ? { id } : {}), url } }),
      }));
      const detailTool = {
        role: "toolResult",
        toolName: "demo__show",
        content: "Keep the original tool result",
        details: {
          mcpAppPreview: {
            kind: "canvas",
            view: { id: "app" },
            mcpApp: { viewId: "app" },
          },
        },
      };
      const pending = [...tools, detailTool];
      const messages =
        placement === "next-renderable"
          ? [...pending, toolAssistant, target]
          : placement === "last-renderable"
            ? [target, toolAssistant, ...pending]
            : [target, ...pending];
      Object.freeze(messages);
      const original = JSON.stringify(messages);
      const targetIndex = placement === "next-renderable" ? messages.length - 1 : 0;
      const accepted = [
        { index: 1, viewId: "first", url: "/rejected-id-url" },
        { index: 3, viewId: "second", url: "/later-url" },
        { index: 5, url: "/url-only" },
      ].map(({ index, ...preview }) => ({
        type: "canvas",
        preview: { kind: "canvas", surface: "assistant_message", render: "url", ...preview },
        rawText: tools[index]?.content,
      }));
      const expectedContent = [
        ...baseContent,
        ...accepted,
        {
          type: "canvas",
          preview: {
            kind: "canvas",
            surface: "assistant_message",
            render: "url",
            viewId: "app",
            mcpApp: { viewId: "app" },
          },
          rawText: null,
        },
      ];

      const augmented = augmentChatHistoryWithCanvasBlocks(messages);

      expect(augmented).toEqual(
        messages.map((message, index) =>
          index === targetIndex ? { ...target, content: expectedContent } : message,
        ),
      );
      expect(augmented[targetIndex]).not.toBe(target);
      for (const [index, message] of messages.entries()) {
        if (index !== targetIndex) {
          expect(augmented[index]).toBe(message);
        }
      }
      expect(JSON.stringify(messages)).toBe(original);
    },
  );
});
