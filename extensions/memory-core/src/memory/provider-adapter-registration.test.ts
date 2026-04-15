import { describe, expect, it } from "vitest";
import { filterUnregisteredMemoryEmbeddingProviderAdapters } from "./provider-adapter-registration.js";

describe("filterUnregisteredMemoryEmbeddingProviderAdapters", () => {
  it("keeps builtin adapters that are not already registered", () => {
    const adapters = filterUnregisteredMemoryEmbeddingProviderAdapters({
      builtinAdapters: [
        { id: "local" },
        { id: "openai" },
        { id: "gemini" },
        { id: "voyage" },
        { id: "mistral" },
      ],
      registeredAdapters: [],
    });

    expect(adapters.map((adapter) => adapter.id)).toEqual([
      "local",
      "openai",
      "gemini",
      "voyage",
      "mistral",
    ]);
  });

  it("skips builtin adapters that are already registered", () => {
    const adapters = filterUnregisteredMemoryEmbeddingProviderAdapters({
      builtinAdapters: [
        { id: "local" },
        { id: "openai" },
        { id: "gemini" },
        { id: "voyage" },
        { id: "mistral" },
      ],
      registeredAdapters: [{ id: "local" }, { id: "gemini" }],
    });

    expect(adapters.map((adapter) => adapter.id)).toEqual(["openai", "voyage", "mistral"]);
  });
});
