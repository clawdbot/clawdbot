import type { DraftCloudProfile, DraftEnvironment, DraftNode } from "./discovery.ts";
import { environmentMenuFacts } from "./place-facts.ts";

export function resolvePlacePickerSections(params: {
  environments: readonly DraftEnvironment[] | null;
  execNodes: readonly DraftNode[];
  cloudProfiles: readonly DraftCloudProfile[];
}): {
  deviceNodes: DraftNode[];
  deviceFacts: Map<string, string[]>;
  cloudProfiles: DraftCloudProfile[];
} {
  const environmentById = params.environments
    ? new Map(params.environments.map((environment) => [environment.id, environment]))
    : null;
  return {
    deviceNodes: params.execNodes.filter((node) => {
      if (!node.connected || !node.canExec) {
        return false;
      }
      if (environmentById === null || environmentById.size === 0) {
        // Missing and empty catalogs preserve the established live-node fallback.
        return true;
      }
      const environment = environmentById.get(`node:${node.nodeId}`);
      return environment?.type === "node";
    }),
    deviceFacts: new Map(
      params.execNodes.map((node) => [
        node.nodeId,
        environmentMenuFacts(environmentById?.get(`node:${node.nodeId}`)),
      ]),
    ),
    cloudProfiles: [...params.cloudProfiles],
  };
}
