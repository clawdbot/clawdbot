// Vllm tests cover provider discovery.contract plugin behavior.
import { fileURLToPath } from "node:url";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describeVllmProviderDiscoveryContract } from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";
import vllmPlugin from "./index.js";

describeVllmProviderDiscoveryContract({
  load: () => import("./index.js"),
  apiModuleId: fileURLToPath(new URL("./api.js", import.meta.url)),
});

describe("vLLM provider registration", () => {
  it("exposes the binary thinking profile hook", async () => {
    const provider = await registerSingleProviderPlugin(vllmPlugin);

    expect(
      provider.resolveThinkingProfile?.({
        provider: "vllm",
        modelId: "Qwen/Qwen3-8B",
        reasoning: true,
        compat: { thinkingFormat: "qwen-chat-template" },
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low", label: "on" }],
      defaultLevel: "off",
    });
  });
});
