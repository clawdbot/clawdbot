// Exposes the Node pairing surface used by gateway and CLI flows.
import { normalizeArrayBackedTrimmedStringList } from "@openclaw/normalization-core/string-normalization";

/** Normalize capability/command lists for node approval-surface comparison. */
export function normalizeNodeApprovalSurfaceList(value: readonly string[] | undefined): string[] {
  return normalizeArrayBackedTrimmedStringList(value) ?? [];
}

/** Compare capability/command surfaces as normalized sets, ignoring order and duplicates. */
export function sameNodeApprovalSurfaceSet(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  const normalizedLeft = new Set(normalizeNodeApprovalSurfaceList(left));
  const normalizedRight = new Set(normalizeNodeApprovalSurfaceList(right));
  if (normalizedLeft.size !== normalizedRight.size) {
    return false;
  }
  for (const entry of normalizedLeft) {
    if (!normalizedRight.has(entry)) {
      return false;
    }
  }
  return true;
}

/** Compare node permission maps deterministically so key order cannot trigger repairs. */
export function sameNodePermissionSurface(
  left: Record<string, boolean> | undefined,
  right: Record<string, boolean> | undefined,
): boolean {
  const leftEntries = Object.entries(left ?? {}).toSorted(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey),
  );
  const rightEntries = Object.entries(right ?? {}).toSorted(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey),
  );
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  return leftEntries.every(([key, value], index) => {
    const rightEntry = rightEntries[index];
    return rightEntry !== undefined && rightEntry[0] === key && rightEntry[1] === value;
  });
}
