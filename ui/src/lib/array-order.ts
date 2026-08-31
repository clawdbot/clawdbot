export type ArrayDropPosition = "before" | "after";

/** Move one entry relative to another while preserving every other entry. */
export function moveArrayEntry<T>(
  order: readonly T[],
  source: T,
  target: T,
  position: ArrayDropPosition,
): T[] {
  const ordered = [...order];
  const sourceIndex = ordered.indexOf(source);
  const targetIndex = ordered.indexOf(target);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
    return ordered;
  }
  const [moved] = ordered.splice(sourceIndex, 1);
  if (moved === undefined) {
    return ordered;
  }
  const insertionIndex = ordered.indexOf(target) + (position === "after" ? 1 : 0);
  ordered.splice(insertionIndex, 0, moved);
  return ordered;
}
