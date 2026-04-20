import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import plugin from "./index.js";

describe("kimi provider plugin", () => {
  it("uses binary thinking with thinking off by default", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.isBinaryThinking?.({
        provider: "kimi",
        modelId: "kimi-code",
      } as never),
    ).toBe(true);
    expect(
      provider.resolveDefaultThinkingLevel?.({
        provider: "kimi",
        modelId: "kimi-code",
        reasoning: true,
      } as never),
    ).toBe("off");
  });
});
