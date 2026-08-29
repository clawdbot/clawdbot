import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { GatewayRequestContext } from "./types.js";

/** Reads already-published startup facts without starting provider discovery on an RPC hot path. */
export async function readPreparedServerMethodModelCatalog(
  context: GatewayRequestContext,
  options?: { agentId?: string },
): Promise<ModelCatalogEntry[] | undefined> {
  try {
    return context.readPreparedGatewayModelCatalog
      ? await context.readPreparedGatewayModelCatalog(options)
      : undefined;
  } catch {
    // Catalog metadata decorates these responses; owner selection or lifecycle
    // races must not make the primary roster/session RPC unavailable.
    return undefined;
  }
}
