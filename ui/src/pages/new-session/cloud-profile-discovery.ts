import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { requestPlaceCatalog } from "./cloud-target.ts";
import type { DraftCloudProfile, DraftEnvironment } from "./discovery.ts";

export const CLOUD_PROFILE_RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 30_000, 60_000] as const;

export function discoverPlaceCatalog(
  client: Pick<GatewayBrowserClient, "request">,
  canWrite: boolean,
  isAdmin: boolean,
): Promise<{ profiles: DraftCloudProfile[]; environments: DraftEnvironment[] }> {
  return canWrite
    ? requestPlaceCatalog(client).then((catalog) => ({
        ...catalog,
        profiles: isAdmin ? catalog.profiles : [],
      }))
    : Promise.resolve({ profiles: [], environments: [] });
}
