import { describe, expect, it } from "vitest";
import { parseTarVerboseMetadata } from "./install-tar-verbose.js";

describe("parseTarVerboseMetadata", () => {
  it("parses BSD and GNU tar verbose sizes", () => {
    expect(parseTarVerboseMetadata("-rw-r--r--  0 user group 123 Jan 01 00:00 SKILL.md")).toEqual([
      { type: "File", size: 123 },
    ]);
    expect(parseTarVerboseMetadata("-rw-r--r-- user/group 456 2026-05-28 00:00 SKILL.md")).toEqual([
      { type: "File", size: 456 },
    ]);
  });

  it("rejects partial or unsafe tar verbose size tokens", () => {
    expect(() =>
      parseTarVerboseMetadata("-rw-r--r--  0 user group 123abc Jan 01 00:00 SKILL.md"),
    ).toThrow(/unable to parse tar entry size/u);
    expect(() =>
      parseTarVerboseMetadata("-rw-r--r-- user/group 9007199254740993 2026-05-28 00:00 SKILL.md"),
    ).toThrow(/unable to parse tar entry size/u);
  });
});
