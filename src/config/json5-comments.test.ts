import { describe, expect, it, vi } from "vitest";
import { warnIfJSON5CommentsWillBeStripped } from "./json5-comments.js";

describe("warnIfJSON5CommentsWillBeStripped", () => {
  it.each([
    ["line", "{\n  // keep this note\n  value: 1\n}"],
    ["block", "{ /* keep this note */ value: 1 }"],
  ])("warns for %s comments", (_kind, raw) => {
    const warn = vi.fn();

    warnIfJSON5CommentsWillBeStripped({ raw, filePath: "/tmp/openclaw.json", warn });

    expect(warn).toHaveBeenCalledWith(
      "Config write will strip JSON5 comments from /tmp/openclaw.json.",
    );
  });

  it("ignores comment tokens inside JSON5 strings", () => {
    const warn = vi.fn();

    warnIfJSON5CommentsWillBeStripped({
      raw: `{ url: "https://example.com/a", note: 'literal /* note */ and // text', escaped: "say \\"//\\"" }`,
      filePath: "/tmp/openclaw.json",
      warn,
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it("respects quiet writes", () => {
    const warn = vi.fn();

    warnIfJSON5CommentsWillBeStripped({
      raw: "{ // comment\n value: 1 }",
      filePath: "/tmp/openclaw.json",
      warn,
      skipOutputLogs: true,
    });

    expect(warn).not.toHaveBeenCalled();
  });
});
