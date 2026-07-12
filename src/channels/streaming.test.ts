import { describe, expect, it } from "vitest";
import {
  buildChannelProgressDraftLine,
  formatChannelProgressDraftText,
  resolveChannelPreviewStreamMode,
  resolveChannelStreamingBlockCoalesce,
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingChunkMode,
  resolveChannelStreamingNativeTransport,
  resolveChannelStreamingPreviewChunk,
  resolveChannelStreamingProgressNarration,
} from "./streaming.js";

describe("buildChannelProgressDraftLine", () => {
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

describe("streaming config resolution", () => {
  // Legacy flat aliases are doctor-migrated (`openclaw doctor --fix`); runtime
  // resolution reads only the canonical nested streaming shape.
  it("ignores legacy flat streaming keys", () => {
    const legacyEntry = {
      streamMode: "block",
      chunkMode: "newline",
      blockStreaming: true,
      draftChunk: { minChars: 10 },
      blockStreamingCoalesce: { idleMs: 5 },
      nativeStreaming: false,
    } as never;

    expect(resolveChannelPreviewStreamMode(legacyEntry, "partial")).toBe("partial");
    expect(resolveChannelStreamingChunkMode(legacyEntry)).toBeUndefined();
    expect(resolveChannelStreamingBlockEnabled(legacyEntry)).toBeUndefined();
    expect(resolveChannelStreamingPreviewChunk(legacyEntry)).toBeUndefined();
    expect(resolveChannelStreamingBlockCoalesce(legacyEntry)).toBeUndefined();
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

  it("keeps scalar streaming support for channels whose schema allows it", () => {
    // Mattermost's schema accepts a scalar mode string or boolean as canonical.
    expect(resolveChannelPreviewStreamMode({ streaming: "block" }, "partial")).toBe("block");
    expect(resolveChannelPreviewStreamMode({ streaming: true }, "off")).toBe("partial");
    expect(resolveChannelPreviewStreamMode({ streaming: false }, "partial")).toBe("off");
  });
});

describe("progress narration", () => {
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
