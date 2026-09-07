// Snapshot hydration helpers merge saved runtime skill snapshots into live state.
type SnapshotWithRuntimeSkills = {
  resolvedSkills?: unknown;
  skillCommandUsagePaths?: unknown;
};

type SnapshotRebuild<T extends SnapshotWithRuntimeSkills> = {
  resolvedSkills?: T["resolvedSkills"];
  skillCommandUsagePaths?: T["skillCommandUsagePaths"];
};

// Resolved paths are runtime-only: session persistence keeps the lightweight
// catalog/prompt, while consumers that need concrete SKILL.md paths hydrate them
// from a fresh workspace scan.
export function hydrateResolvedSkills<T extends SnapshotWithRuntimeSkills>(
  snapshot: T,
  rebuild: () => SnapshotRebuild<T>,
): T {
  if (snapshot.resolvedSkills !== undefined && snapshot.skillCommandUsagePaths !== undefined) {
    return snapshot;
  }
  const rebuilt = rebuild();
  return {
    ...snapshot,
    resolvedSkills: snapshot.resolvedSkills ?? rebuilt.resolvedSkills,
    skillCommandUsagePaths: snapshot.skillCommandUsagePaths ?? rebuilt.skillCommandUsagePaths,
  };
}
