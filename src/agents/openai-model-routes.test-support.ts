import type {
  ProviderModelRouteCandidate,
  ProviderModelRouteResolution,
} from "../plugin-sdk/provider-model-types.js";

export const platformRoute = {
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  authRequirement: "api-key",
  requestTransportOverrides: "none",
  runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
} satisfies ProviderModelRouteCandidate;

export const subscriptionRoute = {
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authRequirement: "subscription",
  requestTransportOverrides: "none",
  runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
} satisfies ProviderModelRouteCandidate;

export const dualRoutes = {
  kind: "routes",
  defaultRuntimeId: "codex",
  routes: [platformRoute, subscriptionRoute],
} satisfies ProviderModelRouteResolution;

/**
 * Canned OpenAI route resolution for tests that `vi.mock` the route resolver module.
 * `undefined` keeps the real resolver; the mocking test resets it after each case.
 */
export const openAIModelRoutesMock = {
  resolution: undefined as ProviderModelRouteResolution | null | undefined,
};
