/**
 * Public SDK subpath for provider stream event and family helpers.
 */
export {
  createCodexNativeWebSearchWrapper,
  createOpenAIAttributionHeadersWrapper,
  createOpenAIFastModeWrapper,
  createOpenAIReasoningCompatibilityWrapper,
  createOpenAIResponsesContextManagementWrapper,
  createOpenAIServiceTierWrapper,
  createOpenAITextVerbosityWrapper,
  buildProviderStreamFamilyHooks,
  getOpenRouterModelCapabilities,
  loadOpenRouterModelCapabilities,
  // Legacy shortcuts must remain identity aliases across both shipped SDK subpaths.
  GOOGLE_THINKING_STREAM_HOOKS,
  KILOCODE_THINKING_STREAM_HOOKS,
  MINIMAX_FAST_MODE_STREAM_HOOKS,
  MOONSHOT_THINKING_STREAM_HOOKS,
  OPENAI_RESPONSES_STREAM_HOOKS,
  OPENROUTER_THINKING_STREAM_HOOKS,
  TOOL_STREAM_DEFAULT_ON_HOOKS,
  resolveOpenAIFastMode,
  resolveOpenAIServiceTier,
  resolveOpenAITextVerbosity,
} from "./provider-stream.js";
