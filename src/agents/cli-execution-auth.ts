/**
 * Auth-profile forwarding shared by normal and narrow CLI-backed agent runs.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAuthProfileOrder } from "./auth-profiles/order.js";
import { loadAuthProfileStoreForRuntime } from "./auth-profiles/store.js";
import { resolveCliBackendConfig } from "./cli-backends.js";

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
 * Resolve the profile a CLI backend may consume. Claude and Gemini use their
 * native profile identities; Gemini may additionally bridge a canonical
 * Google API key. A user-locked profile must fail closed here because falling
 * through would silently run the request as another user.
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
  const store = loadStore(params.agentDir, {
    readOnly: true,
    allowKeychainPrompt: false,
    externalCliProviderIds: [params.cliExecutionProvider],
  });
  const selectedAuthProfileId = params.selected?.authProfileId?.trim();
  if (selectedAuthProfileId) {
    const credential = store.profiles[selectedAuthProfileId];
    if (credential?.provider === params.cliExecutionProvider) {
      return selectedAuthProfileId;
    }
    if (
      params.cliExecutionProvider === GOOGLE_GEMINI_CLI_PROVIDER_ID &&
      credential?.provider === GOOGLE_PROVIDER_ID &&
      credential.type === "api_key" &&
      params.selected?.authProfileIdSource !== "auto"
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
  })[0];
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
