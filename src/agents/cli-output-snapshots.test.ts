import { describe, expect, it } from "vitest";
import { createCliJsonlStreamingParser } from "./cli-output-stream.js";

const BACKEND = {
  command: "claude",
  output: "jsonl",
  jsonlDialect: "claude-stream-json",
} as const;

function joinJsonlFrames(...frames: unknown[]) {
  return frames.map((frame) => JSON.stringify(frame)).join("\n");
}

function claudeTextDelta(text: string) {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  };
}

function claudePartialSnapshot(id: string, content: unknown[]) {
  return { type: "assistant", message: { id, content, stop_reason: null } };
}

describe("Claude CLI assistant snapshots", () => {
  it("streams cumulative snapshots as incremental deltas", () => {
    const deltas: Array<{ text: string; delta: string }> = [];
    const parser = createCliJsonlStreamingParser({
      backend: BACKEND,
      providerId: "claude-cli",
      onAssistantDelta: ({ text, delta }) => deltas.push({ text, delta }),
    });

    parser.push(
      joinJsonlFrames(
        claudePartialSnapshot("msg-1", [{ type: "text", text: "Hello" }]),
        claudePartialSnapshot("msg-1", [{ type: "text", text: "Hello world" }]),
        { type: "result", subtype: "success", result: "Hello world" },
      ),
    );
    parser.finish();

    expect(deltas).toEqual([
      { text: "Hello", delta: "Hello" },
      { text: "Hello world", delta: " world" },
    ]);
    expect(parser.getOutput()?.text).toBe("Hello world");
  });

  it("deduplicates stream-event text repeated by a snapshot", () => {
    const deltas: Array<{ text: string; delta: string }> = [];
    const parser = createCliJsonlStreamingParser({
      backend: BACKEND,
      providerId: "claude-cli",
      onAssistantDelta: ({ text, delta }) => deltas.push({ text, delta }),
    });

    parser.push(
      joinJsonlFrames(
        claudeTextDelta("Hi"),
        claudePartialSnapshot("msg-1", [{ type: "text", text: "Hi" }]),
        claudePartialSnapshot("msg-1", [{ type: "text", text: "Hi there" }]),
        { type: "result", subtype: "success", result: "Hi there" },
      ),
    );
    parser.finish();

    expect(deltas).toEqual([
      { text: "Hi", delta: "Hi" },
      { text: "Hi there", delta: " there" },
    ]);
    expect(parser.getOutput()?.text).toBe("Hi there");
  });

  it("keeps commentary, tools, and later assistant text in their lanes", () => {
    const commentary: string[] = [];
    const tools: string[] = [];
    const deltas: Array<{ text: string; delta: string }> = [];
    const parser = createCliJsonlStreamingParser({
      backend: BACKEND,
      providerId: "claude-cli",
      onAssistantDelta: ({ text, delta }) => deltas.push({ text, delta }),
      onCommentaryText: (text) => commentary.push(text),
      onToolUseStart: (tool) => tools.push(tool.name),
    });

    parser.push(
      joinJsonlFrames(
        claudePartialSnapshot("msg-before-tool", [{ type: "text", text: "Inspecting now." }]),
        claudePartialSnapshot("msg-before-tool", [
          { type: "text", text: "Inspecting now." },
          { type: "tool_use", id: "tool-1", name: "Read", input: {} },
        ]),
        claudePartialSnapshot("msg-after-tool", [{ type: "text", text: "Done." }]),
        { type: "result", subtype: "success", result: "Done." },
      ),
    );
    parser.finish();

    expect(commentary).toEqual(["Inspecting now."]);
    expect(tools).toEqual(["Read"]);
    expect(deltas).toEqual([{ text: "Done.", delta: "Done." }]);
    expect(parser.getOutput()?.text).toBe("Done.");
  });

  it("preserves tool-split snapshots when commentary is disabled", () => {
    const deltas: Array<{ text: string; delta: string }> = [];
    const parser = createCliJsonlStreamingParser({
      backend: BACKEND,
      providerId: "claude-cli",
      onAssistantDelta: ({ text, delta }) => deltas.push({ text, delta }),
    });

    parser.push(
      joinJsonlFrames(
        claudePartialSnapshot("msg-before-tool", [{ type: "text", text: "Inspecting now." }]),
        claudePartialSnapshot("msg-before-tool", [
          { type: "text", text: "Inspecting now." },
          { type: "tool_use", id: "tool-1", name: "Read", input: {} },
        ]),
        claudePartialSnapshot("msg-after-tool", [{ type: "text", text: "Done." }]),
        { type: "result", subtype: "success", result: "Done." },
      ),
    );
    parser.finish();

    expect(deltas).toEqual([
      { text: "Inspecting now.", delta: "Inspecting now." },
      { text: "Inspecting now.\n\nDone.", delta: "\n\nDone." },
    ]);
    expect(parser.getOutput()?.text).toBe("Inspecting now.\n\nDone.");
  });

  it("routes leading tagged reasoning before visible snapshot text", () => {
    const thinking: string[] = [];
    const visible: string[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: BACKEND,
      providerId: "claude-cli",
      onAssistantDelta: ({ delta }) => visible.push(delta),
      onThinkingDelta: ({ delta }) => thinking.push(delta),
    });

    parser.push(
      joinJsonlFrames(
        claudePartialSnapshot("msg-1", [
          { type: "text", text: "<thinking>Private.</thinking>Visible." },
        ]),
        { type: "result", subtype: "success", result: "<thinking>Private.</thinking>Visible." },
      ),
    );
    parser.finish();

    expect(thinking).toEqual(["Private."]);
    expect(visible).toEqual(["Visible."]);
    expect(parser.getOutput()?.text).toBe("Visible.");
  });

  it.each([
    {
      name: "missing stop reason",
      record: {
        type: "assistant",
        message: { id: "msg-1", content: [{ type: "text", text: "x" }] },
      },
    },
    {
      name: "terminal stop reason",
      record: {
        type: "assistant",
        message: { id: "msg-1", content: [{ type: "text", text: "x" }], stop_reason: "end_turn" },
      },
    },
    {
      name: "subagent parent",
      record: {
        ...claudePartialSnapshot("msg-1", [{ type: "text", text: "x" }]),
        parent_tool_use_id: "tool-parent",
      },
    },
    {
      name: "tool-only snapshot",
      record: claudePartialSnapshot("msg-1", [
        { type: "tool_use", id: "tool-1", name: "Read", input: {} },
      ]),
    },
  ])("does not stream a snapshot with $name", ({ record }) => {
    const deltas: string[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: BACKEND,
      providerId: "claude-cli",
      onAssistantDelta: ({ delta }) => deltas.push(delta),
    });

    parser.push(JSON.stringify(record));
    parser.finish();

    expect(deltas).toEqual([]);
  });
});
