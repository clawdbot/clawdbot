import { describe, expect, it } from "vitest";
import type { MessageGroup } from "../types/chat-types.ts";
import { buildChatItems, type BuildChatItemsProps } from "./build-chat-items.ts";

function createProps(overrides: Partial<BuildChatItemsProps> = {}): BuildChatItemsProps {
  return {
    sessionKey: "main",
    messages: [],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
    ...overrides,
  };
}

function messageGroups(props: Partial<BuildChatItemsProps>): MessageGroup[] {
  return buildChatItems(createProps(props)).filter((item) => item.kind === "group");
}

function firstMessageContent(group: MessageGroup): unknown[] {
  const message = group.messages[0]?.message as { content?: unknown };
  return Array.isArray(message.content) ? message.content : [];
}

describe("buildChatItems", () => {
  it("keeps consecutive user messages from different senders in separate groups", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "user",
          content: "first",
          senderLabel: "Iris",
          timestamp: 1000,
        },
        {
          role: "user",
          content: "second",
          senderLabel: "Joaquin De Rojas",
          timestamp: 1001,
        },
      ],
    });

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.senderLabel)).toEqual(["Iris", "Joaquin De Rojas"]);
  });

  it("attaches lifted canvas previews to the nearest assistant turn", () => {
    const groups = messageGroups({
      messages: [
        {
          id: "assistant-with-canvas",
          role: "assistant",
          content: [{ type: "text", text: "First reply." }],
          timestamp: 1_000,
        },
        {
          id: "assistant-without-canvas",
          role: "assistant",
          content: [{ type: "text", text: "Later unrelated reply." }],
          timestamp: 2_000,
        },
      ],
      toolMessages: [
        {
          id: "tool-canvas-for-first-reply",
          role: "tool",
          toolCallId: "call-canvas-old",
          toolName: "canvas_render",
          content: JSON.stringify({
            kind: "canvas",
            view: {
              backend: "canvas",
              id: "cv_nearest_turn",
              url: "/__openclaw__/canvas/documents/cv_nearest_turn/index.html",
              title: "Nearest turn demo",
              preferred_height: 320,
            },
            presentation: {
              target: "assistant_message",
            },
          }),
          timestamp: 1_001,
        },
      ],
    });

    expect(firstMessageContent(groups[0]).some((block) => isCanvasBlock(block))).toBe(true);
    expect(firstMessageContent(groups[1]).some((block) => isCanvasBlock(block))).toBe(false);
  });

  it("does not lift generic view handles from non-canvas payloads", () => {
    const groups = messageGroups({
      messages: [
        {
          id: "assistant-generic-inline",
          role: "assistant",
          content: [{ type: "text", text: "Rendered the item inline." }],
          timestamp: 1000,
        },
      ],
      toolMessages: [
        {
          id: "tool-generic-inline",
          role: "tool",
          toolCallId: "call-generic-inline",
          toolName: "plugin_card_details",
          content: JSON.stringify({
            selected_item: {
              summary: {
                label: "Alpha",
                meaning: "Generic example",
              },
              view: {
                backend: "canvas",
                id: "cv_generic_inline",
                url: "/__openclaw__/canvas/documents/cv_generic_inline/index.html",
                title: "Inline generic preview",
                preferred_height: 420,
              },
            },
          }),
          timestamp: 1001,
        },
      ],
    });

    expect(firstMessageContent(groups[0]).some((block) => isCanvasBlock(block))).toBe(false);
  });

  it("lifts streamed canvas toolresult blocks into the assistant bubble", () => {
    const groups = messageGroups({
      messages: [
        {
          id: "assistant-streamed-artifact",
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          timestamp: 1000,
        },
      ],
      toolMessages: [
        {
          id: "tool-streamed-artifact",
          role: "assistant",
          toolCallId: "call_streamed_artifact",
          timestamp: 999,
          content: [
            {
              type: "toolcall",
              name: "canvas_render",
              arguments: { source: { type: "handle", id: "cv_streamed_artifact" } },
            },
            {
              type: "toolresult",
              name: "canvas_render",
              text: JSON.stringify({
                kind: "canvas",
                view: {
                  backend: "canvas",
                  id: "cv_streamed_artifact",
                  url: "/__openclaw__/canvas/documents/cv_streamed_artifact/index.html",
                  title: "Streamed demo",
                  preferred_height: 320,
                },
                presentation: {
                  target: "assistant_message",
                },
              }),
            },
          ],
        },
      ],
    });

    const canvasBlocks = firstMessageContent(groups[0]).filter((block) => isCanvasBlock(block));
    expect(canvasBlocks).toHaveLength(1);
    expect(canvasBlocks[0]).toMatchObject({
      preview: {
        viewId: "cv_streamed_artifact",
        title: "Streamed demo",
      },
    });
  });
});

function isCanvasBlock(block: unknown): boolean {
  return (
    Boolean(block) &&
    typeof block === "object" &&
    (block as { type?: unknown; preview?: { kind?: unknown } }).type === "canvas" &&
    (block as { preview?: { kind?: unknown } }).preview?.kind === "canvas"
  );
}
