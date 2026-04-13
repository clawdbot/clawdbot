import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "./models-config.providers.secret-helpers.js";
import {
  resolveAwsSdkApiKeyVarName,
  resolveMissingProviderApiKey,
} from "./models-config.providers.secret-helpers.js";

/**
 * Regression tests for #49891 / #50699 / #54274:
 *
 * When the Bedrock provider uses `auth: "aws-sdk"` and no AWS environment
 * variables are set (e.g. EC2 instance role, ECS task role), the
 * normalisation step must NOT inject a fake `apiKey: "AWS_PROFILE"` marker.
 * Doing so poisons the downstream auth resolver and causes
 * "No API key found for amazon-bedrock" errors.
 */
describe("resolveMissingProviderApiKey — aws-sdk auth", () => {
  const baseProvider: ProviderConfig = {
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    api: "bedrock-converse-stream",
    auth: "aws-sdk",
    models: [
      {
        id: "anthropic.claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        input: ["text"],
        reasoning: false,
        cost: { input: 0.003, output: 0.015, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
    ],
  };

  const emptyEnv: NodeJS.ProcessEnv = {};

  it("does NOT inject apiKey when no AWS env vars are set (instance role)", () => {
    const result = resolveMissingProviderApiKey({
      providerKey: "amazon-bedrock",
      provider: baseProvider,
      env: emptyEnv,
      profileApiKey: undefined,
    });

    // Provider should be returned unchanged — no apiKey field added
    expect(result).toBe(baseProvider);
    expect(result.apiKey).toBeUndefined();
  });

  it("does NOT inject apiKey via providerApiKeyResolver when it returns undefined", () => {
    const result = resolveMissingProviderApiKey({
      providerKey: "amazon-bedrock",
      provider: baseProvider,
      env: emptyEnv,
      profileApiKey: undefined,
      providerApiKeyResolver: () => undefined,
    });

    expect(result).toBe(baseProvider);
    expect(result.apiKey).toBeUndefined();
  });

  it("injects apiKey marker when AWS_ACCESS_KEY_ID + SECRET are present", () => {
    const envWithKeys: NodeJS.ProcessEnv = {
      AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", // pragma: allowlist secret
    };

    const result = resolveMissingProviderApiKey({
      providerKey: "amazon-bedrock",
      provider: baseProvider,
      env: envWithKeys,
      profileApiKey: undefined,
    });

    expect(result.apiKey).toBe("AWS_ACCESS_KEY_ID");
  });

  it("injects apiKey marker when AWS_PROFILE is set", () => {
    const envWithProfile: NodeJS.ProcessEnv = {
      AWS_PROFILE: "my-profile",
    };

    const result = resolveMissingProviderApiKey({
      providerKey: "amazon-bedrock",
      provider: baseProvider,
      env: envWithProfile,
      profileApiKey: undefined,
    });

    expect(result.apiKey).toBe("AWS_PROFILE");
  });

  it("injects apiKey marker when AWS_BEARER_TOKEN_BEDROCK is set", () => {
    const envWithBearer: NodeJS.ProcessEnv = {
      AWS_BEARER_TOKEN_BEDROCK: "some-bearer-token",
    };

    const result = resolveMissingProviderApiKey({
      providerKey: "amazon-bedrock",
      provider: baseProvider,
      env: envWithBearer,
      profileApiKey: undefined,
    });

    expect(result.apiKey).toBe("AWS_BEARER_TOKEN_BEDROCK");
  });

  it("skips injection when provider already has apiKey configured", () => {
    const providerWithKey: ProviderConfig = {
      ...baseProvider,
      apiKey: "existing-key",
    };

    const result = resolveMissingProviderApiKey({
      providerKey: "amazon-bedrock",
      provider: providerWithKey,
      env: emptyEnv,
      profileApiKey: undefined,
    });

    // Should return unchanged — already has apiKey
    expect(result).toBe(providerWithKey);
    expect(result.apiKey).toBe("existing-key");
  });

  it("uses providerApiKeyResolver result when it returns a value", () => {
    const result = resolveMissingProviderApiKey({
      providerKey: "amazon-bedrock",
      provider: baseProvider,
      env: emptyEnv,
      profileApiKey: undefined,
      providerApiKeyResolver: () => "AWS_ACCESS_KEY_ID",
    });

    expect(result.apiKey).toBe("AWS_ACCESS_KEY_ID");
  });
});

describe("resolveAwsSdkApiKeyVarName", () => {
  it("returns undefined when AWS auth env markers are absent", () => {
    expect(resolveAwsSdkApiKeyVarName({})).toBeUndefined();
  });

  it("preserves the AWS auth env precedence order", () => {
    expect(
      resolveAwsSdkApiKeyVarName({
        AWS_BEARER_TOKEN_BEDROCK: "bearer",
        AWS_PROFILE: "default",
      }),
    ).toBe("AWS_BEARER_TOKEN_BEDROCK");
    expect(
      resolveAwsSdkApiKeyVarName({
        AWS_PROFILE: "default",
      }),
    ).toBe("AWS_PROFILE");
  });
});
