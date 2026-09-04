/**
 * Claude model-family policy helpers for provider policy artifacts.
 *
 * Provider policy artifacts (`provider-policy-api.js`) load eagerly whenever a
 * provider is resolved, so their module graph must stay leaf-light. This
 * subpath re-exports the Claude identity and thinking helpers from their leaf
 * owners; importing them through `provider-model-shared` drags the transport
 * and compat graph into every policy load (~60s under jiti in source checkouts).
 */
export { resolveClaudeModelIdentity, resolveClaudeMythos5ModelIdentity } from "@openclaw/llm-core";
export { resolveClaudeThinkingProfile } from "../plugins/provider-claude-thinking.js";
