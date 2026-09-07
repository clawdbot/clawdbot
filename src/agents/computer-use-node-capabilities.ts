import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import type {
  ComputerUseCapabilityDescriptor,
  ComputerUseV2ActionName,
} from "../plugins/computer-use-contract.js";
import {
  COMPUTER_USE_V1_ACTION_NAMES,
  COMPUTER_USE_V2_ACTION_NAMES,
} from "../plugins/computer-use-contract.js";
import { COMPUTER_ACT_COMMAND, SCREEN_SNAPSHOT_COMMAND } from "./tools/computer-tool-shared.js";
import { listNodes, type NodeListNode } from "./tools/nodes-utils.js";

export type PreparedPairedComputerUse = {
  actions: readonly ComputerUseV2ActionName[];
  guidanceCapabilities?: ComputerUseCapabilityDescriptor;
};

export type PairedComputerUseAvailability = {
  cacheKey: string;
  prepared?: PreparedPairedComputerUse;
};

/** A paired target must support both observation and input to enter the computer tool pool. */
export function isEligibleComputerNode(node: NodeListNode): boolean {
  const commands = Array.isArray(node.commands) ? node.commands : [];
  return (
    node.connected === true &&
    commands.includes(COMPUTER_ACT_COMMAND) &&
    commands.includes(SCREEN_SNAPSHOT_COMMAND)
  );
}

/** Projects effective paired-node descriptors into one honest pre-publication action surface. */
function preparePairedComputerUse(
  nodes: readonly NodeListNode[],
): PreparedPairedComputerUse | undefined {
  const eligible = nodes.filter(isEligibleComputerNode);
  if (eligible.length === 0) {
    return undefined;
  }
  const advertised = new Set<ComputerUseV2ActionName>();
  for (const node of eligible) {
    for (const action of node.computerUse?.actions ?? COMPUTER_USE_V1_ACTION_NAMES) {
      advertised.add(action);
    }
  }
  return {
    actions: COMPUTER_USE_V2_ACTION_NAMES.filter((action) => advertised.has(action)),
    // Per-provider guidance is only exact when there is one possible target.
    guidanceCapabilities: eligible.length === 1 ? eligible[0]?.computerUse : undefined,
  };
}

/** Loads current approved node facts before a model-facing tool catalog is serialized. */
export async function loadPairedComputerUseAvailability(
  signal?: AbortSignal,
): Promise<PairedComputerUseAvailability> {
  const nodes = await listNodes({}, signal).catch(() => {
    signal?.throwIfAborted();
    return [];
  });
  signal?.throwIfAborted();
  const eligible = nodes.filter(isEligibleComputerNode);
  return {
    cacheKey: stableStringify(
      eligible
        .toSorted((a, b) => a.nodeId.localeCompare(b.nodeId))
        .map(({ nodeId, computerUse }) => ({ nodeId, computerUse })),
    ),
    prepared: preparePairedComputerUse(eligible),
  };
}
