import type { ProviderFastModePolicyContext } from "openclaw/plugin-sdk/provider-model-types";
import { describe, expect, it } from "vitest";
import { resolveFastModeSupport } from "./fast-mode-policy.js";

const opus: ProviderFastModePolicyContext = {
  provider: "anthropic",
  modelId: "claude-opus-5",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  authMode: "api_key",
  requestCapabilities: { endpointClass: "anthropic-public", allowsAnthropicServiceTier: true },
};

describe("selected request Fast applicability", () => {
  it.each([
    { name: "Sonnet 5", context: { modelId: "claude-sonnet-5" }, expected: false },
    { name: "Opus 5", context: {}, expected: true },
    { name: "legacy Priority Tier", context: { modelId: "claude-sonnet-4-6" }, expected: true },
    { name: "OAuth", context: { authMode: "oauth" }, expected: false },
    { name: "unknown auth", context: { authMode: undefined }, expected: undefined },
    { name: "unclassified token", context: { authMode: "token" }, expected: undefined },
    { name: "unknown API", context: { api: undefined }, expected: undefined },
    {
      name: "native runtime",
      context: { modelId: "claude-sonnet-5", runtimeId: "codex" },
      expected: undefined,
    },
    {
      name: "explicit tier",
      context: { params: { serviceTier: "standard_only" } },
      expected: false,
    },
    { name: "invalid tier", context: { params: { serviceTier: "invalid" } }, expected: true },
    {
      name: "proxy",
      context: {
        requestCapabilities: { endpointClass: "custom", allowsAnthropicServiceTier: false },
      },
      expected: false,
    },
  ] satisfies {
    name: string;
    context: Partial<ProviderFastModePolicyContext>;
    expected: boolean | undefined;
  }[])("preserves $name applicability", ({ context, expected }) => {
    expect(resolveFastModeSupport({ ...opus, ...context })).toBe(expected);
  });
});
