// @vitest-environment node
// Control UI tests cover workboard behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  addWorkboardCardComment,
  archiveWorkboardCard,
  captureSessionToWorkboard,
  deleteWorkboardCard,
  dispatchWorkboard,
  filterWorkboardCardsForPreset,
  getWorkboardLifecycle,
  getWorkboardDependencyState,
  getWorkboardState,
  loadWorkboard,
  moveWorkboardCard,
  refreshWorkboard,
  saveWorkboardCardDraft,
  startWorkboardCard,
  stopWorkboardLifecycleRefresh,
  stopWorkboardCard,
  summarizeWorkboardHealth,
  syncWorkboardLifecycle,
  type WorkboardCard,
  type WorkboardTaskSummary,
} from "./index.ts";
import { normalizeExecution, normalizeMetadata } from "./metadata-normalization.ts";
import {
  createGatewaySession,
  createLifecycleHarness,
  createWorkboardCard,
  createWorkboardExecution,
  createWorkboardTask,
  createWorkboardTestClient as createClient,
  type WorkboardTestClient,
} from "./test/index-helpers.ts";

function requestPatch(client: ReturnType<typeof createClient>, index: number) {
  return (client.request.mock.calls[index]?.[1] as { patch?: Record<string, unknown> } | undefined)
    ?.patch;
}

function requestCalls(client: WorkboardTestClient, method: string) {
  return client.request.mock.calls.filter(([calledMethod]) => calledMethod === method);
}

function createSequencedClient(routes: Record<string, readonly unknown[]>, fallback: unknown = {}) {
  const remaining = Object.fromEntries(
    Object.entries(routes).map(([method, replies]) => [method, [...replies]]),
  );
  return createClient((method) => {
    const replies = remaining[method];
    const reply = replies && replies.length > 0 ? replies.shift() : fallback;
    if (reply instanceof Error) {
      throw reply;
    }
    return reply;
  });
}

const sampleCard = createWorkboardCard();
const sampleSession = createGatewaySession();

const sampleTaskSessionKey = "subagent:workboard-default-card-1";
const sampleTask = createWorkboardTask();

function makeCard(overrides: Partial<WorkboardCard> = {}) {
  return { ...sampleCard, ...overrides } satisfies WorkboardCard;
}

function makeSession(overrides: Partial<GatewaySessionRow> = {}) {
  return { ...sampleSession, ...overrides } satisfies GatewaySessionRow;
}

function makeTask(overrides: Partial<WorkboardTaskSummary> = {}) {
  return { ...sampleTask, ...overrides } satisfies WorkboardTaskSummary;
}

function listResult(cards: unknown[] = [sampleCard], statuses: string[] = ["todo", "done"]) {
  return { cards, statuses };
}

function createLinkedCard(overrides: Partial<WorkboardCard> = {}) {
  return createWorkboardCard({
    status: "running",
    sessionKey: sampleTaskSessionKey,
    runId: "run-1",
    taskId: sampleTask.taskId,
    ...overrides,
  });
}

function createSessionCard(overrides: Partial<WorkboardCard> = {}) {
  return createWorkboardCard({ sessionKey: sampleSession.key, ...overrides });
}

function createStaleSessionCard(
  lastSessionUpdatedAt: number,
  overrides: Partial<WorkboardCard> = {},
) {
  return createSessionCard({
    status: "running",
    ...overrides,
    metadata: {
      ...overrides.metadata,
      stale: {
        detectedAt: 1,
        lastSessionUpdatedAt,
        reason: "Linked session has not reported recent activity.",
        ...overrides.metadata?.stale,
      },
    },
  });
}

function createConfirmationCards(count: number) {
  return Array.from({ length: count }, (_, index) =>
    createWorkboardCard({
      id: `card-${index}`,
      status: "running",
      taskId: `task-${index}`,
    }),
  );
}

function createConfirmationClient(failTaskId?: string) {
  return createClient((method, params) => {
    if (method === "tasks.list") {
      return { tasks: [] };
    }
    if (method !== "tasks.get") {
      return {};
    }
    const taskId = (params as { taskId: string }).taskId;
    if (taskId === failTaskId) {
      throw new Error("task confirmation unavailable");
    }
    return { task: createWorkboardTask({ id: taskId, taskId }) };
  });
}

let host: object;
let state: ReturnType<typeof getWorkboardState>;

function openEditDraft(card: WorkboardCard, status: WorkboardCard["status"] = "running") {
  state.draftOpen = true;
  state.editingCardId = card.id;
  state.draftTitle = card.title;
  state.draftNotes = card.notes ?? "";
  state.draftStatus = status;
  state.draftPriority = card.priority;
  state.draftLabels = card.labels.join(", ");
  state.draftAgentId = card.agentId ?? "";
  state.draftSessionKey = card.sessionKey ?? "";
}

function makeMovedCard(card: WorkboardCard, overrides: Partial<WorkboardCard> = {}) {
  return {
    ...card,
    status: "running",
    updatedAt: 2,
    events: [
      {
        id: "move-1",
        kind: "moved",
        at: 2,
        fromStatus: "todo",
        toStatus: "running",
      },
    ],
    ...overrides,
  } satisfies WorkboardCard;
}

function makeCommentedCard(
  card: WorkboardCard,
  body: string,
  overrides: Partial<WorkboardCard> = {},
) {
  return {
    ...card,
    metadata: { comments: [{ id: "comment-1", body, createdAt: 2 }] },
    ...overrides,
  } satisfies WorkboardCard;
}

function loadBoard(
  client: WorkboardTestClient,
  options: Omit<Parameters<typeof loadWorkboard>[0], "host" | "client" | "force"> = {},
) {
  return loadWorkboard({ host, client, force: true, ...options });
}

function syncLifecycle(
  client: WorkboardTestClient,
  sessions: GatewaySessionRow[] = [],
  options: Omit<Parameters<typeof syncWorkboardLifecycle>[0], "host" | "client" | "sessions"> = {},
) {
  return syncWorkboardLifecycle({ host, client, sessions, ...options });
}

function refreshBoard(
  client: Parameters<typeof refreshWorkboard>[0]["client"],
  source: "live" | "manual",
) {
  return refreshWorkboard({ host, client, source });
}

function captureSession(client: WorkboardTestClient, session: GatewaySessionRow = sampleSession) {
  return captureSessionToWorkboard({ host, client, session });
}

function dispatchBoard(
  client: WorkboardTestClient,
  options: Omit<Parameters<typeof dispatchWorkboard>[0], "host" | "client"> = {},
) {
  return dispatchWorkboard({ host, client, ...options });
}

function saveDraft(client: WorkboardTestClient) {
  return saveWorkboardCardDraft({ host, client });
}

function moveCard(
  client: WorkboardTestClient,
  options: Omit<Parameters<typeof moveWorkboardCard>[0], "host" | "client">,
) {
  return moveWorkboardCard({ host, client, ...options });
}

function startCard(
  client: WorkboardTestClient,
  options: Omit<Parameters<typeof startWorkboardCard>[0], "host" | "client">,
) {
  return startWorkboardCard({ host, client, ...options });
}

function startSampleCard(
  client: WorkboardTestClient,
  options: Omit<Parameters<typeof startWorkboardCard>[0], "host" | "client" | "card"> = {},
) {
  return startCard(client, { card: sampleCard, ...options });
}

function stopCard(client: WorkboardTestClient, card: WorkboardCard) {
  return stopWorkboardCard({ host, client, card });
}

function commentCard(
  client: WorkboardTestClient,
  options: Omit<Parameters<typeof addWorkboardCardComment>[0], "host" | "client">,
) {
  return addWorkboardCardComment({ host, client, ...options });
}

function deleteCard(client: WorkboardTestClient, cardId: string) {
  return deleteWorkboardCard({ host, client, cardId });
}

function archiveCard(client: WorkboardTestClient, cardId: string) {
  return archiveWorkboardCard({ host, client, cardId });
}

function setLoadedCard(card: WorkboardCard, task?: WorkboardTaskSummary) {
  state.loaded = true;
  state.cards = [card];
  if (task) {
    state.tasksByCardId.set(card.id, task);
  }
}

