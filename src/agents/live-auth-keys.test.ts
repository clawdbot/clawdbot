/**
 * Regression coverage for live-test provider API-key discovery.
 * Verifies env precedence, manifest fallback, and non-secret error classifiers.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.unmock("../secrets/provider-env-vars.js");

let collectProviderApiKeys: typeof import("./live-auth-keys.js").collectProviderApiKeys;
let isApiKeyRateLimitError: typeof import("./live-auth-keys.js").isApiKeyRateLimitError;

async function loadModulesForTest(): Promise<void> {
  vi.resetModules();
  vi.doUnmock("../secrets/provider-env-vars.js");
  ({ collectProviderApiKeys, isApiKeyRateLimitError } = await import("./live-auth-keys.js"));
}

beforeAll(async () => {
  await loadModulesForTest();
});

describe("collectProviderApiKeys", () => {
  it("honors provider auth env vars with nonstandard names", () => {
    const env = { MODELSTUDIO_API_KEY: "modelstudio-live-key" };

    expect(
      collectProviderApiKeys("alibaba", {
        env,
        providerEnvVars: ["MODELSTUDIO_API_KEY", "DASHSCOPE_API_KEY"],
      }),
    ).toEqual(["modelstudio-live-key"]);
  });

  it("dedupes manifest env vars against direct provider env naming", () => {
    const env = { XAI_API_KEY: "xai-live-key" };

    expect(
      collectProviderApiKeys("xai", {
        env,
        providerEnvVars: ["XAI_API_KEY"],
      }),
    ).toEqual(["xai-live-key"]);
  });
});

describe("isApiKeyRateLimitError", () => {
  it.each([
    "rate_limit",
    "rate limit reached",
    "HTTP 429 too many requests",
    "quota exceeded",
    "quota_exceeded",
    "resource exhausted",
    "resource_exhausted",
    "too many requests",
  ])("preserves the intentional key-rotation signal %s", (message) => {
    expect(isApiKeyRateLimitError(message)).toBe(true);
  });

  it.each([
    "request id req-4291 failed",
    "model gpt-5.5-preview-0429 not found",
    "input length 14295 tokens exceeds the model limit",
    "429 insufficient_quota",
  ])("does not rotate keys for the non-rate-limit signal %s", (message) => {
    // FIXED(refactor-06): embedded numbers and billing quota failures are not key-local throttles.
    expect(isApiKeyRateLimitError(message)).toBe(false);
  });
});
