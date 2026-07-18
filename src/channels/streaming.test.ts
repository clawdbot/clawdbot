import { describe, expect, it } from "vitest";
import {
  buildChannelProgressDraftLine,
  formatChannelProgressDraftText,
  formatPlanChecklistLines,
  normalizeAgentPlanSteps,
  isChannelProgressDraftWorkToolName,
  mergeChannelProgressDraftLine,
  resolveChannelPreviewStreamMode,
  resolveChannelStreamingBlockCoalesce,
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingChunkMode,
  resolveChannelStreamingNativeTransport,
  resolveChannelStreamingPreviewChunk,
  resolveChannelStreamingProgressNarration,
} from "./streaming.js";

describe("buildChannelProgressDraftLine", () => {
  it("suppresses update_plan from generic work-tool progress", () => {
    expect(isChannelProgressDraftWorkToolName("update_plan")).toBe(false);
  });

  it("omits generic completed status from successful command output with title", () => {
    const line = buildChannelProgressDraftLine(
      {
        event: "command-output",
        toolCallId: "exec-1",
        phase: "end",
        title: "pwd",
        name: "exec",
        exitCode: 0,
      },
      { commandText: "raw" },
    );

    expect(line).toMatchObject({
      kind: "command-output",
      id: "exec-1",
      text: "🛠️ pwd",
      detail: "pwd",
      status: "completed",
    });
  });

  it("uses the tool label when successful command output has no title", () => {
    const line = buildChannelProgressDraftLine({
      event: "command-output",
      phase: "end",
      name: "exec",
      exitCode: 0,
    });

    expect(line).toMatchObject({
      kind: "command-output",
      text: "🛠️ Exec",
      status: "completed",
    });
    expect(line?.detail).toBeUndefined();
  });

  it("keeps command status and title in raw command progress lines", () => {
    const line = buildChannelProgressDraftLine(
      {
        event: "command-output",
        toolCallId: "exec-1",
        phase: "end",
        title: "command false",
        name: "exec",
        exitCode: 2,
      },
      { commandText: "raw" },
    );

    expect(line).toMatchObject({
      kind: "command-output",
      id: "exec-1",
      text: "🛠️ exit 2; command false",
      detail: "command false",
      status: "exit 2",
    });
  });

  it("keeps only command status in status-only progress lines", () => {
    const line = buildChannelProgressDraftLine(
      {
        event: "command-output",
        phase: "end",
        title: "command false",
        name: "exec",
        exitCode: 2,
      },
      { commandText: "status" },
    );

    expect(line).toMatchObject({
      kind: "command-output",
      text: "🛠️ exit 2",
      detail: "exit 2",
      status: "exit 2",
    });
    expect(line?.text).not.toContain("command false");
  });
});

describe("mergeChannelProgressDraftLine", () => {
  it("keeps identical visible lines distinct when their stable ids differ", () => {
    const first = { id: "tool-1", kind: "tool" as const, text: "bash", label: "bash" };
    const second = { id: "tool-2", kind: "tool" as const, text: "bash", label: "bash" };

    const lines = mergeChannelProgressDraftLine([first], second, { maxLines: 8 });

    expect(lines.map((line) => line.id)).toEqual(["tool-1", "tool-2"]);
  });
});

describe("normalizeAgentPlanSteps", () => {
  it("normalizes external-plugin string steps and typed entries, dropping blanks", () => {
    expect(
      normalizeAgentPlanSteps([
        "Inspect",
        "  ",
        { step: "  Patch  ", status: "in_progress" },
        { step: "   ", status: "pending" },
        { step: "Test", status: "bogus" },
      ]),
    ).toEqual([
      { step: "Inspect", status: "pending" },
      { step: "Patch", status: "in_progress" },
    ]);
    expect(normalizeAgentPlanSteps(undefined)).toBeUndefined();
  });
});

describe("streaming config resolution", () => {
  // Flat delivery keys remain external SDK compatibility fallbacks. Bundled
  // schemas are nested-only; mode-family aliases stay doctor-only.
  it("resolves flat delivery keys while ignoring mode-family aliases", () => {
    const legacyEntry = {
      streamMode: "block",
      chunkMode: "newline",
      blockStreaming: true,
      draftChunk: { minChars: 10 },
      blockStreamingCoalesce: { idleMs: 5 },
      nativeStreaming: false,
    } as never;

    expect(resolveChannelPreviewStreamMode(legacyEntry, "partial")).toBe("partial");
    expect(resolveChannelStreamingChunkMode(legacyEntry)).toBe("newline");
    expect(resolveChannelStreamingBlockEnabled(legacyEntry)).toBe(true);
    expect(resolveChannelStreamingPreviewChunk(legacyEntry)).toEqual({ minChars: 10 });
    expect(resolveChannelStreamingBlockCoalesce(legacyEntry)).toEqual({ idleMs: 5 });
    expect(resolveChannelStreamingNativeTransport(legacyEntry)).toBeUndefined();
  });

  it("resolves the canonical nested streaming shape", () => {
    const entry = {
      streaming: {
        mode: "block",
        chunkMode: "newline",
        preview: { chunk: { minChars: 10 } },
        block: { enabled: true, coalesce: { idleMs: 5 } },
        nativeTransport: false,
      },
    };

    expect(resolveChannelPreviewStreamMode(entry, "partial")).toBe("block");
    expect(resolveChannelStreamingChunkMode(entry)).toBe("newline");
    expect(resolveChannelStreamingBlockEnabled(entry)).toBe(true);
    expect(resolveChannelStreamingPreviewChunk(entry)).toEqual({ minChars: 10 });
    expect(resolveChannelStreamingBlockCoalesce(entry)).toEqual({ idleMs: 5 });
    expect(resolveChannelStreamingNativeTransport(entry)).toBe(false);
  });

  it("keeps the scalar streaming fallback for external SDK plugin configs", () => {
    // Bundled schemas are nested-only; this compatibility path is deprecated.
    expect(resolveChannelPreviewStreamMode({ streaming: "block" }, "partial")).toBe("block");
    expect(resolveChannelPreviewStreamMode({ streaming: true }, "off")).toBe("partial");
    expect(resolveChannelPreviewStreamMode({ streaming: false }, "partial")).toBe("off");
  });
});

