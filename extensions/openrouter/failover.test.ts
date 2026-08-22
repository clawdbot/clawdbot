// OpenRouter failover tests keep vendor error policy at its owning plugin boundary.
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeAll, describe, expect, it } from "vitest";
import openrouterPlugin from "./index.js";

let provider: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;

beforeAll(async () => {
  provider = await registerSingleProviderPlugin(openrouterPlugin);
});

function classifyOpenRouterFailure(errorMessage: string, providerId?: string) {
  return provider.classifyFailoverReason?.({ provider: providerId, errorMessage });
}

describe("OpenRouter failover classification", () => {
  it.each([
    ["Key limit exceeded", "billing"],
    ["HTTP 401: 401 Key limit reached (monthly limit)", "billing"],
    ["Key limit hit", "billing"],
    [
      "HTTP 403: 403 API key budget limit exceeded (monthly limit). Contact your org admin.",
      "billing",
    ],
    ["API key budget limit reached", "billing"],
    ["API key budget limit hit", "billing"],
    ["Provider returned error", "timeout"],
  ] as const)("maps %s to %s", (errorMessage, expected) => {
    expect(classifyOpenRouterFailure(errorMessage, "openrouter")).toBe(expected);
  });

  it.each([undefined, "anthropic", "custom-openrouter"])(
    "does not apply OpenRouter policy to provider %s",
    (providerId) => {
      expect(classifyOpenRouterFailure("Key limit exceeded", providerId)).toBeUndefined();
      expect(classifyOpenRouterFailure("Provider returned error", providerId)).toBeUndefined();
    },
  );
});
