// Focused public test contracts for native agent-runtime adapters.

export {
  AUTH_PROFILE_RUNTIME_CONTRACT,
  createAuthAliasManifestRegistry,
  expectedForwardedAuthProfile,
} from "./test-helpers/agents/auth-profile-runtime-contract.js";
export { DELIVERY_NO_REPLY_RUNTIME_CONTRACT } from "./test-helpers/agents/delivery-no-reply-runtime-contract.js";
export {
  installCodexToolResultMiddleware,
  installOpenClawOwnedToolHooks,
  mediaToolResult,
  resetOpenClawOwnedToolHooks,
  textToolResult,
} from "./test-helpers/agents/openclaw-owned-tool-runtime-contract.js";
export {
  createContractFallbackConfig,
  createContractRunResult,
  OUTCOME_FALLBACK_RUNTIME_CONTRACT,
} from "./test-helpers/agents/outcome-fallback-runtime-contract.js";
export {
  CODEX_CONTRACT_PROVIDER_ID,
  codexPromptOverlayContext,
  GPT5_CONTRACT_MODEL_ID,
  GPT5_PREFIXED_CONTRACT_MODEL_ID,
  NON_GPT5_CONTRACT_MODEL_ID,
  NON_OPENAI_CONTRACT_PROVIDER_ID,
  OPENAI_CODEX_CONTRACT_PROVIDER_ID,
  OPENAI_CONTRACT_PROVIDER_ID,
  openAiPluginPersonalityConfig,
  sharedGpt5PersonalityConfig,
} from "./test-helpers/agents/prompt-overlay-runtime-contract.js";
export {
  createNativeOpenAICodexResponsesModel,
  createNativeOpenAIResponsesModel,
  createParameterFreeTool,
  createPermissiveTool,
  createProxyOpenAIResponsesModel,
  createStrictCompatibleTool,
  normalizedParameterFreeSchema,
} from "./test-helpers/agents/schema-normalization-runtime-contract.js";
export {
  assistantHistoryMessage,
  currentPromptHistoryMessage,
  inlineDataUriOrphanLeaf,
  mediaOnlyHistoryMessage,
  QUEUED_USER_MESSAGE_MARKER,
  structuredHistoryMessage,
  structuredOrphanLeaf,
  textOrphanLeaf,
} from "./test-helpers/agents/transcript-repair-runtime-contract.js";
