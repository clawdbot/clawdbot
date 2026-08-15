import { randomUUID } from "node:crypto";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { assertCanMutateClaimedCard, cardParentIds } from "./store-card-helpers.js";
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
      const existing = await this.get(id);
      if (!existing) {
        throw new Error(`card not found: ${id}`);
      }
      // Operator surfaces omit scope and may override claims. Agent tools pass scope so a
      // worker cannot move another worker's claimed card between the preflight and this write.
      assertCanMutateClaimedCard(existing, scope);
      return await this.updateCard(
        id,
        { status, position },
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
      const now = Date.now();
      const reason = normalizeBoundedString(input.reason, undefined, 1000, "promote reason");
      const comments = reason
        ? [
            ...(existing.metadata?.comments ?? []),
            { id: randomUUID(), body: reason, createdAt: now },
          ].slice(-MAX_CARD_COMMENTS)
        : existing.metadata?.comments;
      const metadata = {
        ...clearDiagnostics(existing.metadata, ["stranded_ready", "blocked_too_long"]),
        comments,
        stale: undefined,
      };
      if (input.force !== true && existing.metadata?.dependencyOverride) {
        const recoveryStatus = existing.metadata.dependencyOverride.scheduledWithoutDate
          ? "scheduled"
          : existing.status;
        const clearedMetadata = { ...metadata, dependencyOverride: undefined };
        const status = await this.dependencyTargetStatus(
          { ...existing, status: recoveryStatus, metadata: clearedMetadata },
          now,
        );
        return await this.updateCard(
          id,
          { status, metadata: clearedMetadata },
          { enforceStatusHolds: false, allowMetadataDependencyOverride: true },
        );
      }
      const parentIds = cardParentIds(existing).toSorted();
      const scheduledAt = existing.metadata?.automation?.scheduledAt;
      const scheduledWithoutDate = existing.status === "scheduled" && !scheduledAt;
      const dependencyOverride =
        input.force === true &&
        (parentIds.length > 0 || Boolean(scheduledAt && scheduledAt > now) || scheduledWithoutDate)
          ? {
              grantedAt: now,
              parentIds,
              ...(scheduledAt ? { scheduledAt } : {}),
              ...(scheduledWithoutDate ? { scheduledWithoutDate: true as const } : {}),
              ...(reason ? { reason } : {}),
            }
          : undefined;
      return await this.updateCard(
        id,
        {
          status: "ready",
          metadata: {
            ...metadata,
            dependencyOverride,
          },
        },
        {
          enforceStatusHolds: input.force !== true,
          allowMetadataDependencyOverride: true,
        },
      );
    });
  }
}
