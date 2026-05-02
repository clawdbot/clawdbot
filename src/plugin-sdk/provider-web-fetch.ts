// Public web-fetch registration helpers for provider plugins.

import type {
  WebFetchCredentialResolutionSource,
  WebFetchProviderPlugin,
  WebFetchProviderToolDefinition,
} from "../plugins/types.js";
export { jsonResult, readNumberParam, readStringParam } from "../agents/tools/common.js";
export {
  withSelfHostedWebToolsEndpoint,
  withStrictWebToolsEndpoint,
  withTrustedWebToolsEndpoint,
} from "../agents/tools/web-guarded-fetch.js";
export { markdownToText, truncateText } from "../agents/tools/web-fetch-utils.js";
export {
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  writeCache,
} from "../agents/tools/web-shared.js";
export { enablePluginInConfig } from "../plugins/enable.js";
export { wrapExternalContent, wrapWebContent } from "../security/external-content.js";
export type {
  WebFetchCredentialResolutionSource,
  WebFetchProviderPlugin,
  WebFetchProviderToolDefinition,
};
