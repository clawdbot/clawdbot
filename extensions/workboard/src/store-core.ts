import { createHash, randomUUID } from "node:crypto";
import type {
  WorkboardBoardMetadata,
  WorkboardCard,
  WorkboardEvent,
  WorkboardLink,
  WorkboardMetadata,
  WorkboardStatus,
} from "@openclaw/workboard-contract";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isWorkboardCardStore } from "./persistence-types.js";
import type {
  PersistedWorkboardAttachment,
  PersistedWorkboardBoard,
  PersistedWorkboardCard,
  PersistedWorkboardNotificationSubscription,
  WorkboardBoardCardAggregate,
  WorkboardCardStore,
  WorkboardKeyedStore,
} from "./persistence-types.js";
import { normalizeAutomationPatch, normalizeCardAutomation } from "./store-automation.js";
import {
  assertCanMutateClaimedCard,
  cardBoardId,
  cardParentIds,
  cardSessionKey,
  compareCards,
  isActiveDependencyTarget,
  isDependencyPromotableStatus,
  lifecycleStatusSourceUpdatedAtFromPatch,
  removeUndefinedCardFields,
  shouldSkipPersistedLifecycleStatusUpdate,
  syncExecutionAttemptMetadata,
  updateEvent,
  appendEvent,
} from "./store-card-helpers.js";
import {
  invertWorkboardCardMutation,
  invertWorkboardWorkspaceMutation,
  sameWorkboardCardState,
} from "./store-compensation.js";
import { MAX_CARD_COMMENTS, MAX_CARD_WORKER_LOGS, POSITION_STEP } from "./store-constants.js";
import type {
  WorkboardBoardInput,
  WorkboardBoardSummary,
  WorkboardCardPatch,
  WorkboardCommentInput,
  WorkboardLinkInput,
  WorkboardLinkedCreateInput,
  WorkboardListOptions,
  WorkboardMutationScope,
  WorkboardStatsResult,
} from "./store-inputs.js";
import {
  appendLinkPreservingDependencies,
  metadataIsEmpty,
  normalizeAutomation,
  normalizeBoardId,
  normalizeBoardIdRequired,
  normalizeBoardMetadata,
  normalizeBoundedString,
  normalizeExecution,
  normalizeLabels,
  normalizeLinkType,
  normalizeMetadata,
  normalizeNotes,
  normalizePosition,
  normalizePriority,
  normalizeStatus,
  normalizeStringList,
  normalizeTemplateId,
  normalizeTimestamp,
  normalizeTitle,
  syncExecutionSessionKey,
  trimMetadataToBudget,
} from "./store-normalizers.js";
import { WorkboardStoreRuntime } from "./store-runtime.js";

type WorkboardUpdateCardOptions = {
  allowAutomationLaunch?: boolean;
  allowMetadataDependencyLinks?: boolean;
  enforceStatusHolds?: boolean;
  event?: Omit<WorkboardEvent, "id" | "at">;
  eventAt?: number;
  expectedUpdatedAt?: number;
  ownerSlot?: { ownerId: string; now: number };
  preserveProofId?: string;
};

type WorkboardMutationJournalEntry = {
  before?: WorkboardCard;
  after: WorkboardCard;
};

const WORKBOARD_CAS_ATTEMPTS = 3;

export class WorkboardCoreStore extends WorkboardStoreRuntime {
  private lastNotificationSequence = 0;
  private readonly cardStore?: WorkboardCardStore;
  private compensationJournal?: WorkboardMutationJournalEntry[];
  protected readonly store: WorkboardKeyedStore;
  protected readonly boardStore: WorkboardKeyedStore<PersistedWorkboardBoard>;
  protected readonly subscriptionStore: WorkboardKeyedStore<PersistedWorkboardNotificationSubscription>;
  protected readonly attachmentStore: WorkboardKeyedStore<PersistedWorkboardAttachment>;

  constructor(
    store: WorkboardKeyedStore,
    stores: {
      boards?: WorkboardKeyedStore<PersistedWorkboardBoard>;
      subscriptions?: WorkboardKeyedStore<PersistedWorkboardNotificationSubscription>;
      attachments?: WorkboardKeyedStore<PersistedWorkboardAttachment>;
      dataVersion?: () => number;
      close?: () => void;
    } = {},
  ) {
    super(stores.dataVersion, stores.close);
    if (isWorkboardCardStore(store)) {
      this.cardStore = this.trackCardStore(store);
      this.store = this.cardStore;
    } else {
      this.store = this.track(store);
    }
    this.boardStore = this.track(
      stores.boards ?? (store as unknown as WorkboardKeyedStore<PersistedWorkboardBoard>),
    );
    this.subscriptionStore = this.track(
      stores.subscriptions ??
        (store as unknown as WorkboardKeyedStore<PersistedWorkboardNotificationSubscription>),
      { notifyChanges: false },
    );
    this.attachmentStore = this.track(
      stores.attachments ?? (store as unknown as WorkboardKeyedStore<PersistedWorkboardAttachment>),
      { notifyChanges: false },
    );
  }

