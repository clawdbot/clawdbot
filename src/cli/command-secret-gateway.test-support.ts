import type { resolveManifestContractOwnerPluginId } from "../plugins/plugin-registry.js";
import type { analyzeCommandSecretAssignmentsFromSnapshot } from "../secrets/command-config.js";
import type { collectConfigAssignments } from "../secrets/runtime-config-collectors.js";
import type { resolveRuntimeWebTools } from "../secrets/runtime-web-tools.js";
import type { discoverConfigSecretTargetsByIds } from "../secrets/target-registry.js";
import "./command-secret-gateway.js";

type CommandSecretGatewayTestDeps = {
  analyzeCommandSecretAssignmentsFromSnapshot: typeof analyzeCommandSecretAssignmentsFromSnapshot;
  collectConfigAssignments: typeof collectConfigAssignments;
  discoverConfigSecretTargetsByIds: typeof discoverConfigSecretTargetsByIds;
  resolveManifestContractOwnerPluginId: typeof resolveManifestContractOwnerPluginId;
  resolveRuntimeWebTools: typeof resolveRuntimeWebTools;
};

type CommandSecretGatewayTestApi = {
  setDepsForTest(overrides: Partial<CommandSecretGatewayTestDeps>): () => void;
  resetDepsForTest(): void;
};

function getTestApi(): CommandSecretGatewayTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.commandSecretGatewayTestApi")
  ] as CommandSecretGatewayTestApi;
}

export const testing = {
  setDepsForTest(overrides: Partial<CommandSecretGatewayTestDeps>): () => void {
    return getTestApi().setDepsForTest(overrides);
  },
  resetDepsForTest(): void {
    getTestApi().resetDepsForTest();
  },
};
