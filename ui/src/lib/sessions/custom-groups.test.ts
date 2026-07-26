// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readSessionCustomGroupNames } from "./custom-groups.ts";

describe("readSessionCustomGroupNames", () => {
  it("normalizes valid names and ignores malformed entries", () => {
    expect(
      readSessionCustomGroupNames({
        groups: [{ name: " Alpha " }, { name: "" }, { name: 42 }, null],
      }),
    ).toEqual(["Alpha"]);
    expect(readSessionCustomGroupNames(null)).toEqual([]);
  });
});
