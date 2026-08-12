// Workboard plugin module implements store behavior.
import { createHash, randomUUID } from "node:crypto";
import type {
  WorkboardAttachment,
  WorkboardCard,
  WorkboardExternalExecutionLink,
  WorkboardReconciliationApplyResult,
  WorkboardReconciliationObservation,
  WorkboardReconciliationSourceObservation,
  WorkboardReconciliationSourceObservationResult,
  WorkboardLink,
  WorkboardStatus,
} from "@openclaw/workboard-contract";
import type {
  PersistedWorkboardAttachment,
  PersistedWorkboardBoard,
  PersistedWorkboardNotificationSubscription,
  WorkboardKeyedStore,
} from "./persistence-types.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import {
  buildWorkerContext,
  cardBoardId,
  closeRunningAttempts,
  computeCardDiagnostics,
  isDependencyPromotableStatus,
  latestRunningAttempt,
  mergeDiagnostics,
  removeUndefinedCardFields,
  retryBudgetExhausted,
} from "./store-card-helpers.js";
import {
  isWorkboardClaimReclaimable,
  MAX_ATTACHMENT_ENTRIES,
  MAX_CARDS,
  MAX_CARD_NOTIFICATIONS,
  secondsToDurationMs,
} from "./store-constants.js";
import type {
  WorkboardBulkInput,
  WorkboardCardPatch,
  WorkboardDiagnosticsResult,
  WorkboardDispatchOptions,
  WorkboardDispatchResult,
} from "./store-inputs.js";
import {
  metadataIsEmpty,
  normalizeBoardId,
  normalizeTimestamp,
  trimMetadataToBudget,
} from "./store-normalizers.js";
import { WorkboardNotificationStore } from "./store-notifications.js";

export type { WorkboardDispatchResult } from "./store-inputs.js";

const RECONCILIATION_PROTECTED_STATUSES = new Set<WorkboardStatus>(["blocked", "review", "done"]);

function reconciliationLinkFor(
  card: WorkboardCard,
  fallback: WorkboardExternalExecutionLink,
): WorkboardExternalExecutionLink {
  const link = externalLinkFor(card, fallback);
  return {
    sourceUrl: link?.url ?? card.sourceUrl ?? fallback.sourceUrl,
    tenant: card.metadata?.automation?.tenant ?? fallback.tenant,
    idempotencyKey: fallback.idempotencyKey,
    sourceUpdatedAt: link?.sourceUpdatedAt ?? fallback.sourceUpdatedAt,
    reconciliationAssociationKey:
      link?.reconciliationAssociationKey ?? fallback.reconciliationAssociationKey,
    ...(link?.title ? { title: link.title } : {}),
  };
}

function externalLinkId(link: WorkboardExternalExecutionLink): string {
  return `external:${createHash("sha256").update(`${link.tenant}\u0000${link.idempotencyKey}`).digest("base64url")}`;
}

function isExternalLinkFor(card: WorkboardCard, link: WorkboardExternalExecutionLink): boolean {
  return externalLinkFor(card, link) !== undefined;
}

function externalLinkFor(card: WorkboardCard, link: WorkboardExternalExecutionLink) {
  return card.metadata?.links?.find(
    (entry) =>
      entry.id === externalLinkId(link) ||
      (entry.id === `external:${link.idempotencyKey}` &&
        card.metadata?.automation?.tenant === link.tenant),
  );
}

function latestExternalSourceUpdatedAt(card: WorkboardCard): number | undefined {
  const values = card.metadata?.links
    ?.filter((entry) => entry.id.startsWith("external:"))
    .map((entry) => entry.sourceUpdatedAt)
    .filter((value): value is number => value !== undefined);
  return values?.length ? Math.max(...values) : undefined;
}

function hasExternalLink(card: WorkboardCard, link: WorkboardExternalExecutionLink): boolean {
  return isExternalLinkFor(card, link);
}

function appendExternalLink(card: WorkboardCard, link: WorkboardExternalExecutionLink) {
  return [
    ...(card.metadata?.links ?? []),
    {
      id: externalLinkId(link),
      type: "relates_to" as const,
      createdAt: Date.now(),
      sourceUpdatedAt: link.sourceUpdatedAt,
      reconciliationAssociationKey:
        link.reconciliationAssociationKey ?? randomUUID().replaceAll("-", ""),
      url: link.sourceUrl,
      ...(link.title ? { title: link.title } : {}),
    },
  ];
}

