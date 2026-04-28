import { describe, expect, it } from "vitest";
import { deepinfraMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";

describe("deepinfra memory embedding adapter", () => {
  it("declares a remote auth-backed embedding provider", () => {
    expect(deepinfraMemoryEmbeddingProviderAdapter).toMatchObject({
      id: "deepinfra",
      defaultModel: "BAAI/bge-m3",
      transport: "remote",
      authProviderId: "deepinfra",
      autoSelectPriority: 55,
      allowExplicitWhenConfiguredAuto: true,
    });
    expect(deepinfraMemoryEmbeddingProviderAdapter.shouldContinueAutoSelection).toBeTypeOf(
      "function",
    );
  });
});
