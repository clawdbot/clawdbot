import type { CreateManagedWorktreeParams, ManagedWorktreeRecord } from "./types.js";

export function worktreeOwnerMatches(
  record: ManagedWorktreeRecord,
  params: Pick<CreateManagedWorktreeParams, "ownerKind" | "ownerId">,
): boolean {
  return (
    record.ownerKind === (params.ownerKind ?? "manual") &&
    (record.ownerId ?? undefined) === (params.ownerId ?? undefined)
  );
}
