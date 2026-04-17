import { describe, expect, it } from "vitest";
import { DEFAULT_LOCAL_MODEL } from "./embeddings.js";

describe("package embeddings barrel", () => {
  it("re-exports the source local embedding contract", () => {
    expect(DEFAULT_LOCAL_MODEL).toContain("embeddinggemma");
  });
});
