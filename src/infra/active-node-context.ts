/** Stable active-node identity projected into the dynamic model runtime line. */
export type ActiveNodeContext = {
  nodeId: string;
};

let activeNodeContext: ActiveNodeContext | null = null;

/** Publishes the gateway's current active-node choice without volatile timestamps. */
export function setActiveNodeContext(next: ActiveNodeContext | null): void {
  activeNodeContext = next ? { ...next } : null;
}

/** Returns a defensive snapshot for prompt construction. */
export function getActiveNodeContext(): ActiveNodeContext | null {
  return activeNodeContext ? { ...activeNodeContext } : null;
}

/** Formats the stable authenticated id; node-controlled labels stay out of prompt text. */
export function formatActiveNodeContextLabel(
  context: ActiveNodeContext | null,
): string | undefined {
  return context?.nodeId;
}

export function resetActiveNodeContextForTests(): void {
  activeNodeContext = null;
}
