// Config materialization carries this upgrade-only fact without restoring the retired marker.
const legacyDefaultAgentIdByConfig = new WeakMap<object, string>();

export function setRetainedLegacyDefaultAgentId(config: object, agentId: string | undefined): void {
  if (agentId) {
    legacyDefaultAgentIdByConfig.set(config, agentId);
  } else {
    legacyDefaultAgentIdByConfig.delete(config);
  }
}

export function getRetainedLegacyDefaultAgentId(config: object): string | undefined {
  return legacyDefaultAgentIdByConfig.get(config);
}
