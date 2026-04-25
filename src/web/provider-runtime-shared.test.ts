import { describe, expect, it } from "vitest";
import { resolveWebProviderDefinition } from "./provider-runtime-shared.js";

describe("resolveWebProviderDefinition", () => {
  it("falls back to auto-detect when runtime metadata has no selected provider", () => {
    const resolved = resolveWebProviderDefinition({
      config: {},
      toolConfig: { enabled: true },
      runtimeMetadata: {},
      providers: [
        {
          id: "custom",
        },
      ],
      resolveEnabled: () => true,
      resolveAutoProviderId: () => "custom",
      createTool: ({ provider }) => ({
        name: provider.id,
      }),
    });

    expect(resolved).toEqual({
      provider: {
        id: "custom",
      },
      definition: {
        name: "custom",
      },
    });
  });
});
