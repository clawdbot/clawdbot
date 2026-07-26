import { describe, expect, it } from "vitest";
import {
  parseRemoteModelCatalogBundle,
  validateAndSanitizeRemoteModelCatalogBundle,
} from "./remote-catalog-bundle.js";

const validBundle = {
  schemaVersion: 1,
  generatedAt: 1_753_500_000_000,
  minVersion: "2026.7.0",
  sourceCommit: "abc123",
  providers: {
    anthropic: {
      baseUrl: "https://evil.test",
      headers: { Authorization: "bad" },
      defaultModel: "claude-test",
      defaultUtilityModel: "claude-test",
      models: [
        {
          id: "claude-test",
          baseUrl: "https://evil.test/model",
          headers: { "X-Evil": "yes" },
          compat: { nested: { baseUrl: "https://evil.test/nested", headers: { X: "y" } } },
        },
      ],
    },
  },
} as const;

describe("remote model catalog bundle", () => {
  it("accepts schema v1 and deeply strips endpoint and header fields", () => {
    const parsed = validateAndSanitizeRemoteModelCatalogBundle(validBundle);
    const anthropic = parsed.providers.anthropic;
    expect(anthropic).toBeDefined();
    if (!anthropic) {
      throw new Error("expected anthropic provider");
    }
    expect(anthropic).not.toHaveProperty("baseUrl");
    expect(anthropic).not.toHaveProperty("headers");
    expect(anthropic).toMatchObject({
      defaultModel: "claude-test",
      defaultUtilityModel: "claude-test",
    });
    expect(anthropic.models[0]).not.toHaveProperty("baseUrl");
    expect(anthropic.models[0]).not.toHaveProperty("headers");
    expect(anthropic.models[0]?.compat).toEqual({ nested: {} });
  });

  it("rejects unsupported versions, invalid timestamps, and malformed providers", () => {
    expect(() => parseRemoteModelCatalogBundle({ ...validBundle, schemaVersion: 2 })).toThrow();
    expect(() => parseRemoteModelCatalogBundle({ ...validBundle, generatedAt: 0 })).toThrow();
    expect(() =>
      parseRemoteModelCatalogBundle({
        ...validBundle,
        generatedAt: Date.now() + 2 * 24 * 60 * 60_000,
      }),
    ).toThrow("generatedAt is implausibly far in the future");
    expect(() =>
      parseRemoteModelCatalogBundle({ ...validBundle, providers: { anthropic: { models: [] } } }),
    ).toThrow();
    expect(() =>
      parseRemoteModelCatalogBundle({
        ...validBundle,
        providers: { anthropic: { models: [{ id: " duplicate " }, { id: "duplicate" }] } },
      }),
    ).toThrow("duplicate model id: duplicate");
  });
});
