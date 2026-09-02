/**
 * Auth-profile forwarding shared by normal and narrow CLI-backed agent runs.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAuthProfileOrder } from "./auth-profiles/order.js";
import { loadAuthProfileStoreForRuntime } from "./auth-profiles/store.js";
import { resolveCliBackendConfig, resolveCliRuntimeCanonicalProvider } from "./cli-backends.js";
import { resolveBundledCliBackendAuthPolicy } from "./cli-runner/cli-backend-auth-policy.js";

const GOOGLE_GEMINI_CLI_PROVIDER_ID = "google-gemini-cli";
const GOOGLE_PROVIDER_ID = "google";
const CLAUDE_CLI_PROVIDER_ID = "claude-cli";

type CliExecutionAuthProfileSelection = {
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
};

export class CliExecutionAuthProfileError extends Error {
  override name = "CliExecutionAuthProfileError";
}

export function cliBackendAcceptsAuthProfileForwarding(params: {
  provider: string;
  config: OpenClawConfig;
  agentId?: string;
}): boolean {
  const backend = resolveCliBackendConfig(params.provider, params.config, {
    agentId: params.agentId,
  });
  return backend?.id === GOOGLE_GEMINI_CLI_PROVIDER_ID || backend?.id === CLAUDE_CLI_PROVIDER_ID;
}

/**
 * Resolve native profiles and explicitly selected credentials the CLI can consume.
 * A user-locked profile must fail closed rather than run as another user.
 */
export function resolveCliExecutionAuthProfileId(params: {
  cliExecutionProvider: string;
  authProfileProvider: string;
  config: OpenClawConfig;
  agentDir: string;
  selected?: CliExecutionAuthProfileSelection;
  loadAuthProfileStoreForRuntime?: typeof loadAuthProfileStoreForRuntime;
}): string | undefined {
  const loadStore = params.loadAuthProfileStoreForRuntime ?? loadAuthProfileStoreForRuntime;
  const selectedAuthProfileId = params.selected?.authProfileId?.trim();
  const store = loadStore(params.agentDir, {
    readOnly: true,
    allowKeychainPrompt: false,
    externalCliProviderIds: [params.cliExecutionProvider],
    profileId: selectedAuthProfileId,
  });
  const nativeAuthProfileIds = resolveBundledCliBackendAuthPolicy(
    params.cliExecutionProvider,
  )?.nativeAuthProfileIds;
  if (selectedAuthProfileId && nativeAuthProfileIds?.includes(selectedAuthProfileId)) {
    return undefined;
  }
  if (selectedAuthProfileId) {
    const credential = store.profiles[selectedAuthProfileId];
    if (credential?.provider === params.cliExecutionProvider) {
      return selectedAuthProfileId;
    }
    // Canonical credentials require an explicit choice and the backend's registered
    // owner. Automatic selection must not replace the CLI's native identity.
    if (
      credential &&
      params.selected?.authProfileIdSource !== "auto" &&
      (params.cliExecutionProvider === CLAUDE_CLI_PROVIDER_ID ||
        (params.cliExecutionProvider === GOOGLE_GEMINI_CLI_PROVIDER_ID &&
          credential.type === "api_key")) &&
      credential.provider ===
        resolveCliRuntimeCanonicalProvider({
          runtime: params.cliExecutionProvider,
          config: params.config,
          includeSetupRegistry: true,
        })
    ) {
      return selectedAuthProfileId;
    }
    if (params.selected?.authProfileIdSource !== "auto") {
      if (!credential) {
        throw new CliExecutionAuthProfileError(
          `No credentials found for profile "${selectedAuthProfileId}".`,
        );
      }
      throw new CliExecutionAuthProfileError(
        `CLI backend "${params.cliExecutionProvider}" cannot use auth profile "${selectedAuthProfileId}" owned by "${credential.provider}".`,
      );
    }
  }

  const cliProfileId = resolveAuthProfileOrder({
    cfg: params.config,
    store,
    provider: params.cliExecutionProvider,
  }).find(
    (profileId) =>
      store.profiles[profileId]?.provider === params.cliExecutionProvider &&
      !nativeAuthProfileIds?.includes(profileId),
  );
  if (cliProfileId) {
    return cliProfileId;
  }

  if (
    params.cliExecutionProvider !== GOOGLE_GEMINI_CLI_PROVIDER_ID ||
    params.authProfileProvider !== GOOGLE_PROVIDER_ID
  ) {
    return undefined;
  }

  return resolveAuthProfileOrder({
    cfg: params.config,
    store,
    provider: GOOGLE_PROVIDER_ID,
  }).find((profileId) => {
    const credential = store.profiles[profileId];
    return credential?.provider === GOOGLE_PROVIDER_ID && credential.type === "api_key";
  });
}
