// Progress draft line tests cover line splitting and display limits for progress drafts.
import { describe, expect, it } from "vitest";
import { removeChannelProgressDraftLine } from "./progress-draft-lines.js";
import { buildChannelProgressDraftLine } from "./streaming.js";

describe("progress draft lines", () => {
  it("uses the item lifecycle identity for raw tool call ids", () => {
    const toolLine = buildChannelProgressDraftLine({
      event: "tool",
      toolCallId: "read-1",
      name: "read",
      phase: "start",
    });
    const itemLine = buildChannelProgressDraftLine({
      event: "item",
      itemId: "tool:read-1",
      itemKind: "tool",
      name: "read",
      status: "completed",
    });

    expect(toolLine?.id).toBe("tool:read-1");
    expect(itemLine?.id).toBe(toolLine?.id);
  });

  it("treats tool call ids as opaque when building item identities", () => {
    const line = buildChannelProgressDraftLine({
      event: "tool",
      toolCallId: "tool:read-1",
      name: "read",
      phase: "start",
    });

    expect(line?.id).toBe("tool:tool:read-1");
  });

  it("removes keyed progress lines in place", () => {
    const line = buildChannelProgressDraftLine({
      event: "item",
      itemId: "preamble-1",
      itemKind: "preamble",
      title: "Preamble",
      progressText: "Checking the app-server stream",
    });
    if (!line) {
      throw new Error("expected preamble progress line");
    }
    const lines: Array<string | typeof line> = ["🛠️ Exec", line];

    expect(removeChannelProgressDraftLine(lines, "preamble-1")).toEqual(["🛠️ Exec"]);
    expect(removeChannelProgressDraftLine(lines, "missing")).toBe(lines);
    expect(removeChannelProgressDraftLine(lines, " ")).toBe(lines);
  });
});
