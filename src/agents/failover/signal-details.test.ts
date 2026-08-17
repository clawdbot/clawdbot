import { describe, expect, it } from "vitest";
import { extractFailoverSignalDetails } from "./classify.js";

describe("extractFailoverSignalDetails", () => {
  it.each([
    {
      name: "backs off before a split surrogate pair",
      input: `${"a".repeat(999)}🎉!`,
      expected: "a".repeat(999),
    },
    {
      name: "keeps the full ASCII budget",
      input: "a".repeat(1001),
      expected: "a".repeat(1000),
    },
  ])("$name in nested provider details", ({ input, expected }) => {
    const details = extractFailoverSignalDetails({ error: { body: { detail: input } } });

    expect(details).toEqual([expected]);
  });
});
