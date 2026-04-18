import { describeProviderContracts } from "../../../test/helpers/plugins/provider-contract.js";
import { describeWebSearchProviderContracts } from "../../../test/helpers/plugins/web-search-provider-contract.js";

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
  "moonshot",
  "perplexity",
  "tavily",
  "xai",
] as const) {
  describeWebSearchProviderContracts(providerId);
}
