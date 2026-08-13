import { describe, expect, it } from "vitest";
import { resolveSessionResetRecallCutoff } from "./session-reset-recall.js";

describe("resolveSessionResetRecallCutoff", () => {
  it("uses the first kept entry before the latest reset as the live cutoff", () => {
    expect(
      resolveSessionResetRecallCutoff([
        { type: "message", id: "old" },
        { type: "reset", id: "first" },
        { type: "message", id: "kept" },
        { type: "message", id: "newer" },
        { type: "reset", id: "latest", firstKeptEntryId: "kept" },
      ]),
    ).toEqual({ state: "valid", cutoffLine: 3 });
  });

  it("uses the latest reset line when it keeps no earlier entries", () => {
    expect(
      resolveSessionResetRecallCutoff([
        { type: "message", id: "old" },
        { type: "reset", id: "latest" },
        { type: "message", id: "current" },
      ]),
    ).toEqual({ state: "valid", cutoffLine: 2 });
  });

  it.each([
    [[{ type: "message", id: "only" }]],
    [[{ type: "reset", id: "latest", firstKeptEntryId: "missing" }]],
    [[{ type: "reset", id: "latest", firstKeptEntryId: 42 }]],
    [
      [
        { type: "reset", id: "latest", firstKeptEntryId: "after" },
        { type: "message", id: "after" },
      ],
    ],
  ])("fails closed for absent or invalid reset lineage", (events) => {
    expect(resolveSessionResetRecallCutoff(events).state).not.toBe("valid");
  });
});