describe("progress narration", () => {
  it("renders plan markers and keeps the checklist under narration", () => {
    const plan = [
      { step: "Inspect", status: "completed" as const },
      { step: "Patch", status: "in_progress" as const },
      { step: "Test", status: "pending" as const },
    ];

    expect(formatPlanChecklistLines(plan, { maxLines: 5, maxLineChars: 80 })).toEqual([
      "✅ Inspect",
      "▸ Patch",
      "▢ Test",
    ]);
    expect(
      formatChannelProgressDraftText({
        entry: { streaming: { mode: "progress", progress: { label: false } } },
        lines: ["🛠️ hidden"],
        narration: "Working through the plan.",
        plan,
      }),
    ).toBe("Working through the plan.\n\n✅ Inspect\n▸ Patch\n▢ Test");
  });

  it("summarizes overflowing plans and prioritizes unfinished steps", () => {
    expect(
      formatPlanChecklistLines(
        [
          { step: "One", status: "completed" },
          { step: "Two", status: "completed" },
          { step: "Three", status: "in_progress" },
          { step: "Four", status: "pending" },
        ],
        { maxLines: 3, maxLineChars: 80 },
      ),
    ).toEqual(["✅ 2/4 done", "▸ Three", "▢ Four"]);
  });

  it("keeps the active step when later pending work fills the checklist", () => {
    expect(
      formatPlanChecklistLines(
        [
          { step: "Done", status: "completed" },
          { step: "Active", status: "in_progress" },
          { step: "Next", status: "pending" },
          { step: "Later", status: "pending" },
          { step: "Last", status: "pending" },
        ],
        { maxLines: 3, maxLineChars: 80 },
      ),
    ).toEqual(["✅ 1/5 done", "▸ Active", "▢ Last"]);
  });

  it("shares the line budget between tool progress and the checklist", () => {
    expect(
      formatChannelProgressDraftText({
        entry: {
          streaming: { mode: "progress", progress: { label: false, maxLines: 3 } },
        },
        lines: ["tool one", "tool two", "tool three"],
        plan: [
          { step: "Active", status: "in_progress" },
          { step: "Next", status: "pending" },
        ],
      }),
    ).toBe("• tool three\n▸ Active\n▢ Next");
  });

  it("omits the implicit progress label when narration is available", () => {
    const text = formatChannelProgressDraftText({
      entry: { streaming: { mode: "progress" } },
      lines: ["🛠️ Exec"],
      narration: "Counting lines in the workspace files.",
    });

    expect(text).toBe("Counting lines in the workspace files.");
  });

  it("keeps an explicitly configured automatic label above narration", () => {
    const text = formatChannelProgressDraftText({
      entry: {
        streaming: {
          mode: "progress",
          progress: { label: "auto", labels: ["Clawing"] },
        },
      },
      lines: ["🛠️ Exec"],
      narration: "Counting lines in the workspace files.",
    });

    expect(text).toBe("Clawing\n\nCounting lines in the workspace files.");
  });

  it("renders narration instead of tool lines", () => {
    const text = formatChannelProgressDraftText({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      lines: ["🛠️ Exec", "🛠️ Wc"],
      narration: "Counting lines in the workspace files.",
    });

    expect(text).toBe("Shelling\n\nCounting lines in the workspace files.");
  });

  it("compacts narration at a word boundary instead of line width", () => {
    const narration = Array.from({ length: 60 }, (_value, index) => `word${index}`).join(" ");
    const text = formatChannelProgressDraftText({
      entry: { streaming: { mode: "progress", progress: { label: false } } },
      lines: [],
      narration,
    });

    expect(text.endsWith("…")).toBe(true);
    expect(Array.from(text).length).toBeLessThanOrEqual(280);
    expect(text).not.toContain("\n");
  });

  it("resolves the narration toggle with default on", () => {
    // Mode gating is the caller's job; unset config keeps narration available.
    expect(resolveChannelStreamingProgressNarration(undefined)).toBe(true);
    expect(resolveChannelStreamingProgressNarration({ streaming: { mode: "progress" } })).toBe(
      true,
    );
    expect(
      resolveChannelStreamingProgressNarration({
        streaming: { mode: "progress", progress: { narration: false } },
      }),
    ).toBe(false);
  });
});
