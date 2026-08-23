import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { requestCloudProfiles } from "./cloud-target.ts";
import type { DraftCloudProfile } from "./discovery.ts";

export const CLOUD_PROFILE_RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 30_000, 60_000] as const;

export function selectProfiles(
  profiles: DraftCloudProfile[],
  client: { recoveryScopeReady?: boolean } | null,
  recoveryScope: string,
) {
  const unsupported = profiles.length > 0 && client?.recoveryScopeReady === true && !recoveryScope;
  return { profiles: unsupported ? [] : profiles, unsupported };
}

export function discoverCloudProfiles(
  client: Pick<GatewayBrowserClient, "request">,
  admin: boolean,
): Promise<DraftCloudProfile[]> {
  return admin ? requestCloudProfiles(client) : Promise.resolve([]);
}
