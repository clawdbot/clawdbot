// Web search runtime types describe search provider factories and dependencies.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  PluginWebSearchProviderEntry,
  WebSearchProviderToolDefinition,
} from "../plugins/web-provider-types.js";
import type { RuntimeWebSearchMetadata } from "../secrets/runtime-web-tools.types.js";

// Shared web_search runtime contracts. Keep these in a types-only module so
// provider registries and callers can import them without loading runtime code.
type WebSearchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { search?: infer Search }
    ? Search
    : undefined
  : undefined;

/** Provider/tool resolution inputs for web_search. */
export type ResolveWebSearchDefinitionParams = {
  config?: OpenClawConfig;
  agentDir?: string;
  sandboxed?: boolean;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
  providerId?: string;
  preferRuntimeProviders?: boolean;
  preferInputConfig?: boolean;
};

/** Inputs for executing a web_search request through the selected provider. */
export type RunWebSearchParams = ResolveWebSearchDefinitionParams & {
  args: Record<string, unknown>;
  signal?: AbortSignal;
};

/** Normalized execution result that records which provider answered. */
export type RunWebSearchResult = {
  provider: string;
  result: Record<string, unknown>;
};

/** List-provider query parameters. */
export type ListWebSearchProvidersParams = {
  config?: OpenClawConfig;
};

export type RuntimeWebSearchProviderEntry = PluginWebSearchProviderEntry;
export type RuntimeWebSearchToolDefinition = WebSearchProviderToolDefinition;
export type RuntimeWebSearchConfig = WebSearchConfig;
