// Verifies secret resolution config types and defaults.
import { describe, expect, it } from "vitest";
import {
  isUnresolvedSecretInputError,
  normalizeResolvedSecretInputString,
  parseLegacySecretRefEnvMarker,
  resolveSecretInputString,
  UnresolvedSecretInputError,
} from "./types.secrets.js";

describe("resolveSecretInputString", () => {
  it.each([
    { value: "  abc123  ", normalized: "abc123" },
    { value: "${OPENAI_API_KEY}", normalized: "${OPENAI_API_KEY}" },
  ])("returns available for non-empty string value $value", ({ value, normalized }) => {
    expect(
      resolveSecretInputString({
        value,
        path: "models.providers.openai.apiKey",
      }),
    ).toEqual({
      status: "available",
      value: normalized,
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

  it("prioritizes explicit refValue over retained plaintext in inspect mode", () => {
    expect(
      resolveSecretInputString({
        value: "retained-plaintext",
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

  it.each([
    {
      name: "inline ref",
      value: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      refValue: undefined,
    },
    {
      name: "explicit ref with retained plaintext",
      value: "retained-plaintext",
      refValue: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    },
  ])(
    "throws a typed unresolved SecretRef error in strict mode for $name",
    ({ value, refValue }) => {
      let thrown: unknown;
      try {
        resolveSecretInputString({
          value,
          refValue,
          path: "models.providers.openai.apiKey",
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UnresolvedSecretInputError);
      expect(isUnresolvedSecretInputError(thrown)).toBe(true);
      expect(thrown).toMatchObject({
        path: "models.providers.openai.apiKey",
        ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      });
    },
  );
});

describe("normalizeResolvedSecretInputString", () => {
  it("keeps explicit references authoritative over retained plaintext", () => {
    expect(() =>
      normalizeResolvedSecretInputString({
        value: "retained-plaintext",
        refValue: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        path: "models.providers.openai.apiKey",
      }),
    ).toThrow(UnresolvedSecretInputError);
  });
});

describe("parseLegacySecretRefEnvMarker", () => {
  it("parses legacy env marker strings without making them valid SecretInput strings", () => {
    expect(parseLegacySecretRefEnvMarker("secretref-env:OPENAI_API_KEY")).toEqual({
      source: "env",
      provider: "default",
      id: "OPENAI_API_KEY",
    });
    expect(parseLegacySecretRefEnvMarker("__env__:BAILIAN_API_KEY")).toEqual({
      source: "env",
      provider: "default",
      id: "BAILIAN_API_KEY",
    });
    expect(parseLegacySecretRefEnvMarker("secretref-env:not-valid")).toBeNull();
    expect(
      resolveSecretInputString({
        value: "secretref-env:OPENAI_API_KEY",
        path: "models.providers.openai.apiKey",
        mode: "inspect",
      }),
    ).toEqual({
      status: "available",
      value: "secretref-env:OPENAI_API_KEY",
      ref: null,
    });
  });
});
