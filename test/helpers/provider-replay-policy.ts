import { expect } from "vitest";
import { registerSingleProviderPlugin } from "./plugins/plugin-registration.js";

export async function expectPassthroughReplayPolicy(params: {
  modelId: string;
  plugin: unknown;
  providerId: string;
  sanitizeThoughtSignatures?: boolean;
}) {
  const provider = await registerSingleProviderPlugin(params.plugin as never);
  const policy = provider.buildReplayPolicy?.({
    provider: params.providerId,
    modelApi: "openai-completions",
    modelId: params.modelId,
  } as never);

  expect(policy).toMatchObject({
    applyAssistantFirstOrderingFix: false,
    validateGeminiTurns: false,
    validateAnthropicTurns: false,
  });

  if (params.sanitizeThoughtSignatures) {
    expect(policy).toMatchObject({
      sanitizeThoughtSignatures: {
        allowBase64Only: true,
        includeCamelCase: true,
      },
    });
  } else {
    expect(policy).not.toHaveProperty("sanitizeThoughtSignatures");
  }

  return provider;
}
