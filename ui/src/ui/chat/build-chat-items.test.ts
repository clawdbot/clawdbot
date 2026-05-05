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

  it("collapses consecutive duplicate text messages into one rendered item with a count", () => {
    const groups = messageGroups({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "Same update" }], timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "Same update" }], timestamp: 2 },
        { role: "assistant", content: [{ type: "text", text: "Same update" }], timestamp: 3 },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].messages).toHaveLength(1);
    expect(groups[0].messages[0]).toMatchObject({ duplicateCount: 3 });
  });

  it("suppresses assistant HEARTBEAT_OK acknowledgements before rendering history", () => {
    const groups = messageGroups({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "HEARTBEAT_OK" }], timestamp: 1 },
        { role: "assistant", content: "HEARTBEAT_OK", timestamp: 2 },
        { role: "user", content: [{ type: "text", text: "HEARTBEAT_OK" }], timestamp: 3 },
        { role: "assistant", content: [{ type: "text", text: "Visible reply" }], timestamp: 4 },
      ],
    });

    expect(groups).toHaveLength(2);
    expect(groups[0].role).toBe("user");
    expect(groups[1].role).toBe("assistant");
    expect(groups[1].messages[0].message).toMatchObject({
      content: [{ type: "text", text: "Visible reply" }],
    });
  });

  it("suppresses assistant HEARTBEAT_OK acknowledgements that carry hidden thinking blocks", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Checking scheduled work." },
            {
              type: "text",
              text: "HEARTBEAT_OK",
              textSignature: JSON.stringify({ v: 1, phase: "final_answer" }),
            },
          ],
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [
            { id: "rs_1", type: "reasoning" },
            { type: "text", text: "HEARTBEAT_OK" },
          ],
          timestamp: 2,
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Useful hidden reasoning." },
            { type: "text", text: "Visible reply" },
          ],
          timestamp: 3,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].messages).toHaveLength(1);
    expect(groups[0].messages[0].message).toMatchObject({
      content: [
        { type: "thinking", thinking: "Useful hidden reasoning." },
        { type: "text", text: "Visible reply" },
      ],
    });
  });

  it("keeps HEARTBEAT_OK turns that carry visible non-text content", () => {
    const canvasBlock = createAssistantCanvasBlock({ suffix: "heartbeat_visible_content" });
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "HEARTBEAT_OK" }, canvasBlock],
          timestamp: 1,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].messages).toHaveLength(1);
    expect(firstMessageContent(groups[0]).some((block) => isCanvasBlock(block))).toBe(true);
  });

  it("suppresses active HEARTBEAT_OK streams before rendering", () => {
    const items = buildChatItems(
      createProps({
        stream: "HEARTBEAT_OK",
        streamStartedAt: 1,
      }),
    );

    expect(items).toEqual([]);
  });

  it("does not collapse duplicate text messages separated by another message", () => {
    const groups = messageGroups({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "same" }], timestamp: 1 },
        { role: "user", content: [{ type: "text", text: "break" }], timestamp: 2 },
        { role: "assistant", content: [{ type: "text", text: "same" }], timestamp: 3 },
      ],
    });

    expect(groups).toHaveLength(3);
    expect(groups[0].messages[0].duplicateCount).toBeUndefined();
    expect(groups[2].messages[0].duplicateCount).toBeUndefined();
  });

  it("does not collapse messages that carry canvas previews", () => {
    const canvasBlock = createAssistantCanvasBlock({ suffix: "duplicate_guard" });
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "preview" }, canvasBlock],
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "preview" }, canvasBlock],
          timestamp: 2,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].messages).toHaveLength(2);
    expect(groups[0].messages[0].duplicateCount).toBeUndefined();
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

  it("explains compaction boundaries and exposes the checkpoint action", () => {
    const items = buildChatItems(
      createProps({
        messages: [
          {
            role: "system",
            timestamp: 2_000,
            __openclaw: {
              kind: "compaction",
              id: "checkpoint-1",
            },
          },
        ],
      }),
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "divider",
      label: "Compacted history",
      description:
        "Earlier turns are preserved in a compaction checkpoint. Open session checkpoints to branch or restore that pre-compaction view.",
      action: {
        kind: "session-checkpoints",
        label: "Open checkpoints",
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

function createAssistantCanvasBlock(params: { suffix: string }) {
  const viewId = `cv_inline_${params.suffix}`;
  return {
    type: "canvas",
    preview: {
      kind: "canvas",
      surface: "assistant_message",
      render: "url",
      viewId,
      title: "Inline demo",
      url: `/__openclaw__/canvas/documents/${viewId}/index.html`,
      preferredHeight: 360,
    },
  };
}
