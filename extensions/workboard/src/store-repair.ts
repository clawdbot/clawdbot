import type { WorkboardMutationScope, WorkboardRepairDecompositionInput } from "./store-inputs.js";
import { WorkboardPromoteStore } from "./store-promote.js";

export class WorkboardRepairStore extends WorkboardPromoteStore {
  async repairDecomposition(
    parentId: string,
    input: WorkboardRepairDecompositionInput = {},
    scope?: WorkboardMutationScope,
  ): Promise<{
    parentId: string;
    dryRun: boolean;
    candidateChildIds: string[];
    repairedChildIds: string[];
    skippedChildIds: string[];
  }> {
    return await this.enqueueMutation(async () => {
      const parent = await this.get(parentId);
      if (!parent) {
        throw new Error(`card not found: ${parentId}`);
      }
      const dryRun = input.apply !== true;
      const candidateChildIds: string[] = [];
      const repairedChildIds: string[] = [];
      const skippedChildIds: string[] = [];
      const parentMode = parent.metadata?.automation?.decompositionMode;
      const createdCardIds = parent.metadata?.automation?.createdCardIds ?? [];

      // Only an explicit orchestration mode proves that decomposition intended
      // non-blocking children. A missing mode is historical/ambiguous and is
      // therefore preserved rather than repaired.
      if (parentMode !== "orchestration") {
        skippedChildIds.push(...createdCardIds);
        return { parentId, dryRun, candidateChildIds, repairedChildIds, skippedChildIds };
      }

      for (const childId of createdCardIds) {
        const child = await this.get(childId);
        const proven =
          child?.metadata?.automation?.createdByCardId === parent.id &&
          child.metadata?.automation?.decompositionMode === "orchestration";
        const hasReciprocalDependency =
          proven &&
          (parent.metadata?.links ?? []).some(
            (link) => link.type === "child" && link.targetCardId === child.id,
          ) &&
          (child.metadata?.links ?? []).some(
            (link) => link.type === "parent" && link.targetCardId === parent.id,
          );
        if (!hasReciprocalDependency) {
          skippedChildIds.push(childId);
          continue;
        }
        candidateChildIds.push(childId);
        if (!dryRun) {
          await this.unlinkDependencyDirect(parent.id, childId, Date.now(), scope);
          repairedChildIds.push(childId);
        }
      }
      return { parentId, dryRun, candidateChildIds, repairedChildIds, skippedChildIds };
    });
  }
}
