import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import { QWEN_36_PLUS_MODEL_ID, QWEN_BASE_URL } from "./api.js";
import qwenPlugin from "./index.js";

async function registerQwenProvider() {
  // The test runtime asserts the plugin registers exactly one provider and returns it.
  return registerSingleProviderPlugin(qwenPlugin);
}

describe("qwen provider plugin", () => {
  it("keeps qwen3.6-plus out of Coding Plan normalized catalogs", async () => {
    const provider = await registerQwenProvider();

    const normalized = provider.normalizeConfig?.({
      provider: "qwen",
      providerConfig: {
        baseUrl: QWEN_BASE_URL,
        models: [{ id: "qwen3.5-plus" }, { id: QWEN_36_PLUS_MODEL_ID }],
      },
    } as never);

    expect(normalized?.models?.map((model) => model.id)).toEqual(["qwen3.5-plus"]);
  });

  it("does not expose runtime model suppression hooks", async () => {
    const provider = await registerQwenProvider();

    expect(provider.suppressBuiltInModel).toBeUndefined();
  });
});
