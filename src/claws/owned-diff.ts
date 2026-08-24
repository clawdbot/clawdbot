/**
 * Shared ownership-diff decision core for Claw plan builders.
 *
 * buildClawUpdatePlan derives one action per owned component (agent,
 * workspaceFile, package, mcpServer, cronJob) by comparing the recorded
 * ownership state against the target declaration. Every component follows the
 * same decision skeleton; only the manual/unchanged predicates differ. This
 * module owns that skeleton and its exact evaluation order, which plan
 * integrity and consent rebinding depend on:
 *
 *   1. component-wide manual conditions (evaluated even without a current ref)
 *   2. missing current ref -> "add"
 *   3. current-specific manual conditions
 *   4. recorded state is "missing" and restores are declared -> "change"
 *   5. unchanged predicate -> "unchanged"
 *   6. otherwise -> "change"
 *
 * Removal passes share the same contract: manual state blocks, otherwise the
 * caller chooses between "remove" (sole ownership) and "release" (shared or
 * independently owned artifact is preserved).
 */

export type OwnedDiffDecision = "add" | "change" | "remove" | "release" | "unchanged" | "manual";

export type DiffOwnedChangeParams = {
  /** A current ownership record exists. */
  hasCurrent: boolean;
  /** Manual conditions that apply regardless of a current record. */
  manualBeforeAdd?: () => boolean;
  /** Manual conditions that only apply when a current record exists. */
  manualWhenPresent?: () => boolean;
  /** A missing current record restores as "change" instead of "add". */
  restoresMissing?: () => boolean;
  /** Digest/identity equality means nothing needs to change. */
  unchangedWhen?: () => boolean;
};

export function diffOwnedChange(params: DiffOwnedChangeParams): OwnedDiffDecision {
  if (params.manualBeforeAdd?.()) {
    return "manual";
  }
  if (!params.hasCurrent) {
    return "add";
  }
  if (params.manualWhenPresent?.()) {
    return "manual";
  }
  if (params.restoresMissing?.()) {
    return "change";
  }
  if (params.unchangedWhen?.()) {
    return "unchanged";
  }
  return "change";
}

export type DiffOwnedRemovalParams = {
  /** Removal is blocked by unresolved or drifted ownership state. */
  manual: boolean;
  /** Preserve the artifact and only release this Claw's reference. */
  release?: boolean;
};

export function diffOwnedRemoval(params: DiffOwnedRemovalParams): OwnedDiffDecision {
  if (params.manual) {
    return "manual";
  }
  return params.release ? "release" : "remove";
}
