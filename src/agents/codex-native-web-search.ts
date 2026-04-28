import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hasAvailableCodexAuth,
  isCodexNativeSearchEligibleModel,
} from "./codex-native-web-search-core.js";
import { resolveCodexNativeWebSearchConfig } from "./codex-native-web-search.shared.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";
export {
  buildCodexNativeWebSearchTool,
  type CodexNativeSearchActivation,
  type CodexNativeSearchPayloadPatchResult,
  hasAvailableCodexAuth,
  hasCodexNativeWebSearchTool,
  isCodexNativeSearchEligibleModel,
  patchCodexNativeWebSearchPayload,
  resolveCodexNativeSearchActivation,
  shouldSuppressManagedWebSearchTool,
} from "./codex-native-web-search-core.js";
export {
  type CodexNativeSearchContextSize,
  type CodexNativeSearchMode,
  type CodexNativeSearchUserLocation,
  describeCodexNativeWebSearch,
  type ResolvedCodexNativeWebSearchConfig,
  resolveCodexNativeWebSearchConfig,
} from "./codex-native-web-search.shared.js";

export function isCodexNativeWebSearchRelevant(params: {
  config: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
}): boolean {
  if (resolveCodexNativeWebSearchConfig(params.config).enabled) {
    return true;
  }
  if (hasAvailableCodexAuth(params)) {
    return true;
  }

  const defaultModel = resolveDefaultModelForAgent({
    cfg: params.config,
    agentId: params.agentId,
  });
  const configuredProvider = params.config.models?.providers?.[defaultModel.provider];
  const configuredModelApi = configuredProvider?.models?.find(
    (candidate) => candidate.id === defaultModel.model,
  )?.api;
  return isCodexNativeSearchEligibleModel({
    modelProvider: defaultModel.provider,
    modelApi: configuredModelApi ?? configuredProvider?.api,
  });
}
