type AnchorState = "starting" | "active" | "closing" | "closed";

/**
 * A lineage pipe can close while the direct child is still running when the
 * child closes inherited descriptors (OpenSSH does this during startup).
 * The root exit event, not lineage EOF, is authoritative for the direct child.
 */
export function shouldRequestLineageCleanup(state: AnchorState, rootExited: boolean): boolean {
  return state === "active" && rootExited;
}
