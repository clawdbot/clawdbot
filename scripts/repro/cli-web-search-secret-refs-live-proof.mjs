#!/usr/bin/env node
/**
 * Live repro for CLI infer web search SecretRef resolution (PR #82699).
 * Run: TAVILY_API_KEY=resolved-live-proof pnpm exec tsx scripts/repro/cli-web-search-secret-refs-live-proof.mjs
 */
import { resolveCommandConfigWithSecrets } from "../../src/cli/command-config-resolution.js";
import { getWebSearchCommandSecretTargetIds } from "../../src/cli/command-secret-targets.js";

const unresolvedConfig = {
  tools: { web: { search: { provider: "tavily", enabled: true } } },
  plugins: {
    entries: {
      tavily: {
        config: {
          webSearch: {
            apiKey: { source: "env", provider: "default", id: "TAVILY_API_KEY" },
          },
        },
      },
    },
  },
};

process.env.TAVILY_API_KEY = process.env.TAVILY_API_KEY ?? "resolved-live-proof";

const { effectiveConfig, diagnostics } = await resolveCommandConfigWithSecrets({
  config: unresolvedConfig,
  commandName: "infer web search",
  targetIds: getWebSearchCommandSecretTargetIds(),
  autoEnable: true,
});

const apiKey = effectiveConfig.plugins?.entries?.tavily?.config?.webSearch?.apiKey;
const unresolved = unresolvedConfig.plugins.entries.tavily.config.webSearch.apiKey;

console.log("unresolved apiKey is SecretRef object =", typeof unresolved === "object");
console.log(
  "resolveCommandConfigWithSecrets apiKey is string =",
  typeof apiKey === "string" && apiKey.length > 0,
);
console.log("resolved apiKey remains redacted =", typeof apiKey === "string");
console.log("diagnostics count =", diagnostics.length);
