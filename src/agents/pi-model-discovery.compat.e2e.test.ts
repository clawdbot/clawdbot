import { afterEach, describe, expect, it, vi } from "vitest";

describe("pi-model-discovery module compatibility", () => {
  afterEach(() => {
    vi.doUnmock("@earendil-works/pi-coding-agent");
  });

  it("loads when InMemoryAuthStorageBackend is not exported", async () => {
    vi.resetModules();
    vi.doMock("@earendil-works/pi-coding-agent", () => {
      function MockAuthStorage() {}
      function MockModelRegistry() {}

      return {
        AuthStorage: MockAuthStorage,
        ModelRegistry: MockModelRegistry,
      };
    });

    const module = await import("./pi-model-discovery.js");
    expect(typeof module.discoverAuthStorage).toBe("function");
    expect(typeof module.discoverModels).toBe("function");
  });
});
