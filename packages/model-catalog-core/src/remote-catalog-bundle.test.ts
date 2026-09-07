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
          contextWindows: [
            { id: "200k", label: "200K", contextWindow: 200_000 },
            { id: "1m", label: "1M", contextWindow: 1_000_000 },
          ],
          contextWindowDefault: "1m",
          compat: { nested: { baseUrl: "https://evil.test/nested", headers: { X: "y" } } },
        },
      ],
    },
  },
  pricing: {
    "openai/gpt-external": { input: 2.5, output: 10, cacheRead: 1.25 },
  },
} as const;

describe("remote model catalog bundle", () => {
  it("accepts schema v1 and deeply strips endpoint and header fields", () => {
    const parsed = validateAndSanitizeRemoteModelCatalogBundle(validBundle);
    const anthropic = parsed.providers.anthropic;
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
    expect(anthropic.models[0]).toMatchObject({
      contextWindows: [
        { id: "200k", label: "200K", contextWindow: 200_000 },
        { id: "1m", label: "1M", contextWindow: 1_000_000 },
      ],
      contextWindowDefault: "1m",
    });
    expect(parsed.pricing?.["openai/gpt-external"]).toEqual({
      input: 2.5,
      output: 10,
      cacheRead: 1.25,
    });
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
    expect(() =>
      parseRemoteModelCatalogBundle({
        ...validBundle,
        pricing: { "openai/bad": { input: -1, output: 2 } },
      }),
    ).toThrow();
    expect(() =>
      parseRemoteModelCatalogBundle({
        ...validBundle,
        pricing: { "openai/bad": { input: 1, output: 2, baseUrl: "https://bad.test" } },
      }),
    ).toThrow();
    expect(() =>
      parseRemoteModelCatalogBundle({
        ...validBundle,
        providers: {
          anthropic: {
            models: [
              {
                id: "bad-default",
                contextWindows: [{ id: "200k", label: "200K", contextWindow: 200_000 }],
                contextWindowDefault: "1m",
              },
            ],
          },
        },
      }),
    ).toThrow("contextWindowDefault must reference a declared contextWindows option");
  });
});
