import { describe, expect, it } from "vitest";
import {
  buildChannelProgressDraftLine,
  formatChannelProgressDraftText,
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
