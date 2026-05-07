import { describeProviderContracts } from "../../plugin-sdk/test-helpers/provider-contract.js";
import { describeWebSearchProviderContracts } from "../../plugin-sdk/test-helpers/web-search-provider-contract.js";

for (const providerId of [
  "anthropic",
  "fal",
  "google",
  "minimax",
  "moonshot",
  "openai",
  "openrouter",
  "xai",
] as const) {
  describeProviderContracts(providerId);
}

for (const providerId of [
  "brave",
  "duckduckgo",
  "exa",
  "firecrawl",
  "google",
  "minimax",
  "moonshot",
  "perplexity",
  "tavily",
  "xai",
] as const) {
  describeWebSearchProviderContracts(providerId);
}
