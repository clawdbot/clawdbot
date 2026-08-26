import { describe, expect, it } from "vitest";
import { readSessionArchiveReasonFromHitPath } from "./session-reset-recall-metadata.js";

describe("readSessionArchiveReasonFromHitPath", () => {
  it.each([
    ["sessions/a.jsonl.reset.2026-08-11T08-00-00Z", "reset"],
    ["sessions/a.jsonl.reset.2026-08-11T08-00-00.000Z.zst", "reset"],
    ["sessions/a.jsonl.deleted.2026-08-11T08-00-00Z", "deleted"],
    ["sessions\\a.jsonl.deleted.2026-08-11T08-00-00.000Z.zst", "deleted"],
    ["sessions/a.jsonl.reset.2026-08-11T08:00:00Z", undefined],
    ["sessions/a.jsonl.reset.2026-08-11T08-00-00Z.gz", undefined],
    ["sessions/a.jsonl.deleted.2026-08-11T08-00-00Z.extra", undefined],
    ["sessions/a.jsonl.RESET.2026-08-11T08-00-00Z", undefined],
  ])("classifies %s", (path, expected) => {
    expect(readSessionArchiveReasonFromHitPath(path)).toBe(expected);
  });
});
