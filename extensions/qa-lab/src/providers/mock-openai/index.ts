import { createMockQaProviderDefinition } from "../shared/mock-provider-definition.js";

export const mockOpenAiProviderDefinition = createMockQaProviderDefinition({
  mode: "mock-openai",
  commandName: "mock-openai",
  commandDescription: "Run the local mock OpenAI Responses API server for QA",
  serverLabel: "QA mock OpenAI",
  mockAuthProviders: ["openai", "anthropic"],
});
