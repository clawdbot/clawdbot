// Workboard plugin module implements store behavior.
import { randomUUID } from "node:crypto";
import type {
  WorkboardAttachment,
  WorkboardCard,
  WorkboardDiagnostic,
  WorkboardExecution,
  WorkboardExecutionStatus,
  WorkboardMetadata,
  WorkboardStaleState,
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
  cardRunId,
  cardSessionKey,
  closeRunningAttempts,
  computeCardDiagnostics,
  isDependencyPromotableStatus,
  latestRunningAttempt,
  mergeDiagnostics,
  retryBudgetExhausted,
  shouldSkipPersistedLifecycleStatusUpdate,
  shouldSyncWorkboardLifecycleStatus,
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
import { normalizeBoardId, normalizeTimestamp } from "./store-normalizers.js";
import { WorkboardNotificationStore } from "./store-notifications.js";

export type { WorkboardDispatchResult } from "./store-inputs.js";
export { WorkboardCardConflictError } from "./store-core.js";

type WorkboardExecutionAssociationInput = {
  expectedSessionKey?: string;
  expectedRunId?: string;
  sessionKey: string;
  runId?: string;
  execution: WorkboardExecution;
};

type WorkboardLifecycleAssociation = Omit<WorkboardExecutionAssociationInput, "execution">;
type WorkboardExecutionAssociationPatch = WorkboardCardPatch & {
  metadata?: WorkboardMetadata;
};

function executionAssociationPatch(
  card: WorkboardCard,
  input: WorkboardExecutionAssociationInput,
): WorkboardExecutionAssociationPatch | undefined {
  if (
    cardSessionKey(card) !== input.expectedSessionKey ||
    cardRunId(card) !== input.expectedRunId
  ) {
    return undefined;
  }
  const attempts = [...(card.metadata?.attempts ?? [])];
  const attemptIndex = attempts.findLastIndex(
    (attempt) =>
      attempt.status === "running" &&
      ((input.expectedRunId && attempt.runId === input.expectedRunId) ||
        (!input.expectedRunId &&
          input.expectedSessionKey &&
          attempt.sessionKey === input.expectedSessionKey)),
  );
  if (attemptIndex >= 0) {
    const attempt = attempts[attemptIndex];
    if (attempt) {
      attempts[attemptIndex] = {
        ...attempt,
        id: input.runId ?? attempt.id,
        sessionKey: input.sessionKey,
        ...(input.runId ? { runId: input.runId } : {}),
      };
    }
  }
  return {
    sessionKey: input.sessionKey,
    ...(input.runId ? { runId: input.runId } : {}),
    execution: input.execution,
    ...(attemptIndex >= 0 ? { metadata: { ...card.metadata, attempts } } : {}),
  };
}

function lifecycleExecution(params: {
  card: WorkboardCard;
  association: WorkboardLifecycleAssociation;
  status?: WorkboardExecutionStatus;
  now: number;
}): WorkboardExecution {
  const existing = params.card.execution;
  const runId = params.association.runId ?? existing?.runId;
  return {
    id: existing?.id ?? `${params.card.id}:agent-session`,
    kind: "agent-session",
    mode: existing?.mode ?? "autonomous",
    status: params.status ?? existing?.status ?? "running",
    ...(existing?.engine ? { engine: existing.engine } : {}),
    ...(existing?.model ? { model: existing.model } : {}),
    sessionKey: params.association.sessionKey,
    ...(runId ? { runId } : {}),
    startedAt: existing?.startedAt ?? params.card.startedAt ?? params.card.updatedAt,
    updatedAt: params.now,
  };
}

// Capability layers split review boundaries only; the core still owns persistence and mutation order.
export class WorkboardStore extends WorkboardNotificationStore {
  async enrichExecutionAssociation(
    id: string,
    input: WorkboardExecutionAssociationInput,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const result = await this.updateLatestCard(id, (current) =>
        executionAssociationPatch(current, input),
      );
      return result.card;
    });
  }

  async syncLifecycle(
    id: string,
    input: {
      targetStatus: WorkboardStatus | undefined;
      executionStatus: WorkboardExecutionStatus | undefined;
      sourceUpdatedAt: number | undefined;
      stale: WorkboardStaleState | undefined;
      now: number;
      association?: WorkboardLifecycleAssociation;
    },
  ): Promise<boolean> {
    return await this.enqueueMutation(async () => {
      const result = await this.updateLatestCard(id, (card) => {
        if (card.metadata?.archivedAt) {
          return undefined;
        }
        const patch: WorkboardCardPatch = {};
        let metadata: Record<string, unknown> | undefined;
        // Recompute from the latest row after every cross-host CAS conflict.
        if (
          input.sourceUpdatedAt !== undefined &&
          shouldSyncWorkboardLifecycleStatus(card, input.targetStatus)
        ) {
          patch.status = input.targetStatus;
          metadata = { lifecycleStatusSourceUpdatedAt: input.sourceUpdatedAt };
        }
        const associationIsCurrent =
          input.association &&
          (input.sourceUpdatedAt === undefined ||
            !shouldSkipPersistedLifecycleStatusUpdate(card, input.sourceUpdatedAt)) &&
          cardSessionKey(card) === input.association.expectedSessionKey &&
          cardRunId(card) === input.association.expectedRunId;
        const associationNeedsUpdate =
          input.association &&
          (card.sessionKey !== input.association.sessionKey ||
            (input.association.runId !== undefined && card.runId !== input.association.runId) ||
            !card.execution ||
            card.execution.sessionKey !== input.association.sessionKey ||
            (input.association.runId !== undefined &&
              card.execution.runId !== input.association.runId) ||
            (input.executionStatus !== undefined &&
              card.execution.status !== input.executionStatus));
        if (associationIsCurrent && input.association && associationNeedsUpdate) {
          const associationPatch = executionAssociationPatch(card, {
            ...input.association,
            execution: lifecycleExecution({
              card,
              association: input.association,
              status: input.executionStatus,
              now: input.now,
            }),
          });
          if (associationPatch) {
            Object.assign(patch, associationPatch);
            metadata = { ...associationPatch.metadata, ...metadata };
          }
        } else if (
          !input.association &&
          card.execution &&
          input.executionStatus &&
          card.execution.status !== input.executionStatus
        ) {
          patch.execution = {
            ...card.execution,
            status: input.executionStatus,
            updatedAt: input.now,
          };
        }
        if (input.stale) {
          const existing = card.metadata?.stale;
          if (
            !existing ||
            existing.lastSessionUpdatedAt !== input.stale.lastSessionUpdatedAt ||
            existing.reason !== input.stale.reason
          ) {
            metadata = {
              ...metadata,
              stale: { ...input.stale, detectedAt: existing?.detectedAt ?? input.stale.detectedAt },
            };
          }
        } else if (card.metadata?.stale) {
          metadata = { ...metadata, stale: null };
        }
        if (metadata) {
          patch.metadata = metadata;
        }
        return Object.keys(patch).length === 0 ? undefined : patch;
      });
      return result.updated;
    });
  }

  async prepareStart(id: string, now = Date.now()): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => await this.promoteDependencyReady(id, now));
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
        let diagnostics: WorkboardDiagnostic[] = [];
        const result = await this.updateLatestCard(card.id, (current) => {
          if (current.metadata?.archivedAt) {
            return undefined;
          }
          diagnostics = mergeDiagnostics(
            current.metadata?.diagnostics,
            computeCardDiagnostics(current, now),
          );
          if (diagnostics.length === 0 && !current.metadata?.diagnostics?.length) {
            return undefined;
          }
          return { metadata: { ...current.metadata, diagnostics } };
        });
        if (diagnostics.length > 0) {
          rows.push({ card: result.card, diagnostics });
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
