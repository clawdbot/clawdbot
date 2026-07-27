/** Diagnostic codes emitted while selecting runtime web search/fetch providers. */
export type RuntimeWebDiagnosticCode =
  | "WEB_SEARCH_PROVIDER_INVALID_AUTODETECT"
  | "WEB_SEARCH_AUTODETECT_SELECTED"
  | "WEB_SEARCH_KEY_UNRESOLVED_FALLBACK_USED"
  | "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK"
  | "WEB_FETCH_PROVIDER_INVALID_AUTODETECT"
  | "WEB_FETCH_AUTODETECT_SELECTED"
  | "WEB_FETCH_PROVIDER_KEY_UNRESOLVED_FALLBACK_USED"
  | "WEB_FETCH_PROVIDER_KEY_UNRESOLVED_NO_FALLBACK";

/** User-facing diagnostic attached to runtime web-tool metadata. */
export type RuntimeWebDiagnostic = {
  code: RuntimeWebDiagnosticCode;
  message: string;
  path?: string;
};

/** Runtime selection metadata for the web search tool. */
export type RuntimeWebSearchMetadata = {
  /** Provider explicitly configured in source config, before auto-detect fallback. */
  providerConfigured?: string;
  providerSource: "configured" | "auto-detect" | "none";
  /** Provider that runtime calls should use after config validation and credential lookup. */
  selectedProvider?: string;
  /** Source that supplied the selected provider credential, or why it is unavailable. */
  selectedProviderKeySource?: "config" | "secretRef" | "env" | "missing";
  /** Perplexity transport chosen from provider config or runtime default. */
  perplexityTransport?: "search_api" | "chat_completions";
  diagnostics: RuntimeWebDiagnostic[];
};

/** Runtime selection metadata for the web fetch tool. */
export type RuntimeWebFetchMetadata = {
  /** Provider explicitly configured in source config, before auto-detect fallback. */
  providerConfigured?: string;
  providerSource: "configured" | "auto-detect" | "none";
  /** Provider that runtime calls should use after config validation and credential lookup. */
  selectedProvider?: string;
  /** Source that supplied the selected provider credential, or why it is unavailable. */
  selectedProviderKeySource?: "config" | "secretRef" | "env" | "missing";
  diagnostics: RuntimeWebDiagnostic[];
};

/** Combined runtime metadata for web search/fetch tools and shared diagnostics. */
export type RuntimeWebToolsMetadata = {
  search: RuntimeWebSearchMetadata;
  fetch: RuntimeWebFetchMetadata;
  diagnostics: RuntimeWebDiagnostic[];
};
