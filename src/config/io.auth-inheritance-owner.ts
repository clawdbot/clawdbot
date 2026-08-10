import { pinLegacyInheritedAuthOwnerForRosterTransition } from "../agents/legacy-inherited-auth-dir.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const AUTH_INHERITANCE_PATH = "agents.defaults.authInheritance";

function explicitlySetsAuthInheritance(explicitSetPaths?: readonly (readonly string[])[]): boolean {
  return Boolean(
    explicitSetPaths?.some((writePath) => {
      const path = writePath.join(".");
      return path === AUTH_INHERITANCE_PATH || path.startsWith(`${AUTH_INHERITANCE_PATH}.`);
    }),
  );
}

export function prepareAuthInheritanceOwnerForWrite(params: {
  currentConfig: OpenClawConfig;
  targetConfig: OpenClawConfig;
  writesOwnershipTopology: boolean;
  explicitSetPaths?: readonly (readonly string[])[];
}): { config: OpenClawConfig; insertedPaths: string[][] } {
  if (!params.writesOwnershipTopology || explicitlySetsAuthInheritance(params.explicitSetPaths)) {
    return { config: params.targetConfig, insertedPaths: [] };
  }
  const config = pinLegacyInheritedAuthOwnerForRosterTransition(
    params.currentConfig,
    params.targetConfig,
  );
  return {
    config,
    insertedPaths:
      config === params.targetConfig ? [] : [["agents", "defaults", "authInheritance", "agentId"]],
  };
}