function objectiveKeyFor(card: WorkboardCard): string | undefined {
  return card.metadata?.automation?.objectiveKey;
}

function reconciliationResult(
  card: WorkboardCard,
  outcome: "applied" | "duplicate" | "protected" | "stale" | "conflict",
  link: WorkboardExternalExecutionLink,
): WorkboardReconciliationApplyResult & {
  outcome: "applied" | "duplicate" | "protected" | "stale" | "conflict";
} {
  return {
    card,
    applied: outcome === "applied" || outcome === "duplicate" || outcome === "stale",
    outcome,
    link,
  };
}

function sourceObservationRequestJson(
  observation: WorkboardReconciliationSourceObservation,
): string {
  return JSON.stringify({
    cardId: observation.cardId,
    tenant: observation.tenant,
    objectiveKey: observation.objectiveKey,
    sourceUrl: observation.sourceUrl,
    reconciliationAssociationKey: observation.reconciliationAssociationKey,
    observationId: observation.observationId,
    sourceState: observation.sourceState,
    staleAfterMisses: observation.staleAfterMisses,
  });
}

function canonicalSourceObservationRequestJson(
  value: string | undefined,
  associationKey: string,
): string | undefined {
  if (!value) return undefined;
  try {
    const request = JSON.parse(value) as Record<string, unknown>;
    return JSON.stringify({
      cardId: request.cardId,
      tenant: request.tenant,
      objectiveKey: request.objectiveKey,
      sourceUrl: request.sourceUrl,
      reconciliationAssociationKey:
        typeof request.reconciliationAssociationKey === "string"
          ? request.reconciliationAssociationKey
          : associationKey,
      observationId: request.observationId,
      sourceState: request.sourceState,
      staleAfterMisses: request.staleAfterMisses,
    });
  } catch {
    return value;
  }
}

function sourceObservationResult(
  card: WorkboardCard,
  observation: WorkboardReconciliationSourceObservation,
  evidence: WorkboardLink,
): WorkboardReconciliationSourceObservationResult {
  const persistedEvidence = sourceObservationEvidence(evidence);
  return {
    card,
    association: {
      cardId: observation.cardId,
      tenant: observation.tenant,
      objectiveKey: observation.objectiveKey,
      sourceUrl: observation.sourceUrl,
      reconciliationAssociationKey: observation.reconciliationAssociationKey,
    },
    observationId: observation.observationId,
    revision: evidence.lastSourceObservationRevision ?? card.updatedAt,
    evidence: {
      ...persistedEvidence,
      ...(evidence.lastSourceObservationId === undefined
        ? {}
        : { lastSourceObservationId: evidence.lastSourceObservationId }),
    },
  };
}

function sourceObservationEvidence(evidence: WorkboardLink) {
  const fallback = rawSourceObservationEvidence(evidence);
  if (!evidence.lastSourceObservationEvidenceJson) return fallback;
  try {
    const value = JSON.parse(evidence.lastSourceObservationEvidenceJson) as Record<string, unknown>;
    return {
      ...(typeof value.consecutiveSuccessfulFullScanMisses === "number"
        ? { consecutiveSuccessfulFullScanMisses: value.consecutiveSuccessfulFullScanMisses }
        : {}),
      ...(typeof value.staleAt === "number" ? { staleAt: value.staleAt } : {}),
      ...(value.staleState === "stale" ? { staleState: "stale" as const } : {}),
    };
  } catch {
    return fallback;
  }
}

function rawSourceObservationEvidence(evidence: WorkboardLink) {
  return {
    ...(evidence.consecutiveSuccessfulFullScanMisses === undefined
      ? {}
      : { consecutiveSuccessfulFullScanMisses: evidence.consecutiveSuccessfulFullScanMisses }),
    ...(evidence.staleAt === undefined ? {} : { staleAt: evidence.staleAt }),
    ...(evidence.staleState === undefined ? {} : { staleState: evidence.staleState }),
  };
}

