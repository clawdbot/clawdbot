import { randomUUID } from "node:crypto";
import { isFutureDateTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import {
  appendEvent,
  assertCanMutateClaimedCard,
  capText,
  cardChildIds,
  cardParentIds,
  cardRunId,
  cardSessionKey,
  closeRunningAttempts,
  retryBudgetExhausted,
} from "./store-card-helpers.js";
import {
  addWorkboardDurationMs,
  DEFAULT_CLAIM_TTL_MS,
  MAX_CARD_ARTIFACTS,
  MAX_CARD_COMMENTS,
  MAX_CARD_NOTIFICATIONS,
  MAX_CARD_PROOF,
  secondsToDurationMs,
} from "./store-constants.js";
import { WorkboardEnrichmentStore } from "./store-enrichment.js";
import type {
  WorkboardBlockInput,
  WorkboardClaimInput,
  WorkboardCompleteInput,
  WorkboardDecomposeChildInput,
  WorkboardDecomposeInput,
  WorkboardHeartbeatInput,
  WorkboardMutationScope,
  WorkboardPromoteInput,
  WorkboardProofInput,
  WorkboardReassignInput,
  WorkboardReclaimInput,
  WorkboardSpecifyInput,
} from "./store-inputs.js";
import {
  clearDiagnostics,
  deriveChildIdempotencyKey,
  normalizeArtifact,
  normalizeAutomation,
  normalizeBoundedString,
  normalizeOptionalString,
  normalizeProofInput,
  normalizeStatus,
  normalizeStringList,
  removeUndefinedMetadataFields,
} from "./store-normalizers.js";
import type {
  WorkboardArtifact,
  WorkboardCard,
  WorkboardNotification,
  WorkboardRunAttempt,
} from "./types.js";

export class WorkboardWorkflowStore extends WorkboardEnrichmentStore {
  async claim(
    id: string,
    input: WorkboardClaimInput,
  ): Promise<{ card: WorkboardCard; token: string }> {
    const ownerId = normalizeBoundedString(input.ownerId, undefined, 120, "claim owner");
    if (!ownerId) {
      throw new Error("claim ownerId is required.");
    }
    const ttlSeconds =
      typeof input.ttlSeconds === "number" && Number.isFinite(input.ttlSeconds)
        ? Math.max(1, Math.trunc(input.ttlSeconds))
        : undefined;
    const token =
      normalizeBoundedString(input.token, undefined, 160, "claim token") ?? randomUUID();
    return await this.enqueueMutation(async () => {
      const now = Date.now();
      const expiresAt = addWorkboardDurationMs(
        now,
        ttlSeconds ? secondsToDurationMs(ttlSeconds) : DEFAULT_CLAIM_TTL_MS,
      );
      const guarded = await this.promoteDependencyReady(id, now);
      const existingClaim = guarded.metadata?.claim;
      const activeClaim =
        existingClaim && isFutureDateTimestampMs(existingClaim.expiresAt, { nowMs: now })
          ? existingClaim
          : undefined;
      if (cardParentIds(guarded).length > 0 && guarded.status !== "ready" && !activeClaim) {
        throw new Error("card dependencies are not done.");
      }
      if (guarded.status === "scheduled") {
        throw new Error("card is scheduled for later.");
      }
      if (retryBudgetExhausted(guarded)) {
        throw new Error("card exhausted its retry budget.");
      }
      if (activeClaim) {
        throw new Error(`card already claimed by ${activeClaim.ownerId}.`);
      }
      const metadata = clearDiagnostics(guarded.metadata, ["stranded_ready"]);
      const card = await this.updateCard(id, {
        metadata: {
          ...metadata,
          claim: { ownerId, token, claimedAt: now, lastHeartbeatAt: now, expiresAt },
        },
      });
      const next = await this.updateCard(card.id, {
        status:
          card.status === "backlog" || card.status === "todo" || card.status === "ready"
            ? "running"
            : card.status,
        agentId: card.agentId ?? ownerId,
      });
      return { card: next, token };
    });
  }

  async heartbeat(id: string, input: WorkboardHeartbeatInput): Promise<WorkboardCard> {
    const note = normalizeBoundedString(input.note, undefined, 400, "heartbeat note");
    const card = await this.updateMetadata(id, (existing) => {
      const claim = existing.metadata?.claim;
      if (!claim) {
        throw new Error("card is not claimed.");
      }
      const now = Math.max(Date.now(), claim.lastHeartbeatAt + 1);
      const token = normalizeOptionalString(input.token);
      const ownerId = normalizeOptionalString(input.ownerId);
      if (token && token !== claim.token) {
        throw new Error("claim token does not match.");
      }
      if (!token && ownerId && ownerId !== claim.ownerId) {
        throw new Error("claim owner does not match.");
      }
      const nextClaim = {
        ...claim,
        lastHeartbeatAt: now,
        expiresAt: claim.expiresAt
          ? addWorkboardDurationMs(
              now,
              Math.max(
                1,
                claim.expiresAt > claim.claimedAt
                  ? claim.expiresAt - claim.lastHeartbeatAt
                  : DEFAULT_CLAIM_TTL_MS,
              ),
            )
          : undefined,
      };
      const metadata = clearDiagnostics(existing.metadata, ["running_without_heartbeat"]);
      return {
        ...metadata,
        claim: removeUndefinedMetadataFields({ claim: nextClaim }).claim,
        comments: note
          ? [...(metadata.comments ?? []), { id: randomUUID(), body: note, createdAt: now }].slice(
              -MAX_CARD_COMMENTS,
            )
          : metadata.comments,
      };
    });
    return card;
  }

  async releaseClaim(
    id: string,
    input: WorkboardHeartbeatInput & { status?: unknown } = {},
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new Error(`card not found: ${id}`);
      }
      const status =
        input.status === undefined
          ? existing.status
          : normalizeStatus(input.status, existing.status);
      const claim = existing.metadata?.claim;
      if (claim) {
        const token = normalizeOptionalString(input.token);
        const ownerId = normalizeOptionalString(input.ownerId);
        if (token && token !== claim.token) {
          throw new Error("claim token does not match.");
        }
        if (!token && ownerId && ownerId !== claim.ownerId) {
          throw new Error("claim owner does not match.");
        }
      }
      return await this.updateCard(
        id,
        {
          status,
          metadata: { ...existing.metadata, claim: undefined },
        },
        { enforceStatusHolds: input.status !== undefined },
      );
    });
  }

  async complete(
    id: string,
    input: WorkboardCompleteInput = {},
    scope: WorkboardMutationScope | null | undefined = input,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => await this.completeDirect(id, input, scope));
  }

  private async completeDirect(
    id: string,
    input: WorkboardCompleteInput = {},
    scope: WorkboardMutationScope | null | undefined = input,
  ): Promise<WorkboardCard> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`card not found: ${id}`);
    }
    assertCanMutateClaimedCard(existing, scope === null ? undefined : scope);
    const now = Date.now();
    const createdCardIds = normalizeStringList(input.createdCardIds, "created card ids", 120);
    const childIds = cardChildIds(existing);
    for (const createdCardId of createdCardIds) {
      const createdCard = await this.get(createdCardId);
      if (!createdCard) {
        throw new Error(`created card not found: ${createdCardId}`);
      }
      const linkedFromParent =
        childIds.includes(createdCardId) && cardParentIds(createdCard).includes(existing.id);
      if (!linkedFromParent) {
        throw new Error(`created card is not linked to this card: ${createdCardId}`);
      }
    }
    const summary = normalizeBoundedString(input.summary, undefined, 2000, "summary");
    const proofInput =
      input.proof && typeof input.proof === "object" && !Array.isArray(input.proof)
        ? (input.proof as WorkboardProofInput)
        : undefined;
    const proof = proofInput ? normalizeProofInput(proofInput, now) : undefined;
    const artifacts = Array.isArray(input.artifacts)
      ? input.artifacts
          .map((artifact) => normalizeArtifact({ ...artifact, createdAt: now }))
          .filter((artifact): artifact is WorkboardArtifact => artifact !== null)
          .slice(-MAX_CARD_ARTIFACTS)
      : [];
    const metadata = clearDiagnostics(existing.metadata, ["missing_proof"]);
    const notification: WorkboardNotification = {
      id: randomUUID(),
      kind: "completed",
      createdAt: now,
      sequence: this.nextNotificationSequence(now),
      message: capText(summary, 240) ?? "Workboard card completed.",
      ...(cardSessionKey(existing) ? { sessionKey: cardSessionKey(existing) } : {}),
      ...(cardRunId(existing) ? { runId: cardRunId(existing) } : {}),
    };
    const execution =
      existing.execution?.status === "running"
        ? { ...existing.execution, status: "done" as const, updatedAt: now }
        : existing.execution;
    return await this.updateCard(
      id,
      {
        status: "done",
        ...(execution ? { execution } : {}),
        metadata: {
          ...metadata,
          claim: undefined,
          attempts: closeRunningAttempts(metadata.attempts, now, "succeeded"),
          failureCount: 0,
          automation: normalizeAutomation(
            {
              ...metadata.automation,
              summary,
              createdCardIds,
            },
            metadata.automation,
          ),
          comments: summary
            ? [
                ...(metadata.comments ?? []),
                { id: randomUUID(), body: summary, createdAt: now },
              ].slice(-MAX_CARD_COMMENTS)
            : metadata.comments,
          proof: proof ? [...(metadata.proof ?? []), proof].slice(-MAX_CARD_PROOF) : metadata.proof,
          artifacts: artifacts.length
            ? [...(metadata.artifacts ?? []), ...artifacts].slice(-MAX_CARD_ARTIFACTS)
            : metadata.artifacts,
          notifications: [...(metadata.notifications ?? []), notification].slice(
            -MAX_CARD_NOTIFICATIONS,
          ),
        },
      },
      { enforceStatusHolds: true },
    );
  }

  async block(
    id: string,
    input: WorkboardBlockInput = {},
    scope: WorkboardMutationScope | null | undefined = input,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new Error(`card not found: ${id}`);
      }
      assertCanMutateClaimedCard(existing, scope === null ? undefined : scope);
      const now = Date.now();
      const reason =
        normalizeBoundedString(input.reason, undefined, 2000, "block reason") ??
        "Workboard card blocked.";
      const metadata = existing.metadata ?? {};
      const notification: WorkboardNotification = {
        id: randomUUID(),
        kind: "failed",
        createdAt: now,
        sequence: this.nextNotificationSequence(now),
        message: capText(reason, 240) ?? "Workboard card blocked.",
        ...(cardSessionKey(existing) ? { sessionKey: cardSessionKey(existing) } : {}),
        ...(cardRunId(existing) ? { runId: cardRunId(existing) } : {}),
      };
      const execution =
        existing.execution?.status === "running"
          ? { ...existing.execution, status: "blocked" as const, updatedAt: now }
          : existing.execution;
      return await this.updateCard(id, {
        status: "blocked",
        ...(execution ? { execution } : {}),
        metadata: {
          ...metadata,
          claim: undefined,
          attempts: closeRunningAttempts(metadata.attempts, now, "blocked", reason),
          failureCount: (metadata.failureCount ?? 0) + 1,
          comments: [
            ...(metadata.comments ?? []),
            { id: randomUUID(), body: reason, createdAt: now },
          ].slice(-MAX_CARD_COMMENTS),
          notifications: [...(metadata.notifications ?? []), notification].slice(
            -MAX_CARD_NOTIFICATIONS,
          ),
        },
      });
    });
  }

  async unblock(id: string, scope?: WorkboardMutationScope): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new Error(`card not found: ${id}`);
      }
      assertCanMutateClaimedCard(existing, scope);
      const metadata = clearDiagnostics(existing.metadata, ["blocked_too_long"]);
      return await this.updateCard(id, { status: "todo", metadata: { ...metadata, stale: null } });
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

  async reassign(
    id: string,
    input: WorkboardReassignInput = {},
    scope?: WorkboardMutationScope | null,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new Error(`card not found: ${id}`);
      }
      assertCanMutateClaimedCard(existing, scope === null ? undefined : scope);
      const agentId =
        input.agentId === undefined ? existing.agentId : normalizeOptionalString(input.agentId);
      const status =
        input.status === undefined
          ? existing.status
          : normalizeStatus(input.status, existing.status);
      const reason = normalizeBoundedString(input.reason, undefined, 1000, "reassign reason");
      const shouldResetFailures = input.resetFailures !== false;
      const baseMetadata = shouldResetFailures
        ? clearDiagnostics(existing.metadata, ["blocked_too_long", "repeated_failures"])
        : existing.metadata;
      const metadata = {
        ...baseMetadata,
        ...(shouldResetFailures ? { failureCount: 0 } : {}),
        comments: reason
          ? [
              ...(baseMetadata?.comments ?? []),
              { id: randomUUID(), body: reason, createdAt: Date.now() },
            ].slice(-MAX_CARD_COMMENTS)
          : baseMetadata?.comments,
      };
      return await this.updateCard(id, { agentId, status, metadata }, { enforceStatusHolds: true });
    });
  }

  async reclaim(
    id: string,
    input: WorkboardReclaimInput = {},
    scope?: WorkboardMutationScope | null,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new Error(`card not found: ${id}`);
      }
      assertCanMutateClaimedCard(existing, scope === null ? undefined : scope);
      const now = Date.now();
      const reason =
        normalizeBoundedString(input.reason, undefined, 1000, "reclaim reason") ??
        "Workboard claim reclaimed.";
      const targetStatus =
        input.status === undefined
          ? existing.status === "running"
            ? "ready"
            : existing.status
          : normalizeStatus(input.status, existing.status);
      const reclaimed = await this.updateCard(
        id,
        {
          status: targetStatus,
          execution: existing.execution?.status === "running" ? null : existing.execution,
          metadata: {
            ...existing.metadata,
            claim: undefined,
            attempts: closeRunningAttempts(existing.metadata?.attempts, now, "stopped", reason),
            comments: [
              ...(existing.metadata?.comments ?? []),
              { id: randomUUID(), body: reason, createdAt: now },
            ].slice(-MAX_CARD_COMMENTS),
            stale: null,
          },
        },
        { enforceStatusHolds: true },
      );
      return await this.promoteDependencyReady(reclaimed.id, now);
    });
  }

  async runs(id: string): Promise<{ card: WorkboardCard; attempts: WorkboardRunAttempt[] }> {
    const card = await this.get(id);
    if (!card) {
      throw new Error(`card not found: ${id}`);
    }
    return { card, attempts: card.metadata?.attempts ?? [] };
  }

  async specify(
    id: string,
    input: WorkboardSpecifyInput = {},
    scope?: WorkboardMutationScope | null,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new Error(`card not found: ${id}`);
      }
      assertCanMutateClaimedCard(existing, scope === null ? undefined : scope);
      if (
        existing.status !== "triage" &&
        existing.status !== "backlog" &&
        existing.status !== "todo"
      ) {
        throw new Error("only triage, backlog, or todo cards can be specified.");
      }
      const requestedStatus = normalizeStatus(input.status, "todo");
      if (requestedStatus !== "todo") {
        throw new Error("specified cards must move to todo.");
      }
      const now = Date.now();
      const summary = normalizeBoundedString(input.summary, undefined, 2000, "spec summary");
      const metadata = {
        ...existing.metadata,
        comments: summary
          ? [
              ...(existing.metadata?.comments ?? []),
              { id: randomUUID(), body: summary, createdAt: now },
            ].slice(-MAX_CARD_COMMENTS)
          : existing.metadata?.comments,
        automation: normalizeAutomation(
          {
            ...existing.metadata?.automation,
            summary: summary ?? existing.metadata?.automation?.summary,
          },
          existing.metadata?.automation,
        ),
      };
      const { summary: _summary, status: _status, ...cardPatch } = input;
      const updated = await this.updateCard(
        id,
        {
          ...cardPatch,
          status: "todo",
          metadata,
        },
        { enforceStatusHolds: true },
      );
      const specified = {
        ...updated,
        events: appendEvent(updated, { kind: "specified" }, now),
      };
      await this.store.register(specified.id, { version: 1, card: specified });
      return specified;
    });
  }

  async decompose(
    id: string,
    input: WorkboardDecomposeInput = {},
    scope?: WorkboardMutationScope | null,
  ): Promise<{ parent: WorkboardCard; children: WorkboardCard[] }> {
    return await this.enqueueMutation(async () => {
      const parent = await this.get(id);
      if (!parent) {
        throw new Error(`card not found: ${id}`);
      }
      assertCanMutateClaimedCard(parent, scope === null ? undefined : scope);
      const childrenInput = Array.isArray(input.children) ? input.children : [];
      if (childrenInput.length === 0) {
        throw new Error("children are required.");
      }
      if (childrenInput.length > 20) {
        throw new Error("at most 20 children can be created at once.");
      }
      const parentAutomation = parent.metadata?.automation;
      const existingCardIds = new Set((await this.list()).map((card) => card.id));
      const children: WorkboardCard[] = [];
      const reusedChildSnapshots = new Map<string, WorkboardCard>();
      try {
        for (const rawChild of childrenInput) {
          if (!rawChild || typeof rawChild !== "object" || Array.isArray(rawChild)) {
            throw new Error("children must be objects.");
          }
          const child = rawChild as WorkboardDecomposeChildInput;
          const created = await this.createDirect(
            {
              ...child,
              parents: [parent.id],
              boardId: child.boardId ?? parentAutomation?.boardId,
              tenant: child.tenant ?? parentAutomation?.tenant,
              createdByCardId: parent.id,
              idempotencyKey:
                child.idempotencyKey ??
                deriveChildIdempotencyKey(parentAutomation?.idempotencyKey, children.length + 1),
            },
            scope === null ? undefined : scope,
          );
          const reusedUnlinkedChild =
            existingCardIds.has(created.id) && !cardParentIds(created).includes(parent.id);
          if (reusedUnlinkedChild) {
            reusedChildSnapshots.set(created.id, created);
          }
          children.push(
            cardParentIds(created).includes(parent.id)
              ? created
              : await this.linkCardsDirect(parent.id, created.id, Date.now(), {
                  allowStatusOnlyActiveChild: true,
                  scope: scope === null ? undefined : scope,
                }),
          );
        }
        const summary = normalizeBoundedString(input.summary, undefined, 2000, "decompose summary");
        const completeParent = input.completeParent !== false;
        const updatedParent = completeParent
          ? await this.completeDirect(
              parent.id,
              { summary, createdCardIds: children.map((child) => child.id) },
              scope,
            )
          : await (async () => {
              const latestParent = (await this.get(parent.id)) ?? parent;
              return await this.updateCard(
                parent.id,
                {
                  status:
                    latestParent.status === "triage" || latestParent.status === "backlog"
                      ? "todo"
                      : latestParent.status,
                  metadata: {
                    ...latestParent.metadata,
                    automation: normalizeAutomation(
                      {
                        ...latestParent.metadata?.automation,
                        summary,
                        createdCardIds: children.map((child) => child.id),
                      },
                      latestParent.metadata?.automation,
                    ),
                  },
                },
                { enforceStatusHolds: true },
              );
            })();
        const decomposedParent = {
          ...updatedParent,
          events: appendEvent(updatedParent, { kind: "decomposed" }),
        };
        await this.store.register(decomposedParent.id, { version: 1, card: decomposedParent });
        return { parent: decomposedParent, children };
      } catch (error) {
        for (const child of children.toReversed()) {
          if (!existingCardIds.has(child.id)) {
            await this.deleteDirect(child.id);
          }
        }
        for (const child of reusedChildSnapshots.values()) {
          await this.store.register(child.id, { version: 1, card: child });
        }
        await this.store.register(parent.id, { version: 1, card: parent });
        throw error;
      }
    });
  }
}
