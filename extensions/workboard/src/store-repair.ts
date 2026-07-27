import type { WorkboardMutationScope, WorkboardRepairDecompositionInput } from "./store-inputs.js";
import { normalizeAutomation } from "./store-normalizers.js";
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

      if (parentMode === "hard") {
        return { parentId, dryRun, candidateChildIds, repairedChildIds, skippedChildIds };
      }

      // Cards written before decompositionMode existed must retain the old,
      // hard-link behavior. Adopt that intent durably instead of guessing that
      // provenance alone makes a reciprocal dependency safe to remove.
      if (parentMode === undefined) {
        if (!dryRun && createdCardIds.length > 0) {
          await this.updateCard(
            parent.id,
            {
              metadata: {
                ...parent.metadata,
                automation: normalizeAutomation(
                  { ...parent.metadata?.automation, decompositionMode: "hard" },
                  parent.metadata?.automation,
                ),
              },
            },
            { enforceStatusHolds: false },
          );
        }
        for (const childId of createdCardIds) {
          const child = await this.get(childId);
          if (child?.metadata?.automation?.createdByCardId !== parent.id) {
            skippedChildIds.push(childId);
            continue;
          }
          skippedChildIds.push(childId);
          if (!dryRun && child.metadata?.automation?.decompositionMode === undefined) {
            await this.updateCard(
              child.id,
              {
                metadata: {
                  ...child.metadata,
                  automation: normalizeAutomation(
                    { ...child.metadata?.automation, decompositionMode: "hard" },
                    child.metadata?.automation,
                  ),
                },
              },
              { enforceStatusHolds: false },
            );
          }
        }
        return { parentId, dryRun, candidateChildIds, repairedChildIds, skippedChildIds };
      }

      // Only an explicit orchestration mode proves that decomposition intended
      // non-blocking children. A missing child mode is legacy/ambiguous and is
      // therefore preserved rather than repaired.
      if (parentMode !== "orchestration") {
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