// Capability layers split review boundaries only; the core still owns persistence and mutation order.
export class WorkboardStore extends WorkboardNotificationStore {
  /**
   * Applies an externally observed execution within the store mutation queue.
   * Every precondition is evaluated from the same card snapshot that is mutated.
   */
  async applyReconciliation(
    observation: WorkboardReconciliationObservation,
    link: WorkboardExternalExecutionLink,
  ): Promise<WorkboardReconciliationApplyResult> {
    return await this.enqueueMutation(async () => {
      const cards = await this.list();
      const explicit = observation.cardId ? await this.get(observation.cardId) : undefined;
      if (observation.cardId && !explicit) {
        throw new Error(`card not found: ${observation.cardId}`);
      }
      if (
        explicit &&
        observation.objectiveKey !== undefined &&
        objectiveKeyFor(explicit) !== observation.objectiveKey
      ) {
        throw new Error("objectiveKey does not match card.");
      }
      const duplicate = cards.find(
        (card) =>
          card.metadata?.automation?.tenant === link.tenant &&
          (card.metadata?.automation?.idempotencyKey === link.idempotencyKey ||
            hasExternalLink(card, link)),
      );
      if (duplicate) {
        if (explicit && duplicate.id !== explicit.id) {
          throw new Error("idempotency association does not match card.");
        }
        return reconciliationResult(duplicate, "duplicate", reconciliationLinkFor(duplicate, link));
      }

      const existing = explicit
        ? explicit
        : cards.find((card) => {
            if (card.metadata?.automation?.tenant !== link.tenant) return false;
            return observation.objectiveKey !== undefined
              ? objectiveKeyFor(card) === observation.objectiveKey
              : card.sourceUrl === link.sourceUrl;
          });
      if (existing) {
        if (
          existing.metadata?.automation?.tenant !== undefined &&
          existing.metadata.automation.tenant !== link.tenant
        ) {
          return reconciliationResult(existing, "conflict", link);
        }
        if (
          observation.expectedRevision !== undefined &&
          observation.expectedRevision !== existing.updatedAt
        ) {
          return reconciliationResult(existing, "conflict", link);
        }
        if (RECONCILIATION_PROTECTED_STATUSES.has(existing.status)) {
          return reconciliationResult(existing, "protected", link);
        }
        const latestAssociationSourceUpdatedAt = latestExternalSourceUpdatedAt(existing);
        if (
          (existing.metadata?.lifecycleStatusSourceUpdatedAt !== undefined &&
            link.sourceUpdatedAt < existing.metadata.lifecycleStatusSourceUpdatedAt) ||
          (latestAssociationSourceUpdatedAt !== undefined &&
            link.sourceUpdatedAt < latestAssociationSourceUpdatedAt)
        ) {
          const associated = await this.updateCard(
            existing.id,
            {
              metadata: {
                ...existing.metadata,
                links: appendExternalLink(existing, link),
                ...(observation.triage ? { reconciliationTriage: observation.triage } : {}),
              },
            },
            { allowReconciliationTriage: true },
          );
          return reconciliationResult(associated, "stale", reconciliationLinkFor(associated, link));
        }
        const patch = observation.card ?? {};
        const updated = await this.updateCard(
          existing.id,
          {
            ...patch,
            ...(RECONCILIATION_PROTECTED_STATUSES.has(patch.status as WorkboardStatus)
              ? { status: existing.status }
              : {}),
            sourceUrl: link.sourceUrl,
            tenant: link.tenant,
            idempotencyKey: link.idempotencyKey,
            metadata: {
              ...existing.metadata,
              lifecycleStatusSourceUpdatedAt: link.sourceUpdatedAt,
              links: appendExternalLink(existing, link),
              ...(observation.triage ? { reconciliationTriage: observation.triage } : {}),
            },
          },
          { allowReconciliationTriage: true },
        );
        return reconciliationResult(updated, "applied", reconciliationLinkFor(updated, link));
      }

      const card = observation.card ?? {};
      if (typeof card.title !== "string" || card.title.trim() === "") {
        throw new Error("card.title is required when creating a card.");
      }
      const created = await this.createDirect(
        {
          ...card,
          ...(RECONCILIATION_PROTECTED_STATUSES.has(card.status as WorkboardStatus)
            ? { status: "todo" }
            : {}),
          sourceUrl: link.sourceUrl,
          tenant: link.tenant,
          idempotencyKey: link.idempotencyKey,
          metadata: {
            automation: {
              tenant: link.tenant,
              idempotencyKey: link.idempotencyKey,
            },
            lifecycleStatusSourceUpdatedAt: link.sourceUpdatedAt,
            links: [
              {
                id: externalLinkId(link),
                type: "relates_to",
                createdAt: Date.now(),
                sourceUpdatedAt: link.sourceUpdatedAt,
                reconciliationAssociationKey:
                  link.reconciliationAssociationKey ?? randomUUID().replaceAll("-", ""),
                url: link.sourceUrl,
                ...(link.title ? { title: link.title } : {}),
              },
            ],
            ...(observation.triage ? { reconciliationTriage: observation.triage } : {}),
          },
        },
        undefined,
        {
          ...(observation.objectiveKey === undefined
            ? {}
            : { reconciliationObjectiveKey: observation.objectiveKey }),
          ...(observation.triage === undefined ? {} : { reconciliationTriage: observation.triage }),
        },
      );
      return reconciliationResult(created, "applied", reconciliationLinkFor(created, link));
    });
  }

