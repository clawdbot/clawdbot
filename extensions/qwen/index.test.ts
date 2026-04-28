import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import qwenPlugin from "./index.js";

async function registerQwenProvider() {
  return registerSingleProviderPlugin(qwenPlugin);
}

describe("qwen provider plugin", () => {
  it("does not expose runtime model suppression hooks", async () => {
    const provider = await registerQwenProvider();

    expect(provider.suppressBuiltInModel).toBeUndefined();
  });
});
