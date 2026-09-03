import { describe, expect, it } from "vitest";
import { readControlUiProofOption } from "../../scripts/lib/control-ui-proof-args.mts";

describe("readControlUiProofOption", () => {
  it.each([
    ["first inline", ["node", "script", "--label=first", "--label=second"], "first"],
    ["first split", ["node", "script", "--label", "first", "--label", "second"], "first"],
    ["split then inline", ["node", "script", "--label", "split", "--label=inline"], "inline"],
    ["inline then split", ["node", "script", "--label=inline", "--label", "split"], "inline"],
    ["empty inline", ["node", "script", "--label="], ""],
    ["missing split", ["node", "script", "--label"], undefined],
    [
      "next option as split value",
      ["node", "script", "--label", "--output-dir", "proof"],
      "--output-dir",
    ],
  ] as const)("%s", (_name, argv, expected) => {
    expect(readControlUiProofOption(argv, "label")).toBe(expected);
  });
});
