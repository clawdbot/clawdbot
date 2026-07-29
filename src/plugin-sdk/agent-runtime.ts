import {
  getPreparedModelCatalogSnapshot,
  loadPreparedModelCatalog,
  type LoadPreparedModelCatalogParams,
} from "../agents/prepared-model-catalog.js";
/**
 * @deprecated Broad public SDK barrel. Prefer focused agent/runtime subpaths
 * and avoid adding new imports here.
 */
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";

export {
  listAgentIds,
  resolveAgentEffectiveModelPrimary,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentDir,
  resolveSessionAgentIds,
  setAgentEffectiveModelPrimary,
} from "../agents/agent-scope.js";

export { DEFAULT_PROVIDER } from "../agents/defaults.js";
// Consumed by the codex plugin's app-server usage surface.
export { CODEX_APP_SERVER_AUTH_MARKER } from "../agents/model-auth-markers.js";
export { resolveAgentAvatar } from "../agents/identity-avatar.js";
export type { AgentAvatarResolution } from "../agents/identity-avatar.js";
export {
  resolveAckReaction,
  resolveAgentIdentity,
  resolveHumanDelayConfig,
  resolveIdentityNamePrefix,
} from "../agents/identity.js";

export { resolveApiKeyForProvider } from "../agents/model-auth.js";
export { findModelInCatalog, modelSupportsVision } from "../agents/model-catalog.js";
export type { ModelCatalogEntry } from "../agents/model-catalog.js";
export { getPreparedModelCatalogSnapshot, loadPreparedModelCatalog };

type LoadModelCatalogCompatibilityParams = LoadPreparedModelCatalogParams & {
  /** @deprecated Lifecycle publication owns refreshes; retained for source compatibility. */
  useCache?: boolean;
  /** @deprecated Use getPreparedModelCatalogSnapshot for new nonblocking readers. */
  cacheOnly?: boolean;
  /** @deprecated Plugin metadata belongs to the published lifecycle generation. */
  metadataSnapshot?: PluginMetadataSnapshot;
};

/** @deprecated Use loadPreparedModelCatalog or getPreparedModelCatalogSnapshot. */
export async function loadModelCatalog(params: LoadModelCatalogCompatibilityParams = {}) {
  const { agentId, agentDir, cacheOnly, config, env, readOnly, workspaceDir } = params;
  const preparedParams: LoadPreparedModelCatalogParams = {
    ...(agentId ? { agentId } : {}),
    ...(agentDir ? { agentDir } : {}),
    ...(config ? { config } : {}),
    ...(env ? { env } : {}),
    ...(readOnly !== undefined ? { readOnly } : {}),
    ...(workspaceDir ? { workspaceDir } : {}),
  };
  if (cacheOnly) {
    return getPreparedModelCatalogSnapshot(preparedParams)?.entries ?? [];
  }
  return await loadPreparedModelCatalog(preparedParams);
}

export {
  buildModelAliasIndex,
  findNormalizedProviderValue,
  parseModelRef,
  resolveAllowedModelRef,
  resolveModelRefFromString,
  resolveThinkingDefaultWithRuntimeCatalog,
} from "../agents/model-selection.js";

export { EmbeddedBlockChunker } from "../agents/embedded-agent-block-chunker.js";
export { formatReasoningMessage } from "../agents/embedded-agent-utils.js";
export { resolveProviderIdForAuth } from "../agents/provider-auth-aliases.js";
export type { ProviderAuthAliasLookupParams } from "../agents/provider-auth-aliases.js";

export {
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
  readStringArrayParam,
} from "../agents/tools/common.js";

// Intentional public runtime surface: channel plugins use ingress agent helpers directly.
export { agentCommandFromIngress } from "../agents/agent-command.js";
export { getTtsProvider, resolveTtsConfig, resolveTtsPrefsPath } from "../tts/tts.js";
export type { ResolvedTtsConfig } from "../tts/tts.js";

export {
  listProfilesForProvider,
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  loadAuthProfileStoreWithoutExternalProfiles,
  loadAuthProfileStoreForSecretsRuntime,
  loadAuthProfileStoreForRuntime,
  replaceRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
  findPersistedAuthProfileCredential,
  resolvePersistedAuthProfileOwnerAgentDir,
  clearExpiredCooldowns,
  isProfileInCooldown,
  markAuthProfileBlockedUntil,
  refreshOAuthCredentialForRuntime,
  resolveProfilesUnavailableReason,
  resolveProfileUnusableUntilForDisplay,
  resolveApiKeyForProfile,
  resolveAuthProfileEligibility,
  resolveAuthProfileOrder,
  resolveAuthStorePathForDisplay,
} from "../agents/auth-profiles.js";
export type {
  AuthProfileCredential,
  AuthProfileFailureReason,
  AuthProfileStore,
  OAuthCredential,
} from "../agents/auth-profiles.js";

export { buildConfiguredModelCatalog } from "../agents/model-selection-shared.js";
export { extractAssistantText } from "../agents/embedded-agent-utils.js";
export { jsonResult } from "../agents/tools/tool-results.js";
export { readStringParam } from "../agents/tools/common.js";
export {
  resolveAgentConfig,
  resolveAgentDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope-config.js";
export { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
export { resolveThinkingDefault } from "../agents/model-thinking-default.js";