  protected async withCardCompensation<T>(run: () => Promise<T>): Promise<T> {
    if (this.compensationJournal) {
      return await run();
    }
    const journal: WorkboardMutationJournalEntry[] = [];
    this.compensationJournal = journal;
    try {
      return await run();
    } catch (operationError) {
      const compensationErrors = await this.rollbackCardMutations(journal);
      if (compensationErrors.length > 0) {
        throw this.compensationError(operationError, compensationErrors);
      }
      throw operationError;
    } finally {
      this.compensationJournal = undefined;
    }
  }

  private compensationError(operationError: unknown, cleanupErrors: unknown[]): AggregateError {
    const message =
      operationError instanceof Error ? operationError.message : String(operationError);
    return new AggregateError([operationError, ...cleanupErrors], message, {
      cause: operationError,
    });
  }

  private recordCardMutation(before: WorkboardCard | undefined, after: WorkboardCard): void {
    // Reverse replay needs every step: later inverses strip their fields before
    // an operation-created row can be safely classified as host-adopted.
    this.compensationJournal?.push({ before, after });
  }

  private async rollbackCardMutations(
    journal: WorkboardMutationJournalEntry[],
  ): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const entry of journal.toReversed()) {
      try {
        if (!entry.before) {
          await this.rollbackCreatedCard(entry.after);
          continue;
        }
        await this.rollbackUpdatedCard(entry.before, entry.after);
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  async compensateWorkspaceMutation(before: WorkboardCard, after: WorkboardCard): Promise<void> {
    await this.enqueueMutation(
      async () => await this.rollbackUpdatedCard(before, after, invertWorkboardWorkspaceMutation),
    );
  }

  private async rollbackUpdatedCard(
    before: WorkboardCard,
    after: WorkboardCard,
    invert = invertWorkboardCardMutation,
  ): Promise<void> {
    for (let attempt = 0; attempt < WORKBOARD_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.get(after.id);
      if (!current) {
        return;
      }
      const merged = invert(before, after, current);
      if (sameWorkboardCardState(current, merged)) {
        return;
      }
      const compensation = {
        ...merged,
        updatedAt: Math.max(Date.now(), current.updatedAt + 1),
      };
      if (await this.registerCardIfUpdatedAt(compensation, current.updatedAt)) {
        return;
      }
    }
    throw new Error(`card changed repeatedly during compensation: ${after.id}`);
  }

  private async rollbackCreatedCard(created: WorkboardCard): Promise<void> {
    for (let attempt = 0; attempt < WORKBOARD_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.get(created.id);
      if (!current || !sameWorkboardCardState(current, created)) {
        return;
      }
      if (await this.deleteCardIfUpdatedAt(created.id, current.updatedAt)) {
        return;
      }
    }
    throw new Error(`card changed repeatedly during compensation: ${created.id}`);
  }

  private async registerCardIfUpdatedAt(
    card: WorkboardCard,
    expectedUpdatedAt: number,
  ): Promise<boolean> {
    if (this.cardStore) {
      return await this.cardStore.registerIfUpdatedAt(
        card.id,
        { version: 1, card },
        expectedUpdatedAt,
      );
    }
    if ((await this.get(card.id))?.updatedAt !== expectedUpdatedAt) {
      return false;
    }
    await this.store.register(card.id, { version: 1, card });
    return true;
  }

  private async deleteCardIfUpdatedAt(id: string, expectedUpdatedAt: number): Promise<boolean> {
    if (this.cardStore) {
      return await this.cardStore.deleteIfUpdatedAt(id, expectedUpdatedAt);
    }
    if ((await this.get(id))?.updatedAt !== expectedUpdatedAt) {
      return false;
    }
    return await this.store.delete(id);
  }

  protected async updateLatestCard(
    id: string,
    buildPatch: (current: WorkboardCard) => WorkboardCardPatch | undefined,
    options: Omit<WorkboardUpdateCardOptions, "expectedUpdatedAt"> = {},
  ): Promise<{ card: WorkboardCard; updated: boolean }> {
    for (let attempt = 0; ; attempt += 1) {
      const current = await this.get(id);
      if (!current) {
        throw new Error(`card not found: ${id}`);
      }
      const patch = buildPatch(current);
      if (!patch) {
        return { card: current, updated: false };
      }
      try {
        const card = await this.updateCard(id, patch, {
          ...options,
          expectedUpdatedAt: current.updatedAt,
        });
        return { card, updated: card.updatedAt !== current.updatedAt };
      } catch (error) {
        if (
          !(error instanceof WorkboardCardConflictError) ||
          attempt === WORKBOARD_CAS_ATTEMPTS - 1
        ) {
          throw error;
        }
      }
    }
  }

  protected async updateMetadata(
    id: string,
    mutate: (existing: WorkboardCard) => WorkboardMetadata,
    options: { preserveProofId?: string } = {},
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const result = await this.updateLatestCard(
        id,
        (current) => ({ metadata: mutate(current) }),
        options,
      );
      return result.card;
    });
  }

  protected async deleteDetachedAttachments(
    existing: WorkboardCard,
    next: WorkboardCard,
  ): Promise<void> {
    const nextIds = new Set(next.metadata?.attachments?.map((attachment) => attachment.id) ?? []);
    for (const attachment of existing.metadata?.attachments ?? []) {
      if (!nextIds.has(attachment.id)) {
        await this.attachmentStore.delete(attachment.id);
      }
    }
  }

  protected nextNotificationSequence(now: number): number {
    const base = Math.max(0, Math.trunc(now)) * 1000;
    this.lastNotificationSequence = Math.max(this.lastNotificationSequence + 1, base);
    return this.lastNotificationSequence;
  }

  async list(options: WorkboardListOptions = {}): Promise<WorkboardCard[]> {
    const boardId = normalizeBoardId(options.boardId);
    const entries = await this.store.entries();
    return entries
      .map((entry) => entry.value)
      .filter(
        (entry): entry is PersistedWorkboardCard => entry?.version === 1 && Boolean(entry.card?.id),
      )
      .map((entry) => entry.card)
      .filter((card) => !boardId || cardBoardId(card) === boardId)
      .toSorted(compareCards);
  }

  async listBoards(): Promise<{ boards: WorkboardBoardSummary[] }> {
    const boards = new Map<string, WorkboardBoardSummary>();
    for (const entry of await this.boardStore.entries()) {
      if (entry.value?.version !== 1 || !entry.value.board?.id) {
        continue;
      }
      const board = entry.value.board;
      boards.set(board.id, {
        id: board.id,
        ...(board.name ? { name: board.name } : {}),
        ...(board.description ? { description: board.description } : {}),
        ...(board.icon ? { icon: board.icon } : {}),
        ...(board.color ? { color: board.color } : {}),
        ...(board.automationJobId ? { automationJobId: board.automationJobId } : {}),
        ...(board.defaultWorkspace ? { defaultWorkspace: board.defaultWorkspace } : {}),
        ...(board.orchestration ? { orchestration: board.orchestration } : {}),
        total: 0,
        active: 0,
        archived: 0,
        byStatus: {},
        updatedAt: board.updatedAt,
        ...(board.archivedAt ? { archivedAt: board.archivedAt } : {}),
      });
    }
    if (!boards.has("default")) {
      boards.set("default", {
        id: "default",
        total: 0,
        active: 0,
        archived: 0,
        byStatus: {},
      });
    }
    const cardAggregates: WorkboardBoardCardAggregate[] = this.cardStore
      ? await this.cardStore.listBoardAggregates()
      : (await this.list()).map((card) => ({
          boardId: cardBoardId(card),
          status: card.status,
          total: 1,
          archived: card.metadata?.archivedAt ? 1 : 0,
          updatedAt: card.updatedAt,
        }));
    for (const aggregate of cardAggregates) {
      const boardId = aggregate.boardId;
      const summary =
        boards.get(boardId) ??
        ({
          id: boardId,
          total: 0,
          active: 0,
          archived: 0,
          byStatus: {},
        } satisfies WorkboardBoardSummary);
      summary.total += aggregate.total;
      summary.archived += aggregate.archived;
      summary.active += aggregate.total - aggregate.archived;
      summary.byStatus[aggregate.status] =
        (summary.byStatus[aggregate.status] ?? 0) + aggregate.total;
      summary.updatedAt = Math.max(summary.updatedAt ?? 0, aggregate.updatedAt);
      boards.set(boardId, summary);
    }
    return {
      boards: [...boards.values()].toSorted((a, b) =>
        a.id === "default" ? -1 : b.id === "default" ? 1 : a.id.localeCompare(b.id),
      ),
    };
  }

  async upsertBoard(input: WorkboardBoardInput): Promise<WorkboardBoardMetadata> {
    return await this.enqueueMutation(async () => {
      const id = normalizeBoardIdRequired(input.id);
      const existing = await this.boardStore.lookup(id);
      const board = normalizeBoardMetadata({ ...input, id }, existing?.board);
      await this.boardStore.register(id, { version: 1, board });
      return board;
    });
  }

  async archiveBoard(id: unknown, archived: unknown = true): Promise<WorkboardBoardMetadata> {
    return await this.upsertBoard({ id, archived });
  }

  async deleteBoard(id: unknown): Promise<{ deleted: boolean }> {
    return await this.enqueueMutation(async () => {
      const boardId = normalizeBoardIdRequired(id);
      if (boardId === "default") {
        throw new Error("default board cannot be deleted.");
      }
      if ((await this.list({ boardId })).length > 0) {
        throw new Error("board still has cards; archive it or move/delete the cards first.");
      }
      for (const entry of await this.subscriptionStore.entries()) {
        if (entry.value?.version === 1 && entry.value.subscription?.boardId === boardId) {
          await this.subscriptionStore.delete(entry.key);
        }
      }
      return { deleted: await this.boardStore.delete(boardId) };
    });
  }

  async stats(input: WorkboardListOptions = {}, now = Date.now()): Promise<WorkboardStatsResult> {
    const cards = await this.list(input);
    const boardId = normalizeBoardId(input.boardId) ?? "all";
    const byStatus: Partial<Record<WorkboardStatus, number>> = {};
    const byAgent = Object.create(null) as Record<string, number>;
    let oldestReadyAt: number | undefined;
    let updatedAt: number | undefined;
    let archived = 0;
    for (const card of cards) {
      byStatus[card.status] = (byStatus[card.status] ?? 0) + 1;
      byAgent[card.agentId ?? "(default)"] = (byAgent[card.agentId ?? "(default)"] ?? 0) + 1;
      if (card.metadata?.archivedAt) {
        archived += 1;
      }
      if (card.status === "ready" && !card.metadata?.archivedAt) {
        oldestReadyAt = Math.min(oldestReadyAt ?? card.updatedAt, card.updatedAt);
      }
      updatedAt = Math.max(updatedAt ?? 0, card.updatedAt);
    }
    return {
      id: boardId,
      total: cards.length,
      active: cards.length - archived,
      archived,
      byStatus,
      byAgent,
      ...(oldestReadyAt ? { oldestReadyAgeMs: Math.max(0, now - oldestReadyAt) } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    };
  }

  async get(id: string): Promise<WorkboardCard | undefined> {
    const entry = await this.store.lookup(id.trim());
    return entry?.version === 1 ? entry.card : undefined;
  }

  private async removeReferencesToCard(cardId: string): Promise<void> {
    for (const card of await this.list()) {
      const links = card.metadata?.links;
      if (!links?.some((link) => link.targetCardId === cardId)) {
        continue;
      }
      await this.updateCard(card.id, {
        metadata: {
          ...card.metadata,
          links: links.filter((link) => link.targetCardId !== cardId),
        },
      });
    }
  }

  async create(
    input: WorkboardLinkedCreateInput,
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(
      async () =>
        await this.withCardCompensation(async () => await this.createDirect(input, scope)),
    );
  }

  protected async createDirect(
    input: WorkboardLinkedCreateInput,
    scope?: WorkboardMutationScope,
    options: { cardId?: string; insertIfAbsent?: boolean } = {},
  ): Promise<WorkboardCard> {
    const now = Date.now();
    const requestedStatus = normalizeStatus(input.status, "todo");
    const cards = await this.list();
    const parents = normalizeStringList(input.parents, "parents", 120);
    const automation = normalizeCardAutomation(input);
    const heldBySchedule =
      Boolean(automation?.scheduledAt && automation.scheduledAt > now) &&
      requestedStatus !== "blocked";
    let status: WorkboardStatus = heldBySchedule ? "scheduled" : requestedStatus;
    let heldByDependencies = false;
    if (parents.length > 0 && (status === "running" || status === "review")) {
      status = "todo";
      heldByDependencies = true;
    }
    if (automation?.idempotencyKey) {
      const existing = cards.find(
        (card) =>
          card.metadata?.automation?.idempotencyKey === automation.idempotencyKey &&
          card.metadata?.automation?.tenant === automation.tenant &&
          cardBoardId(card) === (automation.boardId ?? "default"),
      );
      if (existing) {
        return existing;
      }
    }
    const cardsById = new Map(cards.map((card) => [card.id, card]));
    const parentCards = parents.map((parentId) => {
      const parent = cardsById.get(parentId);
      if (!parent) {
        throw new Error(`card not found: ${parentId}`);
      }
      return parent;
    });
    const childAutomation = normalizeAutomation(
      {
        ...automation,
        createdByCardId:
          automation?.createdByCardId ?? (parents.length === 1 ? parents[0] : undefined),
      },
      automation,
    );
    const normalizedPosition = normalizePosition(input.position, Number.NaN);
    const notes = normalizeNotes(input.notes);
    const agentId = normalizeOptionalString(input.agentId);
    const sessionKey = normalizeOptionalString(input.sessionKey);
    const runId = normalizeOptionalString(input.runId);
    const taskId = normalizeOptionalString(input.taskId);
    const sourceUrl = normalizeOptionalString(input.sourceUrl);
    const normalizedExecution = normalizeExecution(input.execution);
    const execution =
      normalizedExecution?.status === "running" && (heldBySchedule || heldByDependencies)
        ? undefined
        : normalizedExecution;
    const startedAt =
      input.startedAt === undefined
        ? status === "running"
          ? now
          : undefined
        : normalizeTimestamp(input.startedAt, 0) || undefined;
    const completedAt =
      input.completedAt === undefined
        ? status === "done"
          ? now
          : undefined
        : normalizeTimestamp(input.completedAt, 0) || undefined;
    const metadata = normalizeMetadata(
      input.metadata,
      {
        templateId: normalizeTemplateId(input.templateId),
        ...(childAutomation ? { automation: childAutomation } : {}),
      },
      { allowDependencyLinks: false, allowArchivedAt: false },
    );
    const syncedMetadata = trimMetadataToBudget(
      syncExecutionAttemptMetadata(metadata, execution, now),
    );
    const boardId = syncedMetadata.automation?.boardId ?? "default";
    const position = Number.isFinite(normalizedPosition)
      ? normalizedPosition
      : Math.max(
          0,
          ...cards
            .filter((card) => card.status === status && cardBoardId(card) === boardId)
            .map((card) => card.position),
        ) + POSITION_STEP;
    let card: WorkboardCard = {
      id: options.cardId ?? randomUUID(),
      title: normalizeTitle(input.title),
      status,
      priority: normalizePriority(input.priority, "normal"),
      labels: normalizeLabels(input.labels),
      position,
      createdAt: now,
      updatedAt: now,
      events: [
        {
          id: randomUUID(),
          kind: "created",
          at: now,
          toStatus: status,
          ...(sessionKey ? { sessionKey } : {}),
          ...(runId ? { runId } : {}),
        },
      ],
      ...(notes ? { notes } : {}),
      ...(agentId ? { agentId } : {}),
      ...(sessionKey ? { sessionKey } : {}),
      ...(runId ? { runId } : {}),
      ...(taskId ? { taskId } : {}),
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(execution ? { execution } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(completedAt ? { completedAt } : {}),
      ...(!metadataIsEmpty(syncedMetadata) ? { metadata: syncedMetadata } : {}),
    };
    if (options.insertIfAbsent && this.cardStore) {
      const inserted = await this.cardStore.registerIfAbsent(card.id, { version: 1, card });
      if (!inserted) {
        const winner = await this.get(card.id);
        if (!winner) {
          throw new Error("captured session card disappeared during creation.");
        }
        return winner;
      }
      this.recordCardMutation(undefined, card);
    } else {
      await this.store.register(card.id, { version: 1, card });
      this.recordCardMutation(undefined, card);
    }
    for (const parent of parentCards) {
      card = await this.linkCardsDirect(parent.id, card.id, now, {
        allowStatusOnlyActiveChild: true,
        scope,
      });
    }
    return card;
  }

  async captureSession(input: WorkboardLinkedCreateInput): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const sessionKey = normalizeOptionalString(input.sessionKey);
      if (!sessionKey) {
        throw new Error("sessionKey is required.");
      }
      const boardId = normalizeBoardId(input.boardId) ?? "default";
      const matches = (await this.list())
        .filter((card) => cardSessionKey(card) === sessionKey)
        .toSorted((left, right) => right.updatedAt - left.updatedAt);
      const existing =
        matches.find((card) => !card.metadata?.archivedAt) ??
        matches.find((card) => Boolean(card.metadata?.archivedAt));
      if (existing) {
        if (!existing.metadata?.archivedAt) {
          return existing;
        }
        const restored = await this.updateLatestCard(existing.id, (current) => {
          if (cardSessionKey(current) !== sessionKey) {
            throw new Error("captured session identity collision.");
          }
          return current.metadata?.archivedAt
            ? { metadata: { ...current.metadata, archivedAt: 0 } }
            : undefined;
        });
        return restored.card;
      }
      const digest = createHash("sha256")
        .update("openclaw.workboard.session-capture.v1\0")
        .update(sessionKey)
        .digest();
      // RFC 9562 version 8 keeps the documented UUID-shaped card id while the
      // existing primary key becomes the cross-process session identity.
      digest.writeUInt8((digest.readUInt8(6) & 0x0f) | 0x80, 6);
      digest.writeUInt8((digest.readUInt8(8) & 0x3f) | 0x80, 8);
      const hex = digest.toString("hex", 0, 16);
      const cardId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      const winner = await this.createDirect({ ...input, boardId, parents: undefined }, undefined, {
        cardId,
        insertIfAbsent: true,
      });
      if (cardSessionKey(winner) !== sessionKey) {
        throw new Error("captured session identity collision.");
      }
      return winner;
    });
  }

  async update(
    id: string,
    patch: WorkboardCardPatch,
    options: { expectedUpdatedAt?: number } = {},
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(
      async () =>
        await this.updateCard(id, patch, {
          allowMetadataDependencyLinks: false,
          enforceStatusHolds: true,
          expectedUpdatedAt: options.expectedUpdatedAt,
        }),
    );
  }

  protected async updateCard(
    id: string,
    patch: WorkboardCardPatch,
    options: WorkboardUpdateCardOptions = {},
  ): Promise<WorkboardCard> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`card not found: ${id}`);
    }
    if (
      options.expectedUpdatedAt !== undefined &&
      existing.updatedAt !== options.expectedUpdatedAt
    ) {
      throw new WorkboardCardConflictError(existing);
    }
    const lifecycleStatusSourceUpdatedAt = lifecycleStatusSourceUpdatedAtFromPatch(patch.metadata);
    const existingLifecycleStatusSourceUpdatedAt =
      existing.metadata?.lifecycleStatusSourceUpdatedAt;
    const hasFreshLifecycleStatusSource =
      lifecycleStatusSourceUpdatedAt !== undefined &&
      lifecycleStatusSourceUpdatedAt !== existingLifecycleStatusSourceUpdatedAt;
    let effectivePatch = patch;
    if (
      patch.status !== undefined &&
      lifecycleStatusSourceUpdatedAt !== undefined &&
      shouldSkipPersistedLifecycleStatusUpdate(existing, lifecycleStatusSourceUpdatedAt)
    ) {
      // Ignore stale lifecycle status writes, but still accept any non-status updates in the patch.
      effectivePatch = { ...patch, status: undefined };
      if (patch.metadata && typeof patch.metadata === "object" && !Array.isArray(patch.metadata)) {
        const metadataPatch = patch.metadata as Record<string, unknown>;
        const { lifecycleStatusSourceUpdatedAt: _ignored, ...rest } = metadataPatch;
        effectivePatch.metadata = Object.keys(rest).length > 0 ? rest : undefined;
      }
      const hasSemanticPatch = Object.entries(effectivePatch).some(
        ([key, value]) => key !== "status" && key !== "metadata" && value !== undefined,
      );
      if (!hasSemanticPatch && effectivePatch.metadata === undefined) {
        return existing;
      }
    }
    const status = normalizeStatus(effectivePatch.status, existing.status);
    const now = Math.max(Date.now(), existing.updatedAt + 1);
    const startedAt =
      effectivePatch.startedAt === undefined
        ? status === "running"
          ? (existing.startedAt ?? now)
          : existing.startedAt
        : normalizeTimestamp(effectivePatch.startedAt, 0) || undefined;
    const completedAt =
      effectivePatch.completedAt === undefined
        ? status === "done"
          ? (existing.completedAt ?? now)
          : undefined
        : normalizeTimestamp(effectivePatch.completedAt, 0) || undefined;
    const sessionKey =
      effectivePatch.sessionKey === undefined
        ? existing.sessionKey
        : normalizeOptionalString(effectivePatch.sessionKey);
    const execution =
      effectivePatch.execution === undefined
        ? effectivePatch.sessionKey === undefined
          ? existing.execution
          : syncExecutionSessionKey(existing.execution, sessionKey)
        : normalizeExecution(effectivePatch.execution);
    let metadata = normalizeMetadata(effectivePatch.metadata, existing.metadata, {
      allowAutomationLaunch: options.allowAutomationLaunch,
      allowDependencyLinks: options.allowMetadataDependencyLinks !== false,
      preserveProofId: options.preserveProofId,
    });
    if (status !== existing.status && !hasFreshLifecycleStatusSource) {
      // Status patches often spread existing metadata. Only a newly supplied
      // lifecycle source is provenance; copied markers must not survive a manual transition.
      metadata = { ...metadata, lifecycleStatusSourceUpdatedAt: undefined };
    }
    const automationPatch: Record<string, unknown> = {};
    for (const key of [
      "tenant",
      "boardId",
      "createdByCardId",
      "idempotencyKey",
      "skills",
      "workspace",
      "workspaceAccess",
      "maxRuntimeSeconds",
      "maxRetries",
      "scheduledAt",
    ] as const) {
      if (Object.hasOwn(effectivePatch, key) && effectivePatch[key] !== undefined) {
        automationPatch[key] = effectivePatch[key];
      }
    }
    if (Object.keys(automationPatch).length > 0) {
      metadata = trimMetadataToBudget(
        {
          ...metadata,
          automation: normalizeAutomationPatch(automationPatch, metadata.automation),
        },
        options,
      );
    }
    const next = removeUndefinedCardFields({
      ...existing,
      title:
        effectivePatch.title === undefined ? existing.title : normalizeTitle(effectivePatch.title),
      notes:
        effectivePatch.notes === undefined ? existing.notes : normalizeNotes(effectivePatch.notes),
      status,
      priority:
        effectivePatch.priority === undefined
          ? existing.priority
          : normalizePriority(effectivePatch.priority, existing.priority),
      labels:
        effectivePatch.labels === undefined
          ? existing.labels
          : normalizeLabels(effectivePatch.labels),
      agentId:
        effectivePatch.agentId === undefined
          ? existing.agentId
          : normalizeOptionalString(effectivePatch.agentId),
      sessionKey,
      runId:
        effectivePatch.runId === undefined
          ? existing.runId
          : normalizeOptionalString(effectivePatch.runId),
      taskId:
        effectivePatch.taskId === undefined
          ? existing.taskId
          : normalizeOptionalString(effectivePatch.taskId),
      sourceUrl:
        effectivePatch.sourceUrl === undefined
          ? existing.sourceUrl
          : normalizeOptionalString(effectivePatch.sourceUrl),
      execution,
      metadata:
        effectivePatch.templateId === undefined
          ? metadata
          : { ...metadata, templateId: normalizeTemplateId(effectivePatch.templateId) },
      position:
        effectivePatch.position === undefined
          ? existing.position
          : normalizePosition(effectivePatch.position, existing.position),
      updatedAt: now,
      ...(startedAt ? { startedAt } : {}),
      ...(completedAt ? { completedAt } : {}),
    });
    next.metadata = trimMetadataToBudget(
      syncExecutionAttemptMetadata(next.metadata ?? {}, execution, now),
      options,
    );
    next.events = appendEvent(
      next,
      options.event ?? updateEvent(existing, next),
      options.eventAt ?? now,
    );
    if (options.enforceStatusHolds && effectivePatch.status !== undefined) {
      await this.assertActiveStatusAllowed(existing, next, now);
    }
    if (status !== "done") {
      delete next.completedAt;
    }
    if (effectivePatch.startedAt !== undefined && !startedAt) {
      delete next.startedAt;
    }
    if (effectivePatch.completedAt !== undefined && !completedAt) {
      delete next.completedAt;
    }
    if (metadataIsEmpty(next.metadata)) {
      delete next.metadata;
    }
    if (this.cardStore) {
      const expectedUpdatedAt = options.expectedUpdatedAt ?? existing.updatedAt;
      if (options.ownerSlot) {
        const result = await this.cardStore.claimIfOwnerAvailable(
          next.id,
          { version: 1, card: next },
          expectedUpdatedAt,
          options.ownerSlot.ownerId,
          options.ownerSlot.now,
        );
        if (result === "owner_busy") {
          throw new Error(`Owner ${options.ownerSlot.ownerId} already has active Workboard work.`);
        }
        if (result === "updated") {
          this.recordCardMutation(existing, next);
          await this.deleteDetachedAttachments(existing, next);
          return next;
        }
      } else if (
        await this.cardStore.registerIfUpdatedAt(
          next.id,
          { version: 1, card: next },
          expectedUpdatedAt,
        )
      ) {
        this.recordCardMutation(existing, next);
        await this.deleteDetachedAttachments(existing, next);
        return next;
      }
      const current = await this.get(next.id);
      if (!current) {
        throw new Error(`card not found: ${id}`);
      }
      throw new WorkboardCardConflictError(current);
    }
    await this.store.register(next.id, { version: 1, card: next });
    this.recordCardMutation(existing, next);
    await this.deleteDetachedAttachments(existing, next);
    return next;
  }

  private async assertActiveStatusAllowed(
    existing: WorkboardCard,
    next: WorkboardCard,
    now: number,
  ): Promise<void> {
    if (
      next.status !== "ready" &&
      next.status !== "running" &&
      next.status !== "review" &&
      next.status !== "done"
    ) {
      return;
    }
    const parents = cardParentIds(next);
    const cards =
      parents.length > 0 ? new Map((await this.list()).map((card) => [card.id, card])) : undefined;
    if (
      parents.length > 0 &&
      !parents.every((parentId) => cards?.get(parentId)?.status === "done")
    ) {
      throw new Error("card dependencies are not done.");
    }
    if (next.status === "done") {
      return;
    }
    const scheduledAt = next.metadata?.automation?.scheduledAt;
    if ((scheduledAt && scheduledAt > now) || (existing.status === "scheduled" && !scheduledAt)) {
      throw new Error("card is scheduled for later.");
    }
  }

  async delete(id: string): Promise<{ deleted: boolean }> {
    return await this.enqueueMutation(async () => await this.deleteDirect(id));
  }

  protected async deleteDirect(id: string): Promise<{ deleted: boolean }> {
    const cardId = id.trim();
    const deleted = await this.store.delete(cardId);
    if (!deleted) {
      return { deleted: false };
    }
    for (const entry of await this.subscriptionStore.entries()) {
      if (entry.value?.version === 1 && entry.value.subscription?.cardId === cardId) {
        await this.subscriptionStore.delete(entry.key);
      }
    }
    for (const entry of await this.attachmentStore.entries()) {
      if (entry.value?.version === 1 && entry.value.attachment?.cardId === cardId) {
        await this.attachmentStore.delete(entry.key);
      }
    }
    await this.removeReferencesToCard(cardId);
    return { deleted: true };
  }

  async addComment(
    id: string,
    input: WorkboardCommentInput,
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard> {
    const now = Date.now();
    const body = normalizeBoundedString(input.body, undefined, 2000, "comment body");
    if (!body) {
      throw new Error("comment body is required.");
    }
    const comment = { id: randomUUID(), body, createdAt: now };
    return await this.updateMetadata(id, (existing) => {
      assertCanMutateClaimedCard(existing, scope);
      return {
        ...existing.metadata,
        comments: [...(existing.metadata?.comments ?? []), comment].slice(-MAX_CARD_COMMENTS),
      };
    });
  }

  async addLink(id: string, input: WorkboardLinkInput): Promise<WorkboardCard> {
    const now = Date.now();
    const targetCardId = normalizeBoundedString(input.targetCardId, undefined, 120, "link target");
    const url = normalizeBoundedString(input.url, undefined, 2000, "link URL");
    const title = normalizeBoundedString(input.title, undefined, 180, "link title");
    if (!targetCardId && !url) {
      throw new Error("link targetCardId or url is required.");
    }
    const type = normalizeLinkType(input.type, "relates_to");
    if (type === "parent" || type === "child") {
      throw new Error("parent and child dependency links must use linkDependency.");
    }
    const link: WorkboardLink = {
      id: randomUUID(),
      type,
      createdAt: now,
      ...(targetCardId ? { targetCardId } : {}),
      ...(title ? { title } : {}),
      ...(url ? { url } : {}),
    };
    return await this.updateMetadata(id, (existing) => ({
      ...existing.metadata,
      links: appendLinkPreservingDependencies(existing.metadata?.links ?? [], link),
    }));
  }

  async linkCards(
    parentId: string,
    childId: string,
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(
      async () =>
        await this.withCardCompensation(
          async () => await this.linkCardsDirect(parentId, childId, Date.now(), { scope }),
        ),
    );
  }

  protected async linkCardsDirect(
    parentId: string,
    childId: string,
    now = Date.now(),
    options: { allowStatusOnlyActiveChild?: boolean; scope?: WorkboardMutationScope } = {},
  ): Promise<WorkboardCard> {
    if (parentId.trim() === childId.trim()) {
      throw new Error("parent and child cards must differ.");
    }
    const parent = await this.get(parentId);
    const child = await this.get(childId);
    if (!parent) {
      throw new Error(`card not found: ${parentId}`);
    }
    if (!child) {
      throw new Error(`card not found: ${childId}`);
    }
    assertCanMutateClaimedCard(parent, options.scope);
    assertCanMutateClaimedCard(child, options.scope);
    if (child.status === "done" || child.status === "blocked") {
      const cardsById = new Map((await this.list()).map((card) => [card.id, card]));
      const parentIds = [...cardParentIds(child), parent.id].filter(
        (id, index, ids) => ids.indexOf(id) === index,
      );
      if (parentIds.some((id) => cardsById.get(id)?.status !== "done")) {
        throw new Error("terminal child cards cannot gain incomplete parent dependencies.");
      }
    }
    if (isActiveDependencyTarget(child, { allowStatusOnly: options.allowStatusOnlyActiveChild })) {
      throw new Error("active child cards cannot gain parent dependencies.");
    }
    if (await this.dependsOn(parent.id, child.id)) {
      throw new Error("dependency link would create a cycle.");
    }
    const parentLinks = parent.metadata?.links ?? [];
    const childLinks = child.metadata?.links ?? [];
    const nextParentLinks = parentLinks.some(
      (link) => link.type === "child" && link.targetCardId === child.id,
    )
      ? parentLinks
      : appendLinkPreservingDependencies(parentLinks, {
          id: randomUUID(),
          type: "child" as const,
          targetCardId: child.id,
          createdAt: now,
        });
    const nextChildLinks = childLinks.some(
      (link) => link.type === "parent" && link.targetCardId === parent.id,
    )
      ? childLinks
      : appendLinkPreservingDependencies(childLinks, {
          id: randomUUID(),
          type: "parent" as const,
          targetCardId: parent.id,
          createdAt: now,
        });
    await this.updateCard(
      parent.id,
      {
        metadata: { ...parent.metadata, links: nextParentLinks },
      },
      { expectedUpdatedAt: parent.updatedAt },
    );
    const nextChild = await this.updateCard(
      child.id,
      { metadata: { ...child.metadata, links: nextChildLinks } },
      { expectedUpdatedAt: child.updatedAt },
    );
    return await this.promoteDependencyReady(nextChild.id);
  }

  private async dependencyTargetStatus(card: WorkboardCard, now: number): Promise<WorkboardStatus> {
    const scheduledAt = card.metadata?.automation?.scheduledAt;
    const parents = cardParentIds(card);
    if (card.status === "scheduled" && !scheduledAt) {
      return "scheduled";
    }
    if (parents.length === 0) {
      if (scheduledAt && scheduledAt > now && isDependencyPromotableStatus(card.status)) {
        return "scheduled";
      }
      return card.status === "scheduled" ? "ready" : card.status;
    }
    const parentCards = await Promise.all(parents.map((parentId) => this.get(parentId)));
    const parentsDone = parentCards.every((parent) => parent?.status === "done");
    if (
      !parentsDone &&
      scheduledAt &&
      scheduledAt > now &&
      isDependencyPromotableStatus(card.status)
    ) {
      return "scheduled";
    }
    if (!parentsDone && isDependencyPromotableStatus(card.status)) {
      return "todo";
    }
    if (
      parentsDone &&
      scheduledAt &&
      scheduledAt > now &&
      isDependencyPromotableStatus(card.status)
    ) {
      return "scheduled";
    }
    return parentsDone && isDependencyPromotableStatus(card.status) ? "ready" : card.status;
  }

  private async dependsOn(cardId: string, targetParentId: string): Promise<boolean> {
    const cards = new Map((await this.list()).map((entry) => [entry.id, entry]));
    const seen = new Set<string>();
    const visit = (id: string): boolean => {
      if (id === targetParentId) {
        return true;
      }
      if (seen.has(id)) {
        return false;
      }
      seen.add(id);
      const card = cards.get(id);
      return Boolean(card && cardParentIds(card).some(visit));
    };
    return visit(cardId);
  }

  protected async recordDispatch(card: WorkboardCard, now: number): Promise<WorkboardCard> {
    const result = await this.updateLatestCard(card.id, (current) => ({
      metadata: {
        ...current.metadata,
        automation: normalizeAutomation(
          {
            ...current.metadata?.automation,
            dispatchCount: (current.metadata?.automation?.dispatchCount ?? 0) + 1,
            lastDispatchAt: now,
          },
          current.metadata?.automation,
        ),
      },
    }));
    return result.card;
  }

  protected async recordOrchestrationCandidate(
    card: WorkboardCard,
    now: number,
  ): Promise<WorkboardCard> {
    const result = await this.updateLatestCard(card.id, (current) => ({
      metadata: {
        ...current.metadata,
        workerLogs: [
          ...(current.metadata?.workerLogs ?? []),
          {
            id: randomUUID(),
            level: "info" as const,
            message:
              "Auto orchestration marked this triage card for specification or decomposition.",
            createdAt: now,
          },
        ].slice(-MAX_CARD_WORKER_LOGS),
        workerProtocol: {
          state: "idle" as const,
          updatedAt: now,
          detail: "Awaiting workboard_specify or workboard_decompose.",
        },
      },
    }));
    return result.card;
  }

  protected async promoteDependencyReady(id: string, now = Date.now()): Promise<WorkboardCard> {
    const card = await this.get(id);
    if (!card) {
      throw new Error(`card not found: ${id}`);
    }
    if (card.metadata?.archivedAt) {
      return card;
    }
    const target = await this.dependencyTargetStatus(card, now);
    if (target === card.status) {
      return card;
    }
    return await this.updateCard(card.id, { status: target });
  }
}

export class WorkboardCardConflictError extends Error {
  constructor(readonly current: WorkboardCard) {
    super("Card changed while you were editing. Review the latest values and retry.");
    this.name = "WorkboardCardConflictError";
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
