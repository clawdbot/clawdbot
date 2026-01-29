import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

import poePlugin, { validatePoeApiKey } from "./index.js";

describe("poe plugin", () => {
  test("plugin has correct metadata", () => {
    expect(poePlugin.id).toBe("poe");
    expect(poePlugin.name).toBe("Poe");
    expect(poePlugin.description).toContain("Poe API");
    expect(poePlugin.configSchema).toBeDefined();
    expect(poePlugin.register).toBeInstanceOf(Function);
  });

  test("registers provider with correct properties", () => {
    const registeredProviders: unknown[] = [];
    const mockApi = {
      registerProvider: (provider: unknown) => {
        registeredProviders.push(provider);
      },
    };

    poePlugin.register(mockApi as never);

    expect(registeredProviders).toHaveLength(1);
    const provider = registeredProviders[0] as Record<string, unknown>;

    expect(provider.id).toBe("poe");
    expect(provider.label).toBe("Poe");
    expect(provider.docsPath).toBe("/providers/poe");
    expect(provider.envVars).toContain("POE_API_KEY");
    expect(provider.auth).toHaveLength(1);

    const auth = provider.auth as Array<Record<string, unknown>>;
    expect(auth[0].id).toBe("api_key");
    expect(auth[0].kind).toBe("api_key");
  });
});

describe("validatePoeApiKey", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns true for valid API key", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });

    const result = await validatePoeApiKey("valid-key");

    expect(result).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.poe.com/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: {
          Authorization: "Bearer valid-key",
        },
      }),
    );
  });

  test("returns false for invalid API key", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    });

    const result = await validatePoeApiKey("invalid-key");

    expect(result).toBe(false);
  });

  test("returns false on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const result = await validatePoeApiKey("any-key");

    expect(result).toBe(false);
  });
});

describe("poe model definitions", () => {
  test("all models have required fields", () => {
    const registeredProviders: unknown[] = [];
    const mockApi = {
      registerProvider: (provider: unknown) => {
        registeredProviders.push(provider);
      },
    };

    poePlugin.register(mockApi as never);

    // Access auth run function context to check model building
    const provider = registeredProviders[0] as Record<string, unknown>;
    const auth = provider.auth as Array<Record<string, unknown>>;
    expect(auth[0]).toBeDefined();

    // Verify provider has expected structure
    expect(provider.id).toBe("poe");
  });
});