  async applyReconciliationSourceObservation(
    observation: WorkboardReconciliationSourceObservation,
  ): Promise<WorkboardReconciliationSourceObservationResult> {
    return await this.enqueueMutation(async () => {
      const card = await this.get(observation.cardId);
      if (!card) throw new Error(`card not found: ${observation.cardId}`);
      if (
        card.metadata?.automation?.tenant !== observation.tenant ||
        objectiveKeyFor(card) !== observation.objectiveKey
      ) {
        throw new Error("source observation does not match card.");
      }
      const links = card.metadata?.links ?? [];
      const index = links.findIndex(
        (link) => link.reconciliationAssociationKey === observation.reconciliationAssociationKey,
      );
      if (index === -1)
        throw new Error("source observation does not match an external association.");
      const current = links[index]!;
      if (!current.id.startsWith("external:") || current.url !== observation.sourceUrl) {
        throw new Error("source observation does not match an external association.");
      }
      const requestJson = sourceObservationRequestJson(observation);
      if (current.lastSourceObservationId === observation.observationId) {
        if (
          canonicalSourceObservationRequestJson(
            current.lastSourceObservationRequestJson,
            observation.reconciliationAssociationKey,
          ) !== requestJson
        ) {
          throw new Error("source observationId conflicts with a different request.");
        }
        return sourceObservationResult(card, observation, current);
      }
      if (
        observation.expectedRevision !== undefined &&
        card.updatedAt !== observation.expectedRevision
      ) {
        throw new Error("source observation does not match card.");
      }
      const misses =
        observation.sourceState === "present"
          ? 0
          : observation.sourceState === "dependency-failed"
            ? current.consecutiveSuccessfulFullScanMisses
            : (current.consecutiveSuccessfulFullScanMisses ?? 0) + 1;
      const nextEvidence = {
        ...current,
        ...(misses === undefined ? {} : { consecutiveSuccessfulFullScanMisses: misses }),
        ...(observation.sourceState === "dependency-failed"
          ? {}
          : observation.sourceState === "present"
            ? { staleAt: undefined, staleState: undefined }
            : current.staleAt === undefined && (misses ?? 0) >= observation.staleAfterMisses
              ? { staleAt: observation.observedAt, staleState: "stale" as const }
              : {}),
      };
      const acknowledgementRevision = Math.max(Date.now(), card.updatedAt + 1);
      const next = {
        ...nextEvidence,
        lastSourceObservationId: observation.observationId,
        lastSourceObservationRequestJson: requestJson,
        lastSourceObservationRevision: acknowledgementRevision,
        lastSourceObservationEvidenceJson: JSON.stringify(
          rawSourceObservationEvidence(nextEvidence),
        ),
      };
      const nextLinks = [...links];
      nextLinks[index] = next;
      const updated = await this.updateCard(
        card.id,
        {
          metadata: { ...card.metadata, links: nextLinks },
        },
        { updatedAt: acknowledgementRevision },
      );
      const evidence = updated.metadata?.links?.find(
        (link) => link.reconciliationAssociationKey === observation.reconciliationAssociationKey,
      );
      if (!evidence) throw new Error("source observation evidence was not persisted.");
      return sourceObservationResult(updated, observation, evidence);
    });
  }

  private async shouldAutoOrchestrate(card: WorkboardCard): Promise<boolean> {
    if (
      card.status !== "triage" ||
      card.metadata?.archivedAt ||
      card.metadata?.workerProtocol?.state === "idle"
    ) {
      return false;
    }
    const board = await this.boardStore.lookup(cardBoardId(card));
    return board?.version === 1 && board.board.orchestration?.autoDecompose === true;
  }

