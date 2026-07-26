// Workboard plugin module implements store behavior.
import { randomUUID } from "node:crypto";
import type {
  WorkboardAttachment,
  WorkboardCard,
  WorkboardDiagnostic,
  WorkboardDiagnosticAction,
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
  cardChildIds,
  closeRunningAttempts,
  computeCardDiagnostics,
  isDependencyPromotableStatus,
  latestRunningAttempt,
  mergeDiagnostics,
  removeUndefinedCardFields,
  retryBudgetExhausted,
} from "./store-card-helpers.js";
import {
  CLAIM_RECLAIM_MS,
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

function graphDiagnostic(
  kind: WorkboardDiagnostic["kind"],
  title: string,
  detail: string,
  now: number,
  actions: WorkboardDiagnosticAction[] = [
    { kind: "repair_dependency", label: "Review dependency repair" },
  ],
): WorkboardDiagnostic {
  return {
    kind,
    severity: "error",
    title,
    detail,
    firstSeenAt: now,
    lastSeenAt: now,
    count: 1,
    actions,
  };
}

function computeDependencyDiagnostics(
  cards: readonly WorkboardCard[],
  now: number,
): Map<string, WorkboardDiagnostic[]> {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const diagnostics = new Map<string, WorkboardDiagnostic[]>();
  const add = (cardId: string, entry: WorkboardDiagnostic) => {
    const existing = diagnostics.get(cardId) ?? [];
    if (existing.some((candidate) => candidate.kind === entry.kind)) {
      return;
    }
    diagnostics.set(cardId, [...existing, entry]);
  };

  for (const card of cards) {
    for (const link of card.metadata?.links ?? []) {
      if (link.type !== "parent" && link.type !== "child") {
        continue;
      }
      const target = link.targetCardId ? byId.get(link.targetCardId) : undefined;
      const reciprocalType = link.type === "parent" ? "child" : "parent";
      const reciprocal = target?.metadata?.links?.some(
        (candidate) => candidate.type === reciprocalType && candidate.targetCardId === card.id,
      );
      if (!target || !reciprocal) {
        add(
          card.id,
          graphDiagnostic(
            "broken_dependency",
            "Dependency link is not reciprocal",
            "A parent/child dependency points to a missing card or lacks its reciprocal link.",
            now,
          ),
        );
      }
    }
    for (const childId of cardChildIds(card)) {
      const child = byId.get(childId);
      if (
        child &&
        child.status !== "done" &&
        card.status !== "done" &&
        child.metadata?.automation?.createdByCardId === card.id &&
        child.metadata?.automation?.decompositionMode !== "hard"
      ) {
        add(
          card.id,
          graphDiagnostic(
            "aggregate_deadlock",
            "Aggregate parent blocks its own child",
            "A decomposition-created child still has a hard dependency on an incomplete aggregate parent.",
            now,
          ),
        );
        add(
          child.id,
          graphDiagnostic(
            "aggregate_deadlock",
            "Decomposition child is blocked by its aggregate parent",
            "This child appears to retain a legacy hard dependency created by decomposition.",
            now,
          ),
        );
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (cardId: string) => {
    if (visiting.has(cardId)) {
      const cycleStart = stack.indexOf(cardId);
      for (const cycleId of stack.slice(cycleStart)) {
        add(
          cycleId,
          graphDiagnostic(
            "dependency_cycle",
            "Dependency cycle detected",
            "Hard parent/child links form a cycle and prevent dependency promotion.",
            now,
          ),
        );
      }
      return;
    }
    if (visited.has(cardId)) {
      return;
    }
    visiting.add(cardId);
    stack.push(cardId);
    for (const childId of cardChildIds(byId.get(cardId)!)) {
      if (byId.has(childId)) {
        visit(childId);
      }
    }
    stack.pop();
    visiting.delete(cardId);
    visited.add(cardId);
  };
  for (const card of cards) {
    visit(card.id);
  }
  return diagnostics;
}

// Capability layers split review boundaries only; the core still owns persistence and mutation order.
export class WorkboardStore extends WorkboardNotificationStore {
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
        let latest = await this.promoteDependencyReady(card.id, now);
        const wasPromoted = latest.status !== card.status;
        const claim = latest.metadata?.claim;
        const latestAttempt = latestRunningAttempt(latest);
        const maxRuntimeSeconds = latest.metadata?.automation?.maxRuntimeSeconds;
        const runtimeStartedAt = latestAttempt?.startedAt ?? claim?.claimedAt ?? latest.startedAt;
        const timedOut =
          Boolean(maxRuntimeSeconds && runtimeStartedAt) &&
          now - runtimeStartedAt! > secondsToDurationMs(maxRuntimeSeconds!);
        const claimExpired = Boolean(claim?.expiresAt && now - claim.expiresAt > CLAIM_RECLAIM_MS);
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
        if (latest.status === "ready") {
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
    const dependencyDiagnostics = computeDependencyDiagnostics(cards, now);
    const rows = cards.flatMap((card) => {
      const diagnostics = [
        ...computeCardDiagnostics(card, now),
        ...(dependencyDiagnostics.get(card.id) ?? []),
      ];
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
      const dependencyDiagnostics = computeDependencyDiagnostics(cards, now);
      const rows: WorkboardDiagnosticsResult["diagnostics"] = [];
      for (const card of cards) {
        const latest = await this.get(card.id);
        if (!latest) {
          continue;
        }
        const diagnostics = mergeDiagnostics(latest.metadata?.diagnostics, [
          ...computeCardDiagnostics(latest, now),
          ...(dependencyDiagnostics.get(latest.id) ?? []),
        ]);
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
