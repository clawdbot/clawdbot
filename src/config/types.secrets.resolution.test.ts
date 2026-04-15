import { describe, expect, it } from "vitest";
import { normalizeResolvedSecretInputString, resolveSecretInputString } from "./types.secrets.js";

describe("resolveSecretInputString", () => {
  it("returns available for non-empty string values", () => {
    expect(
      resolveSecretInputString({
        value: "  abc123  ",
        path: "models.providers.openai.apiKey",
      }),
    ).toEqual({
      status: "available",
      value: "abc123",
      ref: null,
    });
  });

  it("returns configured_unavailable for unresolved refs in inspect mode", () => {
    expect(
      resolveSecretInputString({
        value: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        path: "models.providers.openai.apiKey",
        mode: "inspect",
      }),
    ).toEqual({
      status: "configured_unavailable",
      value: undefined,
      ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    });
  });

  it("uses explicit refValue in inspect mode", () => {
    expect(
      resolveSecretInputString({
        value: "",
        refValue: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        path: "profiles.default.key",
        mode: "inspect",
      }),
    ).toEqual({
      status: "configured_unavailable",
      value: undefined,
      ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    });
  });

  it("returns missing when no value or ref is configured", () => {
    expect(
      resolveSecretInputString({
        value: "",
        path: "models.providers.openai.apiKey",
        mode: "inspect",
      }),
    ).toEqual({
      status: "missing",
      value: undefined,
      ref: null,
    });
  });

  it("throws for unresolved refs in strict mode", () => {
    expect(() =>
      resolveSecretInputString({
        value: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        path: "models.providers.openai.apiKey",
      }),
    ).toThrow(/unresolved SecretRef/);
  });
});

describe("normalizeResolvedSecretInputString", () => {
  it("keeps strict unresolved-ref behavior", () => {
    expect(() =>
      normalizeResolvedSecretInputString({
        value: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        path: "models.providers.openai.apiKey",
      }),
    ).toThrow(/unresolved SecretRef/);
  });
});
