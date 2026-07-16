import { describe, expect, it } from "vitest";
import { resolveMemorySearchPreflight } from "./manager-search-preflight.js";

describe("memory manager search preflight", () => {
  it("skips search and provider init for blank queries", () => {
    expect(
      resolveMemorySearchPreflight({
        query: "   ",
        hasIndexedContent: true,
      }),
    ).toEqual({
      normalizedQuery: "",
      shouldInitializeProvider: false,
      shouldSearch: false,
    });
  });

  it("skips provider init when the index is empty", () => {
    expect(
      resolveMemorySearchPreflight({
        query: "hello",
        hasIndexedContent: false,
      }),
    ).toEqual({
      normalizedQuery: "hello",
      shouldInitializeProvider: false,
      shouldSearch: false,
    });
  });

  it("allows provider init when query and indexed content are present", () => {
    expect(
      resolveMemorySearchPreflight({
        query: " hello ",
        hasIndexedContent: true,
      }),
    ).toEqual({
      normalizedQuery: "hello",
      shouldInitializeProvider: true,
      shouldSearch: true,
    });
  });
});
