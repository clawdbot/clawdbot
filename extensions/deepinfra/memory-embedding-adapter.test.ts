import { isMissingEmbeddingApiKeyError } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { describe, expect, it } from "vitest";
import { DEFAULT_DEEPINFRA_EMBEDDING_MODEL } from "./embedding-provider.js";
import { deepinfraMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";

describe("deepinfra memory embedding adapter", () => {
  it("declares a remote auth-backed embedding provider", () => {
    expect(Object.keys(deepinfraMemoryEmbeddingProviderAdapter)).toEqual([
      "id",
      "defaultModel",
      "transport",
      "authProviderId",
      "autoSelectPriority",
      "allowExplicitWhenConfiguredAuto",
      "shouldContinueAutoSelection",
      "create",
    ]);
    expect(deepinfraMemoryEmbeddingProviderAdapter.id).toBe("deepinfra");
    expect(deepinfraMemoryEmbeddingProviderAdapter.defaultModel).toBe(
      DEFAULT_DEEPINFRA_EMBEDDING_MODEL,
    );
    expect(deepinfraMemoryEmbeddingProviderAdapter.transport).toBe("remote");
    expect(deepinfraMemoryEmbeddingProviderAdapter.authProviderId).toBe("deepinfra");
    expect(deepinfraMemoryEmbeddingProviderAdapter.autoSelectPriority).toBe(55);
    expect(deepinfraMemoryEmbeddingProviderAdapter.allowExplicitWhenConfiguredAuto).toBe(true);
    expect(deepinfraMemoryEmbeddingProviderAdapter.shouldContinueAutoSelection).toBe(
      isMissingEmbeddingApiKeyError,
    );
    expect(deepinfraMemoryEmbeddingProviderAdapter.create).toBeTypeOf("function");
  });
});
