// Openzoo tests cover provider auth plugin behavior.
import { CUSTOM_LOCAL_AUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { describe, expect, it } from "vitest";
import {
  hasOpenzooAuthorizationHeader,
  isOpenzooKeylessApiKey,
  resolveOpenzooProviderAuthMode,
  shouldUseOpenzooSyntheticAuth,
} from "./provider-auth.js";
import {
  buildOpenzooModelDefinition,
  OPENZOO_LOCAL_API_KEY_PLACEHOLDER,
} from "./provider-models.js";

function createProviderConfig(overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return {
    baseUrl: "http://localhost:8402/v1",
    api: "openai-completions",
    models: [buildOpenzooModelDefinition()],
    ...overrides,
  };
}

describe("openzoo provider auth", () => {
  it("synthesizes local auth for a keyless configured provider", () => {
    expect(shouldUseOpenzooSyntheticAuth(createProviderConfig())).toBe(true);
    expect(
      shouldUseOpenzooSyntheticAuth(
        createProviderConfig({ apiKey: OPENZOO_LOCAL_API_KEY_PLACEHOLDER }),
      ),
    ).toBe(true);
    expect(
      shouldUseOpenzooSyntheticAuth(createProviderConfig({ apiKey: CUSTOM_LOCAL_AUTH_MARKER })),
    ).toBe(true);
    expect(shouldUseOpenzooSyntheticAuth(createProviderConfig({ apiKey: "   " }))).toBe(true);
  });

  it("does not synthesize auth when a real credential or Authorization header exists", () => {
    expect(shouldUseOpenzooSyntheticAuth(createProviderConfig({ apiKey: "real-key" }))).toBe(false);
    expect(
      shouldUseOpenzooSyntheticAuth(
        createProviderConfig({ headers: { Authorization: "Bearer proxy-token" } }),
      ),
    ).toBe(false);
    expect(
      shouldUseOpenzooSyntheticAuth(
        createProviderConfig({ headers: { "X-Proxy-Auth": "proxy-token" } }),
      ),
    ).toBe(true);
  });

  it("does not synthesize auth without configured models", () => {
    expect(shouldUseOpenzooSyntheticAuth(createProviderConfig({ models: [] }))).toBe(false);
    expect(shouldUseOpenzooSyntheticAuth(undefined)).toBe(false);
  });

  it("treats only real credentials as api-key auth", () => {
    expect(resolveOpenzooProviderAuthMode("real-key")).toBe("api-key");
    expect(resolveOpenzooProviderAuthMode(OPENZOO_LOCAL_API_KEY_PLACEHOLDER)).toBeUndefined();
    expect(resolveOpenzooProviderAuthMode(CUSTOM_LOCAL_AUTH_MARKER)).toBeUndefined();
    expect(resolveOpenzooProviderAuthMode("")).toBeUndefined();
    expect(resolveOpenzooProviderAuthMode(undefined)).toBeUndefined();
  });

  it("recognizes the keyless markers", () => {
    expect(isOpenzooKeylessApiKey(` ${OPENZOO_LOCAL_API_KEY_PLACEHOLDER} `)).toBe(true);
    expect(isOpenzooKeylessApiKey(CUSTOM_LOCAL_AUTH_MARKER)).toBe(true);
    expect(isOpenzooKeylessApiKey("real-key")).toBe(false);
    expect(isOpenzooKeylessApiKey(undefined)).toBe(false);
  });

  it("detects Authorization headers case-insensitively", () => {
    expect(hasOpenzooAuthorizationHeader({ authorization: "Bearer token" })).toBe(true);
    expect(hasOpenzooAuthorizationHeader({ Authorization: "" })).toBe(false);
    expect(hasOpenzooAuthorizationHeader({ "X-Other": "1" })).toBe(false);
    expect(hasOpenzooAuthorizationHeader(undefined)).toBe(false);
    expect(hasOpenzooAuthorizationHeader(["Authorization"])).toBe(false);
  });
});
