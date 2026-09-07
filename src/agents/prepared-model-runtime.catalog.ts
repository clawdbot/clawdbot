import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { isPreparedModelCatalogFull } from "./prepared-model-runtime.full-catalog.js";
import {
  advancePreparedModelRuntimeOwnerConfig,
  ownerKey,
  resolvePreparedModelRuntimeOwnerBySnapshot,
  type PreparedModelRuntimeOwner,
  type PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.owner.js";

export function advancePreparedModelRuntimeOwnersConfig(
  owners: Iterable<PreparedModelRuntimeOwner>,
  config: OpenClawConfig,
): void {
  for (const owner of owners) {
    // Read-only owners include the config hash in their map key and remain bound to their lease.
    if (!owner.input.readOnly) {
      advancePreparedModelRuntimeOwnerConfig(owner, config);
    }
  }
}

export async function refreshPreparedModelRuntimeOwnerCatalog(
  owners: Map<string, PreparedModelRuntimeOwner>,
  snapshot: PreparedModelRuntimeSnapshot,
  options: { refresh?: boolean } = {},
): Promise<ModelCatalogSnapshot | undefined> {
  const owner = resolvePreparedModelRuntimeOwnerBySnapshot(snapshot);
  if (!owner || owners.get(ownerKey(owner.input)) !== owner || !snapshot.loadFullModelCatalog) {
    return undefined;
  }
  const currentCatalog = snapshot.readFullModelCatalog?.() ?? snapshot.modelCatalog;
  const refresh = options.refresh === true || owner.catalogStale;
  if (!refresh && isPreparedModelCatalogFull(currentCatalog)) {
    return undefined;
  }
  const generation = owner.generation;
  const catalog = await snapshot.loadFullModelCatalog({ refresh });
  if (
    owner.catalogStale &&
    owner.generation === generation &&
    owners.get(ownerKey(owner.input)) === owner
  ) {
    owner.catalogStale = false;
  }
  return catalog;
}
