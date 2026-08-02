// Verifies streamed TUI message assembly and display state updates.
import { describe, expect, it } from "vitest";
import { TuiStreamAssembler } from "./tui-stream-assembler.js";

const text = (value: string) => ({ type: "text", text: value }) as const;
const thinking = (value: string) => ({ type: "thinking", thinking: value }) as const;
const toolUse = () => ({ type: "tool_use", name: "search" }) as const;
const pairingQr = (terminalText: string) =>
  ({ type: "openclaw_pairing_qr", terminalText }) as const;

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

  it("tracks literal placeholder text as real displayable content until finalization", () => {
    const assembler = new TuiStreamAssembler();

    expect(assembler.hasDisplayText("run-literal-output")).toBe(false);

    assembler.ingestDelta("run-literal-output", messageWithContent([text("(no output)")]), false);

    expect(assembler.hasDisplayText("run-literal-output")).toBe(true);
    expect(
      assembler.finalize("run-literal-output", { role: "assistant", content: [] }, false),
    ).toBe("(no output)");
    expect(assembler.hasDisplayText("run-literal-output")).toBe(false);
  });

  it("falls back to streamed text on empty final payload", () => {
    const assembler = new TuiStreamAssembler();
    assembler.ingestDelta("run-3", messageWithContent([text("Streamed")]), false);
    const finalText = assembler.finalize("run-3", { role: "assistant", content: [] }, false);
    expect(finalText).toBe("Streamed");
  });

  it("renders pairing QR terminal text from final assistant content", () => {
    const assembler = new TuiStreamAssembler();
    const finalText = assembler.finalize(
      "run-pair-qr",
      messageWithContent([
        text("Scan this QR code with the OpenClaw iOS app:"),
        pairingQr("\u001b[47m\u001b[30m█ ▄\u001b[0m"),
      ]),
      false,
    );
    expect(finalText).toContain("Scan this QR code with the OpenClaw iOS app:");
    expect(finalText).toContain("█ ▄");
    expect(finalText).not.toContain("\u001b[47m");
    expect(finalText).not.toBe("(no output)");
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

  it("renders attachment-only assistant finals without exposing media fields", () => {
    const assembler = new TuiStreamAssembler();
    const finalText = assembler.finalize(
      "run-media-only",
      messageWithContent([
        {
          type: "image",
          data: "secret-image",
          url: "file:///Users/operator/private/image.png",
          artifactId: "secret-artifact",
        },
      ]),
      false,
    );
    expect(finalText).toBe("Attached image");
  });

  it("keeps visible thinking ahead of an attachment-only final", () => {
    const assembler = new TuiStreamAssembler();
    const finalText = assembler.finalize(
      "run-media-thinking",
      messageWithContent([
        thinking("Preparing the attachment"),
        { type: "image", data: "secret-image" },
      ]),
      true,
    );
    expect(finalText).toBe("[thinking]\nPreparing the attachment\n\nAttached image");
  });

  it("keeps a streamed caption ahead of an attachment-only final", () => {
    const assembler = new TuiStreamAssembler();
    assembler.ingestDelta(
      "run-media-caption",
      messageWithContent([text("Generated chart")]),
      false,
    );
    const finalText = assembler.finalize(
      "run-media-caption",
      messageWithContent([{ type: "image", data: "secret-image" }]),
      false,
    );
    expect(finalText).toBe("Generated chart");
  });

  it("keeps an error ahead of an attachment summary", () => {
    const assembler = new TuiStreamAssembler();
    const finalText = assembler.finalize(
      "run-media-error",
      messageWithContent([{ type: "video", url: "file:///private/clip.mp4" }]),
      false,
      "media generation failed",
    );
    expect(finalText).toContain("media generation failed");
    expect(finalText).not.toContain("Attached video");
  });

  it("returns null when delta text is unchanged", () => {
    const assembler = new TuiStreamAssembler();
    const first = assembler.ingestDelta("run-4", messageWithContent([text("Repeat")]), false);
    expect(first).toBe("Repeat");
    const second = assembler.ingestDelta("run-4", messageWithContent([text("Repeat")]), false);
    expect(second).toBeNull();
  });

  it("bounds orphaned stream state while preserving recently active runs", () => {
    const assembler = new TuiStreamAssembler();
    for (let index = 0; index < 200; index += 1) {
      assembler.ingestDelta(`run-${index}`, messageWithContent([text(`Draft ${index}`)]), false);
    }

    assembler.ingestDelta("run-0", messageWithContent([text("Recently active")]), false);
    assembler.ingestDelta("run-200", messageWithContent([text("Newest")]), false);

    expect(assembler.finalize("run-0", { role: "assistant", content: [] }, false)).toBe(
      "Recently active",
    );
    expect(assembler.finalize("run-1", { role: "assistant", content: [] }, false)).toBe(
      "(no output)",
    );
    expect(assembler.finalize("run-200", { role: "assistant", content: [] }, false)).toBe("Newest");
  });

  it("does not evict an active run when an evicted run finalizes late", () => {
    const assembler = new TuiStreamAssembler();
    for (let index = 0; index < 201; index += 1) {
      assembler.ingestDelta(`run-${index}`, messageWithContent([text(`Draft ${index}`)]), false);
    }

    expect(assembler.finalize("run-0", messageWithContent([text("Late final")]), false)).toBe(
      "Late final",
    );
    expect(assembler.finalize("run-1", { role: "assistant", content: [] }, false)).toBe("Draft 1");
  });

  it("keeps a live run available across thousands of orphaned stream updates", () => {
    const assembler = new TuiStreamAssembler();
    assembler.ingestDelta("run-live", messageWithContent([text("Still streaming")]), false);

    for (let index = 0; index < 2_000; index += 1) {
      assembler.ingestDelta(
        `run-orphan-${index}`,
        messageWithContent([text(`Draft ${index}`)]),
        false,
      );
      if (index % 100 === 0) {
        assembler.ingestDelta("run-live", messageWithContent([text("Still streaming")]), false);
      }
    }

    expect(assembler.finalize("run-live", { role: "assistant", content: [] }, false)).toBe(
      "Still streaming",
    );
    expect(assembler.finalize("run-orphan-0", { role: "assistant", content: [] }, false)).toBe(
      "(no output)",
    );
    expect(assembler.finalize("run-orphan-1999", { role: "assistant", content: [] }, false)).toBe(
      "Draft 1999",
    );
  });

  it("protects a paused live stream across thousands of orphaned updates", () => {
    const assembler = new TuiStreamAssembler((runId) => runId === "run-live");
    assembler.ingestDelta("run-live", messageWithContent([text("Before the tool call")]), false);

    for (let index = 0; index < 2_000; index += 1) {
      assembler.ingestDelta(
        `run-orphan-${index}`,
        messageWithContent([text(`Draft ${index}`)]),
        false,
      );
    }

    expect(assembler.finalize("run-live", { role: "assistant", content: [] }, false)).toBe(
      "Before the tool call",
    );
    expect(assembler.finalize("run-orphan-0", { role: "assistant", content: [] }, false)).toBe(
      "(no output)",
    );
    expect(assembler.finalize("run-orphan-1999", { role: "assistant", content: [] }, false)).toBe(
      "Draft 1999",
    );
  });

  it("protects concurrent live streams without retaining abandoned runs", () => {
    const protectedRuns = new Set(["run-first", "run-second"]);
    const assembler = new TuiStreamAssembler((runId) => protectedRuns.has(runId));
    assembler.ingestDelta("run-first", messageWithContent([text("First live response")]), false);
    assembler.ingestDelta("run-second", messageWithContent([text("Second live response")]), false);

    for (let index = 0; index < 500; index += 1) {
      assembler.ingestDelta(
        `run-orphan-${index}`,
        messageWithContent([text(`Draft ${index}`)]),
        false,
      );
    }

    expect(assembler.finalize("run-first", { role: "assistant", content: [] }, false)).toBe(
      "First live response",
    );
    expect(assembler.finalize("run-second", { role: "assistant", content: [] }, false)).toBe(
      "Second live response",
    );
    expect(assembler.finalize("run-orphan-0", { role: "assistant", content: [] }, false)).toBe(
      "(no output)",
    );
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
