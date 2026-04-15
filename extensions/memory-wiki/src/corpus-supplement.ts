import type { OpenClawConfig } from "../api.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { getMemoryWikiPage, searchMemoryWiki } from "./query.js";

export function createWikiCorpusSupplement(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
}) {
  return {
    search: async (input: { query: string; maxResults?: number; agentSessionKey?: string }) =>
      await searchMemoryWiki({
        config: params.config,
        appConfig: params.appConfig,
        agentSessionKey: input.agentSessionKey,
        query: input.query,
        maxResults: input.maxResults,
        searchBackend: "local",
        searchCorpus: "wiki",
      }),
    get: async (input: {
      lookup: string;
      fromLine?: number;
      lineCount?: number;
      agentSessionKey?: string;
    }) =>
      await getMemoryWikiPage({
        config: params.config,
        appConfig: params.appConfig,
        agentSessionKey: input.agentSessionKey,
        lookup: input.lookup,
        fromLine: input.fromLine,
        lineCount: input.lineCount,
        searchBackend: "local",
        searchCorpus: "wiki",
      }),
  };
}
