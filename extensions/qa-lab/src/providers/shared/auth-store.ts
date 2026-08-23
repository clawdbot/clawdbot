// Qa Lab plugin module implements auth store behavior.
import path from "node:path";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";

type QaAuthProfileCredential =
  | {
      type: "api_key";
      provider: string;
      key?: string;
      keyRef?: QaSecretRef;
      displayName?: string;
    }
  | {
      type: "token";
      provider: string;
      token?: string;
      tokenRef?: QaSecretRef;
      expires?: number;
    }
  | {
      type: "oauth";
      provider: string;
      access?: string;
      refresh?: string;
      expires?: number;
      idToken?: string;
      clientId?: string;
      enterpriseUrl?: string;
      projectId?: string;
      accountId?: string;
      chatgptPlanType?: string;
      oauthRef?: QaLegacyOAuthRef;
    };

type QaSecretRef = {
  source: "env" | "file" | "exec" | "store";
  provider?: string;
  id: string;
};

type QaLegacyOAuthRef = {
  source: "openclaw-credentials";
  provider: "openai";
  id: string;
};

export function resolveQaAgentAuthDir(params: { stateDir: string; agentId: string }): string {
  return path.join(params.stateDir, "agents", params.agentId, "agent");
}

export async function writeQaAuthProfiles(params: {
  agentDir: string;
  profiles: Record<string, QaAuthProfileCredential>;
  replace?: boolean;
}): Promise<void> {
  const existing = loadAuthProfileStoreWithoutExternalProfiles(params.agentDir, {
    inheritedAuthDir: params.agentDir,
  });
  const nextStore: AuthProfileStore = params.replace
    ? { version: 1, profiles: params.profiles as AuthProfileStore["profiles"] }
    : {
        ...existing,
        version: 1,
        profiles: { ...existing.profiles, ...params.profiles } as AuthProfileStore["profiles"],
      };
  saveAuthProfileStore(nextStore, params.agentDir, {
    filterExternalAuthProfiles: false,
    syncExternalCli: false,
  });
}

export function readQaAuthProfiles(agentDir: string): {
  version: number;
  profiles: Record<string, QaAuthProfileCredential>;
} {
  const store = loadAuthProfileStoreWithoutExternalProfiles(agentDir, {
    inheritedAuthDir: agentDir,
  });
  return {
    version: store.version,
    profiles: store.profiles as Record<string, QaAuthProfileCredential>,
  };
}
