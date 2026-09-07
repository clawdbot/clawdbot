import { listNodes, resolveNodeIdFromList } from "./tools/nodes-utils.js";

/** Prepares current node facts for tool discovery without caching connection state. */
export async function loadNodeExecAvailability(signal?: AbortSignal) {
  const nodes = await listNodes({}, signal).catch(() => {
    signal?.throwIfAborted();
    return [];
  });
  signal?.throwIfAborted();
  return {
    // Only matching and execution facts invalidate a cached tool catalog.
    cacheKey: JSON.stringify(
      nodes
        .toSorted((a, b) => a.nodeId.localeCompare(b.nodeId))
        .map(({ nodeId, displayName, remoteIp, clientId, connected, commands }) => [
          nodeId,
          displayName,
          remoteIp,
          clientId,
          connected === true,
          commands?.includes("system.run") === true,
        ]),
    ),
    isAvailable: (node?: string): boolean => {
      try {
        // Bind against the full inventory: an offline or ambiguous name must not
        // redirect execution to another eligible device with the same name.
        const nodeId = node?.trim() ? resolveNodeIdFromList(nodes, node) : undefined;
        return nodes.some(
          (entry) =>
            (!nodeId || entry.nodeId === nodeId) &&
            entry.connected === true &&
            entry.commands?.includes("system.run") === true,
        );
      } catch {
        return false;
      }
    },
  };
}
