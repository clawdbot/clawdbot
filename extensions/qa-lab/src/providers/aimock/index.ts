import { createMockQaProviderDefinition } from "../shared/mock-provider-definition.js";

export const aimockProviderDefinition = createMockQaProviderDefinition({
  mode: "aimock",
  commandName: "aimock",
  commandDescription: "Run the local AIMock provider server for QA",
  serverLabel: "QA AIMock",
  mockAuthProviders: ["aimock", "openai", "anthropic"],
});
