/** Stable active-node identity projected into the dynamic model runtime line. */
type ActiveNodeContext = {
  nodeId: string;
  pairingGeneration?: string;
};

type ActiveNodeContextState = ActiveNodeContext & {
  isCurrent?: () => boolean;
};

let activeNodeContext: ActiveNodeContextState | null = null;

function snapshotActiveNodeContext(context: ActiveNodeContextState): ActiveNodeContext {
  return {
    nodeId: context.nodeId,
    ...(context.pairingGeneration ? { pairingGeneration: context.pairingGeneration } : {}),
  };
}

/** Publishes the gateway's current active-node choice without volatile timestamps. */
export function setActiveNodeContext(
  next: ActiveNodeContext | null,
  options?: { isCurrent?: () => boolean },
): void {
  activeNodeContext = next ? { ...next, ...options } : null;
}

/** Revalidates the published node before projecting it into an agent prompt. */
export function getCurrentActiveNodeContext(): ActiveNodeContext | null {
  if (!activeNodeContext) {
    return null;
  }
  try {
    if (activeNodeContext.isCurrent && !activeNodeContext.isCurrent()) {
      return null;
    }
  } catch {
    return null;
  }
  return snapshotActiveNodeContext(activeNodeContext);
}

/** Formats the stable authenticated id; node-controlled labels stay out of prompt text. */
export function formatActiveNodeContextLabel(
  context: ActiveNodeContext | null,
): string | undefined {
  return context?.nodeId;
}