  async dispatch(
    input: number | WorkboardDispatchOptions = Date.now(),
  ): Promise<WorkboardDispatchResult> {
    const now = typeof input === "number" ? input : normalizeTimestamp(input.now, Date.now());
    const boardId = typeof input === "number" ? undefined : normalizeBoardId(input.boardId);
    return await this.enqueueMutation(async () => {
      const promoted: WorkboardCard[] = [];
      const reclaimed: WorkboardCard[] = [];
      const blocked: WorkboardCard[] = [];
      const orchestrated: WorkboardCard[] = [];
      const orchestratedByBoard = new Map<string, number>();
      for (const card of await this.list({ boardId })) {
        // Archived cards remain readable and restorable, but must never re-enter automation.
        if (card.metadata?.archivedAt) {
          continue;
        }
        let latest = await this.promoteDependencyReady(card.id, now);
        const wasPromoted = latest.status !== card.status;
        const claim = latest.metadata?.claim;
        const latestAttempt = latestRunningAttempt(latest);
        const maxRuntimeSeconds = latest.metadata?.automation?.maxRuntimeSeconds;
        const runtimeStartedAt = latestAttempt?.startedAt ?? claim?.claimedAt ?? latest.startedAt;
        const timedOut =
          Boolean(maxRuntimeSeconds && runtimeStartedAt) &&
          now - runtimeStartedAt! > secondsToDurationMs(maxRuntimeSeconds!);
        const claimExpired = isWorkboardClaimReclaimable(claim, now);
        const retriesExhausted = retryBudgetExhausted(latest);
        if (latest.status === "running" && (timedOut || claimExpired)) {
          const reason = timedOut
            ? "Run exceeded the card max runtime."
            : "Claim expired without a recent heartbeat.";
          const execution =
            latest.execution?.status === "running"
              ? { ...latest.execution, status: "blocked" as const, updatedAt: now }
              : latest.execution;
          latest = await this.updateCard(latest.id, {
            status: "blocked",
            ...(execution ? { execution } : {}),
            metadata: {
              ...latest.metadata,
              claim: undefined,
              attempts: closeRunningAttempts(latest.metadata?.attempts, now, "blocked", reason),
              failureCount: (latest.metadata?.failureCount ?? 0) + 1,
              notifications: [
                ...(latest.metadata?.notifications ?? []),
                {
                  id: randomUUID(),
                  kind: "failed" as const,
                  createdAt: now,
                  sequence: this.nextNotificationSequence(now),
                  message: reason,
                },
              ].slice(-MAX_CARD_NOTIFICATIONS),
            },
          });
          blocked.push(latest);
        } else if (claimExpired) {
          latest = await this.updateCard(latest.id, {
            metadata: { ...latest.metadata, claim: undefined },
          });
          reclaimed.push(latest);
        }
        if (
          !latest.metadata?.claim &&
          retriesExhausted &&
          isDependencyPromotableStatus(latest.status)
        ) {
          latest = await this.updateCard(latest.id, {
            status: "blocked",
            metadata: {
              ...latest.metadata,
              notifications: [
                ...(latest.metadata?.notifications ?? []),
                {
                  id: randomUUID(),
                  kind: "failed" as const,
                  createdAt: now,
                  sequence: this.nextNotificationSequence(now),
                  message: "Card exhausted its retry budget.",
                },
              ].slice(-MAX_CARD_NOTIFICATIONS),
            },
          });
          blocked.push(latest);
        }
        if (latest.status === "ready" && !latest.metadata?.archivedAt) {
          latest = await this.recordDispatch(latest, now);
        }
        if (await this.shouldAutoOrchestrate(latest)) {
          const latestBoardId = cardBoardId(latest);
          const board = await this.boardStore.lookup(latestBoardId);
          const cap = board?.board.orchestration?.autoDecomposePerDispatch ?? 3;
          const boardCount = orchestratedByBoard.get(latestBoardId) ?? 0;
          if (boardCount < cap) {
            latest = await this.recordOrchestrationCandidate(latest, now);
            orchestrated.push(latest);
            orchestratedByBoard.set(latestBoardId, boardCount + 1);
          }
        }
        if (wasPromoted && latest.status !== "blocked") {
          promoted.push(latest);
        }
      }
      return {
        promoted,
        reclaimed,
        blocked,
        orchestrated,
        count: promoted.length + reclaimed.length + blocked.length + orchestrated.length,
      };
    });
  }

