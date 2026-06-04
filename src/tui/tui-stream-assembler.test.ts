// Verifies streamed TUI message assembly and display state updates.
import { describe, expect, it } from "vitest";
import { TuiStreamAssembler } from "./tui-stream-assembler.js";

const text = (value: string) => ({ type: "text", text: value }) as const;
const thinking = (value: string) => ({ type: "thinking", thinking: value }) as const;
const toolUse = () => ({ type: "tool_use", name: "search" }) as const;

const messageWithContent = (content: readonly Record<string, unknown>[]) =>
  ({
    role: "assistant",
    content,
  }) as const;

const TEXT_ONLY_TWO_BLOCKS = messageWithContent([text("Draft line 1"), text("Draft line 2")]);

type FinalizeBoundaryCase = {
  name: string;
  streamedContent: readonly Record<string, unknown>[];
  finalContent: readonly Record<string, unknown>[];
  expected: string;
};

const FINALIZE_BOUNDARY_CASES: FinalizeBoundaryCase[] = [
  {
    name: "preserves streamed text when tool-boundary final payload drops prefix blocks",
    streamedContent: [text("Before tool call"), toolUse(), text("After tool call")],
    finalContent: [toolUse(), text("After tool call")],
    expected: "Before tool call\nAfter tool call",
  },
  {
    name: "preserves streamed text when streamed run had non-text and final drops suffix blocks",
    streamedContent: [text("Before tool call"), toolUse(), text("After tool call")],
    finalContent: [text("Before tool call")],
    expected: "Before tool call\nAfter tool call",
  },
  {
    name: "prefers final text when non-text appears only in final payload",
    streamedContent: [text("Draft line 1"), text("Draft line 2")],
    finalContent: [toolUse(), text("Draft line 2")],
    expected: "Draft line 2",
  },
  {
    name: "keeps non-empty final text for plain text boundary drops",
    streamedContent: [text("Draft line 1"), text("Draft line 2")],
    finalContent: [text("Draft line 1")],
    expected: "Draft line 1",
  },
  {
    name: "prefers final replacement text when payload is not a boundary subset",
    streamedContent: [text("Before tool call"), toolUse(), text("After tool call")],
    finalContent: [toolUse(), text("Replacement")],
    expected: "Replacement",
  },
  {
    name: "accepts richer final payload when it extends streamed text",
    streamedContent: [text("Before tool call")],
    finalContent: [text("Before tool call"), text("After tool call")],
    expected: "Before tool call\nAfter tool call",
  },
];

describe("TuiStreamAssembler", () => {
  it("keeps thinking before content even when thinking arrives later", () => {
    const assembler = new TuiStreamAssembler();
    const first = assembler.ingestDelta("run-1", messageWithContent([text("Hello")]), true);
    expect(first).toBe("Hello");

    const second = assembler.ingestDelta("run-1", messageWithContent([thinking("Brain")]), true);
    expect(second).toBe("[thinking]\nBrain\n\nHello");
  });

  it("omits thinking when showThinking is false", () => {
    const assembler = new TuiStreamAssembler();
    const output = assembler.ingestDelta(
      "run-2",
      messageWithContent([thinking("Hidden"), text("Visible")]),
      false,
    );
    expect(output).toBe("Visible");
  });

  it("falls back to streamed text on empty final payload", () => {
    const assembler = new TuiStreamAssembler();
    assembler.ingestDelta("run-3", messageWithContent([text("Streamed")]), false);
    const finalText = assembler.finalize("run-3", { role: "assistant", content: [] }, false);
    expect(finalText).toBe("Streamed");
  });

  it("falls back to event error message when final payload has no renderable text", () => {
    const assembler = new TuiStreamAssembler();
    const finalText = assembler.finalize(
      "run-3-error",
      { role: "assistant", content: [] },
      false,
      '401 {"error":{"message":"Missing scopes: model.request"}}',
    );
    expect(finalText).toContain("HTTP 401");
    expect(finalText).toContain("Missing scopes: model.request");
  });

  it("returns null when delta text is unchanged", () => {
    const assembler = new TuiStreamAssembler();
    const first = assembler.ingestDelta("run-4", messageWithContent([text("Repeat")]), false);
    expect(first).toBe("Repeat");
    const second = assembler.ingestDelta("run-4", messageWithContent([text("Repeat")]), false);
    expect(second).toBeNull();
  });

  it("keeps streamed delta text when incoming tool boundary drops a block", () => {
    const assembler = new TuiStreamAssembler();
    const first = assembler.ingestDelta("run-delta-boundary", TEXT_ONLY_TWO_BLOCKS, false);
    expect(first).toBe("Draft line 1\nDraft line 2");

    const second = assembler.ingestDelta(
      "run-delta-boundary",
      messageWithContent([toolUse(), text("Draft line 2")]),
      false,
    );
    expect(second).toBeNull();
  });

  for (const testCase of FINALIZE_BOUNDARY_CASES) {
    it(testCase.name, () => {
      const assembler = new TuiStreamAssembler();
      assembler.ingestDelta("run-boundary", messageWithContent(testCase.streamedContent), false);
      const finalText = assembler.finalize(
        "run-boundary",
        messageWithContent(testCase.finalContent),
        false,
      );
      expect(finalText).toBe(testCase.expected);
    });
  }
});
