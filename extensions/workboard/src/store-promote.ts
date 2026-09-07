import { randomUUID } from "node:crypto";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { assertCanMutateClaimedCard } from "./store-card-helpers.js";
import { MAX_CARD_COMMENTS } from "./store-constants.js";
import { WorkboardEnrichmentStore } from "./store-enrichment.js";
import type { WorkboardMutationScope, WorkboardPromoteInput } from "./store-inputs.js";
import { clearDiagnostics, normalizeBoundedString } from "./store-normalizers.js";

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
      const result = await this.updateLatestCard(
        id,
        (current) => {
          // Recheck after every cross-host CAS conflict so a worker cannot move
          // a card claimed between the read and write.
          assertCanMutateClaimedCard(current, scope);
          return { status, position };
        },
        {
          allowMetadataDependencyLinks: false,
          enforceStatusHolds: true,
        },
      );
      return result.card;
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
