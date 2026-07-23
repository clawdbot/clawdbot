import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveNodeCommandAllowlist } from "../gateway/node-command-policy.js";
import type { NodeSession } from "../gateway/node-registry.js";
import { listNodePairing } from "../infra/node-pairing.js";
import type { NodeModeReadinessEvidence } from "./profiles.js";

const DEFAULT_NODE_MODE_PAIRING_CACHE_TTL_MS = 1_000;
const DEFAULT_NODE_MODE_TIMEOUT_MS = 1_000;
const MAX_NODE_MODE_PAIRING_READS = 2;

type NodeModeReadinessParams = {
  config: OpenClawConfig;
  connectedNodes: readonly NodeSession[];
};

type NodePairingSnapshot = Awaited<ReturnType<typeof listNodePairing>> & {
  paired: Array<
    Awaited<ReturnType<typeof listNodePairing>>["paired"][number] & {
      pairingGeneration?: string;
    }
  >;
};

type NodePairingLoader = () => Promise<NodePairingSnapshot>;

function commandSet(value: unknown): Set<string> {
  return new Set(
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [],
  );
}

async function resolveNodeModeReadinessEvidenceWith(
  params: NodeModeReadinessParams,
  loadPairing: NodePairingLoader,
): Promise<NodeModeReadinessEvidence> {
  try {
    const pairing = await loadPairing();
    const pairedByNodeId = new Map(pairing.paired.map((entry) => [entry.nodeId, entry]));
    const connectedPairedNodes = params.connectedNodes.filter((entry) => {
      const paired = pairedByNodeId.get(entry.nodeId);
      if (!paired) {
        return false;
      }
      return !paired.pairingGeneration || entry.pairingGeneration === paired.pairingGeneration;
    });
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
  } catch {
    const connectedCount = 0;
    return {
      pairing: {
        pairedCount: 0,
        pendingCount: 0,
        error: "Node pairing state is unavailable.",
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
    listPairing?: NodePairingLoader;
    now?: () => number;
    cacheTtlMs?: number;
    timeoutMs?: number;
  } = {},
): (params: NodeModeReadinessParams) => Promise<NodeModeReadinessEvidence> {
  const listPairing =
    deps.listPairing ?? (() => listNodePairing(undefined, { includePairingGeneration: true }));
  const now = deps.now ?? Date.now;
  const cacheTtlMs = Math.max(0, deps.cacheTtlMs ?? DEFAULT_NODE_MODE_PAIRING_CACHE_TTL_MS);
  const timeoutMs = Math.max(1, deps.timeoutMs ?? DEFAULT_NODE_MODE_TIMEOUT_MS);
  let cached:
    | {
        expiresAt: number;
        settled: boolean;
        timedOut: boolean;
        value: ReturnType<NodePairingLoader>;
      }
    | undefined;
  const activeReads = new Set<ReturnType<NodePairingLoader>>();

  const loadCachedPairing: NodePairingLoader = () => {
    const observedAt = now();
    const mayReplaceTimedOut =
      cached?.timedOut === true && activeReads.size < MAX_NODE_MODE_PAIRING_READS;
    if (!cached || (cached.settled && observedAt >= cached.expiresAt) || mayReplaceTimedOut) {
      const value = listPairing();
      const next = {
        expiresAt: observedAt + cacheTtlMs,
        settled: false,
        timedOut: false,
        value,
      };
      cached = next;
      activeReads.add(value);
      void value.then(
        () => {
          next.settled = true;
          activeReads.delete(value);
        },
        () => {
          next.settled = true;
          activeReads.delete(value);
        },
      );
    }
    return cached.value;
  };

  return async (params) => {
    let timeout: NodeJS.Timeout | undefined;
    const pairingRead = loadCachedPairing();
    try {
      const evidence = await Promise.race([
        resolveNodeModeReadinessEvidenceWith(params, () => pairingRead),
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
      if (evidence.pairing?.timedOut && cached?.value === pairingRead) {
        cached.timedOut = true;
      }
      return evidence;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  };
}
