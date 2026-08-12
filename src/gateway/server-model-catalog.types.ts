import type { RuntimeAuthMaterialization } from "../agents/auth-profiles/runtime-materializations.js";
import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import type { ResolvedPublishedModelCatalogOwner } from "../agents/prepared-model-catalog.types.js";

export type GatewayModelCatalogOwnerSnapshot = Pick<
  ResolvedPublishedModelCatalogOwner,
  "agentId" | "agentDir" | "workspaceDir" | "config" | "modelCatalog"
> &
  Partial<Pick<ResolvedPublishedModelCatalogOwner, "authModes" | "authStore" | "metadataSnapshot">>;

export type GatewayModelCatalogSnapshot = ModelCatalogSnapshot &
  Omit<GatewayModelCatalogOwnerSnapshot, "modelCatalog"> & {
    authMaterializations?: readonly RuntimeAuthMaterialization[];
  };
