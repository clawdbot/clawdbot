import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveNodeCommandAllowlist } from "../gateway/node-command-policy.js";
import type { NodeSession } from "../gateway/node-registry.js";
import { listNodePairing } from "../infra/node-pairing.js";
import type { NodeModeReadinessEvidence } from "./profiles.js";

const DEFAULT_NODE_MODE_PAIRING_CACHE_TTL_MS = 1_000;
const DEFAULT_NODE_MODE_TIMEOUT_MS = 1_000;

type NodeModeReadinessParams = {
  config: OpenClawConfig;
  connectedNodes: readonly NodeSession[];
};

function commandSet(value: unknown): Set<string> {
  return new Set(
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [],
  );
}

async function resolveNodeModeReadinessEvidenceWith(
  params: NodeModeReadinessParams,
  loadPairing: typeof listNodePairing,
): Promise<NodeModeReadinessEvidence> {
  try {
    const pairing = await loadPairing();
    const pairedByNodeId = new Map(pairing.paired.map((entry) => [entry.nodeId, entry]));
    const connectedPairedNodes = params.connectedNodes.filter((entry) =>
      pairedByNodeId.has(entry.nodeId),
    );
    let executableApprovedCommandCount = 0;
    for (const node of connectedPairedNodes) {
      const approvedCommands = pairedByNodeId.get(node.nodeId)?.commands ?? [];
      const effectiveAllowlist = resolveNodeCommandAllowlist(params.config, {
        ...node,
        approvedCommands,
      });
      const liveCommands = commandSet(node.commands);
      executableApprovedCommandCount += [...liveCommands].filter((command) =>
        effectiveAllowlist.has(command),
      ).length;
    }
    const connectedCount = connectedPairedNodes.length;
    return {
      pairing: {
        pairedCount: pairing.paired.length,
        pendingCount: pairing.pending.length,
      },
      targets: {
        knownCount: pairing.paired.length,
        connectedCount,
      },
      commandApproval: {
        configured: executableApprovedCommandCount > 0,
        approvedCommandCount: executableApprovedCommandCount,
      },
      controlChannel: {
        connectedCount,
      },
    };
  } catch (error) {
    const connectedCount = 0;
    return {
      pairing: {
        pairedCount: 0,
        pendingCount: 0,
        error: error instanceof Error ? error.message : String(error),
      },
      targets: {
        knownCount: 0,
        connectedCount,
      },
      commandApproval: {
        configured: false,
        approvedCommandCount: 0,
      },
      controlChannel: {
        connectedCount,
      },
    };
  }
}

export function createNodeModeReadinessEvidenceResolver(
  deps: {
    listPairing?: typeof listNodePairing;
    now?: () => number;
    cacheTtlMs?: number;
    timeoutMs?: number;
  } = {},
): (params: NodeModeReadinessParams) => Promise<NodeModeReadinessEvidence> {
  const listPairing = deps.listPairing ?? listNodePairing;
  const now = deps.now ?? Date.now;
  const cacheTtlMs = Math.max(0, deps.cacheTtlMs ?? DEFAULT_NODE_MODE_PAIRING_CACHE_TTL_MS);
  const timeoutMs = Math.max(1, deps.timeoutMs ?? DEFAULT_NODE_MODE_TIMEOUT_MS);
  let cached:
    | {
        expiresAt: number;
        value: ReturnType<typeof listNodePairing>;
      }
    | undefined;

  const loadCachedPairing: typeof listNodePairing = () => {
    const observedAt = now();
    if (!cached || observedAt >= cached.expiresAt) {
      cached = {
        expiresAt: observedAt + cacheTtlMs,
        value: listPairing(),
      };
    }
    return cached.value;
  };

  return async (params) => {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        resolveNodeModeReadinessEvidenceWith(params, loadCachedPairing),
        new Promise<NodeModeReadinessEvidence>((resolve) => {
          timeout = setTimeout(
            () =>
              resolve({
                pairing: {
                  pairedCount: 0,
                  pendingCount: 0,
                  timedOut: true,
                  error: `Node pairing readiness exceeded ${timeoutMs}ms.`,
                },
              }),
            timeoutMs,
          );
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  };
}
