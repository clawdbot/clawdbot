import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { requestPlaceCatalog } from "./cloud-target.ts";
import type { DraftCloudProfile, DraftEnvironment } from "./discovery.ts";

export const CLOUD_PROFILE_RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 30_000, 60_000] as const;

export function selectProfiles(
  profiles: DraftCloudProfile[],
  client: { recoveryScopeReady?: boolean } | null,
  recoveryScope: string,
) {
  const unsupported = profiles.length > 0 && client?.recoveryScopeReady === true && !recoveryScope;
  return { profiles: unsupported ? [] : profiles, unsupported };
}

export function discoverPlaceCatalog(
  client: Pick<GatewayBrowserClient, "request">,
  admin: boolean,
): Promise<{ profiles: DraftCloudProfile[]; environments: DraftEnvironment[] }> {
  return admin ? requestPlaceCatalog(client) : Promise.resolve({ profiles: [], environments: [] });
}
