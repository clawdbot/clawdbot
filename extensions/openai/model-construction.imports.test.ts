import { findSourceImportBackedges } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";

describe("OpenAI model construction imports", () => {
  it("constructs auth descriptors without loading credential stores", async () => {
    expect(
      await findSourceImportBackedges("extensions/openai/openai-provider.ts", [
        "src/agents/auth-profiles/profiles.ts",
        "src/agents/auth-profiles/store.ts",
      ]),
    ).toEqual([]);
  });

  it("registers image policy without loading HTTP dispatchers", async () => {
    expect(
      await findSourceImportBackedges("extensions/openai/image-generation-provider.ts", [
        "src/infra/net/fetch-guard.ts",
      ]),
    ).toEqual([]);
  });

  it.each(["extensions/openai/shared.ts", "extensions/openai/prompt-overlay.ts"])(
    "%s keeps descriptor construction outside host normalization and discovery",
    async (entry) => {
      expect(
        await findSourceImportBackedges(entry, [
          "src/plugins/provider-model-compat.ts",
          "src/plugins/provider-model-helpers.ts",
          "src/plugins/plugin-metadata-snapshot.ts",
          "src/agents/provider-attribution.ts",
        ]),
      ).toEqual([]);
    },
  );
});
