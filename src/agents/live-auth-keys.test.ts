import { beforeAll, describe, expect, it, vi } from "vitest";

vi.unmock("../secrets/provider-env-vars.js");

let collectProviderApiKeys: typeof import("./live-auth-keys.js").collectProviderApiKeys;
let isAnthropicBillingError: typeof import("./live-auth-keys.js").isAnthropicBillingError;

async function loadModulesForTest(): Promise<void> {
  vi.resetModules();
  vi.doUnmock("../secrets/provider-env-vars.js");
  ({ collectProviderApiKeys, isAnthropicBillingError } = await import("./live-auth-keys.js"));
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

describe("isAnthropicBillingError", () => {
  it("does not false-positive on plain 'a 402' prose", () => {
    const samples = [
      "Use a 402 stainless bolt",
      "Book a 402 room",
      "There is a 402 near me",
      "The building at 402 Main Street",
    ];

    for (const sample of samples) {
      expect(isAnthropicBillingError(sample)).toBe(false);
    }
  });

  it("matches real 402 billing payload contexts including JSON keys", () => {
    const samples = [
      "HTTP 402 Payment Required",
      "status: 402",
      "error code 402",
      '{"status":402,"type":"error"}',
      '{"code":402,"message":"payment required"}',
      '{"error":{"code":402,"message":"billing hard limit reached"}}',
      "got a 402 from the API",
      "returned 402",
      "received a 402 response",
    ];

    for (const sample of samples) {
      expect(isAnthropicBillingError(sample)).toBe(true);
    }
  });
});
