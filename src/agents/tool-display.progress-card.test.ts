import { describe, expect, it } from "vitest";
import { formatToolDetail, formatToolSummary, resolveToolDisplay } from "./tool-display.js";

describe("progress card tool display", () => {
  it.each(["progress_card", "update_plan"])(
    "keeps %s card content out of generic labels",
    (name) => {
      const markdown = '<progress aria-label="private" value="1" max="2"></progress>';
      for (const detailMode of ["explain", "raw"] as const) {
        const display = resolveToolDisplay({
          name,
          args: { markdown, plan: [{ step: "private step", status: "in_progress" }] },
          meta: markdown,
          detailMode,
        });
        expect(formatToolDetail(display)).toBeUndefined();
        expect(formatToolSummary(display)).not.toContain("private");
      }
    },
  );
});
