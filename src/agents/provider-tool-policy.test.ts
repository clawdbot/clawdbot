import { describe, expect, it } from "vitest";
import {
  isCanonicalToolProviderPolicyKey,
  normalizeToolProviderPolicyKey,
  resolveProviderToolPolicy,
  resolveProviderToolPolicyEntry,
} from "./provider-tool-policy.js";

describe("provider tool policy", () => {
  it("normalizes provider and model keys", () => {
    expect(normalizeToolProviderPolicyKey(" OpenAI/GPT-5 ")).toBe("openai/gpt-5");
    expect(isCanonicalToolProviderPolicyKey("openai/gpt-5")).toBe(true);
    expect(isCanonicalToolProviderPolicyKey("openai/")).toBe(false);
  });

  it("prefers canonical entries over aliases", () => {
    const entry = resolveProviderToolPolicyEntry({
      byProvider: {
        "amazon-bedrock": { profile: "alias" },
        bedrock: { profile: "canonical" },
      },
      modelProvider: "bedrock",
    });

    expect(entry).toEqual({
      key: "bedrock",
      policy: { profile: "canonical" },
    });
  });

  it("keeps slash-containing model ids inside the selected provider", () => {
    expect(
      resolveProviderToolPolicy({
        byProvider: {
          "anthropic/claude-sonnet": { deny: ["exec"] },
          "openrouter/anthropic/claude-sonnet": { deny: ["read"] },
        },
        modelProvider: "openrouter",
        modelId: "anthropic/claude-sonnet",
      }),
    ).toEqual({ deny: ["read"] });
  });

  it("ignores malformed provider policy entries", () => {
    expect(
      resolveProviderToolPolicy({
        byProvider: {
          openai: "not a policy",
          anthropic: { profile: "minimal" },
        },
        modelProvider: "openai",
      }),
    ).toBeUndefined();
  });
});
