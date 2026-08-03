/**
 * Public Anthropic provider API barrel. It exposes provider construction,
 * Claude CLI helpers, and stream wrappers for config/runtime consumers.
 */
export { CLAUDE_CLI_BACKEND_ID, isClaudeCliProvider } from "./cli-shared.js";
export { buildAnthropicProvider } from "./register.runtime.js";
export {
  createAnthropicBetaHeadersWrapper,
  createAnthropicFastModeWrapper,
  createAnthropicServiceTierWrapper,
  resolveAnthropicBetas,
  resolveAnthropicFastMode,
  resolveAnthropicServiceTier,
  wrapAnthropicProviderStream,
} from "./stream-wrappers.js";
