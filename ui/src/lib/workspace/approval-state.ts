import type { WorkspaceDocument } from "./types.ts";

/** Unlock decisions only after the canonical registry confirms their transition. */
export function reconcilePendingApprovalNames(
  pendingNames: Set<string>,
  workspace: WorkspaceDocument,
): void {
  for (const name of pendingNames) {
    if (workspace.widgetsRegistry[name]?.status !== "pending") {
      pendingNames.delete(name);
    }
  }
}
