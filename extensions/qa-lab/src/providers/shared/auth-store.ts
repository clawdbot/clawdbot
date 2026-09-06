// Qa Lab plugin module implements auth store behavior.
import path from "node:path";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  type AuthProfileCredential,
} from "openclaw/plugin-sdk/agent-runtime";
import { updateAuthProfileStoreWithLock } from "openclaw/plugin-sdk/provider-auth";

type QaAuthProfileCredential = AuthProfileCredential;

function resolveQaAgentAuthDir(params: { stateDir: string; agentId: string }): string {
  return path.join(params.stateDir, "agents", params.agentId, "agent");
}

export async function writeQaAuthProfiles(params: {
  agentId: string;
  profiles: Record<string, QaAuthProfileCredential>;
  replace?: boolean;
  stateDir: string;
}): Promise<void> {
  const agentDir = resolveQaAgentAuthDir(params);
  // Surface pending legacy-source errors before the locked updater, whose
  // public failure contract is intentionally nullable.
  loadAuthProfileStoreWithoutExternalProfiles(agentDir, { inheritedAuthDir: agentDir });
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    stateDir: params.stateDir,
    saveOptions: {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    },
    updater: (store) => {
      store.version = 1;
      store.profiles = params.replace
        ? { ...params.profiles }
        : { ...store.profiles, ...params.profiles };
      if (params.replace) {
        delete store.order;
        delete store.lastGood;
        delete store.usageStats;
      }
      return true;
    },
  });
  if (!updated) {
    throw new Error("Failed to stage the isolated QA auth profile store.");
  }
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
