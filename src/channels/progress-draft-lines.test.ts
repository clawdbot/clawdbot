// Progress draft line tests cover line splitting and display limits for progress drafts.
import { describe, expect, it } from "vitest";
import { removeChannelProgressDraftLine } from "./progress-draft-lines.js";
import { buildChannelProgressDraftLine } from "./streaming.js";

describe("progress draft lines", () => {
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
