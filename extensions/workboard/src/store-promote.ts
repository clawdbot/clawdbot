import { randomUUID } from "node:crypto";
import type {
  WorkboardCard,
  WorkboardExecutionStatus,
  WorkboardStatus,
} from "@openclaw/workboard-contract";
import { assertCanMutateClaimedCard, closeRunningAttempts } from "./store-card-helpers.js";
import { MAX_CARD_COMMENTS } from "./store-constants.js";
import { WorkboardEnrichmentStore } from "./store-enrichment.js";
import type { WorkboardMutationScope, WorkboardPromoteInput } from "./store-inputs.js";
import { clearDiagnostics, normalizeBoundedString, normalizeStatus } from "./store-normalizers.js";

// Statuses that end a card's active lifecycle. Moving to one of these mirrors
// the cleanup complete()/block() apply: clear the claim, close running
// attempts, and mark a live execution terminal (issue #119592). The terminal
// statuses are also valid WorkboardExecutionStatus values, so the mapping is
// identity: a card moved to "review" gets execution status "review", etc.
function terminalExecutionStatus(status: WorkboardStatus): WorkboardExecutionStatus | undefined {
  if (status === "done" || status === "blocked" || status === "review") {
    return status;
  }
  return undefined;
}

export class WorkboardPromoteStore extends WorkboardEnrichmentStore {
  async promoteReady(now = Date.now()): Promise<{ cards: WorkboardCard[]; count: number }> {
    return await this.enqueueMutation(async () => {
      const promoted: WorkboardCard[] = [];
      for (const card of await this.list()) {
        const next = await this.promoteDependencyReady(card.id, now);
        if (next.status !== card.status) {
          promoted.push(next);
        }
      }
      return { cards: promoted, count: promoted.length };
    });
  }

  async move(
    id: string,
    status: unknown,
    position: unknown,
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new Error(`card not found: ${id}`);
      }
      // Operator surfaces omit scope and may override claims. Agent tools pass scope so a
      // worker cannot move another worker's claimed card between the preflight and this write.
      assertCanMutateClaimedCard(existing, scope);
      const targetStatus = normalizeStatus(status, existing.status);
      const executionStatus = terminalExecutionStatus(targetStatus);
      if (!executionStatus) {
        return await this.updateCard(
          id,
          { status: targetStatus, position },
          {
            allowMetadataDependencyLinks: false,
            enforceStatusHolds: true,
          },
        );
      }
      const now = Date.now();
      // Mirror complete()/block(): a card moved to a terminal status must not
      // keep a live claim, running execution, or open running attempt. Leaving
      // them behind wedges the owner's dispatch slot and makes the card an
      // active dependency target forever (issue #119592).
      const execution =
        existing.execution?.status === "running"
          ? { ...existing.execution, status: executionStatus, updatedAt: now }
          : existing.execution;
      const attemptStatus = executionStatus === "blocked" ? "blocked" : "succeeded";
      return await this.updateCard(
        id,
        {
          status: targetStatus,
          position,
          ...(execution ? { execution } : {}),
          metadata: {
            ...existing.metadata,
            claim: undefined,
            attempts: closeRunningAttempts(existing.metadata?.attempts, now, attemptStatus),
          },
        },
        {
          allowMetadataDependencyLinks: false,
          enforceStatusHolds: true,
        },
      );
    });
  }

  async promote(
    id: string,
    input: WorkboardPromoteInput = {},
    scope?: WorkboardMutationScope | null,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new Error(`card not found: ${id}`);
      }
      assertCanMutateClaimedCard(existing, scope === null ? undefined : scope);
      const reason = normalizeBoundedString(input.reason, undefined, 1000, "promote reason");
      const comments = reason
        ? [
            ...(existing.metadata?.comments ?? []),
            { id: randomUUID(), body: reason, createdAt: Date.now() },
          ].slice(-MAX_CARD_COMMENTS)
        : existing.metadata?.comments;
      return await this.updateCard(
        id,
        {
          status: "ready",
          metadata: {
            ...clearDiagnostics(existing.metadata, ["stranded_ready", "blocked_too_long"]),
            comments,
            stale: null,
          },
        },
        { enforceStatusHolds: input.force !== true },
      );
    });
  }
}
