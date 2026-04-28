import { describeProviderContracts } from "openclaw/plugin-sdk/provider-test-contracts";
import { describeWebSearchProviderContracts } from "openclaw/plugin-sdk/provider-test-contracts";

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
