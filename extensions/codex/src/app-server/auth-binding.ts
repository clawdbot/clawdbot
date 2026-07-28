import {
  fingerprintResolvedAuthProfileCredential,
  type AgentHarnessAuthBindingFingerprintParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  resolveApiKeyForProfile,
  type AuthProfileCredential,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";

type CodexAppServerPreparedAuthBinding = {
  authProfileStore: AuthProfileStore;
  fingerprint: string;
};

function withMaterializedCredential(params: {
  store: AuthProfileStore;
  profileId: string;
  credential: AuthProfileCredential;
  value: string;
}): AuthProfileStore {
  const store = structuredClone(params.store);
  if (params.credential.type === "api_key") {
    const { keyRef: _keyRef, ...credential } = params.credential;
    store.profiles[params.profileId] = { ...credential, key: params.value };
  } else if (params.credential.type === "token") {
    const { tokenRef: _tokenRef, ...credential } = params.credential;
    store.profiles[params.profileId] = { ...credential, token: params.value };
  }
  return store;
}

/** Resolves one forwarded profile once so attestation and execution share exact material. */
export async function prepareCodexAppServerAuthBinding(
  params: AgentHarnessAuthBindingFingerprintParams,
): Promise<CodexAppServerPreparedAuthBinding | undefined> {
  const credential = params.authProfileStore.profiles[params.authProfileId];
  if (!credential || credential.type === "oauth") {
    return undefined;
  }
  const resolved = await resolveApiKeyForProfile({
    cfg: params.config,
    store: params.authProfileStore,
    profileId: params.authProfileId,
    agentDir: params.agentDir,
  });
  if (!resolved?.apiKey) {
    throw new Error(`Codex could not resolve auth profile "${params.authProfileId}".`);
  }
  const fingerprint = fingerprintResolvedAuthProfileCredential({
    profileId: params.authProfileId,
    credential,
    resolvedAuth: {
      apiKey: resolved.apiKey,
      profileId: params.authProfileId,
      source: `profile:${params.authProfileId}`,
      mode: credential.type === "api_key" ? "api-key" : "token",
    },
  });
  if (!fingerprint) {
    throw new Error(`Codex could not attest auth profile "${params.authProfileId}".`);
  }
  return {
    fingerprint,
    authProfileStore: withMaterializedCredential({
      store: params.authProfileStore,
      profileId: params.authProfileId,
      credential,
      value: resolved.apiKey,
    }),
  };
}

export async function fingerprintCodexAppServerAuthBinding(
  params: AgentHarnessAuthBindingFingerprintParams,
): Promise<string | undefined> {
  return (await prepareCodexAppServerAuthBinding(params))?.fingerprint;
}
