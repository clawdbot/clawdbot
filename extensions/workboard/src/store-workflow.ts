import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  WorkboardArtifact,
  WorkboardCard,
  WorkboardClaim,
  WorkboardMetadata,
  WorkboardNotification,
  WorkboardRunAttempt,
} from "@openclaw/workboard-contract";
import { isFutureDateTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  assertCanMutateClaimedCard,
  cardBoardId,
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
  isWorkboardClaimReclaimable,
  MAX_CARD_ARTIFACTS,
  MAX_CARD_COMMENTS,
  MAX_CARD_NOTIFICATIONS,
  secondsToDurationMs,
} from "./store-constants.js";
import type {
  WorkboardBlockInput,
  WorkboardCardPatch,
  WorkboardClaimInput,
  WorkboardClaimOptions,
  WorkboardCompleteInput,
  WorkboardDecomposeChildInput,
  WorkboardDecomposeInput,
  WorkboardHeartbeatInput,
  WorkboardMutationScope,
  WorkboardProofInput,
  WorkboardReassignInput,
  WorkboardReclaimInput,
  WorkboardSpecifyInput,
} from "./store-inputs.js";
import {
  appendCompletionProof,
  capText,
  clearDiagnostics,
  deriveChildIdempotencyKey,
  normalizeArtifact,
  normalizeAutomation,
  normalizeBoundedString,
  normalizeProofInput,
  normalizeStatus,
  normalizeStringList,
  removeUndefinedMetadataFields,
} from "./store-normalizers.js";
import { WorkboardPromoteStore } from "./store-promote.js";

function assertClaimIdentity(claim: WorkboardClaim, input: WorkboardHeartbeatInput): void {
  const token = normalizeOptionalString(input.token);
  const ownerId = normalizeOptionalString(input.ownerId);
  if (token && !safeEqualSecret(token, claim.token)) {
    throw new Error("claim token does not match.");
  }
  if (!token && ownerId && ownerId !== claim.ownerId) {
    throw new Error("claim owner does not match.");
  }
}

export class WorkboardWorkflowStore extends WorkboardPromoteStore {
  async claim(
    id: string,
    input: WorkboardClaimInput,
    options: WorkboardClaimOptions = {},
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
      if (guarded.metadata?.archivedAt) {
        throw new Error("card is archived.");
      }
      const expectedAuthority = options.expectedAuthority;
      if (
        expectedAuthority &&
        (guarded.status !== expectedAuthority.status ||
          cardBoardId(guarded) !== expectedAuthority.boardId ||
          guarded.agentId !== expectedAuthority.agentId ||
          !isDeepStrictEqual(
            guarded.metadata?.automation?.workspace,
            expectedAuthority.workspace,
          ) ||
          !isDeepStrictEqual(
            guarded.metadata?.automation?.workspaceAccess,
            expectedAuthority.workspaceAccess,
          ))
      ) {
        throw new Error("card workspace authority changed before claim.");
      }
      const existingClaim = guarded.metadata?.claim;
      const activeClaim =
        existingClaim &&
        (isFutureDateTimestampMs(existingClaim.expiresAt, { nowMs: now }) ||
          // Direct claims must honor the same running-worker heartbeat grace
          // as dispatcher recovery; otherwise they silently steal live tokens.
          (guarded.status === "running" && !isWorkboardClaimReclaimable(existingClaim, now)))
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
      const card = await this.updateCard(
        id,
        {
          status:
            guarded.status === "backlog" || guarded.status === "todo" || guarded.status === "ready"
              ? "running"
              : guarded.status,
          ...(options.adoptWorkspaceAccess && !guarded.metadata?.automation?.workspaceAccess
            ? { workspaceAccess: options.adoptWorkspaceAccess }
            : {}),
          metadata: {
            ...metadata,
            claim: { ownerId, token, claimedAt: now, lastHeartbeatAt: now, expiresAt },
          },
        },
        {
          expectedUpdatedAt: guarded.updatedAt,
          ownerSlot: { ownerId, now },
        },
      );
      return { card, token };
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
      assertClaimIdentity(claim, input);
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
        assertClaimIdentity(claim, input);
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
    const proofId = normalizeBoundedString(input.proofId, undefined, 120, "proof id");
    if (input.proofId !== undefined && !proofId) {
      throw new Error("proofId must be a non-empty string.");
    }
    if (proofId && !proofInput) {
      throw new Error("proof is required when proofId is provided.");
    }
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
          proof: proof ? appendCompletionProof(metadata.proof, proof, proofId) : metadata.proof,
          artifacts: artifacts.length
            ? [...(metadata.artifacts ?? []), ...artifacts].slice(-MAX_CARD_ARTIFACTS)
            : metadata.artifacts,
          notifications: [...(metadata.notifications ?? []), notification].slice(
            -MAX_CARD_NOTIFICATIONS,
          ),
        },
      },
      {
        enforceStatusHolds: true,
        ...(proof ? { preserveProofId: proofId ?? proof.id } : {}),
      },
    );
  }

  protected buildBlockedCardPatch(
    existing: WorkboardCard,
    reason: string,
    now: number,
    options: { clearExecutionAssociation?: boolean } = {},
  ): WorkboardCardPatch & { metadata: WorkboardMetadata } {
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
    return {
      status: "blocked",
      ...(options.clearExecutionAssociation
        ? { sessionKey: null, runId: null, execution: null }
        : execution
          ? { execution }
          : {}),
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
    };
  }

  async block(
    id: string,
    input: WorkboardBlockInput = {},
    scope: WorkboardMutationScope | null | undefined = input,
    options: { clearExecutionAssociation?: boolean } = {},
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
      return await this.updateCard(id, this.buildBlockedCardPatch(existing, reason, now, options));
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
      return await this.updateCard(
        id,
        {
          ...cardPatch,
          status: "todo",
          metadata,
        },
        { enforceStatusHolds: true, event: { kind: "specified" }, eventAt: now },
      );
    });
  }

  async decompose(
    id: string,
    input: WorkboardDecomposeInput = {},
    scope?: WorkboardMutationScope | null,
  ): Promise<{ parent: WorkboardCard; children: WorkboardCard[] }> {
    return await this.enqueueMutation(
      async () =>
        await this.withCardCompensation(async () => {
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
          const children: WorkboardCard[] = [];
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
            children.push(
              cardParentIds(created).includes(parent.id)
                ? created
                : await this.linkCardsDirect(parent.id, created.id, Date.now(), {
                    allowStatusOnlyActiveChild: true,
                    scope: scope === null ? undefined : scope,
                  }),
            );
          }
          const summary = normalizeBoundedString(
            input.summary,
            undefined,
            2000,
            "decompose summary",
          );
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
          const decomposedParent = await this.updateCard(
            updatedParent.id,
            {},
            {
              event: { kind: "decomposed" },
              expectedUpdatedAt: updatedParent.updatedAt,
            },
          );
          return { parent: decomposedParent, children };
        }),
    );
  }
}
