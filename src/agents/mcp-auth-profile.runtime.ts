/** Demand-loaded auth-profile resolution for MCP bearer injection and projection. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveApiKeyForProfile } from "./auth-profiles/oauth.js";
import { loadAuthProfileStoreForSecretsRuntime } from "./auth-profiles/store-runtime.js";

export async function resolveMcpAuthProfileBearerToken(params: {
  serverName: string;
  profileId: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
}): Promise<string> {
  const store = loadAuthProfileStoreForSecretsRuntime(params.agentDir, {
    config: params.cfg,
    externalCliProfileIds: [params.profileId],
  });
  const credential = store.profiles[params.profileId];
  if (!credential) {
    throw new Error(
      `MCP server "${params.serverName}" references auth profile "${params.profileId}", but that profile was not found.`,
    );
  }
  if (credential.type !== "oauth") {
    throw new Error(
      `MCP server "${params.serverName}" references auth profile "${params.profileId}", but ${credential.type} profiles are not refreshable. Use a refresh-capable OAuth profile.`,
    );
  }
  const resolved = await resolveApiKeyForProfile({
    cfg: params.cfg,
    store,
    profileId: params.profileId,
    agentDir: params.agentDir,
  });
  if (!resolved || resolved.profileType !== "oauth" || !resolved.apiKey) {
    throw new Error(
      `MCP server "${params.serverName}" could not resolve refreshable OAuth auth profile "${params.profileId}". Re-authenticate the profile and retry.`,
    );
  }
  if (
    !resolved.credential ||
    resolved.credential.type !== "oauth" ||
    typeof resolved.credential.access !== "string" ||
    resolved.credential.access.trim().length === 0
  ) {
    throw new Error(
      `MCP server "${params.serverName}" resolved OAuth auth profile "${params.profileId}", but no raw access token was available for bearer projection.`,
    );
  }
  return resolved.credential.access;
}