  async bulkUpdate(input: WorkboardBulkInput): Promise<{ cards: WorkboardCard[] }> {
    const ids = Array.isArray(input.ids)
      ? input.ids.filter((id): id is string => typeof id === "string" && id.trim() !== "")
      : [];
    if (ids.length === 0) {
      throw new Error("ids are required.");
    }
    const patch =
      input.patch && typeof input.patch === "object" && !Array.isArray(input.patch)
        ? (input.patch as WorkboardCardPatch)
        : {};
    const cards: WorkboardCard[] = [];
    for (const id of ids) {
      const updated =
        input.archived === undefined
          ? await this.update(id, patch)
          : await this.archive(id, input.archived);
      cards.push(updated);
    }
    return { cards };
  }

  async archive(id: string, archived: unknown): Promise<WorkboardCard> {
    const shouldArchive = archived !== false;
    return await this.updateMetadata(id, (existing) => ({
      ...existing.metadata,
      archivedAt: shouldArchive ? Date.now() : 0,
    }));
  }

  async exportCards(): Promise<{
    cards: WorkboardCard[];
    attachments: WorkboardAttachment[];
    exportedAt: number;
  }> {
    const cards = await this.list();
    const attachments = cards.flatMap((card) => card.metadata?.attachments ?? []);
    return { cards, attachments, exportedAt: Date.now() };
  }

  async diagnostics(now = Date.now()): Promise<WorkboardDiagnosticsResult> {
    const cards = await this.list();
    const rows = cards.flatMap((card) => {
      const diagnostics = computeCardDiagnostics(card, now);
      return diagnostics.length ? [{ card, diagnostics }] : [];
    });
    return {
      diagnostics: rows,
      count: rows.reduce((total, row) => total + row.diagnostics.length, 0),
    };
  }

  async refreshDiagnostics(now = Date.now()): Promise<WorkboardDiagnosticsResult> {
    return await this.enqueueMutation(async () => {
      const cards = await this.list();
      const rows: WorkboardDiagnosticsResult["diagnostics"] = [];
      for (const card of cards) {
        const latest = await this.get(card.id);
        if (!latest || latest.metadata?.archivedAt) {
          continue;
        }
        const diagnostics = mergeDiagnostics(
          latest.metadata?.diagnostics,
          computeCardDiagnostics(latest, now),
        );
        if (diagnostics.length === 0 && !latest.metadata?.diagnostics?.length) {
          continue;
        }
        const metadata = trimMetadataToBudget({ ...latest.metadata, diagnostics });
        const next = removeUndefinedCardFields({
          ...latest,
          metadata: metadataIsEmpty(metadata) ? undefined : metadata,
        });
        await this.store.register(next.id, { version: 1, card: next });
        if (diagnostics.length > 0) {
          rows.push({ card: next, diagnostics });
        }
      }
      return {
        diagnostics: rows,
        count: rows.reduce((total, row) => total + row.diagnostics.length, 0),
      };
    });
  }

  async buildWorkerContext(id: string): Promise<string> {
    const card = await this.get(id);
    if (!card) {
      throw new Error(`card not found: ${id}`);
    }
    return buildWorkerContext(card, await this.list());
  }

  static open(
    openKeyedStore: (options: {
      namespace: string;
      maxEntries: number;
    }) => WorkboardKeyedStore<unknown>,
  ) {
    return new WorkboardStore(
      openKeyedStore({
        namespace: "workboard.cards",
        maxEntries: MAX_CARDS,
      }) as WorkboardKeyedStore,
      {
        boards: openKeyedStore({
          namespace: "workboard.boards",
          maxEntries: 200,
        }) as WorkboardKeyedStore<PersistedWorkboardBoard>,
        subscriptions: openKeyedStore({
          namespace: "workboard.notify",
          maxEntries: 2000,
        }) as WorkboardKeyedStore<PersistedWorkboardNotificationSubscription>,
        attachments: openKeyedStore({
          namespace: "workboard.attachments",
          maxEntries: MAX_ATTACHMENT_ENTRIES,
        }) as WorkboardKeyedStore<PersistedWorkboardAttachment>,
      },
    );
  }

  static openSqlite() {
    const stores = createWorkboardSqliteStores();
    return new WorkboardStore(stores.cards, {
      boards: stores.boards,
      subscriptions: stores.subscriptions,
      attachments: stores.attachments,
      dataVersion: stores.dataVersion,
    });
  }
}