describe("workboard controller", () => {
  beforeEach(() => {
    host = {};
    state = getWorkboardState(host);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("normalizes open execution engines and preserves unknown runtime metadata", () => {
    expect(
      normalizeExecution({
        id: "exec-claude",
        engine: "claude-cli",
        mode: "autonomous",
        status: "running",
        model: "anthropic/claude-sonnet-4-6",
        startedAt: 1,
        updatedAt: 2,
      }),
    ).toMatchObject({
      engine: "claude-cli",
      model: "anthropic/claude-sonnet-4-6",
    });

    const unresolved = normalizeExecution({
      id: "exec-unresolved",
      mode: "autonomous",
      status: "running",
      startedAt: 1,
      updatedAt: 2,
    });
    expect(unresolved).toBeDefined();
    expect(unresolved).not.toHaveProperty("engine");
    expect(unresolved).not.toHaveProperty("model");
    expect(
      normalizeMetadata({
        attempts: [{ id: "attempt-1", engine: "claude-cli", startedAt: 1 }],
      })?.attempts?.[0]?.engine,
    ).toBe("claude-cli");
  });

  describe("runtime ownership", () => {
    it("keeps state pristine when lifecycle teardown happens before first access", () => {
      const pristineHost = {};

      stopWorkboardLifecycleRefresh(pristineHost);

      expect(getWorkboardState(pristineHost).mutationReadiness).toBe("ready");
    });

    it("isolates state and loads between hosts", async () => {
      const firstHost = {};
      const secondHost = {};
      const firstCard = makeCard({ title: "First host" });
      const secondCard = makeCard({ title: "Second host" });
      const firstClient = createClient({
        "workboard.cards.list": listResult([firstCard], ["todo", "done"]),
      });
      const secondClient = createClient({
        "workboard.cards.list": listResult([secondCard], ["todo", "done"]),
      });

      await Promise.all([
        loadWorkboard({ host: firstHost, client: firstClient as never, force: true }),
        loadWorkboard({ host: secondHost, client: secondClient as never, force: true }),
      ]);

      const firstState = getWorkboardState(firstHost);
      const secondState = getWorkboardState(secondHost);
      firstState.query = "first";

      expect(firstState).not.toBe(secondState);
      expect(firstState.cards).toEqual([firstCard]);
      expect(secondState.cards).toEqual([secondCard]);
      expect(secondState.query).toBe("");
    });

    it("loads persisted board summaries with canonical cards", async () => {
      const client = createClient({
        "workboard.cards.list": {
          cards: [sampleCard],
          boards: [
            {
              id: "default",
              name: "Inbox",
              total: 1,
              active: 1,
              archived: 0,
              byStatus: { todo: 1 },
            },
            {
              id: "archive",
              total: 0,
              active: 0,
              archived: 0,
              byStatus: {},
              archivedAt: 7,
            },
            {
              id: "__all__",
              total: 1,
              active: 1,
              archived: 0,
              byStatus: { todo: 1 },
            },
          ],
          statuses: ["todo", "done"],
        },
      });

      await loadBoard(client);

      expect(getWorkboardState(host).boards).toEqual([
        {
          id: "default",
          name: "Inbox",
          total: 1,
          active: 1,
          archived: 0,
          byStatus: { todo: 1 },
        },
        {
          id: "archive",
          total: 0,
          active: 0,
          archived: 0,
          byStatus: {},
          archivedAt: 7,
        },
      ]);
    });

    it("rejects an invalidated generation after its replacement loads", async () => {
      const staleList = createDeferred<unknown>();
      const currentCard = makeCard({ title: "Current generation" });
      const client = createSequencedClient({
        "workboard.cards.list": [staleList.promise, listResult([currentCard])],
      });

      const staleLoad = loadBoard(client);
      await Promise.resolve();
      stopWorkboardLifecycleRefresh(host);
      await loadBoard(client);

      staleList.resolve({
        cards: [makeCard({ title: "Stale generation" })],
        statuses: ["todo", "done"],
      });
      await staleLoad;

      expect(requestCalls(client, "workboard.cards.list").length).toBe(2);
      expect(getWorkboardState(host).cards).toEqual([currentCard]);
    });

    it("tracks lifecycle writes until a same-host reload can proceed", async () => {
      const linkedCard = makeCard({ sessionKey: sampleSession.key });
      const updatedCard = makeCard({ ...linkedCard, status: "running" });
      const lifecycleWrite = createDeferred<{ card: WorkboardCard }>();
      state.loaded = true;
      state.cards = [linkedCard];
      state.lifecycleTasksPrepared = true;
      state.lifecycleTasksPreparedAt = Date.now();
      const client = createClient((method) => {
        if (method === "workboard.cards.update") {
          return lifecycleWrite.promise;
        }
        if (method === "workboard.cards.list") {
          return listResult([updatedCard], ["todo", "running"]);
        }
        return {};
      });

      const syncing = syncLifecycle(client, [sampleSession]);
      await waitForFast(() => {
        expect(client.request).toHaveBeenCalledWith(
          "workboard.cards.update",
          expect.objectContaining({ id: linkedCard.id }),
        );
      });
      stopWorkboardLifecycleRefresh(host);

      const capture = captureSessionToWorkboard({
        host,
        client: client as never,
        session: sampleSession,
      });
      await Promise.resolve();
      expect(client.request).not.toHaveBeenCalledWith("workboard.cards.list", {});

      lifecycleWrite.resolve({ card: updatedCard });
      await syncing;
      await capture;

      expect(client.request).toHaveBeenCalledWith("workboard.cards.list", {});
      expect(state.cards).toEqual([updatedCard]);
    });
  });

  it("loads cards through the plugin gateway method", async () => {
    const client = createClient({
      "workboard.cards.list": listResult([sampleCard], ["todo", "done"]),
    });

    await loadBoard(client);

    expect(client.request).toHaveBeenCalledWith("workboard.cards.list", {});
    expect(getWorkboardState(host).cards).toEqual([sampleCard]);
  });

  it("refreshes diagnostics before listing cards when requested", async () => {
    const client = createClient({
      "workboard.cards.diagnostics.refresh": { diagnostics: [], count: 0 },
      "workboard.cards.list": listResult([sampleCard], ["todo", "done"]),
    });

    await loadBoard(client, { refreshDiagnostics: true });

    expect(client.request).toHaveBeenNthCalledWith(1, "workboard.cards.diagnostics.refresh", {});
    expect(client.request).toHaveBeenNthCalledWith(2, "workboard.cards.list", {});
  });

  it("keeps loading cards when diagnostics refresh fails", async () => {
    const client = createClient((method) => {
      if (method === "workboard.cards.diagnostics.refresh") {
        throw new Error("diagnostics denied");
      }
      return listResult([sampleCard], ["todo", "done"]);
    });

    await loadBoard(client, { refreshDiagnostics: true });

    expect(client.request).toHaveBeenNthCalledWith(1, "workboard.cards.diagnostics.refresh", {});
    expect(client.request).toHaveBeenNthCalledWith(2, "workboard.cards.list", {});
    expect(state.cards).toEqual([sampleCard]);
    expect(state.error).toBeNull();
    expect(state.lastRefreshError).toBe("diagnostics denied");
  });

  it("links loaded cards to matching Gateway tasks", async () => {
    const linked = makeCard({
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    });
    const client = createClient({
      "workboard.cards.list": listResult([linked], ["todo", "done"]),
      "tasks.list": { tasks: [sampleTask] },
    });

    await loadBoard(client);

    expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    expect(state.cards[0]).toMatchObject({ id: "card-1", taskId: "task-1" });
    expect(state.tasksByCardId.get("card-1")).toMatchObject({
      taskId: "task-1",
      status: "running",
    });
  });

  it("preserves matching task links when full task enrichment fails", async () => {
    const linked = makeCard({
      status: "running",
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    });
    state.tasksByCardId.set(sampleCard.id, sampleTask);
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return listResult([linked], ["todo", "running", "done"]);
      }
      if (method === "tasks.list") {
        throw new Error("task ledger unavailable");
      }
      return {};
    });

    await loadBoard(client);

    expect(state.cards[0]).toMatchObject({ id: sampleCard.id, taskId: sampleTask.taskId });
    expect(state.tasksByCardId.get(sampleCard.id)).toEqual(sampleTask);
    expect(state.lifecycleTaskRefreshFailed).toBe(true);
    expect(state.lifecycleTaskRefreshError).toBe("task ledger unavailable");
    expect(state.lastRefreshError).toBe("task ledger unavailable");
  });

  it("confirms persisted task ids before marking paginated omissions missing", async () => {
    const linked = makeCard({
      taskId: sampleTask.taskId,
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    });
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return listResult([linked], ["todo", "done"]);
      }
      if (method === "tasks.list") {
        return { tasks: [] };
      }
      if (method === "tasks.get") {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: `task not found: ${sampleTask.taskId}`,
        });
      }
      return {};
    });

    await loadBoard(client);

    expect(client.request).toHaveBeenCalledWith("tasks.get", { taskId: sampleTask.taskId });
    expect(state.cards[0]).toMatchObject({ taskId: sampleTask.taskId });
    expect(state.missingTaskIds).toEqual(new Set([sampleTask.taskId]));
  });

  it("keeps paginated task omissions unresolved when exact lookup finds the task", async () => {
    const linked = makeCard({
      taskId: sampleTask.taskId,
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    });
    const client = createClient({
      "workboard.cards.list": listResult([linked], ["todo", "done"]),
      "tasks.list": { tasks: [] },
      "tasks.get": { task: sampleTask },
    });

    await loadBoard(client);

    expect(client.request).toHaveBeenCalledWith("tasks.get", { taskId: sampleTask.taskId });
    expect(state.cards[0]).toMatchObject({ taskId: sampleTask.taskId });
    expect(state.tasksByCardId.get(sampleCard.id)).toEqual(sampleTask);
    expect(state.missingTaskIds).toEqual(new Set());
  });

  it("defers lifecycle sync when exact task confirmation fails", async () => {
    const linked = makeCard({
      status: "running",
      taskId: sampleTask.taskId,
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    });
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return listResult([linked], ["todo", "running", "done"]);
      }
      if (method === "tasks.list") {
        return { tasks: [] };
      }
      if (method === "tasks.get") {
        throw new Error("task confirmation unavailable");
      }
      return {};
    });

    await loadBoard(client);

    expect(state.lifecycleTaskRefreshFailed).toBe(true);
    expect(state.lastRefreshError).toBe("task confirmation unavailable");
    vi.clearAllMocks();

    await syncLifecycle(client);

    expect(client.request).not.toHaveBeenCalled();
  });

  it("preserves cached task summaries when full exact confirmation partially fails", async () => {
    const linked = makeCard({
      status: "running",
      taskId: sampleTask.taskId,
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    });
    state.tasksByCardId.set(linked.id, sampleTask);
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return listResult([linked], ["todo", "running", "done"]);
      }
      if (method === "tasks.list") {
        return { tasks: [] };
      }
      if (method === "tasks.get") {
        throw new Error("task confirmation unavailable");
      }
      return {};
    });

    await loadBoard(client);

    expect(state.cards[0]).toMatchObject({ taskId: sampleTask.taskId });
    expect(state.tasksByCardId.get(linked.id)).toEqual(sampleTask);
    expect(state.lifecycleTaskRefreshFailed).toBe(true);
    expect(state.lastRefreshError).toBe("task confirmation unavailable");
  });

  it("keeps linked-poll task failures sticky until a full refresh succeeds", async () => {
    const cards = Array.from({ length: 33 }, (_, index) =>
      makeCard({
        id: `card-${index}`,
        status: "running",
        taskId: `task-${index}`,
      }),
    );
    const tasks = cards.map((card, index) =>
      makeTask({
        id: card.taskId,
        taskId: card.taskId,
        runId: `run-${index}`,
      }),
    );
    state.tasksByCardId = new Map(
      cards.map((card, index) => [
        card.id,
        expectDefined(tasks[index], `workboard task fixture ${index}`),
      ]),
    );
    let failedTaskRequests = 0;
    const client = createClient((method, params) => {
      if (method === "workboard.cards.list") {
        return { cards, statuses: ["todo", "running", "done"] };
      }
      if (method === "tasks.list") {
        return { tasks };
      }
      if (method === "tasks.get") {
        const taskId = (params as { taskId: string }).taskId;
        if (taskId === "task-31") {
          failedTaskRequests += 1;
          throw new Error("task-31 unavailable");
        }
        return { task: tasks.find((task) => task.taskId === taskId) };
      }
      return {};
    });

    await loadBoard(client, { taskRefresh: "linked" });
    const retryAt = state.lifecycleTaskRefreshRetryAt;
    expect(state.lifecycleTaskRefreshFailed).toBe(true);
    expect(state.lifecycleTasksPrepared).toBe(false);
    expect(state.lastRefreshError).toBe("task-31 unavailable");

    await loadBoard(client, { taskRefresh: "linked" });
    expect(failedTaskRequests).toBe(1);
    expect(state.lifecycleTaskRefreshFailed).toBe(true);
    expect(state.lifecycleTaskRefreshRetryAt).toBe(retryAt);
    expect(state.lifecycleTasksPrepared).toBe(false);
    expect(state.lastRefreshError).toBe("task-31 unavailable");

    await loadBoard(client, { taskRefresh: "all" });
    expect(state.lifecycleTaskRefreshFailed).toBe(false);
    expect(state.lifecycleTasksPrepared).toBe(true);
    expect(state.lastRefreshError).toBeNull();
  });

  it.each([
    { name: "no cards", cards: [] },
    { name: "no cards needing task data", cards: [sampleCard] },
  ])("clears lifecycle task errors when a linked poll finds $name", async ({ cards }) => {
    state.lifecycleTaskRefreshFailed = true;
    state.lifecycleTaskRefreshRetryAt = Date.now() + 5000;
    state.lifecycleTaskRefreshError = "tasks unavailable";
    state.lastRefreshError = "tasks unavailable";
    const client = createClient({
      "workboard.cards.list": { cards, statuses: ["todo", "running", "done"] },
    });

    await loadBoard(client, { taskRefresh: "linked" });

    expect(state.lifecycleTaskRefreshFailed).toBe(false);
    expect(state.lifecycleTaskRefreshRetryAt).toBeNull();
    expect(state.lifecycleTaskRefreshError).toBeNull();
    expect(state.lastRefreshError).toBeNull();
  });

  it("reuses exact-confirmed full-load tasks for the next lifecycle sync", async () => {
    const linked = makeCard({
      status: "running",
      taskId: sampleTask.taskId,
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    });
    const client = createClient({
      "workboard.cards.list": listResult([linked], ["todo", "running", "done"]),
      "tasks.list": { tasks: [] },
      "tasks.get": { task: sampleTask },
    });

    await loadBoard(client);

    expect(state.lifecycleTasksPrepared).toBe(true);
    vi.clearAllMocks();

    await syncLifecycle(client);

    expect(client.request).not.toHaveBeenCalled();
    expect(state.tasksByCardId.get(sampleCard.id)).toEqual(sampleTask);
  });

  it("keeps a canonical task link over a newer loose session match", async () => {
    const linked = makeCard({
      taskId: sampleTask.taskId,
      sessionKey: sampleTaskSessionKey,
      runId: sampleTask.runId,
    });
    const unrelated = makeTask({
      id: "task-unrelated",
      taskId: "task-unrelated",
      updatedAt: 10,
    });
    const client = createClient({
      "workboard.cards.list": listResult([linked], ["todo", "done"]),
      "tasks.list": { tasks: [sampleTask, unrelated] },
    });

    await loadBoard(client);

    expect(state.cards[0]).toMatchObject({ taskId: sampleTask.taskId });
    expect(state.tasksByCardId.get(sampleCard.id)).toEqual(sampleTask);
  });

  it("records live refresh metadata after reconciliation", async () => {
    const client = createClient({
      "workboard.cards.list": listResult([sampleCard], ["todo", "done"]),
      "tasks.list": { tasks: [] },
    });
    await refreshBoard(client, "live");

    expect(client.request).toHaveBeenCalledWith("workboard.cards.list", {});
    expect(state.lastRefreshSource).toBe("live");
    expect(state.lastRefreshAt).toEqual(expect.any(Number));
    expect(state.lastRefreshError).toBeNull();
    expect(state.lifecycleTasksPrepared).toBe(true);
  });

  it("preserves mutation errors during successful live refreshes", async () => {
    state.error = "move denied";
    const client = createClient({
      "workboard.cards.list": listResult([sampleCard], ["todo", "done"]),
      "tasks.list": { tasks: [] },
    });

    await refreshBoard(client, "live");

    expect(state.error).toBe("move denied");
    expect(state.lastRefreshError).toBeNull();
    expect(state.lastRefreshAt).toEqual(expect.any(Number));
  });

  it("clears a recovered load error during successful live refreshes", async () => {
    let cardsAvailable = false;
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        if (!cardsAvailable) {
          throw new Error("cards unavailable");
        }
        return listResult([sampleCard], ["todo", "done"]);
      }
      if (method === "tasks.list") {
        return { tasks: [] };
      }
      return {};
    });

    await loadBoard(client);

    expect(state.loaded).toBe(false);
    expect(state.error).toBe("cards unavailable");

    stopWorkboardLifecycleRefresh(host);
    expect(state.loadAttempted).toBe(false);

    cardsAvailable = true;
    await refreshBoard(client, "live");

    expect(state.loaded).toBe(true);
    expect(state.cards).toEqual([sampleCard]);
    expect(state.error).toBeNull();
    expect(state.lastRefreshError).toBeNull();
    expect(state.lastRefreshAt).toEqual(expect.any(Number));
  });

  it("preserves newer mutation errors while recovering failed loads", async () => {
    let cardsAvailable = false;
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        if (!cardsAvailable) {
          throw new Error("cards unavailable");
        }
        return listResult([sampleCard], ["todo", "done"]);
      }
      if (method === "tasks.list") {
        return { tasks: [] };
      }
      return {};
    });

    await loadBoard(client);

    state.error = "move denied";
    cardsAvailable = true;

    await refreshBoard(client, "live");

    expect(state.loaded).toBe(true);
    expect(state.cards).toEqual([sampleCard]);
    expect(state.error).toBe("move denied");
    expect(state.lastRefreshError).toBeNull();
  });

  it("records live refresh failures without replacing mutation errors", async () => {
    state.error = "move denied";
    const client = createClient(() => {
      throw new Error("refresh unavailable");
    });

    await refreshBoard(client, "live");

    expect(state.error).toBe("move denied");
    expect(state.lastRefreshError).toBe("refresh unavailable");
    expect(state.lastRefreshAt).toBeNull();
  });

  it("does not mark a disconnected refresh as successful", async () => {
    const updates: Array<string | null> = [];

    await refreshWorkboard({
      host,
      client: null,
      source: "manual",
      requestUpdate: () => updates.push(getWorkboardState(host).lastRefreshError),
    });

    expect(state.lastRefreshAt).toBeNull();
    expect(state.lastRefreshError).toBe("Gateway client unavailable");
    expect(updates).toContain("Gateway client unavailable");
  });

  it("clears stale refresh errors after a later direct load succeeds", async () => {
    await refreshBoard(null, "manual");

    const client = createClient({
      "workboard.cards.list": listResult([sampleCard], ["todo", "done"]),
      "tasks.list": { tasks: [] },
    });
    await loadBoard(client);

    expect(state.loaded).toBe(true);
    expect(state.error).toBeNull();
    expect(state.lastRefreshError).toBeNull();
  });

  it("keeps refreshed cards when task enrichment fails", async () => {
    const refreshedCard = makeCard({ title: "Refreshed card" });
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return listResult([refreshedCard], ["todo", "done"]);
      }
      if (method === "tasks.list") {
        throw new Error("tasks unavailable");
      }
      return {};
    });

    await refreshBoard(client, "manual");

    expect(state.cards).toMatchObject([{ title: "Refreshed card" }]);
    expect(state.error).toBeNull();
    expect(state.lastRefreshError).toBe("tasks unavailable");
    expect(state.lastRefreshAt).toEqual(expect.any(Number));
  });

  it("defers task-backed lifecycle sync until a later load enrichment succeeds", async () => {
    const linkedCard = makeCard({
      taskId: sampleTask.taskId,
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    });
    const requestUpdate = vi.fn();
    let tasksAvailable = false;
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return listResult([linkedCard], ["todo", "done"]);
      }
      if (method === "tasks.list") {
        if (!tasksAvailable) {
          throw new Error("tasks unavailable");
        }
        return { tasks: [sampleTask] };
      }
      return {};
    });

    await loadBoard(client, { requestUpdate });
    vi.clearAllMocks();

    await syncLifecycle(client, [], { requestUpdate });
    await syncLifecycle(client, [], { requestUpdate });

    expect(client.request).not.toHaveBeenCalled();
    expect(requestUpdate).not.toHaveBeenCalled();

    tasksAvailable = true;
    await loadBoard(client);
    vi.clearAllMocks();
    await syncLifecycle(client);

    expect(client.request).not.toHaveBeenCalledWith("tasks.list", { limit: 500 });
    expect(getWorkboardState(host).tasksByCardId.get(sampleCard.id)).toEqual(sampleTask);
  });

  it("keeps prepared task summaries when bounded poll enrichment fails", async () => {
    const linkedCard = makeCard({
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    });
    state.tasksByCardId.set(sampleCard.id, sampleTask);
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return listResult([linkedCard], ["todo", "done"]);
      }
      if (method === "tasks.get") {
        throw new Error("tasks unavailable");
      }
      return {};
    });

    await refreshBoard(client, "live");

    expect(state.tasksByCardId.get(sampleCard.id)).toEqual(sampleTask);
    expect(state.lifecycleTasksPrepared).toBe(false);
    expect(state.lastRefreshError).toBe("tasks unavailable");
  });

  it("tracks terminal task links after authoritative task pruning", async () => {
    const linkedCard = makeCard({
      taskId: sampleTask.taskId,
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    });
    state.tasksByCardId.set(sampleCard.id, makeTask({ status: "completed" }));
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return listResult([linkedCard], ["todo", "done"]);
      }
      if (method === "tasks.get") {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: `task not found: ${sampleTask.taskId}`,
        });
      }
      return {};
    });

    await refreshBoard(client, "live");

    expect(client.request).toHaveBeenCalledWith("tasks.get", { taskId: sampleTask.taskId });
    expect(state.cards[0]).toMatchObject({ taskId: sampleTask.taskId });
    expect(state.tasksByCardId.has(sampleCard.id)).toBe(false);
    expect(state.missingTaskIds).toEqual(new Set([sampleTask.taskId]));
    expect(state.lastRefreshError).toBeNull();

    vi.clearAllMocks();
    await refreshBoard(client, "live");

    expect(client.request).not.toHaveBeenCalledWith("tasks.get", { taskId: sampleTask.taskId });
  });

  it("keeps canonical task unlinks during bounded live refreshes", async () => {
    state.tasksByCardId.set(sampleCard.id, sampleTask);
    const client = createClient({
      "workboard.cards.list": listResult([sampleCard], ["todo", "done"]),
    });

    await refreshBoard(client, "live");

    expect(state.cards[0]).not.toHaveProperty("taskId");
    expect(state.tasksByCardId.has(sampleCard.id)).toBe(false);
  });

  it("refreshes live state through the read path without write methods", async () => {
    const linkedCard = makeCard({
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    });
    const completedTask = makeTask({ status: "completed" });
    const olderSessionKey = "subagent:workboard-default-card-2";
    const olderCard = makeCard({
      id: "card-2",
      title: "Older running card",
      sessionKey: olderSessionKey,
      runId: "run-2",
    });
    const olderTask = makeTask({
      id: "task-2",
      taskId: "task-2",
      childSessionKey: olderSessionKey,
      runId: "run-2",
      updatedAt: 1,
    });
    const client = createClient((method, params) => {
      if (method === "workboard.cards.list") {
        return { cards: [linkedCard, olderCard], statuses: ["todo", "done"] };
      }
      if (method === "tasks.get") {
        return {
          task:
            (params as { taskId: string }).taskId === sampleTask.taskId ? completedTask : olderTask,
        };
      }
      return {};
    });
    state.tasksByCardId.set(sampleCard.id, sampleTask);
    state.tasksByCardId.set(olderCard.id, olderTask);

    await refreshBoard(client, "live");

    expect(client.request).toHaveBeenCalledWith("workboard.cards.list", {});
    expect(client.request).not.toHaveBeenCalledWith(
      "workboard.cards.diagnostics.refresh",
      expect.anything(),
    );
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    expect(client.request).not.toHaveBeenCalledWith("tasks.list", expect.anything());
    expect(client.request).toHaveBeenCalledWith("tasks.get", { taskId: sampleTask.taskId });
    expect(client.request).toHaveBeenCalledWith("tasks.get", { taskId: olderTask.taskId });
    expect(state.tasksByCardId.get(sampleCard.id)).toEqual(completedTask);
    expect(state.tasksByCardId.get(olderCard.id)).toEqual(olderTask);
  });

  it("polls a canonical replacement task instead of a stale session-matched task", async () => {
    const replacementCard = makeCard({
      sessionKey: sampleTaskSessionKey,
      runId: "run-2",
      taskId: "task-2",
    });
    const replacementTask = makeTask({
      id: "task-2",
      taskId: "task-2",
      runId: "run-2",
      updatedAt: 3,
    });
    state.tasksByCardId.set(sampleCard.id, sampleTask);
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return listResult([replacementCard], ["todo", "done"]);
      }
      if (method === "tasks.get") {
        return { task: replacementTask };
      }
      return {};
    });

    await refreshBoard(client, "live");

    expect(client.request).toHaveBeenCalledWith("tasks.get", { taskId: "task-2" });
    expect(client.request).not.toHaveBeenCalledWith("tasks.get", { taskId: "task-1" });
    expect(state.cards[0]).toMatchObject({ taskId: "task-2", runId: "run-2" });
    expect(state.tasksByCardId.get(sampleCard.id)).toMatchObject({
      taskId: "task-2",
      runId: "run-2",
    });
  });

  it("rotates bounded linked-task polling batches", async () => {
    state.cards = Array.from({ length: 40 }, (_, index) =>
      makeCard({ id: `card-${index}`, taskId: `task-${index}` }),
    );
    const client = createClient((method, params) => {
      if (method === "workboard.cards.list") {
        return listResult(state.cards, ["todo", "done"]);
      }
      if (method === "tasks.get") {
        const taskId = (params as { taskId: string }).taskId;
        return { task: makeTask({ id: taskId, taskId }) };
      }
      return {};
    });

    await refreshBoard(client, "live");
    const firstBatch = client.request.mock.calls
      .filter(([method]) => method === "tasks.get")
      .map(([, params]) => (params as { taskId: string }).taskId);
    vi.clearAllMocks();
    await refreshBoard(client, "live");
    const secondBatch = client.request.mock.calls
      .filter(([method]) => method === "tasks.get")
      .map(([, params]) => (params as { taskId: string }).taskId);

    expect(firstBatch).toHaveLength(32);
    expect(secondBatch).toHaveLength(32);
    expect(secondBatch).not.toEqual(firstBatch);
  });

  it("requires a full lifecycle refresh after a partial bounded task poll", async () => {
    const cards = Array.from({ length: 33 }, (_, index) =>
      makeCard({
        id: `card-${index}`,
        status: "running",
        taskId: `task-${index}`,
      }),
    );
    const tasks = cards.map((card) => makeTask({ id: card.taskId, taskId: card.taskId }));
    const client = createClient((method, params) => {
      if (method === "workboard.cards.list") {
        return { cards, statuses: ["todo", "running", "done"] };
      }
      if (method === "tasks.get") {
        const taskId = (params as { taskId: string }).taskId;
        return { task: tasks.find((task) => task.taskId === taskId) };
      }
      if (method === "tasks.list") {
        return { tasks };
      }
      return {};
    });

    await refreshBoard(client, "live");

    expect(getWorkboardState(host).lifecycleTasksPrepared).toBe(false);
    vi.clearAllMocks();
    await syncLifecycle(client);

    expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
  });

  it("rediscovers a bounded batch of running task links during polls", async () => {
    const cards = Array.from({ length: 6 }, (_, index) =>
      makeCard({
        id: `card-${index}`,
        status: "running",
        sessionKey: `agent:worker-${index}:subagent:workboard-default-card-${index}`,
        runId: `run-${index}`,
      }),
    );
    const client = createClient((method, params) => {
      if (method === "workboard.cards.list") {
        return { cards, statuses: ["todo", "running", "done"] };
      }
      if (method === "tasks.list") {
        const sessionKey = (params as { sessionKey: string }).sessionKey;
        const index = sessionKey.at(-1);
        return {
          tasks: [
            makeTask({
              id: `task-${index}`,
              taskId: `task-${index}`,
              childSessionKey: sessionKey,
              runId: `run-${index}`,
            }),
          ],
        };
      }
      return {};
    });

    await refreshBoard(client, "live");
    const firstDiscoveryCalls = requestCalls(client, "tasks.list");
    expect(firstDiscoveryCalls).toHaveLength(4);
    expect(firstDiscoveryCalls[0]?.[1]).toMatchObject({
      sessionKey: "agent:worker-0:subagent:workboard-default-card-0",
      limit: 500,
    });
    expect(getWorkboardState(host).lifecycleTasksPrepared).toBe(false);

    vi.clearAllMocks();
    await refreshBoard(client, "live");
    const secondDiscoveryCalls = requestCalls(client, "tasks.list");
    expect(secondDiscoveryCalls).toHaveLength(2);
    expect(getWorkboardState(host).cards.every((card) => Boolean(card.taskId))).toBe(true);
  });

  it("rediscovers default-agent task links from an unfiltered bounded page", async () => {
    const linkedCard = makeCard({
      status: "running",
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    });
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return listResult([linkedCard], ["todo", "running", "done"]);
      }
      if (method === "tasks.list") {
        return {
          tasks: [makeTask({ childSessionKey: `agent:main:${sampleTaskSessionKey}` })],
        };
      }
      return {};
    });

    await refreshBoard(client, "live");

    expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    expect(getWorkboardState(host).cards[0]).toMatchObject({ taskId: sampleTask.taskId });
  });

  it("preserves discovered replacements across consecutive polls", async () => {
    const missingTaskId = "task-pruned-from-ledger";
    const replacementTaskId = "task-replacement";
    const replacementTask = makeTask({
      id: replacementTaskId,
      taskId: replacementTaskId,
      childSessionKey: `agent:main:${sampleTaskSessionKey}`,
    });
    const linkedCard = makeCard({
      status: "running",
      taskId: missingTaskId,
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    });
    state.missingTaskIds = new Set([missingTaskId]);
    const client = createClient((method, params) => {
      if (method === "workboard.cards.list") {
        return listResult([linkedCard], ["todo", "running", "done"]);
      }
      if (method === "tasks.list") {
        return { tasks: [replacementTask] };
      }
      if (method === "tasks.get") {
        const taskId = (params as { taskId: string }).taskId;
        if (taskId === replacementTaskId) {
          return { task: replacementTask };
        }
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: `task not found: ${taskId}`,
        });
      }
      return {};
    });

    await refreshBoard(client, "live");

    expect(client.request).not.toHaveBeenCalledWith("tasks.get", { taskId: missingTaskId });
    expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    expect(state.cards[0]).toMatchObject({ taskId: missingTaskId });
    expect(state.tasksByCardId.get(sampleCard.id)).toEqual(replacementTask);
    expect(state.missingTaskIds).toEqual(new Set([missingTaskId]));

    vi.clearAllMocks();
    await refreshBoard(client, "live");

    expect(client.request).toHaveBeenCalledWith("tasks.get", { taskId: replacementTaskId });
    expect(client.request).not.toHaveBeenCalledWith("tasks.get", { taskId: missingTaskId });
    expect(client.request).not.toHaveBeenCalledWith("tasks.list", expect.anything());
    expect(state.cards[0]).toMatchObject({ taskId: missingTaskId });
    expect(state.tasksByCardId.get(sampleCard.id)).toEqual(replacementTask);
    expect(state.missingTaskIds).toEqual(new Set([missingTaskId]));
  });

  it("cycles default-agent task discovery through bounded task pages", async () => {
    const linkedCard = makeCard({
      status: "running",
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    });
    const client = createClient((method, params) => {
      if (method === "workboard.cards.list") {
        return listResult([linkedCard], ["todo", "running", "done"]);
      }
      if (method === "tasks.list") {
        return (params as { cursor?: string }).cursor === "500"
          ? { tasks: [makeTask({ childSessionKey: `agent:main:${sampleTaskSessionKey}` })] }
          : { tasks: [], nextCursor: "500" };
      }
      return {};
    });

    await refreshBoard(client, "live");
    expect(getWorkboardState(host).cards[0]).not.toHaveProperty("taskId");

    vi.clearAllMocks();
    await refreshBoard(client, "live");

    expect(client.request).toHaveBeenCalledWith("tasks.list", {
      limit: 500,
      cursor: "500",
    });
    expect(getWorkboardState(host).cards[0]).toMatchObject({ taskId: sampleTask.taskId });
  });

  it("restarts default-agent task discovery after a terminal page", async () => {
    const linkedCard = makeCard({
      status: "running",
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    });
    const client = createClient((method, params) => {
      if (method === "workboard.cards.list") {
        return listResult([linkedCard], ["todo", "running", "done"]);
      }
      if (method === "tasks.list") {
        return (params as { cursor?: string }).cursor === "500"
          ? { tasks: [] }
          : { tasks: [], nextCursor: "500" };
      }
      return {};
    });

    await refreshBoard(client, "live");
    await refreshBoard(client, "live");
    await refreshBoard(client, "live");

    const discoveryCalls = requestCalls(client, "tasks.list");
    expect(discoveryCalls.map(([, params]) => params)).toEqual([
      { limit: 500 },
      { limit: 500, cursor: "500" },
      { limit: 500 },
    ]);
  });

  it.each([
    { name: "a card drag starts", title: "Drag target", interaction: "drag" },
    { name: "an edit draft opens", title: "Edit target", interaction: "edit" },
  ] as const)("discards an in-flight poll when $name", async ({ title, interaction }) => {
    const listedCards = createDeferred<unknown>();
    const initialCard = makeCard({ title });
    const refreshedCard = makeCard({ title: "Server refresh" });
    state.cards = [initialCard];
    state.loaded = true;
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return listedCards.promise;
      }
      return {};
    });

    const refresh = refreshBoard(client, "live");
    await Promise.resolve();
    if (interaction === "drag") {
      state.draggedCardId = initialCard.id;
    } else {
      state.draftOpen = true;
      state.editingCardId = initialCard.id;
      state.draftTitle = initialCard.title;
    }
    listedCards.resolve({ cards: [refreshedCard], statuses: ["todo", "done"] });
    await refresh;

    expect(state.cards).toEqual([initialCard]);
    if (interaction === "drag") {
      expect(state.draggedCardId).toBe(initialCard.id);
    } else {
      expect(state.editingCardId).toBe(initialCard.id);
      expect(state.draftTitle).toBe(initialCard.title);
    }
    expect(state.lastRefreshAt).toBeNull();
  });

  it("tracks dispatch independently from refresh loading state", async () => {
    state.loading = true;
    state.lifecycleTaskRefreshFailed = true;
    state.lifecycleTaskRefreshError = "task ledger unavailable";
    const requestUpdates: Array<[loading: boolean, dispatching: boolean]> = [];
    const client = createClient({
      "workboard.cards.dispatch": {
        promoted: [],
        reclaimed: [],
        blocked: [],
        orchestrated: [],
        count: 0,
      },
      "workboard.cards.list": listResult([sampleCard], ["todo", "done"]),
      "tasks.list": { tasks: [] },
    });

    await dispatchBoard(client, {
      requestUpdate: () => requestUpdates.push([state.loading, state.dispatching]),
    });

    expect(requestUpdates[0]).toEqual([true, true]);
    expect(requestUpdates.at(-1)).toEqual([true, false]);
    expect(state.loading).toBe(true);
    expect(state.dispatching).toBe(false);
    expect(state.lifecycleTaskRefreshFailed).toBe(false);
    expect(state.lifecycleTaskRefreshError).toBeNull();
    expect(client.request).toHaveBeenCalledWith("workboard.cards.dispatch", {});
  });

  it("limits dispatch to the selected named board", async () => {
    state.boardFilter = "ops";
    state.boards = [{ id: "ops", total: 1, active: 1, archived: 0, byStatus: { ready: 1 } }];
    const client = createClient({
      "workboard.cards.dispatch": {
        promoted: [],
        reclaimed: [],
        blocked: [],
        orchestrated: [],
        count: 0,
      },
      "workboard.cards.list": listResult([sampleCard], ["todo", "done"]),
      "tasks.list": { tasks: [] },
    });

    await dispatchBoard(client);

    expect(client.request).toHaveBeenCalledWith("workboard.cards.dispatch", { boardId: "ops" });
  });

  it("clears stale refresh errors after a successful dispatch reload", async () => {
    state.lastRefreshError = "poll unavailable";
    const client = createClient({
      "workboard.cards.dispatch": {
        promoted: [],
        reclaimed: [],
        blocked: [],
        orchestrated: [],
        count: 0,
      },
      "workboard.cards.list": listResult([sampleCard], ["todo", "done"]),
      "tasks.list": { tasks: [] },
    });

    await dispatchBoard(client);

    expect(state.lastRefreshError).toBeNull();
  });

  it("blocks dispatch while a card draft write is in flight", async () => {
    const update = createDeferred<unknown>();
    state.cards = [sampleCard];
    state.draftTitle = "Move out of ready";
    state.draftStatus = "backlog";
    state.editingCardId = sampleCard.id;
    const client = createClient((method) => {
      if (method === "workboard.cards.update") {
        return update.promise;
      }
      if (method === "workboard.cards.dispatch") {
        return { promoted: [], reclaimed: [], blocked: [], orchestrated: [] };
      }
      if (method === "workboard.cards.list") {
        return listResult([sampleCard], ["todo", "done"]);
      }
      if (method === "tasks.list") {
        return { tasks: [] };
      }
      return {};
    });

    const save = saveDraft(client);
    await Promise.resolve();
    await dispatchBoard(client);

    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.dispatch", {});

    update.resolve({ card: sampleCard });
    await save;
  });

  it("keeps concurrent card writes busy until each write finishes", async () => {
    const first = createDeferred<unknown>();
    const second = createDeferred<unknown>();
    const secondCard = makeCard({ id: "card-2", title: "Second card" });
    const client = createClient((method, params) => {
      if (method === "workboard.cards.move") {
        return (params as { id: string }).id === sampleCard.id ? first.promise : second.promise;
      }
      if (method === "workboard.cards.dispatch") {
        return { promoted: [], reclaimed: [], blocked: [], orchestrated: [] };
      }
      return {};
    });

    const firstMove = moveCard(client, {
      cardId: sampleCard.id,
      status: "review",
      position: 1000,
    });
    const secondMove = moveCard(client, {
      cardId: secondCard.id,
      status: "review",
      position: 2000,
    });
    await Promise.resolve();

    expect(getWorkboardState(host).busyCardIds).toEqual(new Set([sampleCard.id, secondCard.id]));
    await moveCard(client, {
      cardId: sampleCard.id,
      status: "blocked",
      position: 3000,
    });
    expect(
      client.request.mock.calls.filter(
        ([method, params]) =>
          method === "workboard.cards.move" &&
          (params as { id?: string } | undefined)?.id === sampleCard.id,
      ),
    ).toHaveLength(1);

    first.resolve({ card: makeCard({ status: "review" }) });
    getWorkboardState(host).draggedCardId = secondCard.id;
    await firstMove;

    expect(getWorkboardState(host).busyCardIds).toEqual(new Set([secondCard.id]));
    expect(getWorkboardState(host).draggedCardId).toBe(secondCard.id);
    await dispatchBoard(client);
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.dispatch", {});

    second.resolve({ card: { ...secondCard, status: "review" } });
    await secondMove;
    expect(getWorkboardState(host).busyCardIds.size).toBe(0);
    expect(getWorkboardState(host).draggedCardId).toBeNull();
  });

  it.each(["card write", "dispatch"] as const)(
    "does not refresh while a %s is active",
    async (mutation) => {
      if (mutation === "card write") {
        state.busyCardIds.add(sampleCard.id);
      } else {
        state.dispatching = true;
      }
      const client = createClient({
        "workboard.cards.list": listResult([sampleCard], ["todo", "done"]),
        "tasks.list": { tasks: [] },
      });

      await refreshBoard(client, "manual");

      expect(client.request).not.toHaveBeenCalled();
      if (mutation === "dispatch") {
        expect(state.lastRefreshStartedAt).toBeNull();
      }
    },
  );

  it("clears stale task summaries when dispatch task refresh fails", async () => {
    state.tasksByCardId.set("card-1", sampleTask);
    const dispatchedCard = makeCard({ status: "ready" });
    const client = createClient((method) => {
      if (method === "workboard.cards.dispatch") {
        return {
          promoted: [],
          reclaimed: [],
          blocked: [],
          orchestrated: [],
          count: 0,
        };
      }
      if (method === "workboard.cards.list") {
        return listResult([dispatchedCard], ["todo", "ready", "done"]);
      }
      if (method === "tasks.list") {
        throw new Error("task ledger unavailable");
      }
      return {};
    });

    await dispatchBoard(client);

    expect(state.cards).toEqual([dispatchedCard]);
    expect(state.loaded).toBe(true);
    expect(state.tasksByCardId.size).toBe(0);
    expect(state.lifecycleTaskRefreshFailed).toBe(true);
    expect(state.lastRefreshError).toBe("task ledger unavailable");
  });

  it.each(["dispatch", "card write"] as const)(
    "blocks direct forced loads while a %s is active",
    async (activeMutation) => {
      if (activeMutation === "dispatch") {
        state.dispatching = true;
      } else {
        state.busyCardIds.add(sampleCard.id);
      }
      const client = createClient({
        "workboard.cards.list": listResult([sampleCard], ["todo", "done"]),
      });

      await expect(loadBoard(client)).resolves.toBe(false);

      expect(client.request).not.toHaveBeenCalled();
    },
  );

  it("blocks card writes while dispatch is relisting cards", async () => {
    state.dispatching = true;
    state.cards = [sampleCard];
    state.draftTitle = "Queued edit";
    state.editingCardId = sampleCard.id;
    const client = createClient({});

    await saveDraft(client);
    await moveCard(client, {
      cardId: sampleCard.id,
      status: "review",
      position: 2000,
    });
    await deleteCard(client, sampleCard.id);
    await archiveCard(client, sampleCard.id);
    await commentCard(client, {
      cardId: sampleCard.id,
      body: "hold",
    });

    expect(client.request).not.toHaveBeenCalled();
    expect(state.cards).toEqual([sampleCard]);
  });

  it("does not let an older refresh overwrite cards listed after dispatch", async () => {
    const refreshList = createDeferred<unknown>();
    const staleCard = makeCard({ title: "Stale refresh card" });
    const dispatchedCard = makeCard({ title: "Dispatched card" });
    const client = createSequencedClient({
      "workboard.cards.list": [refreshList.promise, listResult([dispatchedCard])],
      "workboard.cards.dispatch": [
        {
          promoted: [],
          reclaimed: [],
          blocked: [],
          orchestrated: [],
          count: 0,
        },
      ],
      "tasks.list": [{ tasks: [] }],
    });

    const refresh = refreshBoard(client, "manual");
    await Promise.resolve();
    expect(getWorkboardState(host).loading).toBe(true);

    await dispatchBoard(client);
    expect(getWorkboardState(host).cards).toMatchObject([{ title: "Dispatched card" }]);

    refreshList.resolve({ cards: [staleCard], statuses: ["todo", "done"] });
    await refresh;

    expect(state.cards).toMatchObject([{ title: "Dispatched card" }]);
    expect(state.loading).toBe(false);
    expect(state.lastRefreshAt).toBeNull();
  });

  it("does not let an older refresh overwrite a card move", async () => {
    const refreshList = createDeferred<unknown>();
    const staleCard = makeCard({ status: "ready", title: "Stale ready card" });
    const movedCard = makeCard({ status: "review", title: "Moved card" });
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return refreshList.promise;
      }
      if (method === "workboard.cards.move") {
        return { card: movedCard };
      }
      if (method === "tasks.list") {
        return { tasks: [] };
      }
      return {};
    });

    const refresh = refreshBoard(client, "manual");
    await Promise.resolve();

    await moveCard(client, {
      cardId: sampleCard.id,
      status: "review",
      position: 2000,
    });
    refreshList.resolve({ cards: [staleCard], statuses: ["ready", "review"] });
    await refresh;

    expect(state.cards).toMatchObject([{ title: "Moved card", status: "review" }]);
  });

  it("allows automatic reload after an initial load is invalidated by a write", async () => {
    const initialList = createDeferred<unknown>();
    const reloadedList = createDeferred<unknown>();
    const movedCard = makeCard({ title: "Moved during initial load" });
    const reloadedCard = makeCard({ title: "Reloaded canonical card" });
    const client = createSequencedClient({
      "workboard.cards.list": [initialList.promise, reloadedList.promise],
      "workboard.cards.move": [{ card: movedCard }],
      "tasks.list": [{ tasks: [] }],
    });

    const initialLoad = loadWorkboard({ host, client: client as never });
    await Promise.resolve();
    await moveCard(client, {
      cardId: sampleCard.id,
      status: "review",
      position: 2000,
    });

    expect(state.loaded).toBe(false);
    expect(state.loadAttempted).toBe(false);
    expect(state.loading).toBe(false);

    const reload = loadWorkboard({ host, client: client as never });
    expect(requestCalls(client, "workboard.cards.list").length).toBe(2);
    reloadedList.resolve({ cards: [reloadedCard], statuses: ["todo", "done"] });
    await reload;
    expect(state.cards).toMatchObject([{ title: "Reloaded canonical card" }]);
    expect(state.loaded).toBe(true);

    initialList.resolve({ cards: [sampleCard], statuses: ["todo", "done"] });
    await initialLoad;
    expect(state.cards).toMatchObject([{ title: "Reloaded canonical card" }]);
  });

  it("does not clear draft-save loading state from an invalidated refresh", async () => {
    const refreshList = createDeferred<unknown>();
    const saveResponse = createDeferred<{ card: WorkboardCard }>();
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return refreshList.promise;
      }
      if (method === "workboard.cards.update") {
        return saveResponse.promise;
      }
      return {};
    });
    state.cards = [sampleCard];
    state.editingCardId = sampleCard.id;
    state.draftTitle = "Saved title";

    const refresh = loadBoard(client);
    await Promise.resolve();
    const save = saveDraft(client);
    await waitForFast(() => {
      expect(client.request).toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    });
    refreshList.resolve({ cards: [sampleCard], statuses: ["todo", "done"] });
    await refresh;

    expect(state.draftSaving).toBe(true);
    expect(state.loading).toBe(true);
    await commentCard(client, {
      cardId: sampleCard.id,
      body: "must wait for save",
    });
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.comment", expect.anything());

    saveResponse.resolve({ card: makeCard({ title: "Saved title" }) });
    await save;
    expect(state.draftSaving).toBe(false);
    expect(state.loading).toBe(false);
  });

  it("queues a forced full refresh behind an in-flight bounded poll load", async () => {
    const pollList = createDeferred<unknown>();
    const forcedCard = makeCard({ title: "Forced full refresh" });
    const client = createSequencedClient({
      "workboard.cards.list": [pollList.promise, listResult([forcedCard])],
      "tasks.list": [{ tasks: [] }],
    });

    const poll = loadBoard(client, { taskRefresh: "linked" });
    await Promise.resolve();
    const forced = loadBoard(client, { refreshDiagnostics: true, taskRefresh: "all" });
    pollList.resolve({ cards: [sampleCard], statuses: ["todo", "done"] });
    await Promise.all([poll, forced]);

    expect(client.request).toHaveBeenCalledWith("workboard.cards.diagnostics.refresh", {});
    expect(requestCalls(client, "workboard.cards.list")).toHaveLength(2);
    expect(requestCalls(client, "tasks.list")).toHaveLength(1);
    expect(getWorkboardState(host).cards).toMatchObject([{ title: "Forced full refresh" }]);
  });

  it("preserves a stronger forced refresh behind another queued forced refresh", async () => {
    const initialList = createDeferred<unknown>();
    const weakerCard = makeCard({ title: "Weaker queued refresh" });
    const strongerCard = makeCard({ title: "Stronger queued refresh" });
    const client = createSequencedClient({
      "workboard.cards.list": [
        initialList.promise,
        listResult([weakerCard]),
        listResult([strongerCard]),
      ],
      "tasks.list": [{ tasks: [] }],
    });

    const initial = loadBoard(client, { taskRefresh: "linked" });
    await Promise.resolve();
    const weaker = loadBoard(client, { taskRefresh: "linked" });
    const stronger = loadBoard(client, { refreshDiagnostics: true, taskRefresh: "all" });
    initialList.resolve({ cards: [sampleCard], statuses: ["todo", "done"] });
    await Promise.all([initial, weaker, stronger]);

    expect(client.request).toHaveBeenCalledWith("workboard.cards.diagnostics.refresh", {});
    expect(requestCalls(client, "workboard.cards.list")).toHaveLength(3);
    expect(requestCalls(client, "tasks.list")).toHaveLength(1);
    expect(getWorkboardState(host).cards).toMatchObject([{ title: "Stronger queued refresh" }]);
  });

  it("does not restart a queued forced refresh after lifecycle teardown", async () => {
    const pollList = createDeferred<unknown>();
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return pollList.promise;
      }
      return {};
    });

    const poll = loadBoard(client, { taskRefresh: "linked" });
    await Promise.resolve();
    const forced = loadBoard(client, { refreshDiagnostics: true, taskRefresh: "all" });
    stopWorkboardLifecycleRefresh(host);
    pollList.resolve({ cards: [sampleCard], statuses: ["todo", "done"] });
    await Promise.all([poll, forced]);

    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.diagnostics.refresh", {});
    expect(requestCalls(client, "workboard.cards.list")).toHaveLength(1);
    expect(getWorkboardState(host).loaded).toBe(false);
  });

  it("reloads a previously loaded board after lifecycle teardown", async () => {
    const reopenedCard = makeCard({ title: "Reopened board" });
    const client = createSequencedClient({
      "workboard.cards.list": [listResult(), listResult([reopenedCard])],
    });

    await loadWorkboard({ host, client: client as never });

    expect(state.loaded).toBe(true);
    expect(state.cards).toEqual([sampleCard]);

    stopWorkboardLifecycleRefresh(host);

    expect(state.loaded).toBe(false);
    expect(state.loadAttempted).toBe(false);
    expect(state.mutationReadiness).toBe("canonical_reload_required");
    await expect(loadWorkboard({ host, client: client as never })).resolves.toBe(true);
    expect(requestCalls(client, "workboard.cards.list").length).toBe(2);
    expect(state.cards).toEqual([reopenedCard]);
    expect(state.mutationReadiness).toBe("ready");
  });

  it("preserves edit drafts without re-enabling their stale save payload", async () => {
    const editHost = {};
    const editState = getWorkboardState(editHost);
    const editClient = createClient({
      "workboard.cards.list": {
        cards: [makeCard({ title: "Canonical title" })],
        statuses: ["todo", "done"],
      },
      "tasks.list": { tasks: [] },
    });
    editState.loaded = true;
    editState.draftOpen = true;
    editState.editingCardId = sampleCard.id;
    editState.draftTitle = "Stale edit";

    stopWorkboardLifecycleRefresh(editHost);

    expect(editState.draftOpen).toBe(true);
    expect(editState.editingCardId).toBe(sampleCard.id);
    expect(editState.draftTitle).toBe("Stale edit");

    await loadWorkboard({ host: editHost, client: editClient as never });

    expect(editState.mutationReadiness).toBe("stale_edit_draft");
    vi.clearAllMocks();
    await saveWorkboardCardDraft({ host: editHost, client: editClient as never });
    expect(editClient.request).not.toHaveBeenCalled();

    const createHost = {};
    const createState = getWorkboardState(createHost);
    const createClientInstance = createClient({
      "workboard.cards.list": listResult([], ["todo", "done"]),
    });
    createState.loaded = true;
    createState.draftOpen = true;
    createState.draftTitle = "Unsaved new card";

    stopWorkboardLifecycleRefresh(createHost);
    await loadWorkboard({ host: createHost, client: createClientInstance as never });

    expect(createState.draftOpen).toBe(true);
    expect(createState.editingCardId).toBeNull();
    expect(createState.draftTitle).toBe("Unsaved new card");
    expect(createState.mutationReadiness).toBe("ready");
  });

  it("preserves an edit draft when its in-flight save fails after teardown", async () => {
    let rejectSave: ((reason?: unknown) => void) | undefined;
    const saveResponse = new Promise<unknown>((_resolve, reject) => {
      rejectSave = reject;
    });
    const client = createClient((method) => {
      if (method === "workboard.cards.update") {
        return saveResponse;
      }
      if (method === "workboard.cards.list") {
        return listResult([sampleCard], ["todo", "done"]);
      }
      if (method === "tasks.list") {
        return { tasks: [] };
      }
      return {};
    });
    setLoadedCard(sampleCard);
    state.draftOpen = true;
    state.editingCardId = sampleCard.id;
    state.draftTitle = "Unsaved edit";

    const save = saveDraft(client);
    await waitForFast(() => {
      expect(client.request).toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    });
    stopWorkboardLifecycleRefresh(host);
    rejectSave?.(new Error("Gateway disconnected"));
    await save;

    expect(state.draftOpen).toBe(true);
    expect(state.editingCardId).toBe(sampleCard.id);
    expect(state.draftTitle).toBe("Unsaved edit");

    await loadWorkboard({ host, client: client as never });
    expect(state.mutationReadiness).toBe("stale_edit_draft");
  });

  it("keeps an in-flight dispatch reload-required after lifecycle teardown", async () => {
    const dispatchResult = createDeferred<unknown>();
    const client = createClient((method) => {
      if (method === "workboard.cards.dispatch") {
        return dispatchResult.promise;
      }
      if (method === "workboard.cards.list") {
        return listResult([sampleCard], ["todo", "done"]);
      }
      if (method === "tasks.list") {
        return { tasks: [] };
      }
      return {};
    });
    setLoadedCard(sampleCard);

    const dispatch = dispatchBoard(client);
    await waitForFast(() => {
      expect(client.request).toHaveBeenCalledWith("workboard.cards.dispatch", {});
    });
    stopWorkboardLifecycleRefresh(host);
    dispatchResult.resolve({});
    await dispatch;

    expect(state.loaded).toBe(false);
    expect(state.mutationReadiness).toBe("canonical_reload_required");

    await expect(loadWorkboard({ host, client: client as never })).resolves.toBe(true);
    expect(state.loaded).toBe(true);
    expect(state.mutationReadiness).toBe("ready");
  });

  it("does not attach a stale forced refresh to a reopened board load", async () => {
    const staleList = createDeferred<unknown>();
    const reopenedList = createDeferred<unknown>();
    const reopenedCard = makeCard({ title: "Reopened board" });
    const client = createSequencedClient({
      "workboard.cards.list": [staleList.promise, reopenedList.promise],
    });

    const initial = loadBoard(client, { taskRefresh: "linked" });
    await Promise.resolve();
    const forced = loadBoard(client, { refreshDiagnostics: true, taskRefresh: "all" });
    stopWorkboardLifecycleRefresh(host);
    const reopened = loadWorkboard({ host, client: client as never });

    staleList.resolve({ cards: [sampleCard], statuses: ["todo", "done"] });
    await initial;
    reopenedList.resolve({ cards: [reopenedCard], statuses: ["todo", "done"] });
    await Promise.all([forced, reopened]);

    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.diagnostics.refresh", {});
    expect(requestCalls(client, "workboard.cards.list")).toHaveLength(2);
    expect(getWorkboardState(host).cards).toMatchObject([{ title: "Reopened board" }]);
  });

  it("detaches a stalled initial load during lifecycle teardown", async () => {
    const initialList = createDeferred<unknown>();
    const reopenedCard = makeCard({ title: "Reopened board" });
    const client = createSequencedClient({
      "workboard.cards.list": [initialList.promise, listResult([reopenedCard])],
    });

    const initialLoad = loadWorkboard({ host, client: client as never });
    await Promise.resolve();
    expect(state.loading).toBe(true);
    expect(state.loadAttempted).toBe(true);

    stopWorkboardLifecycleRefresh(host);

    expect(state.loading).toBe(false);
    expect(state.loadAttempted).toBe(false);
    await expect(loadWorkboard({ host, client: client as never })).resolves.toBe(true);
    expect(requestCalls(client, "workboard.cards.list").length).toBe(2);
    expect(state.cards).toMatchObject([{ title: "Reopened board" }]);

    initialList.resolve({ cards: [sampleCard], statuses: ["todo", "done"] });
    await expect(initialLoad).resolves.toBe(false);
    expect(state.cards).toMatchObject([{ title: "Reopened board" }]);
  });

  it("does not start a queued forced refresh after a card write begins", async () => {
    const pollList = createDeferred<unknown>();
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return pollList.promise;
      }
      return {};
    });

    const poll = loadBoard(client, { taskRefresh: "linked" });
    await Promise.resolve();
    const forced = loadBoard(client, { refreshDiagnostics: true, taskRefresh: "all" });
    getWorkboardState(host).busyCardIds.add(sampleCard.id);
    pollList.resolve({ cards: [sampleCard], statuses: ["todo", "done"] });
    await Promise.all([poll, forced]);

    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.diagnostics.refresh", {});
    expect(requestCalls(client, "workboard.cards.list")).toHaveLength(1);
  });

  it("does not mark a load successful when task enrichment is invalidated by a write", async () => {
    const taskList = createDeferred<unknown>();
    const movedCard = makeCard({ title: "Moved during task enrichment" });
    const reloadedCard = makeCard({ title: "Reloaded after task invalidation" });
    const client = createSequencedClient({
      "workboard.cards.list": [listResult(), listResult([reloadedCard])],
      "tasks.list": [taskList.promise, { tasks: [] }],
      "workboard.cards.move": [{ card: movedCard }],
    });

    const initialLoad = loadWorkboard({ host, client: client as never });
    await Promise.resolve();
    await Promise.resolve();
    expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });

    await moveCard(client, {
      cardId: sampleCard.id,
      status: "review",
      position: 2000,
    });
    taskList.resolve({ tasks: [sampleTask] });
    await expect(initialLoad).resolves.toBe(false);

    expect(state.loaded).toBe(false);
    expect(state.loadAttempted).toBe(false);

    await loadWorkboard({ host, client: client as never });
    expect(state.cards).toMatchObject([{ title: "Reloaded after task invalidation" }]);
    expect(state.loaded).toBe(true);
  });

  it("links cards from paginated Gateway task results", async () => {
    const linked = makeCard({
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    });
    const client = createClient((method, params) => {
      if (method === "workboard.cards.list") {
        return listResult([linked], ["todo", "done"]);
      }
      if (method === "tasks.list" && (params as { cursor?: string }).cursor === "page-2") {
        return { tasks: [sampleTask] };
      }
      if (method === "tasks.list") {
        return { tasks: [], nextCursor: "page-2" };
      }
      return {};
    });

    await loadBoard(client);

    expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    expect(client.request).toHaveBeenCalledWith("tasks.list", {
      limit: 500,
      cursor: "page-2",
    });
    expect(getWorkboardState(host).cards[0]).toMatchObject({ taskId: "task-1" });
  });

  it("summarizes parent dependency readiness from loaded cards", () => {
    const parentDone = makeCard({
      id: "parent-done",
      title: "Done parent",
      status: "done",
    });
    const parentTodo = makeCard({
      id: "parent-todo",
      title: "Todo parent",
      status: "todo",
    });
    const child = makeCard({
      id: "child-1",
      metadata: {
        links: [
          { id: "link-1", type: "parent", targetCardId: parentDone.id, createdAt: 1 },
          { id: "link-2", type: "parent", targetCardId: parentTodo.id, createdAt: 1 },
          { id: "link-3", type: "parent", targetCardId: "missing-parent", createdAt: 1 },
        ],
      },
    });

    const dependencies = getWorkboardDependencyState(child, [parentDone, parentTodo, child]);

    expect(
      dependencies.parents.map((parent) => [parent.title, parent.done, parent.missing]),
    ).toEqual([
      ["Done parent", true, false],
      ["Todo parent", false, false],
      ["missing-parent", false, true],
    ]);
    expect(dependencies.blockedParents.map((parent) => parent.id)).toEqual([
      parentTodo.id,
      "missing-parent",
    ]);
  });

  it("summarizes health from card metadata, linked tasks, and sessions", () => {
    const running = createSessionCard({
      id: "running",
      status: "running",
    });
    const blocked = makeCard({ id: "blocked", status: "blocked" });
    const ready = makeCard({ id: "ready", status: "ready" });
    const missingProof = makeCard({ id: "done", status: "done" });
    const artifactProof = makeCard({
      id: "artifact-proof",
      status: "done",
      metadata: { artifacts: [{ id: "artifact-1", createdAt: 1, label: "log" }] },
    });
    const failed = makeCard({
      id: "failed",
      metadata: {
        failureCount: 2,
        attempts: [{ id: "attempt-1", status: "blocked", startedAt: 1 }],
        stale: { detectedAt: 2, reason: "old" },
      },
    });
    const recovered = makeCard({
      id: "recovered",
      metadata: {
        failureCount: 0,
        attempts: [{ id: "attempt-1", status: "failed", startedAt: 1 }],
      },
    });
    const tasksByCardId = new Map<string, WorkboardTaskSummary>([
      [
        "ready",
        makeTask({
          taskId: "task-ready",
          id: "task-ready",
          status: "timed_out",
        }),
      ],
    ]);

    expect(
      summarizeWorkboardHealth({
        cards: [running, blocked, ready, missingProof, artifactProof, failed, recovered],
        tasksByCardId,
        sessions: [sampleSession],
      }),
    ).toEqual({
      running: 1,
      blocked: 1,
      stale: 1,
      readyUnassigned: 1,
      missingProof: 1,
      failedAttempts: 3,
    });
  });

  it("does not count a terminal linked task already recorded as a failed attempt", () => {
    const represented = makeCard({
      id: "represented",
      metadata: {
        failureCount: 1,
        attempts: [
          {
            id: "run-1",
            runId: "run-1",
            sessionKey: sampleTaskSessionKey,
            status: "blocked",
            startedAt: 1,
          },
        ],
      },
    });
    const unrepresented = makeCard({
      id: "unrepresented",
      metadata: {
        failureCount: 1,
        attempts: [
          {
            id: "run-old",
            runId: "run-old",
            sessionKey: sampleTaskSessionKey,
            status: "blocked",
            startedAt: 1,
          },
        ],
      },
    });
    const tasksByCardId = new Map<string, WorkboardTaskSummary>([
      ["represented", makeTask({ status: "failed" })],
      ["unrepresented", makeTask({ status: "failed" })],
    ]);

    expect(
      summarizeWorkboardHealth({
        cards: [represented, unrepresented],
        tasksByCardId,
        sessions: [],
      }).failedAttempts,
    ).toBe(3);
  });

  it("matches failed attempts by session when only one record has a run id", () => {
    const taskRunOnly = makeCard({
      id: "task-run-only",
      metadata: {
        failureCount: 1,
        attempts: [
          {
            id: "attempt-task-run-only",
            sessionKey: sampleTaskSessionKey,
            status: "blocked",
            startedAt: 1,
          },
        ],
      },
    });
    const attemptRunOnly = makeCard({
      id: "attempt-run-only",
      metadata: {
        failureCount: 1,
        attempts: [
          {
            id: "attempt-run-only",
            runId: "run-1",
            sessionKey: sampleTaskSessionKey,
            status: "blocked",
            startedAt: 1,
          },
        ],
      },
    });
    const tasksByCardId = new Map<string, WorkboardTaskSummary>([
      ["task-run-only", makeTask({ status: "failed" })],
      ["attempt-run-only", makeTask({ status: "failed", runId: undefined })],
    ]);

    expect(
      summarizeWorkboardHealth({
        cards: [taskRunOnly, attemptRunOnly],
        tasksByCardId,
        sessions: [],
      }).failedAttempts,
    ).toBe(2);
  });

  it("matches failed attempts to canonical default-agent task sessions", () => {
    const card = makeCard({
      metadata: {
        failureCount: 1,
        attempts: [
          {
            id: "canonical-attempt",
            sessionKey: sampleTaskSessionKey,
            status: "failed",
            startedAt: 1,
          },
        ],
      },
    });
    const tasksByCardId = new Map<string, WorkboardTaskSummary>([
      [
        card.id,
        makeTask({
          status: "failed",
          childSessionKey: `agent:main:${sampleTaskSessionKey}`,
        }),
      ],
    ]);

    expect(
      summarizeWorkboardHealth({
        cards: [card],
        tasksByCardId,
        sessions: [],
      }).failedAttempts,
    ).toBe(1);
  });

  it("filters built-in Workboard view presets", () => {
    vi.setSystemTime(new Date("2026-06-03T12:00:00Z"));
    const now = Date.now();
    const cards = [
      makeCard({ id: "default-agent" }),
      makeCard({ id: "assigned", agentId: "agent-1" }),
      makeCard({ id: "ready", status: "ready" }),
      makeCard({ id: "review", status: "review" }),
      makeCard({ id: "done", status: "done", completedAt: now - 60_000 }),
      makeCard({
        id: "old-done",
        status: "done",
        completedAt: now - 10 * 24 * 60 * 60 * 1000,
      }),
    ];

    expect(
      filterWorkboardCardsForPreset({
        cards,
        preset: "default_agent",
        tasksByCardId: new Map(),
        sessions: [],
        defaultAgentId: "agent-1",
      }).map((card) => card.id),
    ).toEqual(["default-agent", "assigned", "ready", "review", "done", "old-done"]);
    expect(
      filterWorkboardCardsForPreset({
        cards,
        preset: "ready",
        tasksByCardId: new Map(),
        sessions: [],
      }).map((card) => card.id),
    ).toEqual(["ready"]);
    expect(
      filterWorkboardCardsForPreset({
        cards,
        preset: "missing_proof",
        tasksByCardId: new Map(),
        sessions: [],
      }).map((card) => card.id),
    ).toEqual(["done", "old-done"]);
    expect(
      filterWorkboardCardsForPreset({
        cards,
        preset: "recently_done",
        tasksByCardId: new Map(),
        sessions: [],
      }).map((card) => card.id),
    ).toEqual(["done"]);
  });

  it("links unassigned default-agent tasks with canonicalized session keys", async () => {
    const linked = makeCard({
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    });
    const client = createClient({
      "workboard.cards.list": listResult([linked], ["todo", "done"]),
      "tasks.list": {
        tasks: [
          makeTask({
            childSessionKey: `agent:main:${sampleTaskSessionKey}`,
            runId: "run-1",
          }),
        ],
      },
    });

    await loadBoard(client);

    expect(getWorkboardState(host).cards[0]).toMatchObject({ taskId: "task-1" });
  });

  it("does not relink a loaded card to a stale task from another session", async () => {
    const linked = makeCard({
      sessionKey: "agent:main:dashboard:new",
      runId: "run-1",
    });
    const client = createClient({
      "workboard.cards.list": listResult([linked], ["todo", "done"]),
      "tasks.list": {
        tasks: [
          makeTask({
            childSessionKey: sampleTaskSessionKey,
            runId: "run-1",
          }),
        ],
      },
    });

    await loadBoard(client);

    expect(state.cards[0]).not.toHaveProperty("taskId");
    expect(state.tasksByCardId.has("card-1")).toBe(false);
  });

  it("preserves contract-owned metadata loaded from the plugin gateway method", async () => {
    const client = createClient({
      "workboard.cards.list": {
        cards: [
          {
            ...sampleCard,
            metadata: {
              automation: {
                tenant: "qa",
                skills: ["testing"],
                workspace: {
                  kind: "worktree",
                  path: "/tmp/worktree",
                  branch: "work/card-1",
                  sourcePath: "/repo",
                  sourceBranch: "main",
                },
                workspaceAccess: {
                  unrestricted: false,
                  roots: ["/repo"],
                  writable: true,
                },
                dispatchCount: 2,
                lastDispatchAt: 20,
              },
              claim: {
                ownerId: "agent:main",
                token: "[redacted]",
                claimedAt: 10,
                lastHeartbeatAt: 11,
              },
              diagnostics: [
                {
                  kind: "missing_proof",
                  severity: "warning",
                  title: "Proof missing",
                  detail: "Attach focused validation.",
                  firstSeenAt: 12,
                  lastSeenAt: 13,
                  count: 1,
                  actions: [{ kind: "add_proof", label: "Add proof" }],
                },
                { kind: "future_kind", title: "Invalid contract value" },
                {
                  kind: "missing_proof",
                  severity: "future_severity",
                  title: "Invalid severity value",
                },
              ],
              notifications: [
                {
                  id: "notification-1",
                  kind: "completed",
                  createdAt: 14,
                  sequence: 3,
                  message: "Card completed",
                },
                {
                  id: "notification-2",
                  kind: "future_kind",
                  createdAt: 15,
                  message: "Invalid contract value",
                },
              ],
            },
          },
        ],
        statuses: ["ready", "done"],
      },
    });

    await loadBoard(client);

    expect(getWorkboardState(host).cards[0]?.metadata).toMatchObject({
      automation: {
        tenant: "qa",
        skills: ["testing"],
        workspace: {
          kind: "worktree",
          sourcePath: "/repo",
          sourceBranch: "main",
        },
        workspaceAccess: {
          unrestricted: false,
          roots: ["/repo"],
          writable: true,
        },
        dispatchCount: 2,
        lastDispatchAt: 20,
      },
      claim: { token: "[redacted]" },
      diagnostics: [{ actions: [{ kind: "add_proof", label: "Add proof" }] }],
      notifications: [{ sequence: 3 }],
    });
    expect(getWorkboardState(host).cards[0]?.metadata?.diagnostics).toHaveLength(1);
    expect(getWorkboardState(host).cards[0]?.metadata?.notifications).toHaveLength(1);
  });

  it("updates cards from draft state when editing", async () => {
    state.cards = [sampleCard];
    state.draftOpen = true;
    state.editingCardId = sampleCard.id;
    state.draftTitle = "Updated board";
    state.draftNotes = "New notes";
    state.draftStatus = "review";
    state.draftPriority = "high";
    state.draftLabels = "ui, polish";
    state.draftAgentId = "dev";
    state.draftSessionKey = sampleSession.key;
    const updated = createSessionCard({
      title: "Updated board",
      notes: "New notes",
      status: "review",
      priority: "high",
      labels: ["ui", "polish"],
      agentId: "dev",
    });
    const client = createClient({ "workboard.cards.update": { card: updated } });

    await saveDraft(client);

    expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: "card-1",
      patch: {
        title: "Updated board",
        notes: "New notes",
        status: "review",
        priority: "high",
        labels: ["ui", "polish"],
        agentId: "dev",
        sessionKey: sampleSession.key,
      },
    });
    expect(state.cards[0]).toMatchObject({ title: "Updated board", status: "review" });
    expect(state.draftOpen).toBe(false);
    expect(state.editingCardId).toBeNull();
  });

  it("creates cards from draft state through the save action", async () => {
    state.draftTitle = "Write tests";
    state.draftNotes = "Cover the happy path";
    state.draftSessionKey = "agent:main:dashboard:1";
    const created = makeCard({
      id: "card-2",
      title: "Write tests",
      sessionKey: "agent:main:dashboard:1",
    });
    const client = createClient({ "workboard.cards.create": { card: created } });

    await saveDraft(client);

    expect(client.request).toHaveBeenCalledWith("workboard.cards.create", {
      title: "Write tests",
      notes: "Cover the happy path",
      status: "todo",
      priority: "normal",
      labels: [],
      agentId: "",
      sessionKey: "agent:main:dashboard:1",
    });
    expect(state.cards[0]).toMatchObject({ id: "card-2", title: "Write tests" });
    expect(state.draftOpen).toBe(false);
    expect(state.draftSessionKey).toBe("");
  });

  it("creates cards on the selected named board", async () => {
    state.boardFilter = "ops";
    state.boards = [{ id: "ops", total: 0, active: 0, archived: 0, byStatus: {} }];
    state.draftTitle = "Investigate operations alert";
    const created = makeCard({
      id: "card-ops",
      title: "Investigate operations alert",
      metadata: { automation: { boardId: "ops" } },
    });
    const client = createClient({ "workboard.cards.create": { card: created } });

    await saveDraft(client);

    expect(client.request).toHaveBeenCalledWith("workboard.cards.create", {
      title: "Investigate operations alert",
      notes: "",
      status: "todo",
      priority: "normal",
      labels: [],
      agentId: "",
      sessionKey: "",
      boardId: "ops",
    });
    expect(state.cards[0]).toMatchObject({
      id: "card-ops",
      metadata: { automation: { boardId: "ops" } },
    });
  });

  it("creates template-backed cards through the save action", async () => {
    state.draftTitle = "Fix: flaky worker";
    state.draftTemplateId = "bugfix";
    const created = makeCard({
      id: "card-2",
      title: "Fix: flaky worker",
      metadata: { templateId: "bugfix" },
    });
    const client = createClient({ "workboard.cards.create": { card: created } });

    await saveDraft(client);

    expect(client.request).toHaveBeenCalledWith(
      "workboard.cards.create",
      expect.objectContaining({
        title: "Fix: flaky worker",
        templateId: "bugfix",
      }),
    );
    expect(state.cards[0]?.metadata?.templateId).toBe("bugfix");
    expect(state.draftTemplateId).toBe("");
  });

  it("keeps edit-modal status saves from being rewritten by stale lifecycle sync", async () => {
    const linked = createWorkboardCard({
      sessionKey: sampleSession.key,
      execution: createWorkboardExecution({ sessionKey: sampleSession.key }),
    });
    setLoadedCard(linked);
    openEditDraft(linked);
    const saved = makeMovedCard(linked);
    const client = createClient((method) => {
      if (method === "workboard.cards.update") {
        return { card: saved };
      }
      return {};
    });

    await saveDraft(client);
    await syncLifecycle(client, [
      makeSession({ hasActiveRun: false, status: "done", updatedAt: 1 }),
    ]);

    expect(client.request).toHaveBeenCalledTimes(3);
    expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: "card-1",
      patch: expect.objectContaining({ status: "running" }),
    });
    expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    expect(client.request.mock.calls[2]?.[1]).toMatchObject({
      id: "card-1",
      patch: { execution: expect.objectContaining({ status: "review" }) },
    });
    expect(requestPatch(client, 2)).not.toHaveProperty("status");
    expect(state.cards[0]).toMatchObject({ status: "running" });
  });

  it("does not start lifecycle writes while dispatch is active", async () => {
    state.loaded = true;
    state.dispatching = true;
    state.cards = [makeCard({ sessionKey: sampleSession.key })];
    const client = createClient({
      "workboard.cards.update": { card: makeCard({ status: "running" }) },
    });

    await syncLifecycle(client, [makeSession({ status: "running", hasActiveRun: true })]);

    expect(client.request).not.toHaveBeenCalled();
  });

  it("does not poll tasks or reconcile archived session cards", async () => {
    state.loaded = true;
    const archived = createWorkboardCard({
      status: "running",
      sessionKey: sampleSession.key,
      taskId: "archived-task",
      metadata: { archivedAt: 10 },
    });
    state.cards = [archived];
    const client = createClient({});

    await syncLifecycle(client, [
      makeSession({ status: "done", hasActiveRun: false, updatedAt: 20 }),
    ]);

    expect(client.request).not.toHaveBeenCalled();
    expect(state.cards).toEqual([archived]);
    expect(state.tasksByCardId.size).toBe(0);
  });

  it("reconciles active session cards without rewriting an archived sibling", async () => {
    state.loaded = true;
    const archived = createWorkboardCard({
      id: "archived-session-card",
      status: "running",
      sessionKey: sampleSession.key,
      taskId: "archived-task",
      metadata: { archivedAt: 10 },
    });
    const active = createWorkboardCard({
      id: "active-session-card",
      status: "todo",
      sessionKey: sampleSession.key,
    });
    state.cards = [archived, active];
    const updated = makeCard({ ...active, status: "review" });
    const client = createClient((method) =>
      method === "workboard.cards.update" ? { card: updated } : {},
    );

    await syncLifecycle(client, [
      makeSession({ status: "done", hasActiveRun: false, updatedAt: 20 }),
    ]);

    expect(client.request).toHaveBeenCalledOnce();
    expect(client.request).toHaveBeenCalledWith(
      "workboard.cards.update",
      expect.objectContaining({ id: active.id }),
    );
    expect(state.cards.find((card) => card.id === archived.id)).toEqual(archived);
  });

  it.each(["editing", "dragging"] as const)(
    "does not start lifecycle writes while a card is %s",
    async (interaction) => {
      state.loaded = true;
      state.cards = [makeCard({ sessionKey: sampleSession.key })];
      if (interaction === "editing") {
        state.draftOpen = true;
        state.editingCardId = sampleCard.id;
      } else {
        state.draggedCardId = sampleCard.id;
      }
      const client = createClient({
        "workboard.cards.update": { card: makeCard({ status: "running" }) },
      });

      await syncLifecycle(client, [makeSession({ status: "running", hasActiveRun: true })]);

      expect(client.request).not.toHaveBeenCalled();
    },
  );

  it("does not start lifecycle writes while a canonical refresh is loading", async () => {
    state.loaded = true;
    state.cards = [makeCard({ sessionKey: sampleSession.key })];
    const loadResponse = createDeferred<unknown>();
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return loadResponse.promise;
      }
      if (method === "workboard.cards.update") {
        return { card: makeCard({ status: "running" }) };
      }
      return {};
    });

    const loading = loadBoard(client);
    await Promise.resolve();
    await syncLifecycle(client, [makeSession({ status: "running", hasActiveRun: true })]);

    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request).toHaveBeenCalledWith("workboard.cards.list", {});
    loadResponse.resolve({ cards: [sampleCard] });
    await loading;
  });

  it("does not start lifecycle writes while edit-modal saves are in flight", async () => {
    const linked = createWorkboardCard({
      sessionKey: sampleSession.key,
      execution: createWorkboardExecution({ sessionKey: sampleSession.key }),
    });
    setLoadedCard(linked);
    openEditDraft(linked);
    const saved = makeMovedCard(linked);
    const saveResponse = createDeferred<{ card: WorkboardCard }>();
    const client = createClient((method) => {
      if (method === "workboard.cards.update") {
        return saveResponse.promise;
      }
      return {};
    });

    const saving = saveDraft(client);
    await Promise.resolve();
    await syncLifecycle(client, [
      makeSession({ hasActiveRun: false, status: "done", updatedAt: 1 }),
    ]);

    expect(client.request).toHaveBeenCalledOnce();
    saveResponse.resolve({ card: saved });
    await saving;
    expect(state.cards[0]).toMatchObject({ status: "running" });
  });

  it("adds operator notes to a selected detail card without opening the edit draft", async () => {
    state.cards = [sampleCard];
    state.detailCardId = sampleCard.id;
    state.detailCommentBody = "Need one more proof run.";
    const updated = makeCommentedCard(sampleCard, "Need one more proof run.");
    const client = createClient({ "workboard.cards.comment": { card: updated } });

    await commentCard(client, {
      cardId: sampleCard.id,
      body: state.detailCommentBody,
    });

    expect(client.request).toHaveBeenCalledWith("workboard.cards.comment", {
      id: "card-1",
      body: "Need one more proof run.",
    });
    expect(state.cards[0]?.metadata?.comments?.[0]?.body).toBe("Need one more proof run.");
    expect(state.detailCommentBody).toBe("");
    expect(state.draftOpen).toBe(false);
  });

  it("captures existing sessions as linked workboard cards", async () => {
    const session = makeSession({
      label: "Fix login",
      status: "done",
      hasActiveRun: false,
    });
    const created = createSessionCard({
      title: "Fix login",
      status: "review",
    });
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return listResult([], ["todo", "running", "review"]);
      }
      if (method === "chat.history") {
        return {
          messages: [
            { role: "user", content: [{ type: "text", text: "Please investigate login" }] },
            { role: "assistant", content: [{ type: "text", text: "Found the issue." }] },
            { role: "user", content: [{ type: "text", text: "Please fix login" }] },
            { role: "assistant", content: [{ type: "text", text: "Implemented and tested." }] },
          ],
        };
      }
      if (method === "workboard.cards.create") {
        return { card: created };
      }
      return {};
    });

    const card = await captureSessionToWorkboard({ host, client: client as never, session });

    expect(card).toMatchObject({ title: "Fix login", status: "review" });
    expect(client.request).toHaveBeenNthCalledWith(1, "workboard.cards.list", {});
    expect(client.request).toHaveBeenNthCalledWith(2, "chat.history", {
      sessionKey: sampleSession.key,
      limit: 40,
      maxChars: 6000,
    });
    expect(client.request).toHaveBeenNthCalledWith(3, "workboard.cards.create", {
      title: "Fix login",
      notes: [
        `Session: ${sampleSession.key}`,
        "",
        "Recent user prompt: Please fix login",
        "",
        "Latest assistant note: Implemented and tested.",
      ].join("\n"),
      status: "review",
      priority: "normal",
      agentId: "",
      sessionKey: sampleSession.key,
    });
    expect(getWorkboardState(host).cards[0]).toMatchObject({ sessionKey: sampleSession.key });
  });

  it("captures a session on the selected named board", async () => {
    state.loaded = true;
    state.boardFilter = "ops";
    state.boards = [{ id: "ops", total: 0, active: 0, archived: 0, byStatus: {} }];
    const created = createWorkboardCard({
      id: "captured-ops-card",
      sessionKey: sampleSession.key,
      metadata: { automation: { boardId: "ops" } },
    });
    const client = createClient((method) => {
      if (method === "chat.history") {
        return { messages: [] };
      }
      if (method === "workboard.cards.create") {
        return { card: created };
      }
      return {};
    });

    await expect(captureSession(client, sampleSession)).resolves.toMatchObject({
      id: "captured-ops-card",
      metadata: { automation: { boardId: "ops" } },
    });

    expect(client.request).toHaveBeenCalledWith(
      "workboard.cards.create",
      expect.objectContaining({ boardId: "ops", sessionKey: sampleSession.key }),
    );
    expect(state.cards).toContainEqual(created);
  });

  it("does not duplicate existing captured sessions", async () => {
    const existing = createWorkboardCard({
      execution: createWorkboardExecution({ sessionKey: sampleSession.key }),
    });
    setLoadedCard(existing);
    const client = createClient({});

    const card = await captureSession(client, sampleSession);

    expect(card).toBe(existing);
    expect(client.request).not.toHaveBeenCalled();
  });

  it("reuses an active captured session before an older archived match", async () => {
    const archived = createSessionCard({
      id: "archived-session-card",
      metadata: { archivedAt: 10 },
    });
    const active = createSessionCard({
      id: "active-session-card",
    });
    state.loaded = true;
    state.cards = [archived, active];
    const client = createClient({});

    await expect(captureSession(client, sampleSession)).resolves.toBe(active);
    expect(client.request).not.toHaveBeenCalled();
    expect(state.cards).toEqual([archived, active]);
  });

  it.each([
    { name: "reuses the newest active captured session", inFlight: false },
    {
      name: "returns the newest active captured session while a capture is in flight",
      inFlight: true,
    },
  ])("$name", async ({ inFlight }) => {
    const archived = createSessionCard({
      id: "archived-newest-session-card",
      position: 0,
      updatedAt: 30,
      metadata: { archivedAt: 40 },
    });
    const older = createSessionCard({
      id: "older-active-session-card",
      position: 1000,
      updatedAt: 10,
    });
    const newest = createSessionCard({
      id: "newest-active-session-card",
      position: 2000,
      updatedAt: 20,
    });
    state.loaded = true;
    state.cards = [archived, older, newest];
    if (inFlight) {
      state.capturingSessionKeys.add(sampleSession.key);
    }
    const client = createClient({});

    await expect(captureSession(client, sampleSession)).resolves.toBe(newest);
    expect(client.request).not.toHaveBeenCalled();
    expect(state.cards).toEqual([archived, older, newest]);
  });

  it("returns the active captured session while a duplicate capture is in flight", async () => {
    const archived = createSessionCard({
      id: "archived-inflight-session-card",
      metadata: { archivedAt: 10 },
    });
    const active = createSessionCard({
      id: "active-inflight-session-card",
    });
    state.loaded = true;
    state.cards = [archived, active];
    state.capturingSessionKeys.add(sampleSession.key);
    const client = createClient({});

    await expect(captureSession(client, sampleSession)).resolves.toBe(active);
    expect(client.request).not.toHaveBeenCalled();
    expect(state.cards).toEqual([archived, active]);
  });

  it("restores archived captured sessions instead of leaving them hidden", async () => {
    const archived = createSessionCard({
      metadata: { archivedAt: 10 },
    });
    const restored = {
      ...archived,
      metadata: {},
    } satisfies WorkboardCard;
    setLoadedCard(archived);
    const client = createClient({
      "workboard.cards.archive": { card: restored },
    });

    const card = await captureSession(client, sampleSession);

    expect(card).toMatchObject({ id: restored.id, sessionKey: sampleSession.key });
    expect(card?.metadata?.archivedAt).toBeUndefined();
    expect(client.request).toHaveBeenCalledWith("workboard.cards.archive", {
      id: archived.id,
      archived: false,
    });
    expect(state.cards[0]?.metadata?.archivedAt).toBeUndefined();
  });

  it("does not start duplicate capture requests while a session is in flight", async () => {
    state.capturingSessionKeys.add(sampleSession.key);
    const existing = makeCard({ sessionKey: sampleSession.key });
    state.cards = [existing];
    const client = createClient({});

    const card = await captureSession(client, sampleSession);

    expect(card).toBe(existing);
    expect(client.request).not.toHaveBeenCalled();
  });

  it("captures different sessions concurrently", async () => {
    state.loaded = true;
    const firstSession = makeSession({ key: "agent:main:dashboard:first" });
    const secondSession = makeSession({ key: "agent:main:dashboard:second" });
    const firstCard = makeCard({ id: "card-first", sessionKey: firstSession.key });
    const secondCard = makeCard({ id: "card-second", sessionKey: secondSession.key });
    const firstCreate = createDeferred<unknown>();
    const client = createClient((method, params) => {
      if (method === "chat.history") {
        return { messages: [] };
      }
      if (method === "workboard.cards.create") {
        return (params as { sessionKey: string }).sessionKey === firstSession.key
          ? firstCreate.promise
          : { card: secondCard };
      }
      return {};
    });

    const firstCapture = captureSession(client, firstSession);
    await waitForFast(() => {
      expect(client.request).toHaveBeenCalledWith(
        "workboard.cards.create",
        expect.objectContaining({ sessionKey: firstSession.key }),
      );
    });

    await expect(
      captureSessionToWorkboard({
        host,
        client: client as never,
        session: secondSession,
      }),
    ).resolves.toEqual(secondCard);
    firstCreate.resolve({ card: firstCard });
    await expect(firstCapture).resolves.toEqual(firstCard);

    expect(state.cards.map((card) => card.id).toSorted()).toEqual(["card-first", "card-second"]);
    expect(state.capturingSessionKeys.size).toBe(0);
  });

  it("does not duplicate same-session captures waiting on the initial load", async () => {
    const list = createDeferred<unknown>();
    const create = createDeferred<unknown>();
    const created = makeCard({ sessionKey: sampleSession.key });
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return list.promise;
      }
      if (method === "chat.history") {
        return { messages: [] };
      }
      if (method === "workboard.cards.create") {
        return create.promise;
      }
      return {};
    });

    const firstCapture = captureSession(client, sampleSession);
    const secondCapture = captureSession(client, sampleSession);
    list.resolve({ cards: [], statuses: ["todo"] });
    await waitForFast(() => {
      expect(client.request).toHaveBeenCalledWith(
        "workboard.cards.create",
        expect.objectContaining({ sessionKey: sampleSession.key }),
      );
    });

    expect(requestCalls(client, "workboard.cards.create")).toHaveLength(1);
    create.resolve({ card: created });
    const captures = await Promise.all([firstCapture, secondCapture]);

    expect(captures.filter(Boolean)).toEqual([created]);
    expect(state.cards).toEqual([created]);
    expect(state.capturingSessionKeys.size).toBe(0);
  });

  it("does not capture sessions while dispatch is active", async () => {
    state.dispatching = true;
    const client = createClient({});

    const card = await captureSession(client, sampleSession);

    expect(card).toBeNull();
    expect(client.request).not.toHaveBeenCalled();
  });

  it("does not create capture cards when the duplicate preflight list fails", async () => {
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        throw new Error("list unavailable");
      }
      return {};
    });

    const card = await captureSession(client, sampleSession);

    expect(card).toBeNull();
    expect(client.request).toHaveBeenCalledOnce();
    expect(client.request).toHaveBeenCalledWith("workboard.cards.list", {});
  });

  it("waits for an in-flight Workboard load before capturing a session", async () => {
    const list = createDeferred<unknown>();
    const created = makeCard({ sessionKey: sampleSession.key });
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return list.promise;
      }
      if (method === "chat.history") {
        return { messages: [] };
      }
      if (method === "workboard.cards.create") {
        return { card: created };
      }
      return {};
    });

    const loading = loadBoard(client);
    const captured = captureSession(client, sampleSession);

    await Promise.resolve();
    expect(client.request).toHaveBeenCalledTimes(1);
    list.resolve({ cards: [], statuses: ["todo"] });
    await loading;

    await expect(captured).resolves.toMatchObject({ sessionKey: sampleSession.key });
    expect(client.request).toHaveBeenCalledWith("workboard.cards.create", expect.any(Object));
  });

  it("waits for retained lifecycle writes before capturing after teardown", async () => {
    const lifecycleCard = createSessionCard();
    const capturedSession = makeSession({ key: "agent:main:dashboard:capture" });
    const capturedCard = makeCard({
      id: "captured-card",
      sessionKey: capturedSession.key,
    });
    const lifecycleUpdate = createDeferred<unknown>();
    const client = createClient((method) => {
      if (method === "workboard.cards.update") {
        return lifecycleUpdate.promise;
      }
      if (method === "workboard.cards.list") {
        return {
          cards: [{ ...lifecycleCard, status: "running" }],
          statuses: ["todo", "running", "done"],
        };
      }
      if (method === "tasks.list") {
        return { tasks: [] };
      }
      if (method === "chat.history") {
        return { messages: [] };
      }
      if (method === "workboard.cards.create") {
        return { card: capturedCard };
      }
      return {};
    });
    setLoadedCard(lifecycleCard);
    state.lifecycleTasksPrepared = true;
    state.lifecycleTasksPreparedAt = Date.now();

    const syncing = syncLifecycle(client, [sampleSession]);
    await waitForFast(() => {
      expect(client.request).toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    });
    stopWorkboardLifecycleRefresh(host);
    const capture = captureSession(client, capturedSession);
    await Promise.resolve();

    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.list", {});

    lifecycleUpdate.resolve({ card: { ...lifecycleCard, status: "running" } });
    await syncing;

    await expect(capture).resolves.toEqual(capturedCard);
    expect(client.request).toHaveBeenCalledWith("workboard.cards.list", {});
    expect(client.request).toHaveBeenCalledWith(
      "workboard.cards.create",
      expect.objectContaining({ sessionKey: capturedSession.key }),
    );
  });

  it("clamps captured session fields without splitting surrogate pairs", async () => {
    const titlePrefix = "x".repeat(176);
    const textPrefix = "y".repeat(696);
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return listResult([], ["todo"]);
      }
      if (method === "chat.history") {
        return {
          messages: [{ role: "user", content: [{ type: "text", text: `${textPrefix}😀tail` }] }],
        };
      }
      if (method === "workboard.cards.create") {
        return { card: makeCard({ title: `${titlePrefix}...` }) };
      }
      return {};
    });

    await captureSession(client, makeSession({ label: `${titlePrefix}😀tail` }));

    expect(client.request).toHaveBeenNthCalledWith(
      3,
      "workboard.cards.create",
      expect.objectContaining({
        title: `${titlePrefix}...`,
        notes: [`Session: ${sampleSession.key}`, "", `Recent user prompt: ${textPrefix}...`].join(
          "\n",
        ),
      }),
    );
  });

  it("starts a task run and links it back to the card", async () => {
    const running = createLinkedCard();
    const client = createClient({
      agent: { sessionKey: sampleTaskSessionKey, runId: "run-1" },
      "tasks.list": { tasks: [sampleTask] },
      "workboard.cards.update": { card: running },
    });

    const sessionKey = await startSampleCard(client);

    expect(sessionKey).toBe(sampleTaskSessionKey);
    expect(client.request).toHaveBeenNthCalledWith(
      1,
      "workboard.cards.update",
      expect.objectContaining({
        id: "card-1",
        patch: { status: "running" },
      }),
    );
    expect(client.request).toHaveBeenNthCalledWith(
      2,
      "agent",
      expect.objectContaining({
        sessionKey: sampleTaskSessionKey,
        label: "Build board (card-1)",
        message: expect.stringContaining("Work on this OpenClaw Workboard card: Build board"),
        idempotencyKey: "workboard:default:card-1:1",
      }),
    );
    expect(client.request.mock.calls[1]?.[1]).not.toHaveProperty("model");
    expect(client.request).toHaveBeenNthCalledWith(3, "tasks.list", { limit: 500 });
    expect(client.request).toHaveBeenNthCalledWith(
      4,
      "workboard.cards.update",
      expect.objectContaining({
        id: "card-1",
        patch: expect.objectContaining({
          status: "running",
          runId: "run-1",
          taskId: "task-1",
        }),
      }),
    );
    expect(client.request.mock.calls[3]?.[1]).toHaveProperty("patch.execution", null);
  });

  it("keeps bounded task session labels on a UTF-16 boundary", async () => {
    const title = `${"a".repeat(499)}🚀tail`;
    const client = createClient({
      agent: { sessionKey: sampleTaskSessionKey, runId: "run-1" },
      "tasks.list": { tasks: [sampleTask] },
      "workboard.cards.update": { card: makeCard({ title, status: "running" }) },
    });

    await startCard(client, {
      card: makeCard({ title }),
    });

    expect(client.request).toHaveBeenNthCalledWith(
      2,
      "agent",
      expect.objectContaining({
        label: `${"a".repeat(499)}... (card-1)`,
      }),
    );
  });

  it("starts reassigned cards with the current task session key", async () => {
    const expectedSessionKey = "agent:codex-main:subagent:workboard-default-card-1";
    const staleLinked = makeCard({
      agentId: "codex-main",
      sessionKey: "agent:old-agent:dashboard:stale",
    });
    const running = {
      ...staleLinked,
      status: "running",
      sessionKey: expectedSessionKey,
      runId: "run-1",
      taskId: "task-1",
    };
    const client = createClient({
      agent: { sessionKey: expectedSessionKey, runId: "run-1" },
      "tasks.list": {
        tasks: [makeTask({ childSessionKey: expectedSessionKey })],
      },
      "workboard.cards.update": { card: running },
    });

    const sessionKey = await startCard(client, {
      card: staleLinked,
    });

    expect(sessionKey).toBe(expectedSessionKey);
    expect(client.request).toHaveBeenNthCalledWith(
      2,
      "agent",
      expect.objectContaining({
        agentId: "codex-main",
        sessionKey: expectedSessionKey,
      }),
    );
  });

  // Cards persist whatever agent id they were created with, so the worker key
  // canonicalizes it: "Codex-Main" and "codex-main" name one session, not two.
  it("canonicalizes a card's agent id in the worker session key", async () => {
    const expectedSessionKey = "agent:codex-main:subagent:workboard-default-card-1";
    const mixedCase = makeCard({ agentId: "Codex-Main" });
    const running = {
      ...mixedCase,
      status: "running",
      sessionKey: expectedSessionKey,
      runId: "run-1",
    } satisfies WorkboardCard;
    const client = createClient({
      agent: { runId: "run-1" },
      "tasks.list": { tasks: [] },
      "workboard.cards.update": { card: running },
    });

    const sessionKey = await startCard(client, {
      card: mixedCase,
    });

    expect(sessionKey).toBe(expectedSessionKey);
    expect(client.request).toHaveBeenNthCalledWith(
      2,
      "agent",
      expect.objectContaining({ sessionKey: expectedSessionKey }),
    );
  });

  it("waits briefly for task ledger registration after a started run", async () => {
    vi.useFakeTimers();
    const running = createLinkedCard();
    const client = createSequencedClient(
      {
        agent: [{ sessionKey: sampleTaskSessionKey, runId: "run-1" }],
        "tasks.list": [{ tasks: [] }, { tasks: [] }, { tasks: [sampleTask] }],
      },
      { card: running },
    );

    const started = startSampleCard(client);
    await vi.advanceTimersByTimeAsync(350);
    const sessionKey = await started;

    expect(sessionKey).toBe(sampleTaskSessionKey);
    expect(requestCalls(client, "tasks.list").length).toBe(3);
    expect(client.request).toHaveBeenLastCalledWith(
      "workboard.cards.update",
      expect.objectContaining({
        patch: expect.objectContaining({ taskId: "task-1" }),
      }),
    );
  });

  it("keeps a successfully started run when task lookup stays unavailable", async () => {
    vi.useFakeTimers();
    const running = makeCard({
      status: "running",
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    });
    const client = createClient((method) => {
      if (method === "agent") {
        return { sessionKey: sampleTaskSessionKey, runId: "run-1" };
      }
      if (method === "tasks.list") {
        throw new Error("task ledger unavailable");
      }
      return { card: running };
    });

    const started = startSampleCard(client);
    await vi.advanceTimersByTimeAsync(1000);
    const sessionKey = await started;

    expect(sessionKey).toBe(sampleTaskSessionKey);
    expect(client.request).not.toHaveBeenCalledWith("chat.abort", expect.anything());
    expect(client.request).toHaveBeenLastCalledWith(
      "workboard.cards.update",
      expect.objectContaining({
        patch: expect.objectContaining({
          sessionKey: sampleTaskSessionKey,
          runId: "run-1",
          taskId: null,
        }),
      }),
    );
    expect(getWorkboardState(host).error).toBeNull();
  });

  it("lets the gateway decide starts when cached parent dependencies are stale", async () => {
    const parent = makeCard({ id: "parent-1", title: "Parent", status: "running" });
    const child = makeCard({
      id: "child-1",
      title: "Child",
      metadata: {
        links: [{ id: "link-1", type: "parent", targetCardId: parent.id, createdAt: 1 }],
      },
    });
    const running = {
      ...child,
      status: "running",
      sessionKey: "subagent:workboard-default-child-1",
      runId: "run-1",
    } satisfies WorkboardCard;
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return { cards: [parent, child], statuses: ["todo", "running", "done"] };
      }
      if (method === "agent") {
        return { sessionKey: "subagent:workboard-default-child-1", runId: "run-1" };
      }
      if (method === "tasks.list") {
        return { tasks: [] };
      }
      return { card: running };
    });
    await loadBoard(client);
    client.request.mockClear();

    const sessionKey = await startCard(client, {
      card: child,
    });

    expect(sessionKey).toBe("subagent:workboard-default-child-1");
    expect(client.request).toHaveBeenNthCalledWith(
      1,
      "workboard.cards.update",
      expect.objectContaining({ id: child.id, patch: { status: "running" } }),
    );
    expect(client.request).toHaveBeenNthCalledWith(
      2,
      "agent",
      expect.objectContaining({ sessionKey: "subagent:workboard-default-child-1" }),
    );
  });

  it("does not create a session when the gateway rejects start preflight", async () => {
    const client = createSequencedClient(
      {
        "workboard.cards.update": [
          new Error("Parent cards must be done before starting this card."),
        ],
      },
      { key: "agent:main:dashboard:1" },
    );

    const sessionKey = await startSampleCard(client);

    expect(sessionKey).toBeNull();
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request).toHaveBeenCalledWith(
      "workboard.cards.update",
      expect.objectContaining({ patch: { status: "running" } }),
    );
    expect(getWorkboardState(host).error).toBe(
      "Parent cards must be done before starting this card.",
    );
  });

  it("rolls back the running preflight when task run creation fails", async () => {
    const running = makeCard({ status: "running" });
    const client = createSequencedClient({
      "workboard.cards.update": [{ card: running }, { card: sampleCard }],
      agent: [new Error("gateway disconnected")],
    });

    const sessionKey = await startSampleCard(client);

    expect(sessionKey).toBeNull();
    expect(client.request).toHaveBeenNthCalledWith(
      1,
      "workboard.cards.update",
      expect.objectContaining({ patch: { status: "running" } }),
    );
    expect(client.request).toHaveBeenNthCalledWith(
      3,
      "workboard.cards.update",
      expect.objectContaining({
        patch: expect.objectContaining({
          status: "todo",
          startedAt: null,
          completedAt: null,
        }),
      }),
    );
    expect(getWorkboardState(host).cards).toEqual([sampleCard]);
    expect(getWorkboardState(host).error).toBe("gateway disconnected");
  });

  it("rolls back the running preflight when final session link update fails", async () => {
    const running = makeCard({ status: "running" });
    const client = createSequencedClient({
      "workboard.cards.update": [
        { card: running },
        new Error("write conflict"),
        { card: sampleCard },
      ],
      agent: [{ sessionKey: sampleTaskSessionKey, runId: "run-1" }],
      "tasks.list": [{ tasks: [sampleTask] }],
      "chat.abort": [{ aborted: true, runIds: ["run-1"] }],
    });

    const sessionKey = await startSampleCard(client);

    expect(sessionKey).toBeNull();
    expect(client.request).toHaveBeenNthCalledWith(5, "chat.abort", {
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    });
    expect(client.request).toHaveBeenNthCalledWith(
      6,
      "workboard.cards.update",
      expect.objectContaining({
        patch: expect.objectContaining({
          status: "todo",
          startedAt: null,
          completedAt: null,
        }),
      }),
    );
    expect(getWorkboardState(host).cards).toEqual([sampleCard]);
    expect(getWorkboardState(host).error).toBe("write conflict");
  });

  it("does not start a card before its scheduled time", async () => {
    const scheduled = makeCard({
      id: "scheduled-1",
      status: "scheduled",
      metadata: { automation: { scheduledAt: Date.now() + 60_000 } },
    });
    const client = createClient({
      "workboard.cards.list": listResult([scheduled], ["scheduled", "running", "done"]),
    });
    await loadBoard(client);
    client.request.mockClear();

    const sessionKey = await startCard(client, {
      card: scheduled,
    });

    expect(sessionKey).toBeNull();
    expect(client.request).not.toHaveBeenCalled();
    expect(getWorkboardState(host).error).toBe(
      "Scheduled cards cannot start before their scheduled time.",
    );

    const manualScheduled = makeCard({
      id: "scheduled-2",
      status: "scheduled",
      metadata: { automation: { scheduledAt: Date.now() + 60_000 } },
    });
    const manualLinked = makeCard({
      ...manualScheduled,
      status: "todo",
      metadata: {},
      sessionKey: "agent:main:dashboard:manual",
      execution: createWorkboardExecution({
        id: "exec-manual",
        mode: "manual",
        status: "idle",
        sessionKey: "agent:main:dashboard:manual",
      }),
    });
    const manualClient = createClient({
      "sessions.create": { key: "agent:main:dashboard:manual" },
      "workboard.cards.update": { card: manualLinked },
    });
    const manualSessionKey = await startCard(manualClient, {
      card: manualScheduled,
      mode: "manual",
    });
    expect(manualSessionKey).toBe("agent:main:dashboard:manual");
    expect(manualClient.request).toHaveBeenNthCalledWith(
      1,
      "sessions.create",
      expect.not.objectContaining({ message: expect.any(String) }),
    );
    expect(manualClient.request).toHaveBeenNthCalledWith(
      2,
      "workboard.cards.update",
      expect.objectContaining({
        id: manualScheduled.id,
        patch: expect.objectContaining({ status: "todo", scheduledAt: null }),
      }),
    );

    const readyWithSchedule = makeCard({
      id: "scheduled-2b",
      status: "ready",
      metadata: { automation: { scheduledAt: Date.now() + 60_000 } },
    });
    const readyManualClient = createClient({
      "sessions.create": { key: "agent:main:dashboard:ready-manual" },
      "workboard.cards.update": {
        card: makeCard({ ...readyWithSchedule, sessionKey: "agent:main:dashboard:ready-manual" }),
      },
    });
    await startCard(readyManualClient, {
      card: readyWithSchedule,
      mode: "manual",
    });
    expect(readyManualClient.request).toHaveBeenNthCalledWith(
      2,
      "workboard.cards.update",
      expect.objectContaining({
        id: readyWithSchedule.id,
        patch: expect.objectContaining({ status: "ready", scheduledAt: null }),
      }),
    );

    const dueScheduled = makeCard({
      ...scheduled,
      id: "scheduled-3",
      metadata: { automation: { scheduledAt: Date.now() - 60_000 } },
    });
    const dueRunning = makeCard({
      ...dueScheduled,
      status: "running",
      sessionKey: "subagent:workboard-default-scheduled-3",
      runId: "run-due",
      taskId: "task-due",
    });
    const dueClient = createClient((method) => {
      if (method === "workboard.cards.list") {
        return listResult([dueScheduled], ["scheduled", "running", "done"]);
      }
      if (method === "agent") {
        return {
          sessionKey: "subagent:workboard-default-scheduled-3",
          runId: "run-due",
        };
      }
      if (method === "tasks.list") {
        return {
          tasks: [
            makeTask({
              id: "task-due",
              taskId: "task-due",
              childSessionKey: "subagent:workboard-default-scheduled-3",
              runId: "run-due",
            }),
          ],
        };
      }
      if (method === "workboard.cards.update") {
        return { card: dueRunning };
      }
      return {};
    });
    await loadBoard(dueClient);
    dueClient.request.mockClear();

    const dueSessionKey = await startCard(dueClient, { card: dueScheduled });

    expect(dueSessionKey).toBe("subagent:workboard-default-scheduled-3");
    expect(dueClient.request).toHaveBeenCalledWith(
      "agent",
      expect.objectContaining({
        label: "Build board (schedule)",
      }),
    );
  });

  it("starts a Codex execution with an explicit model override", async () => {
    const running = createWorkboardCard({
      status: "running",
      sessionKey: sampleTaskSessionKey,
      taskId: "task-1",
      execution: createWorkboardExecution({
        id: "card-1:codex",
        model: "openai/gpt-5.6-sol",
        sessionKey: sampleTaskSessionKey,
        runId: "run-1",
        startedAt: 10,
        updatedAt: 10,
      }),
    });
    const client = createSequencedClient({
      "workboard.cards.update": [{ card: makeCard({ status: "running" }) }, { card: running }],
      agent: [{ sessionKey: sampleTaskSessionKey, runId: "run-1" }],
      "tasks.list": [{ tasks: [sampleTask] }],
    });

    await startSampleCard(client, {
      engine: "codex",
    });

    expect(client.request).toHaveBeenNthCalledWith(
      1,
      "workboard.cards.update",
      expect.objectContaining({
        patch: { status: "running" },
      }),
    );
    expect(client.request).toHaveBeenNthCalledWith(
      2,
      "agent",
      expect.objectContaining({
        sessionKey: sampleTaskSessionKey,
        model: "openai/gpt-5.6-sol",
        message: expect.stringContaining("Work on this OpenClaw Workboard card: Build board"),
      }),
    );
    expect(client.request).toHaveBeenNthCalledWith(3, "tasks.list", { limit: 500 });
    expect(client.request).toHaveBeenNthCalledWith(
      4,
      "workboard.cards.update",
      expect.objectContaining({
        id: "card-1",
        patch: expect.objectContaining({
          status: "running",
          execution: expect.objectContaining({
            id: "card-1:agent-session",
            engine: "codex",
            mode: "autonomous",
            model: "openai/gpt-5.6-sol",
            runId: "run-1",
          }),
        }),
      }),
    );
  });

  it("resets execution start time when retrying a card run", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1234);
    try {
      const previous = makeCard({
        execution: {
          id: "card-1:codex",
          kind: "agent-session",
          engine: "codex",
          mode: "autonomous",
          status: "blocked",
          model: "openai/gpt-5.5",
          sessionKey: "agent:main:dashboard:1",
          runId: "run-1",
          startedAt: 10,
          updatedAt: 20,
        },
      });
      const client = createClient({
        agent: { sessionKey: "agent:main:dashboard:1", runId: "run-2" },
        "tasks.list": {
          tasks: [
            makeTask({
              taskId: "task-2",
              id: "task-2",
              childSessionKey: "agent:main:dashboard:1",
              runId: "run-2",
            }),
          ],
        },
        "workboard.cards.update": { card: previous },
      });

      await startCard(client, {
        card: previous,
        engine: "codex",
      });

      expect(client.request).toHaveBeenNthCalledWith(
        4,
        "workboard.cards.update",
        expect.objectContaining({
          patch: expect.objectContaining({
            execution: expect.objectContaining({
              runId: "run-2",
              startedAt: 1234,
            }),
          }),
        }),
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("starts a manual Claude execution without sending the card prompt", async () => {
    const running = createWorkboardCard({
      sessionKey: "agent:main:dashboard:1",
      execution: createWorkboardExecution({
        id: "card-1:claude",
        engine: "claude",
        mode: "manual",
        status: "idle",
        model: "anthropic/claude-sonnet-4-6",
        startedAt: 10,
        updatedAt: 10,
      }),
    });
    const client = createClient({
      "sessions.create": { key: "agent:main:dashboard:1", runStarted: false },
      "workboard.cards.update": { card: running },
    });

    const sessionKey = await startSampleCard(client, {
      engine: "claude",
      mode: "manual",
    });

    expect(sessionKey).toBe("agent:main:dashboard:1");
    expect(client.request).toHaveBeenNthCalledWith(
      1,
      "sessions.create",
      expect.objectContaining({
        model: "anthropic/claude-sonnet-4-6",
      }),
    );
    expect(client.request.mock.calls[0]?.[1]).not.toHaveProperty("message");
    expect(client.request.mock.calls[0]?.[1]).not.toHaveProperty("task");
    expect(client.request).toHaveBeenNthCalledWith(
      2,
      "workboard.cards.update",
      expect.objectContaining({
        id: "card-1",
        patch: expect.objectContaining({
          status: "todo",
          execution: expect.objectContaining({
            engine: "claude",
            mode: "manual",
            status: "idle",
            model: "anthropic/claude-sonnet-4-6",
          }),
        }),
      }),
    );
  });

  it("clears stale task linkage when opening a manual execution", async () => {
    const staleLinkedCard = createWorkboardCard({
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
      taskId: "task-1",
      execution: createWorkboardExecution({
        id: "card-1:codex",
        status: "blocked",
        sessionKey: sampleTaskSessionKey,
        runId: "run-1",
        startedAt: 10,
        updatedAt: 20,
      }),
    });
    const reopened = createWorkboardCard({
      sessionKey: "agent:main:dashboard:new",
      execution: createWorkboardExecution({
        id: "card-1:claude",
        engine: "claude",
        mode: "manual",
        status: "idle",
        model: "anthropic/claude-sonnet-4-6",
        sessionKey: "agent:main:dashboard:new",
        startedAt: 10,
        updatedAt: 10,
      }),
    });
    const client = createClient({
      "sessions.create": { key: "agent:main:dashboard:new", runStarted: false },
      "workboard.cards.update": { card: reopened },
    });
    getWorkboardState(host).tasksByCardId.set("card-1", sampleTask);

    await startCard(client, {
      card: staleLinkedCard,
      engine: "claude",
      mode: "manual",
    });

    expect(client.request).toHaveBeenNthCalledWith(
      2,
      "workboard.cards.update",
      expect.objectContaining({
        id: "card-1",
        patch: expect.objectContaining({
          sessionKey: "agent:main:dashboard:new",
          runId: null,
          taskId: null,
        }),
      }),
    );
    expect(getWorkboardState(host).tasksByCardId.has("card-1")).toBe(false);
  });

  it("rolls back when the Gateway does not return a task run id", async () => {
    const client = createSequencedClient({
      agent: [
        {
          sessionKey: sampleTaskSessionKey,
          runStarted: false,
          runError: { message: "provider unavailable" },
        },
      ],
      "workboard.cards.update": [{ card: makeCard({ status: "running" }) }, { card: sampleCard }],
    });

    const sessionKey = await startSampleCard(client);

    expect(sessionKey).toBeNull();
    expect(client.request).toHaveBeenNthCalledWith(2, "agent", expect.any(Object));
    expect(client.request).toHaveBeenNthCalledWith(
      3,
      "workboard.cards.update",
      expect.objectContaining({ patch: expect.objectContaining({ status: "todo" }) }),
    );
    expect(getWorkboardState(host).error).toBe("Gateway agent method returned an invalid runId.");
  });

  it("moves cards through the plugin gateway method", async () => {
    const moved = makeCard({ status: "blocked", position: 2000 });
    const client = createClient({ "workboard.cards.move": { card: moved } });

    await moveCard(client, {
      cardId: "card-1",
      status: "blocked",
      position: 2000,
    });

    expect(getWorkboardState(host).cards[0]).toMatchObject({
      status: "blocked",
      position: 2000,
    });
  });

  it("keeps dragged status changes from being rewritten by stale lifecycle sync", async () => {
    const linked = createWorkboardCard({
      sessionKey: sampleSession.key,
      execution: createWorkboardExecution({ sessionKey: sampleSession.key }),
    });
    const moved = makeMovedCard(linked, { position: 2000 });
    setLoadedCard(linked);
    const client = createClient((method) => {
      if (method === "workboard.cards.move") {
        return { card: moved };
      }
      if (method === "workboard.cards.update") {
        return { card: { ...moved, status: "review", updatedAt: 3 } };
      }
      return {};
    });

    await moveCard(client, {
      cardId: "card-1",
      status: "running",
      position: 2000,
    });
    await syncLifecycle(client, [
      makeSession({ hasActiveRun: false, status: "done", updatedAt: 1 }),
    ]);

    expect(client.request).toHaveBeenCalledTimes(3);
    expect(client.request).toHaveBeenCalledWith("workboard.cards.move", {
      id: "card-1",
      status: "running",
      position: 2000,
    });
    expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    expect(client.request.mock.calls[2]?.[1]).toMatchObject({
      id: "card-1",
      patch: { execution: expect.objectContaining({ status: "review" }) },
    });
    expect(requestPatch(client, 2)).not.toHaveProperty("status");
    expect(state.cards[0]).toMatchObject({ status: "running", position: 2000 });
  });

  it("does not start lifecycle writes while dragged status changes are in flight", async () => {
    const linked = createWorkboardCard({
      sessionKey: sampleSession.key,
      execution: createWorkboardExecution({ sessionKey: sampleSession.key }),
    });
    const moved = makeMovedCard(linked, { position: 2000 });
    setLoadedCard(linked);
    const moveResponse = createDeferred<{ card: WorkboardCard }>();
    const client = createClient((method) => {
      if (method === "workboard.cards.move") {
        return moveResponse.promise;
      }
      return {};
    });

    const moving = moveCard(client, {
      cardId: "card-1",
      status: "running",
      position: 2000,
    });
    await Promise.resolve();
    await syncLifecycle(client, [
      makeSession({ hasActiveRun: false, status: "done", updatedAt: 1 }),
    ]);

    expect(client.request).toHaveBeenCalledOnce();
    moveResponse.resolve({ card: moved });
    await moving;
    expect(state.cards[0]).toMatchObject({ status: "running", position: 2000 });
  });

  it("ignores stale lifecycle responses when dragged status changes while sync is in flight", async () => {
    const linked = makeCard({ sessionKey: sampleSession.key });
    const moved = makeMovedCard(linked, { position: 2000 });
    const staleLifecycleCard = {
      ...linked,
      status: "review",
      updatedAt: 3,
      metadata: { lifecycleStatusSourceUpdatedAt: 1 },
    } satisfies WorkboardCard;
    setLoadedCard(linked);
    const lifecycleResponse = createDeferred<{ card: WorkboardCard }>();
    const client = createClient((method) => {
      if (method === "workboard.cards.update") {
        return lifecycleResponse.promise;
      }
      if (method === "workboard.cards.move") {
        return { card: moved };
      }
      return {};
    });

    const syncing = syncLifecycle(client, [
      makeSession({ hasActiveRun: false, status: "done", updatedAt: 1 }),
    ]);
    await Promise.resolve();
    await moveCard(client, {
      cardId: "card-1",
      status: "running",
      position: 2000,
    });
    lifecycleResponse.resolve({ card: staleLifecycleCard });
    await syncing;

    expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: "card-1",
      patch: expect.objectContaining({
        status: "review",
        metadata: { lifecycleStatusSourceUpdatedAt: 1 },
      }),
    });
    expect(client.request).toHaveBeenCalledWith("workboard.cards.move", {
      id: "card-1",
      status: "running",
      position: 2000,
    });
    expect(state.cards[0]).toMatchObject({ status: "running", position: 2000 });
  });

  it("ignores lifecycle responses after a newer comment write", async () => {
    const linked = makeCard({ sessionKey: sampleSession.key });
    const commented = makeCommentedCard(linked, "Keep this", { updatedAt: 2 });
    const lifecycleResponse = createDeferred<{ card: WorkboardCard }>();
    setLoadedCard(linked);
    const client = createClient((method) => {
      if (method === "workboard.cards.update") {
        return lifecycleResponse.promise;
      }
      if (method === "workboard.cards.comment") {
        return { card: commented };
      }
      return {};
    });

    const syncing = syncLifecycle(client, [
      makeSession({ hasActiveRun: false, status: "done", updatedAt: 1 }),
    ]);
    await Promise.resolve();
    await commentCard(client, {
      cardId: linked.id,
      body: "Keep this",
    });
    lifecycleResponse.resolve({ card: { ...linked, status: "review", updatedAt: 3 } });
    await syncing;

    expect(state.cards[0]?.metadata?.comments?.[0]?.body).toBe("Keep this");
  });

  it("ignores lifecycle responses without provenance when dragged status changes while sync is in flight", async () => {
    const linked = createWorkboardCard({
      sessionKey: sampleSession.key,
      execution: createWorkboardExecution({ sessionKey: sampleSession.key }),
    });
    const moved = makeMovedCard(linked, { position: 2000 });
    const staleLifecycleCard = {
      ...linked,
      status: "review",
      updatedAt: 3,
      execution: createWorkboardExecution({
        ...linked.execution,
        status: "review",
        updatedAt: 3,
      }),
    } satisfies WorkboardCard;
    setLoadedCard(linked);
    const lifecycleResponse = createDeferred<{ card: WorkboardCard }>();
    const client = createClient((method) => {
      if (method === "workboard.cards.update") {
        return lifecycleResponse.promise;
      }
      if (method === "workboard.cards.move") {
        return { card: moved };
      }
      return {};
    });

    const syncing = syncLifecycle(client, [
      makeSession({ hasActiveRun: false, status: "done", updatedAt: null }),
    ]);
    await Promise.resolve();
    await moveCard(client, {
      cardId: "card-1",
      status: "running",
      position: 2000,
    });
    lifecycleResponse.resolve({ card: staleLifecycleCard });
    await syncing;

    expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: "card-1",
      patch: { execution: expect.objectContaining({ status: "review" }) },
    });
    expect(client.request).toHaveBeenCalledWith("workboard.cards.move", {
      id: "card-1",
      status: "running",
      position: 2000,
    });
    expect(state.cards[0]).toMatchObject({ status: "running", position: 2000 });
  });

  it("keeps non-status edits following newer linked session lifecycle sync", async () => {
    const edited = createSessionCard({
      title: "Renamed only",
      status: "running",
      updatedAt: 5,
      events: [
        {
          id: "move-1",
          kind: "moved",
          at: 2,
          fromStatus: "todo",
          toStatus: "running",
        },
        { id: "edit-1", kind: "edited", at: 5 },
      ],
    });
    setLoadedCard(edited);
    const client = createClient({
      "workboard.cards.update": {
        card: { ...edited, status: "review", updatedAt: 6 },
      },
    });

    await syncLifecycle(client, [
      makeSession({ hasActiveRun: false, status: "done", updatedAt: 3 }),
    ]);

    expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: "card-1",
      patch: expect.objectContaining({ status: "review" }),
    });
    expect(state.cards[0]).toMatchObject({ title: "Renamed only", status: "review" });
  });

  it("keeps lifecycle-created moves following newer linked session lifecycle sync", async () => {
    const lifecycleMoved = createSessionCard({
      status: "running",
      updatedAt: 5,
      metadata: { lifecycleStatusSourceUpdatedAt: 1 },
      events: [
        {
          id: "move-1",
          kind: "moved",
          at: 5,
          fromStatus: "todo",
          toStatus: "running",
        },
      ],
    });
    setLoadedCard(lifecycleMoved);
    const client = createClient({
      "workboard.cards.update": {
        card: {
          ...lifecycleMoved,
          status: "review",
          updatedAt: 6,
          metadata: { lifecycleStatusSourceUpdatedAt: 3 },
        },
      },
    });

    await syncLifecycle(client, [
      makeSession({ hasActiveRun: false, status: "done", updatedAt: 3 }),
    ]);

    expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: "card-1",
      patch: expect.objectContaining({
        status: "review",
        metadata: { lifecycleStatusSourceUpdatedAt: 3 },
      }),
    });
    expect(state.cards[0]).toMatchObject({
      status: "review",
      metadata: { lifecycleStatusSourceUpdatedAt: 3 },
    });
  });

  it("removes stale dependency links from local cards after delete", async () => {
    const parent = makeCard({
      id: "parent-1",
      title: "Parent",
      status: "done",
    });
    const child = makeCard({
      id: "child-1",
      title: "Child",
      metadata: {
        links: [{ id: "link-1", type: "parent", targetCardId: parent.id, createdAt: 1 }],
      },
    });
    const client = createClient((method) => {
      if (method === "workboard.cards.delete") {
        return { deleted: true };
      }
      if (method === "sessions.create") {
        return { key: "agent:main:dashboard:child", runId: "run-child" };
      }
      return { card: { ...child, status: "running", metadata: undefined } };
    });
    getWorkboardState(host).cards = [parent, child];

    await deleteCard(client, parent.id);

    const remaining = expectDefined(getWorkboardState(host).cards[0], "remaining child card");
    expect(remaining).toMatchObject({ id: child.id });
    expect(remaining.metadata?.links).toBeUndefined();

    client.request.mockClear();
    await startCard(client, {
      card: remaining,
    });

    expect(client.request).toHaveBeenNthCalledWith(
      1,
      "workboard.cards.update",
      expect.objectContaining({
        id: child.id,
        patch: { status: "running" },
      }),
    );
  });

  it("derives lifecycle state from linked dashboard sessions", () => {
    const linked = createWorkboardCard({ sessionKey: sampleSession.key });
    const staleAt = Date.now() - 31 * 60 * 1000;
    const cases: ReadonlyArray<
      readonly [string, WorkboardCard, GatewaySessionRow, Record<string, unknown>]
    > = [
      ["unlinked", sampleCard, sampleSession, { session: null, state: "unlinked" }],
      ["active", linked, sampleSession, { state: "running", targetStatus: "running" }],
      [
        "running without an active run",
        linked,
        createGatewaySession({ hasActiveRun: false }),
        { state: "running", targetStatus: "running" },
      ],
      [
        "completed",
        linked,
        createGatewaySession({ hasActiveRun: false, status: "done" }),
        { state: "succeeded", targetStatus: "review" },
      ],
      [
        "failed",
        linked,
        createGatewaySession({ hasActiveRun: false, status: "failed" }),
        { state: "failed", targetStatus: "blocked" },
      ],
      [
        "stale inactive",
        linked,
        createGatewaySession({ hasActiveRun: false, updatedAt: staleAt }),
        { state: "stale", targetStatus: "running" },
      ],
      ...([true, undefined] as const).map(
        (hasActiveRun) =>
          [
            `stale timestamp with hasActiveRun=${String(hasActiveRun)}`,
            linked,
            createGatewaySession({ hasActiveRun, updatedAt: staleAt }),
            { state: "running", targetStatus: "running" },
          ] as const,
      ),
      [
        "execution link",
        createWorkboardCard({
          execution: createWorkboardExecution({ sessionKey: sampleSession.key }),
        }),
        sampleSession,
        { state: "running", targetStatus: "running" },
      ],
    ];

    for (const [name, card, session, expected] of cases) {
      expect(getWorkboardLifecycle(card, [session]), name).toMatchObject(expected);
    }
  });

  it("derives lifecycle state from linked Gateway tasks", () => {
    const card = createWorkboardCard({ sessionKey: sampleTaskSessionKey, runId: "run-1" });
    const completedSession = createGatewaySession({
      key: sampleTaskSessionKey,
      hasActiveRun: false,
      status: "done",
    });
    const cases = [
      ["running", sampleTask, [], { state: "running", targetStatus: "running" }],
      [
        "completed",
        createWorkboardTask({ status: "completed" }),
        [],
        { state: "succeeded", targetStatus: "review" },
      ],
      [
        "timed out",
        createWorkboardTask({ status: "timed_out" }),
        [],
        { state: "failed", targetStatus: "blocked" },
      ],
      [
        "completed session",
        sampleTask,
        [completedSession],
        { state: "succeeded", targetStatus: "review" },
      ],
    ] as const;

    for (const [name, task, sessions, expected] of cases) {
      expect(getWorkboardLifecycle(card, [...sessions], task), name).toMatchObject(expected);
    }
  });

  it("syncs linked card status from session lifecycle without overriding manual review", async () => {
    state.loaded = true;
    state.cards = [
      makeCard({ sessionKey: sampleSession.key }),
      makeCard({ id: "card-review", status: "review", sessionKey: "session-review" }),
    ];
    const client = createClient((method) => {
      if (method === "workboard.cards.update") {
        return { card: makeCard({ status: "running", sessionKey: sampleSession.key }) };
      }
      return {};
    });

    await syncLifecycle(client, [
      sampleSession,
      makeSession({ key: "session-review", status: "failed", hasActiveRun: false }),
    ]);

    expect(client.request).toHaveBeenCalledOnce();
    expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: "card-1",
      patch: expect.objectContaining({
        status: "running",
        metadata: expect.objectContaining({
          lifecycleStatusSourceUpdatedAt: sampleSession.updatedAt,
        }),
      }),
    });
    expect(state.cards.find((card) => card.id === "card-review")?.status).toBe("review");
  });

  it("does not sync stale linked-session status over a card creation status", async () => {
    state.loaded = true;
    state.cards = [
      createSessionCard({
        status: "running",
        createdAt: 2000,
        updatedAt: 2000,
        events: [{ id: "event-created", kind: "created", at: 2000, toStatus: "running" }],
      }),
    ];
    const client = createClient({
      "workboard.cards.update": {
        card: makeCard({ status: "review", sessionKey: sampleSession.key }),
      },
    });

    await syncLifecycle(client, [
      makeSession({
        status: "done",
        hasActiveRun: false,
        updatedAt: 1000,
      }),
    ]);

    expect(client.request).toHaveBeenCalledOnce();
    expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    expect(state.cards[0]?.status).toBe("running");
  });

  it("does not sync linked card status from sessions without lifecycle provenance", async () => {
    state.loaded = true;
    state.cards = [makeCard({ sessionKey: sampleSession.key })];
    const client = createClient({
      "workboard.cards.update": {
        card: makeCard({ status: "review", sessionKey: sampleSession.key }),
      },
    });

    await syncLifecycle(client, [
      makeSession({
        status: "done",
        hasActiveRun: false,
        updatedAt: null,
      }),
    ]);

    expect(client.request).not.toHaveBeenCalled();
    expect(state.cards[0]).toMatchObject({ status: "todo" });
  });

  it("refreshes task lifecycle before syncing task-backed cards", async () => {
    const { card: linked } = createLifecycleHarness(host);
    const client = createClient({
      "tasks.list": { tasks: [makeTask({ status: "completed" })] },
      "workboard.cards.update": {
        card: { ...linked, status: "review" },
      },
    });

    await syncLifecycle(client);

    expect(client.request).toHaveBeenNthCalledWith(1, "tasks.list", { limit: 500 });
    expect(client.request).toHaveBeenNthCalledWith(2, "workboard.cards.update", {
      id: "card-1",
      patch: expect.objectContaining({
        status: "review",
        metadata: expect.objectContaining({
          lifecycleStatusSourceUpdatedAt: sampleTask.updatedAt,
        }),
      }),
    });
    expect(state.tasksByCardId.get("card-1")).toMatchObject({ status: "completed" });
  });

  it("cancels in-flight lifecycle reconciliation when refresh stops", async () => {
    const { card: linked } = createLifecycleHarness(host);
    const taskList = createDeferred<unknown>();
    const client = createClient((method) => {
      if (method === "tasks.list") {
        return taskList.promise;
      }
      if (method === "workboard.cards.update") {
        return { card: { ...linked, status: "review" } };
      }
      return {};
    });

    const sync = syncLifecycle(client);
    await waitForFast(() => {
      expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    });
    stopWorkboardLifecycleRefresh(host);
    taskList.resolve({ tasks: [makeTask({ status: "completed" })] });
    await sync;

    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    expect(state.cards[0]?.status).toBe("running");
  });

  it("cancels remaining lifecycle card writes when refresh stops", async () => {
    const first = makeCard({ id: "card-1", sessionKey: "session-1" });
    const second = makeCard({ id: "card-2", sessionKey: "session-2" });
    const firstUpdate = createDeferred<{ card: WorkboardCard }>();
    state.loaded = true;
    state.cards = [first, second];
    state.lifecycleTasksPrepared = true;
    state.lifecycleTasksPreparedAt = Date.now();
    const client = createClient((method, params) => {
      if (method === "workboard.cards.update") {
        return (params as { id: string }).id === first.id
          ? firstUpdate.promise
          : { card: { ...second, status: "running" } };
      }
      if (method === "workboard.cards.list") {
        return { cards: [first, second], statuses: ["todo", "running"] };
      }
      return {};
    });
    const sessions = [makeSession({ key: "session-1" }), makeSession({ key: "session-2" })];

    const syncing = syncWorkboardLifecycle({ host, client: client as never, sessions });
    await waitForFast(() => {
      expect(client.request).toHaveBeenCalledWith(
        "workboard.cards.update",
        expect.objectContaining({ id: first.id }),
      );
    });
    stopWorkboardLifecycleRefresh(host);
    expect(state.syncingCardIds).toEqual(new Set([first.id]));
    await expect(loadWorkboard({ host, client: client as never })).resolves.toBe(false);
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.list", {});
    firstUpdate.resolve({ card: { ...first, status: "running" } });
    await syncing;
    expect(state.syncingCardIds.size).toBe(0);
    await expect(loadWorkboard({ host, client: client as never })).resolves.toBe(true);
    expect(client.request).toHaveBeenCalledWith("workboard.cards.list", {});

    expect(requestCalls(client, "workboard.cards.update")).toHaveLength(1);
  });

  it("reuses an in-flight lifecycle task refresh across render-driven syncs", async () => {
    createLifecycleHarness(host);
    const taskList = createDeferred<unknown>();
    const client = createClient((method) => {
      if (method === "tasks.list") {
        return taskList.promise;
      }
      return {};
    });

    const first = syncLifecycle(client);
    await waitForFast(() => {
      expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    });
    const second = syncLifecycle(client);
    await Promise.resolve();

    expect(requestCalls(client, "tasks.list")).toHaveLength(1);

    taskList.resolve({ tasks: [sampleTask] });
    await Promise.all([first, second]);

    expect(requestCalls(client, "tasks.list")).toHaveLength(1);
    expect(state.lifecycleTasksPrepared).toBe(true);
  });

  it("requests a fresh lifecycle sync after a shared task refresh is invalidated by a write", async () => {
    const { card: linked } = createLifecycleHarness(host);
    const commented = makeCommentedCard(linked, "Keep this", { updatedAt: 2 });
    const completedTask = makeTask({ status: "completed", updatedAt: 3 });
    const firstTaskList = createDeferred<unknown>();
    const client = createSequencedClient({
      "tasks.list": [firstTaskList.promise, { tasks: [completedTask] }],
      "workboard.cards.comment": [{ card: commented }],
      "workboard.cards.update": [{ card: { ...commented, status: "review", updatedAt: 4 } }],
    });
    const requestUpdate = vi.fn();

    const first = syncLifecycle(client, [], { requestUpdate });
    await waitForFast(() => {
      expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    });
    await commentCard(client, {
      cardId: linked.id,
      body: "Keep this",
      requestUpdate,
    });
    vi.clearAllMocks();

    const second = syncLifecycle(client, [], { requestUpdate });
    firstTaskList.resolve({ tasks: [sampleTask] });
    await Promise.all([first, second]);

    expect(requestUpdate).toHaveBeenCalledOnce();
    vi.clearAllMocks();

    await syncLifecycle(client, [], { requestUpdate });

    expect(client.request).toHaveBeenNthCalledWith(1, "tasks.list", { limit: 500 });
    expect(client.request).toHaveBeenNthCalledWith(2, "workboard.cards.update", {
      id: linked.id,
      patch: expect.objectContaining({ status: "review" }),
    });
    expect(state.cards[0]?.status).toBe("review");
  });

  it("authoritatively refreshes running linked cards without task ids before lifecycle sync", async () => {
    state.loaded = true;
    state.cards = [
      makeCard({
        status: "running",
        sessionKey: sampleTaskSessionKey,
        runId: "run-1",
      }),
    ];
    const client = createClient({
      "tasks.list": { tasks: [] },
    });

    await syncLifecycle(client);

    expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    expect(state.lifecycleTasksPrepared).toBe(true);
  });

  it("reconciles session-only cards when task discovery is unavailable", async () => {
    const linked = createSessionCard({
      status: "running",
      runId: "run-1",
    });
    setLoadedCard(linked);
    const client = createClient((method) => {
      if (method === "tasks.list") {
        throw new Error("tasks unavailable");
      }
      if (method === "workboard.cards.update") {
        return { card: { ...linked, status: "review" } };
      }
      return {};
    });

    await syncLifecycle(client, [makeSession({ status: "done", hasActiveRun: false })]);

    expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: linked.id,
      patch: expect.objectContaining({ status: "review" }),
    });
    expect(state.cards[0]?.status).toBe("review");
  });

  it("honors task refresh backoff while reconciling session-only cards", async () => {
    const linked = createSessionCard({
      status: "running",
      runId: "run-1",
    });
    setLoadedCard(linked);
    state.lifecycleTaskRefreshFailed = true;
    state.lifecycleTaskRefreshRetryAt = Date.now() + 5000;
    state.lifecycleTaskRefreshError = "tasks unavailable";
    const client = createClient((method) => {
      if (method === "tasks.list") {
        throw new Error("task refresh retried during backoff");
      }
      if (method === "workboard.cards.update") {
        return { card: { ...linked, status: "review" } };
      }
      return {};
    });

    await syncLifecycle(client, [makeSession({ status: "done", hasActiveRun: false })]);

    expect(client.request).not.toHaveBeenCalledWith("tasks.list", expect.anything());
    expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: linked.id,
      patch: expect.objectContaining({ status: "review" }),
    });
    expect(state.cards[0]?.status).toBe("review");
  });

  it("exact-confirms task list omissions before lifecycle writes", async () => {
    const { card: linked } = createLifecycleHarness(host);
    const client = createClient({
      "tasks.list": { tasks: [] },
      "tasks.get": { task: sampleTask },
    });

    await syncLifecycle(client);

    expect(client.request).toHaveBeenNthCalledWith(1, "tasks.list", { limit: 500 });
    expect(client.request).toHaveBeenNthCalledWith(2, "tasks.get", {
      taskId: sampleTask.taskId,
    });
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    expect(state.tasksByCardId.get(linked.id)).toEqual(sampleTask);
    expect(state.lifecycleTasksPrepared).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["mismatched", "run-new"],
  ])("accepts exact-confirmed task ids with %s run metadata", async (_label, taskRunId) => {
    vi.useFakeTimers();
    const { card: linked } = createLifecycleHarness(host, {
      card: { runId: "run-stale" },
      task: null,
    });
    const confirmedTask = makeTask({ runId: taskRunId });
    const client = createClient({
      "tasks.list": { tasks: [] },
      "tasks.get": { task: confirmedTask },
    });
    const requestUpdate = vi.fn();

    await syncLifecycle(client, [], { requestUpdate });

    expect(state.tasksByCardId.get(linked.id)).toEqual(confirmedTask);
    expect(state.lifecycleTasksPrepared).toBe(true);
    vi.clearAllMocks();
    await vi.advanceTimersByTimeAsync(100);
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("rotates bounded exact confirmations before lifecycle writes", async () => {
    vi.useFakeTimers();
    const cards = createConfirmationCards(65);
    state.loaded = true;
    state.cards = cards;
    const client = createConfirmationClient();
    const requestUpdate = vi.fn();

    await syncLifecycle(client, [], { requestUpdate });

    expect(requestCalls(client, "tasks.get")).toHaveLength(32);
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    expect(state.lifecycleTasksPrepared).toBe(false);

    vi.clearAllMocks();
    await vi.advanceTimersByTimeAsync(100);
    expect(requestUpdate).toHaveBeenCalledOnce();
    vi.clearAllMocks();
    await syncLifecycle(client, [], { requestUpdate });

    expect(requestCalls(client, "tasks.get")).toHaveLength(32);
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    expect(state.lifecycleTasksPrepared).toBe(false);

    vi.clearAllMocks();
    await vi.advanceTimersByTimeAsync(100);
    await syncLifecycle(client, [], { requestUpdate });

    expect(requestCalls(client, "tasks.get")).toHaveLength(1);
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    expect(state.lifecycleTasksPrepared).toBe(true);
  });

  it("fails closed when bounded confirmations exceed their freshness window", async () => {
    vi.useFakeTimers();
    const cards = createConfirmationCards(33);
    state.loaded = true;
    state.cards = cards;
    const client = createConfirmationClient();
    const requestUpdate = vi.fn();

    await syncLifecycle(client, [], { requestUpdate });

    expect(requestCalls(client, "tasks.get")).toHaveLength(32);
    expect(state.lifecycleTaskRefreshContinueAt).not.toBeNull();

    vi.clearAllMocks();
    await vi.advanceTimersByTimeAsync(5001);
    await syncLifecycle(client, [], { requestUpdate });

    expect(client.request).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    expect(state.lifecycleTasksPrepared).toBe(false);
    expect(state.lifecycleTaskRefreshFailed).toBe(true);
    expect(state.lifecycleTaskRefreshContinueAt).toBeNull();
    expect(state.lifecycleTaskRefreshError).not.toBeNull();

    vi.clearAllMocks();
    await vi.advanceTimersByTimeAsync(5000);
    expect(requestUpdate).toHaveBeenCalledOnce();
  });

  it("stops bounded exact confirmations after a transient batch failure", async () => {
    const cards = createConfirmationCards(33);
    state.loaded = true;
    state.cards = cards;
    const client = createConfirmationClient("task-0");

    await syncLifecycle(client);

    expect(requestCalls(client, "tasks.get")).toHaveLength(32);
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    expect(state.lifecycleTaskRefreshFailed).toBe(true);
    expect(state.lifecycleTasksPrepared).toBe(false);
  });

  it.each([
    { name: "exact confirmation succeeds", failure: null, status: "running" },
    { name: "task listing fails", failure: "tasks unavailable", status: "ready" },
    {
      name: "exact confirmation fails",
      failure: "task confirmation unavailable",
      status: "ready",
    },
  ] as const)("preserves a tracked replacement when $name", async ({ failure, status }) => {
    const missingTaskId = "task-pruned-from-ledger";
    const replacementTask = createWorkboardTask({
      id: "task-replacement",
      taskId: "task-replacement",
    });
    const linked = createWorkboardCard({
      status,
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
      taskId: missingTaskId,
    });
    setLoadedCard(linked, replacementTask);
    state.missingTaskIds = new Set([missingTaskId]);
    const client = createClient((method) => {
      if (failure === "tasks unavailable") {
        throw new Error(failure);
      }
      if (method === "tasks.list") {
        return { tasks: [] };
      }
      if (failure) {
        throw new Error(failure);
      }
      return { task: replacementTask };
    });

    await syncLifecycle(client);

    expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    if (failure !== "tasks unavailable") {
      expect(client.request).toHaveBeenCalledWith("tasks.get", { taskId: replacementTask.taskId });
    }
    expect(client.request).not.toHaveBeenCalledWith("tasks.get", { taskId: missingTaskId });
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    expect(state.tasksByCardId.get(linked.id)).toEqual(replacementTask);
    expect(state.missingTaskIds).toEqual(new Set([missingTaskId]));
    expect(state.lifecycleTaskRefreshError).toBe(failure);
  });

  it("defers lifecycle writes when exact confirmation after task listing fails", async () => {
    const linked = createLinkedCard();
    setLoadedCard(linked, sampleTask);
    const client = createClient((method) => {
      if (method === "tasks.list") {
        return { tasks: [] };
      }
      if (method === "tasks.get") {
        throw new Error("task confirmation unavailable");
      }
      return {};
    });

    await syncLifecycle(client);

    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    expect(state.lifecycleTaskRefreshFailed).toBe(true);
    expect(state.error).toBeNull();
    expect(state.lifecycleTaskRefreshError).toBe("task confirmation unavailable");
  });

  it("requests a render after lifecycle refresh marks a task missing", async () => {
    const linked = makeCard({
      status: "ready",
      taskId: sampleTask.taskId,
    });
    setLoadedCard(linked);
    const client = createClient((method) => {
      if (method === "tasks.list") {
        return { tasks: [] };
      }
      if (method === "tasks.get") {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: `task not found: ${sampleTask.taskId}`,
        });
      }
      return {};
    });
    const requestUpdate = vi.fn();

    await syncLifecycle(client, [], { requestUpdate });

    expect(state.missingTaskIds).toEqual(new Set([sampleTask.taskId]));
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    expect(requestUpdate).toHaveBeenCalledOnce();
  });

  it("keeps prepared task lifecycle state after no-op syncs", async () => {
    vi.useFakeTimers();
    createLifecycleHarness(host, { prepared: true });
    const client = createClient({
      "tasks.list": { tasks: [sampleTask] },
    });

    await syncLifecycle(client);
    await syncLifecycle(client);

    expect(client.request).not.toHaveBeenCalled();
    expect(state.lifecycleTasksPrepared).toBe(true);
  });

  it("refreshes prepared task lifecycle state after its freshness window", async () => {
    vi.useFakeTimers();
    const { card: linked } = createLifecycleHarness(host, { prepared: true });
    const completedTask = makeTask({ status: "completed" });
    const client = createClient({
      "tasks.list": { tasks: [completedTask] },
      "workboard.cards.update": { card: { ...linked, status: "review" } },
    });
    const requestUpdate = vi.fn();

    await syncLifecycle(client, [], { requestUpdate });
    expect(client.request).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    expect(requestUpdate).toHaveBeenCalledOnce();
    vi.clearAllMocks();
    await syncLifecycle(client, [], { requestUpdate });

    expect(client.request).toHaveBeenNthCalledWith(1, "tasks.list", { limit: 500 });
    expect(client.request).toHaveBeenNthCalledWith(2, "workboard.cards.update", expect.anything());
  });

  it("retries a failed lifecycle task refresh after backoff", async () => {
    vi.useFakeTimers();
    createLifecycleHarness(host);
    const requestUpdate = vi.fn();
    let tasksAvailable = false;
    const client = createClient((method) => {
      if (method === "tasks.list") {
        if (!tasksAvailable) {
          throw new Error("tasks unavailable");
        }
        return { tasks: [sampleTask] };
      }
      return {};
    });

    await syncLifecycle(client, [], { requestUpdate });
    expect(client.request).toHaveBeenCalledOnce();
    expect(requestUpdate).toHaveBeenCalledOnce();
    expect(state.lifecycleTaskRefreshError).toBe("tasks unavailable");
    state.lastRefreshError = "tasks unavailable";
    vi.clearAllMocks();

    await syncLifecycle(client, [], { requestUpdate });

    expect(client.request).not.toHaveBeenCalled();
    expect(requestUpdate).not.toHaveBeenCalled();

    tasksAvailable = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(requestUpdate).toHaveBeenCalledOnce();
    vi.clearAllMocks();
    state.error = "unrelated write error";
    state.lastRefreshError = "newer cards refresh failure";
    await syncLifecycle(client, [], { requestUpdate });

    expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    expect(state.lifecycleTaskRefreshFailed).toBe(false);
    expect(state.lifecycleTaskRefreshError).toBeNull();
    expect(state.lastRefreshError).toBe("newer cards refresh failure");
    expect(state.error).toBe("unrelated write error");
    expect(requestUpdate).toHaveBeenCalledOnce();
  });

  it("does not resume lifecycle writes when dispatch starts during task refresh", async () => {
    const { card: linked } = createLifecycleHarness(host);
    const taskList = createDeferred<unknown>();
    const client = createClient((method) => {
      if (method === "tasks.list") {
        return taskList.promise;
      }
      return { card: { ...linked, status: "review" } };
    });

    const syncing = syncLifecycle(client, []);
    await Promise.resolve();
    state.dispatching = true;
    taskList.resolve({ tasks: [makeTask({ status: "completed" })] });
    await syncing;

    expect(client.request).toHaveBeenCalledOnce();
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
  });

  it("does not apply lifecycle task refresh after a newer card write", async () => {
    const { card: linked } = createLifecycleHarness(host);
    const commented = makeCommentedCard(linked, "Keep this", { updatedAt: 2 });
    const taskList = createDeferred<unknown>();
    const client = createClient((method) => {
      if (method === "tasks.list") {
        return taskList.promise;
      }
      if (method === "workboard.cards.comment") {
        return { card: commented };
      }
      return {};
    });

    const syncing = syncLifecycle(client, []);
    await Promise.resolve();
    await commentCard(client, {
      cardId: linked.id,
      body: "Keep this",
    });
    taskList.resolve({ tasks: [makeTask({ status: "completed" })] });
    await syncing;

    expect(state.cards[0]?.metadata?.comments?.[0]?.body).toBe("Keep this");
    expect(state.tasksByCardId.get("card-1")).toEqual(sampleTask);
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
  });

  it("moves stale running sessions into running while recording stale metadata", async () => {
    const staleUpdatedAt = Date.now() - 31 * 60 * 1000;
    const linked = createSessionCard({
      metadata: {
        comments: [{ id: "comment-1", body: "Keep me", createdAt: 1 }],
      },
    });
    setLoadedCard(linked);
    const client = createClient({
      "workboard.cards.update": {
        card: {
          ...linked,
          status: "running",
          metadata: {
            stale: {
              detectedAt: 1,
              lastSessionUpdatedAt: staleUpdatedAt,
              reason: "Linked session has not reported recent activity.",
            },
          },
        },
      },
    });

    await syncLifecycle(client, [makeSession({ updatedAt: staleUpdatedAt, hasActiveRun: false })]);

    expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: "card-1",
      patch: {
        status: "running",
        metadata: {
          lifecycleStatusSourceUpdatedAt: staleUpdatedAt,
          stale: expect.objectContaining({
            lastSessionUpdatedAt: staleUpdatedAt,
            reason: "Linked session has not reported recent activity.",
          }),
        },
      },
    });
  });

  it("syncs stale session metadata and clears it when the session recovers", async () => {
    const linked = createStaleSessionCard(1, {
      metadata: {
        comments: [{ id: "comment-1", body: "Keep me", createdAt: 1 }],
      },
    });
    setLoadedCard(linked);
    const client = createClient({
      "workboard.cards.update": {
        card: { ...linked, metadata: undefined, updatedAt: 3 },
      },
    });

    await syncLifecycle(client, [makeSession({ updatedAt: Date.now(), hasActiveRun: true })]);

    expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: "card-1",
      patch: {
        metadata: {
          stale: null,
        },
      },
    });
  });

  it("clears stale metadata after a newer manual status move", async () => {
    const linked = createStaleSessionCard(1, {
      events: [
        {
          id: "move-1",
          kind: "moved",
          at: 5,
          fromStatus: "todo",
          toStatus: "running",
        },
      ],
    });
    setLoadedCard(linked);
    const client = createClient({
      "workboard.cards.update": {
        card: { ...linked, metadata: undefined, updatedAt: 6 },
      },
    });

    await syncLifecycle(client, [
      makeSession({
        status: "running",
        updatedAt: 3,
        hasActiveRun: true,
      }),
    ]);

    expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: "card-1",
      patch: { metadata: { stale: null } },
    });
    expect(state.cards[0]?.metadata?.stale).toBeUndefined();
  });

  it("does not rewrite unchanged stale session metadata", async () => {
    const staleUpdatedAt = Date.now() - 31 * 60 * 1000;
    const linked = createStaleSessionCard(staleUpdatedAt);
    setLoadedCard(linked);
    const client = createClient({ "workboard.cards.update": { card: linked } });

    await syncLifecycle(client, [makeSession({ updatedAt: staleUpdatedAt, hasActiveRun: false })]);

    expect(client.request).toHaveBeenCalledOnce();
    expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
  });

  it("does not mark executions blocked when the linked session is missing from the current list", async () => {
    const linked = createWorkboardCard({
      status: "running",
      sessionKey: "agent:main:dashboard:missing",
      execution: createWorkboardExecution({ sessionKey: "agent:main:dashboard:missing" }),
    });
    setLoadedCard(linked);
    const client = createClient({ "workboard.cards.update": { card: linked } });

    await syncLifecycle(client);

    expect(client.request).toHaveBeenCalledOnce();
    expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
  });

  it("skips lifecycle writeback for read-only workboard clients", async () => {
    state.loaded = true;
    state.cards = [makeCard({ sessionKey: sampleSession.key })];
    const client = createClient(() => {
      throw new Error("write denied");
    });

    await syncLifecycle(client, [sampleSession], { canWrite: false });

    expect(client.request).not.toHaveBeenCalled();
    expect(state.error).toBeNull();
  });

  it("recovers task refresh failures for read-only workboard clients", async () => {
    const linked = createLinkedCard({ runId: sampleTask.runId });
    setLoadedCard(linked);
    state.lifecycleTaskRefreshFailed = true;
    state.lifecycleTaskRefreshError = "tasks unavailable";
    state.lastRefreshError = "tasks unavailable";
    const client = createClient({ "tasks.list": { tasks: [sampleTask] } });

    await syncLifecycle(client, [], { canWrite: false });

    expect(client.request).toHaveBeenCalledOnce();
    expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    expect(state.lifecycleTaskRefreshFailed).toBe(false);
    expect(state.lifecycleTaskRefreshError).toBeNull();
    expect(state.lastRefreshError).toBeNull();
    expect(state.lifecycleTasksPrepared).toBe(true);
  });

  it("resyncs cards manually moved back to an active lifecycle column", async () => {
    const linked = createSessionCard({
      status: "running",
      updatedAt: 1000,
    });
    const completedSession = makeSession({
      hasActiveRun: false,
      status: "done",
      updatedAt: 2000,
    });
    setLoadedCard(linked);
    const client = createClient({
      "workboard.cards.update": {
        card: { ...linked, status: "review", updatedAt: 3000 },
      },
    });

    await syncLifecycle(client, [completedSession]);
    state.cards = [{ ...linked, updatedAt: 4000 }];
    await syncLifecycle(client, [completedSession]);

    expect(client.request).toHaveBeenCalledTimes(3);
    expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
  });

  it("does not retry a failed lifecycle task refresh before backoff", async () => {
    const linked = createSessionCard({
      status: "running",
      updatedAt: 1000,
    });
    const completedSession = makeSession({
      hasActiveRun: false,
      status: "done",
      updatedAt: 2000,
    });
    setLoadedCard(linked);
    const client = createClient((method) => {
      if (method === "tasks.list") {
        throw new Error("tasks unavailable");
      }
      if (method === "workboard.cards.update") {
        return { card: { ...linked, status: "review", updatedAt: 3000 } };
      }
      return {};
    });

    await syncLifecycle(client, [completedSession]);
    await syncLifecycle(client, [completedSession]);

    expect(requestCalls(client, "tasks.list")).toHaveLength(1);
    expect(requestCalls(client, "workboard.cards.update")).toHaveLength(1);
    expect(state.error).toBeNull();
    expect(state.lifecycleTaskRefreshError).toBe("tasks unavailable");
    expect(state.cards[0]?.status).toBe("review");
  });

  it("stops linked sessions and marks cards blocked", async () => {
    const linked = makeCard({ sessionKey: sampleSession.key, runId: "run-1" });
    const blocked = { ...linked, status: "blocked" };
    const client = createClient({
      "chat.abort": { aborted: true, runIds: ["run-1"] },
      "workboard.cards.update": { card: blocked },
    });

    await stopCard(client, linked);

    expect(client.request).toHaveBeenNthCalledWith(1, "chat.abort", {
      sessionKey: sampleSession.key,
      runId: "run-1",
    });
    expect(client.request).toHaveBeenNthCalledWith(2, "workboard.cards.update", {
      id: "card-1",
      patch: { status: "blocked" },
    });
    expect(getWorkboardState(host).cards[0]).toMatchObject({ status: "blocked" });
  });

  it("cancels active linked tasks and aborts the running session", async () => {
    const linked = createLinkedCard({ status: sampleCard.status });
    const blocked = { ...linked, status: "blocked" };
    state.cards = [linked];
    state.tasksByCardId.set("card-1", sampleTask);
    const client = createClient({
      "tasks.cancel": { cancelled: true },
      "chat.abort": { aborted: true, runIds: ["run-1"] },
      "workboard.cards.update": { card: blocked },
    });

    await stopCard(client, linked);

    expect(client.request).toHaveBeenNthCalledWith(1, "tasks.cancel", {
      taskId: "task-1",
      reason: "Stopped from Workboard.",
    });
    expect(client.request).toHaveBeenNthCalledWith(2, "chat.abort", {
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    });
    expect(client.request).toHaveBeenNthCalledWith(3, "workboard.cards.update", {
      id: "card-1",
      patch: { status: "blocked" },
    });
    expect(getWorkboardState(host).cards[0]).toMatchObject({ status: "blocked" });
    expect(getWorkboardState(host).tasksByCardId.get("card-1")).toMatchObject({
      taskId: "task-1",
      status: "cancelled",
    });
  });

  it("marks a cancelled task blocked when follow-up session abort fails", async () => {
    const linked = createLinkedCard({ status: sampleCard.status });
    const blocked = { ...linked, status: "blocked" };
    state.cards = [linked];
    state.tasksByCardId.set("card-1", sampleTask);
    const client = createSequencedClient({
      "tasks.cancel": [{ cancelled: true }],
      "chat.abort": [new Error("run already removed")],
      "workboard.cards.update": [{ card: blocked }],
    });

    await stopCard(client, linked);

    expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: "card-1",
      patch: { status: "blocked" },
    });
    expect(state.cards[0]).toMatchObject({ status: "blocked" });
    expect(state.error).toBeNull();
  });

  it("cancels a tracked replacement instead of its confirmed-missing task link", async () => {
    const missingTaskId = "task-pruned-from-ledger";
    const replacementTask = makeTask({
      id: "task-replacement",
      taskId: "task-replacement",
    });
    const linked = createLinkedCard({ status: sampleCard.status, taskId: missingTaskId });
    const blocked = { ...linked, status: "blocked" };
    state.cards = [linked];
    state.tasksByCardId.set("card-1", replacementTask);
    state.missingTaskIds = new Set([missingTaskId]);
    const client = createClient({
      "tasks.cancel": { cancelled: true },
      "chat.abort": { aborted: true, runIds: ["run-1"] },
      "workboard.cards.update": { card: blocked },
    });

    await stopCard(client, linked);

    expect(client.request).toHaveBeenNthCalledWith(1, "tasks.cancel", {
      taskId: replacementTask.taskId,
      reason: "Stopped from Workboard.",
    });
    expect(state.tasksByCardId.get("card-1")).toMatchObject({
      taskId: replacementTask.taskId,
      status: "cancelled",
    });
  });

  it.each([
    {
      name: "successful cancellation",
      taskId: "task-1",
      cancel: () => ({ cancelled: true }),
      missing: false,
    },
    {
      name: "found:false cancellation",
      taskId: "task-pruned",
      cancel: () => ({ found: false, cancelled: false }),
      missing: true,
    },
    {
      name: "missing-task cancellation",
      taskId: "task-pruned",
      cancel: () => {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "task not found: task-pruned",
        });
      },
      missing: true,
    },
  ])("stops task-only cards after $name", async ({ taskId, cancel, missing }) => {
    const linked = createWorkboardCard({ status: "running", taskId });
    const blocked = createWorkboardCard({ status: "blocked", taskId });
    state.cards = [linked];
    const client = createClient((method) =>
      method === "tasks.cancel" ? cancel() : { card: blocked },
    );

    await stopCard(client, linked);

    expect(client.request.mock.calls).toEqual([
      ["tasks.cancel", { taskId, reason: "Stopped from Workboard." }],
      ["workboard.cards.update", { id: "card-1", patch: { status: "blocked" } }],
    ]);
    expect(state.cards).toEqual([blocked]);
    if (missing) {
      expect(state.missingTaskIds).toEqual(new Set([taskId]));
    } else {
      expect(state.tasksByCardId.get("card-1")).toMatchObject({ taskId, status: "cancelled" });
    }
    expect(state.error).toBeNull();
  });

  it("records found:false task cancellation before aborting its linked session", async () => {
    const linked = createLinkedCard({ taskId: "task-pruned" });
    const blocked = { ...linked, status: "blocked" as const };
    state.cards = [linked];
    const client = createSequencedClient(
      {
        "tasks.cancel": [{ found: false, cancelled: false }],
        "chat.abort": [{ aborted: true, runIds: ["run-1"] }],
      },
      { card: blocked },
    );

    await stopCard(client, linked);

    expect(client.request).toHaveBeenNthCalledWith(1, "tasks.cancel", {
      taskId: "task-pruned",
      reason: "Stopped from Workboard.",
    });
    expect(client.request).toHaveBeenNthCalledWith(2, "chat.abort", {
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    });
    expect(client.request).toHaveBeenNthCalledWith(3, "workboard.cards.update", {
      id: "card-1",
      patch: { status: "blocked" },
    });
    expect(state.cards).toEqual([blocked]);
    expect(state.missingTaskIds).toEqual(new Set(["task-pruned"]));
    expect(state.error).toBeNull();
  });

  it("leaves linked cards unchanged when a missing task has no active session to abort", async () => {
    const linked = createLinkedCard({ taskId: "task-pruned" });
    state.cards = [linked];
    const client = createSequencedClient(
      {
        "tasks.cancel": [
          new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "task not found: task-pruned",
          }),
        ],
        "chat.abort": [{ aborted: false, runIds: [] }],
      },
      { card: { ...linked, status: "blocked" } },
    );

    await stopCard(client, linked);

    expect(client.request).toHaveBeenCalledTimes(3);
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    expect(state.cards).toEqual([linked]);
    expect(state.missingTaskIds).toEqual(new Set(["task-pruned"]));
    expect(state.error).toBeNull();
  });

  it("reports linked session abort errors after a missing task cancellation", async () => {
    const linked = createLinkedCard({ taskId: "task-pruned" });
    state.cards = [linked];
    const client = createSequencedClient({
      "tasks.cancel": [
        new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "task not found: task-pruned",
        }),
      ],
      "chat.abort": [new Error("session abort unavailable")],
    });

    await stopCard(client, linked);

    expect(client.request).toHaveBeenCalledTimes(2);
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    expect(state.cards).toEqual([linked]);
    expect(state.missingTaskIds).toEqual(new Set(["task-pruned"]));
    expect(state.error).toBe("session abort unavailable");
  });

  it("reports task cancellation errors without aborting the linked session", async () => {
    const linked = createLinkedCard();
    state.cards = [linked];
    state.tasksByCardId.set(linked.id, sampleTask);
    const client = createSequencedClient({
      "tasks.cancel": [new Error("task ledger unavailable")],
    });

    await stopCard(client, linked);

    expect(client.request).toHaveBeenCalledOnce();
    expect(client.request).toHaveBeenCalledWith("tasks.cancel", {
      taskId: "task-1",
      reason: "Stopped from Workboard.",
    });
    expect(state.cards).toEqual([linked]);
    expect(state.error).toBe("task ledger unavailable");
  });

  it("marks task-linked cards blocked when task cancellation already stopped the session", async () => {
    const linked = createLinkedCard({ status: sampleCard.status });
    state.cards = [linked];
    state.tasksByCardId.set("card-1", sampleTask);
    const blocked = { ...linked, status: "blocked" as const };
    const client = createClient({
      "tasks.cancel": { cancelled: true },
      "chat.abort": { aborted: false, runIds: [] },
      "workboard.cards.update": { card: blocked },
    });

    await stopCard(client, linked);

    expect(client.request).toHaveBeenNthCalledWith(1, "tasks.cancel", {
      taskId: "task-1",
      reason: "Stopped from Workboard.",
    });
    expect(client.request).toHaveBeenNthCalledWith(2, "chat.abort", {
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    });
    expect(client.request).toHaveBeenNthCalledWith(3, "chat.abort", {
      sessionKey: sampleTaskSessionKey,
    });
    expect(client.request).toHaveBeenNthCalledWith(4, "workboard.cards.update", {
      id: "card-1",
      patch: { status: "blocked" },
    });
    expect(state.cards).toEqual([blocked]);
    expect(state.tasksByCardId.get("card-1")).toMatchObject({
      taskId: "task-1",
      status: "cancelled",
    });
  });

  it("cancels active task-only cards from the local task map", async () => {
    const blocked = makeCard({ status: "blocked" });
    state.cards = [sampleCard];
    state.tasksByCardId.set("card-1", sampleTask);
    const client = createClient({
      "tasks.cancel": { cancelled: true },
      "workboard.cards.update": { card: blocked },
    });

    await stopCard(client, sampleCard);

    expect(client.request).toHaveBeenNthCalledWith(1, "tasks.cancel", {
      taskId: "task-1",
      reason: "Stopped from Workboard.",
    });
    expect(client.request).toHaveBeenNthCalledWith(2, "workboard.cards.update", {
      id: "card-1",
      patch: { status: "blocked" },
    });
    expect(getWorkboardState(host).tasksByCardId.get("card-1")).toMatchObject({
      taskId: "task-1",
      status: "cancelled",
    });
  });

  it("archives cards through the plugin gateway method", async () => {
    const archived = makeCard({
      metadata: { archivedAt: 20 },
    });
    const client = createClient({ "workboard.cards.archive": { card: archived } });

    await archiveCard(client, "card-1");

    expect(client.request).toHaveBeenCalledWith("workboard.cards.archive", {
      id: "card-1",
      archived: true,
    });
    expect(getWorkboardState(host).cards[0]?.metadata?.archivedAt).toBe(20);
  });

  it("falls back to the active session abort when the stored run id is stale", async () => {
    const linked = makeCard({ sessionKey: sampleSession.key, runId: "old-run" });
    const blocked = { ...linked, status: "blocked" };
    const client = createSequencedClient(
      {
        "chat.abort": [
          { aborted: false, runIds: [] },
          { aborted: true, runIds: ["new-run"] },
        ],
      },
      { card: blocked },
    );

    await stopCard(client, linked);

    expect(client.request).toHaveBeenNthCalledWith(1, "chat.abort", {
      sessionKey: sampleSession.key,
      runId: "old-run",
    });
    expect(client.request).toHaveBeenNthCalledWith(2, "chat.abort", {
      sessionKey: sampleSession.key,
    });
    expect(client.request).toHaveBeenNthCalledWith(3, "workboard.cards.update", {
      id: "card-1",
      patch: { status: "blocked" },
    });
    expect(getWorkboardState(host).cards[0]).toMatchObject({ status: "blocked" });
  });

  it("leaves cards unchanged when stop does not abort an active run", async () => {
    const linked = makeCard({ sessionKey: sampleSession.key, runId: "stale-run" });
    state.cards = [linked];
    const client = createClient({
      "chat.abort": { aborted: false, runIds: [] },
    });

    await stopCard(client, linked);

    expect(client.request).toHaveBeenCalledTimes(2);
    expect(client.request).toHaveBeenNthCalledWith(1, "chat.abort", {
      sessionKey: sampleSession.key,
      runId: "stale-run",
    });
    expect(client.request).toHaveBeenNthCalledWith(2, "chat.abort", {
      sessionKey: sampleSession.key,
    });
    expect(state.cards).toEqual([linked]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
