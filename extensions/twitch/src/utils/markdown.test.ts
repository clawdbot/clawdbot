import { describe, expect, it } from "vitest";
import { chunkTextForTwitch } from "./markdown.js";

describe("chunkTextForTwitch", () => {
  it("strips markdown and keeps surrogate pairs intact at hard boundaries", () => {
    const prefix = "a".repeat(499);

    expect(chunkTextForTwitch(`**${prefix}😀b**`, 500)).toEqual([prefix, "😀b"]);
  });
});
