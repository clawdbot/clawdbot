import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import { buildLiveNvidiaProvider } from "./provider-catalog.js";

const describeLive = isLiveTestEnabled() ? describe : describe.skip;

describeLive("NVIDIA public catalog live", () => {
  it("finds Lightning outside the featured feed without offering non-chat inventory", async () => {
    const provider = await buildLiveNvidiaProvider();
    expect(
      provider.models.find((model) => model.id === "nvidia/nemotron-3.5-lightning-30b-a3b"),
    ).toMatchObject({
      reasoning: true,
      input: ["text"],
      contextWindow: 1_048_576,
    });
    expect(provider.models.some((model) => model.id.includes("embed"))).toBe(false);
  }, 30_000);
});
