import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { PreparedAgentCredentialModes } from "../../agents/agent-auth-credential-modes.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { readSessionRuntimeOwnership } from "../../agents/harness/session-runtime-ownership.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import { getPreparedModelRuntimeAuthMaterializations } from "../../agents/prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ChatMetadataReadParams, ChatMetadataResult } from "./chat-metadata-contract.js";
import type { GatewayRequestContext } from "./types.js";

export type ChatMetadataProjectionFacts = {
  agentId: string;
  owner: PreparedModelRuntimeSnapshot;
  authStore: AuthProfileStore;
  authModes: PreparedAgentCredentialModes;
  modelCatalog: ModelCatalogSnapshot;
};

export type PreparedAgentProjection<T = ChatMetadataResult> = {
  modelCatalog: ModelCatalogEntry[];
  read: () => T;
  isCurrent: () => boolean;
};

export async function prepareChatMetadataModelProjection(params: {
  context: GatewayRequestContext;
  facts: ChatMetadataProjectionFacts;
  requesterProfileId?: string;
  preferredProfileId?: string;
  pinnedProfileId?: string;
  assertCurrent?: () => void;
}): Promise<PreparedAgentProjection<{ models?: unknown[] }>> {
  const { prepareModelsListResult, createGatewayAgentModelCatalogProjector } =
    await import("./models-list-result.js");
  // A draft has no persisted session grant: recheck its live human before hydrating private auth.
  params.assertCurrent?.();
  // Chat metadata must stay on process-published facts. Live discovery belongs to explicit
  // models.list control-plane reads so a slow provider cannot delay chat startup.
  const snapshot = params.facts.modelCatalog;
  const projector = createGatewayAgentModelCatalogProjector({
    cfg: params.facts.owner.config,
    agentId: params.facts.agentId,
    snapshot,
    metadataSnapshot: params.facts.owner.metadataSnapshot,
    preparedAuthStore: params.facts.authStore,
    requesterProfileId: params.requesterProfileId,
    // The owner records usable auth at discovery; metadata must share that exact generation fact.
    preparedRuntimeAuthModes: params.facts.authModes,
    preparedRuntimeAuthMaterializations: getPreparedModelRuntimeAuthMaterializations(
      params.facts.owner,
    ),
    pluginRegistry: params.facts.owner.pluginRegistry,
    isCurrent: params.facts.owner.isCurrent,
    observationConfig: params.facts.owner.observationConfig,
    ...(params.preferredProfileId ? { preferredProfileId: params.preferredProfileId } : {}),
    ...(params.pinnedProfileId ? { pinnedProfileId: params.pinnedProfileId } : {}),
  });
  const [modelCatalog, readModels] = await Promise.all([
    projector.projectCatalog(),
    prepareModelsListResult({
      context: params.context,
      agentId: params.facts.agentId,
      params: { view: "configured" },
      preloadedCatalog: {
        agentId: params.facts.agentId,
        config: params.facts.owner.config,
        snapshot,
      },
      preloadedOnly: true,
      catalogProjector: projector,
    }),
  ]);
  return {
    modelCatalog,
    read: () => ({ models: readModels.read().models }),
    isCurrent: readModels.isCurrent,
  };
}

// Read session ownership after the shared profile projection; never cache this overlay.
export function projectChatSessionMetadata(
  readParams: ChatMetadataReadParams,
  metadata: ChatMetadataResult,
  config: OpenClawConfig,
): ChatMetadataResult {
  const ownership = readSessionRuntimeOwnership({ ...readParams, config });
  if (ownership?.auth !== "native" || !metadata.models) {
    return metadata;
  }
  // Pending native branches have no tuple yet. Remove the host-only gate from
  // the rendered placeholder, without calling it a native selection or proving credentials.
  const renderedModel =
    ownership.modelRef ??
    resolveSessionModelRef(config, readParams.sessionEntry, readParams.agentId, {
      allowPluginNormalization: false,
    });
  return {
    ...metadata,
    models: metadata.models.map((model) => {
      const row = asOptionalRecord(model);
      if (row?.provider !== renderedModel.provider || row.id !== renderedModel.model) {
        return model;
      }
      const {
        available: _available,
        unavailableReason: _reason,
        unavailableUntil: _until,
        ...native
      } = row;
      return native;
    }),
  };
}
