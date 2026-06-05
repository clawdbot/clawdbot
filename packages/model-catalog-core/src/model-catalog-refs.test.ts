// Model Catalog Core tests cover model catalog refs behavior.
import { describe, expect, it } from "vitest";
import { buildModelCatalogMergeKey, buildModelCatalogRef } from "./model-catalog-refs.js";

describe("model catalog refs", () => {
  it("normalizes provider ids without lowercasing model ids in refs", () => {
    expect(buildModelCatalogRef("OpenAI", "GPT-5.4")).toBe("openai/GPT-5.4");
    expect(buildModelCatalogMergeKey("OpenAI", "GPT-5.4")).toBe("openai::gpt-5.4");
  });
});
