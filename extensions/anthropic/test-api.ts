/**
 * Test API barrel for Anthropic plugin internals. Tests import this path to
 * avoid reaching into unrelated runtime modules.
 */
export { buildAnthropicCliBackend } from "./cli-backend.js";
export { normalizeClaudeBackendConfig } from "./cli-shared.js";
export { anthropicMediaUnderstandingProvider } from "./media-understanding-provider.js";
