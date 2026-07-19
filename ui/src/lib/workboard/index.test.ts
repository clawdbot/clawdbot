// Control UI tests cover workboard behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function createClient(
  responses: Record<string, unknown> | ((method: string, params: unknown) => unknown),
) {
  const request = vi.fn(async (method: string, params: unknown) =>
    typeof responses === "function" ? responses(method, params) : responses[method],
  );
  return { request };
}

function requestPatch(client: ReturnType<typeof createClient>, index: number) {
  return (client.request.mock.calls[index]?.[1] as { patch?: Record<string, unknown> } | undefined)
    ?.patch;
}

function createDeferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  if (!resolve) {
    throw new Error("Expected deferred resolver");
  }
  return { promise, resolve };
}

const sampleCard: WorkboardCard = {
  id: "card-1",
  title: "Build board",
  status: "todo",
  priority: "normal",
  labels: [],
  position: 1000,
  createdAt: 1,
  updatedAt: 1,
};

const sampleSession: GatewaySessionRow = {
  key: "agent:main:dashboard:1",
  kind: "direct",
  updatedAt: Date.now(),
  displayName: "Dashboard session",
  hasActiveRun: true,
  status: "running",
};

const sampleTaskSessionKey = "subagent:workboard-default-card-1";
const sampleTask = {
  id: "task-1",
  taskId: "task-1",
  status: "running",
  title: "Build board",
  childSessionKey: sampleTaskSessionKey,
  runId: "run-1",
  updatedAt: 2,
} satisfies WorkboardTaskSummary;

describe("workboard controller", () => {
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
      const host = {};

      stopWorkboardLifecycleRefresh(host);

      expect(getWorkboardState(host).mutationReadiness).toBe("ready");
    });

    it("isolates state and loads between hosts", async () => {
      const firstHost = {};
      const secondHost = {};
      const firstCard = { ...sampleCard, title: "First host" };
      const secondCard = { ...sampleCard, title: "Second host" };
      const firstClient = createClient({
        "workboard.cards.list": { cards: [firstCard], statuses: ["todo", "done"] },
      });
      const secondClient = createClient({
        "workboard.cards.list": { cards: [secondCard], statuses: ["todo", "done"] },
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
      const host = {};
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

      await loadWorkboard({ host, client: client as never, force: true });

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
      const host = {};
      const staleList = createDeferred<unknown>();
      const currentCard = { ...sampleCard, title: "Current generation" };
      let listCalls = 0;
      const client = createClient((method) => {
        if (method === "workboard.cards.list") {
          listCalls += 1;
          return listCalls === 1
            ? staleList.promise
            : { cards: [currentCard], statuses: ["todo", "done"] };
        }
        return {};
      });

      const staleLoad = loadWorkboard({ host, client: client as never, force: true });
      await Promise.resolve();
      stopWorkboardLifecycleRefresh(host);
      await loadWorkboard({ host, client: client as never, force: true });

      staleList.resolve({
        cards: [{ ...sampleCard, title: "Stale generation" }],
        statuses: ["todo", "done"],
      });
      await staleLoad;

      expect(listCalls).toBe(2);
      expect(getWorkboardState(host).cards).toEqual([currentCard]);
    });

    it("tracks lifecycle writes until a same-host reload can proceed", async () => {
      const host = {};
      const linkedCard = { ...sampleCard, sessionKey: sampleSession.key };
      const updatedCard = { ...linkedCard, status: "running" as const };
      const lifecycleWrite = createDeferred<{ card: WorkboardCard }>();
      const state = getWorkboardState(host);
      state.loaded = true;
      state.cards = [linkedCard];
      state.lifecycleTasksPrepared = true;
      state.lifecycleTasksPreparedAt = Date.now();
      const client = createClient((method) => {
        if (method === "workboard.cards.update") {
          return lifecycleWrite.promise;
        }
        if (method === "workboard.cards.list") {
          return { cards: [updatedCard], statuses: ["todo", "running"] };
        }
        return {};
      });

      const syncing = syncWorkboardLifecycle({
        host,
        client: client as never,
        sessions: [sampleSession],
      });
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
    const host = {};
    const client = createClient({
      "workboard.cards.list": { cards: [sampleCard], statuses: ["todo", "done"] },
    });

    await loadWorkboard({ host, client: client as never, force: true });

    expect(client.request).toHaveBeenCalledWith("workboard.cards.list", {});
    expect(getWorkboardState(host).cards).toEqual([sampleCard]);
  });

  it("refreshes diagnostics before listing cards when requested", async () => {
    const host = {};
    const client = createClient({
      "workboard.cards.diagnostics.refresh": { diagnostics: [], count: 0 },
      "workboard.cards.list": { cards: [sampleCard], statuses: ["todo", "done"] },
    });

    await loadWorkboard({
      host,
      client: client as never,
      force: true,
      refreshDiagnostics: true,
    });

    expect(client.request).toHaveBeenNthCalledWith(1, "workboard.cards.diagnostics.refresh", {});
    expect(client.request).toHaveBeenNthCalledWith(2, "workboard.cards.list", {});
  });

  it("keeps loading cards when diagnostics refresh fails", async () => {
    const host = {};
    const client = createClient((method) => {
      if (method === "workboard.cards.diagnostics.refresh") {
        throw new Error("diagnostics denied");
      }
      return { cards: [sampleCard], statuses: ["todo", "done"] };
    });

    await loadWorkboard({
      host,
      client: client as never,
      force: true,
      refreshDiagnostics: true,
    });

    const state = getWorkboardState(host);
    expect(client.request).toHaveBeenNthCalledWith(1, "workboard.cards.diagnostics.refresh", {});
    expect(client.request).toHaveBeenNthCalledWith(2, "workboard.cards.list", {});
    expect(state.cards).toEqual([sampleCard]);
    expect(state.error).toBeNull();
    expect(state.lastRefreshError).toBe("diagnostics denied");
  });

  it("links loaded cards to matching Gateway tasks", async () => {
    const host = {};
    const linked = {
      ...sampleCard,
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    } satisfies WorkboardCard;
    const client = createClient({
      "workboard.cards.list": { cards: [linked], statuses: ["todo", "done"] },
      "tasks.list": { tasks: [sampleTask] },
    });

    await loadWorkboard({ host, client: client as never, force: true });

    const state = getWorkboardState(host);
    expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    expect(state.cards[0]).toMatchObject({ id: "card-1", taskId: "task-1" });
    expect(state.tasksByCardId.get("card-1")).toMatchObject({
      taskId: "task-1",
      status: "running",
    });
  });

  it("preserves matching task links when full task enrichment fails", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    } satisfies WorkboardCard;
    state.tasksByCardId.set(sampleCard.id, sampleTask);
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return { cards: [linked], statuses: ["todo", "running", "done"] };
      }
      if (method === "tasks.list") {
        throw new Error("task ledger unavailable");
      }
      return {};
    });

    await loadWorkboard({ host, client: client as never, force: true });

    expect(state.cards[0]).toMatchObject({ id: sampleCard.id, taskId: sampleTask.taskId });
    expect(state.tasksByCardId.get(sampleCard.id)).toEqual(sampleTask);
    expect(state.lifecycleTaskRefreshFailed).toBe(true);
    expect(state.lifecycleTaskRefreshError).toBe("task ledger unavailable");
    expect(state.lastRefreshError).toBe("task ledger unavailable");
  });

  it("confirms persisted task ids before marking paginated omissions missing", async () => {
    const host = {};
    const linked = {
      ...sampleCard,
      taskId: sampleTask.taskId,
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    } satisfies WorkboardCard;
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return { cards: [linked], statuses: ["todo", "done"] };
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

    await loadWorkboard({ host, client: client as never, force: true });

    const state = getWorkboardState(host);
    expect(client.request).toHaveBeenCalledWith("tasks.get", { taskId: sampleTask.taskId });
    expect(state.cards[0]).toMatchObject({ taskId: sampleTask.taskId });
    expect(state.missingTaskIds).toEqual(new Set([sampleTask.taskId]));
  });

  it("keeps paginated task omissions unresolved when exact lookup finds the task", async () => {
    const host = {};
    const linked = {
      ...sampleCard,
      taskId: sampleTask.taskId,
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    } satisfies WorkboardCard;
    const client = createClient({
      "workboard.cards.list": { cards: [linked], statuses: ["todo", "done"] },
      "tasks.list": { tasks: [] },
      "tasks.get": { task: sampleTask },
    });

    await loadWorkboard({ host, client: client as never, force: true });

    const state = getWorkboardState(host);
    expect(client.request).toHaveBeenCalledWith("tasks.get", { taskId: sampleTask.taskId });
    expect(state.cards[0]).toMatchObject({ taskId: sampleTask.taskId });
    expect(state.tasksByCardId.get(sampleCard.id)).toEqual(sampleTask);
    expect(state.missingTaskIds).toEqual(new Set());
  });

  it("defers lifecycle sync when exact task confirmation fails", async () => {
    const host = {};
    const linked = {
      ...sampleCard,
      status: "running",
      taskId: sampleTask.taskId,
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    } satisfies WorkboardCard;
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return { cards: [linked], statuses: ["todo", "running", "done"] };
      }
      if (method === "tasks.list") {
        return { tasks: [] };
      }
      if (method === "tasks.get") {
        throw new Error("task confirmation unavailable");
      }
      return {};
    });

    await loadWorkboard({ host, client: client as never, force: true });

    const state = getWorkboardState(host);
    expect(state.lifecycleTaskRefreshFailed).toBe(true);
    expect(state.lastRefreshError).toBe("task confirmation unavailable");
    vi.clearAllMocks();

    await syncWorkboardLifecycle({ host, client: client as never, sessions: [] });

    expect(client.request).not.toHaveBeenCalled();
  });

  it("preserves cached task summaries when full exact confirmation partially fails", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      status: "running",
      taskId: sampleTask.taskId,
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    } satisfies WorkboardCard;
    state.tasksByCardId.set(linked.id, sampleTask);
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return { cards: [linked], statuses: ["todo", "running", "done"] };
      }
      if (method === "tasks.list") {
        return { tasks: [] };
      }
      if (method === "tasks.get") {
        throw new Error("task confirmation unavailable");
      }
      return {};
    });

    await loadWorkboard({ host, client: client as never, force: true });

    expect(state.cards[0]).toMatchObject({ taskId: sampleTask.taskId });
    expect(state.tasksByCardId.get(linked.id)).toEqual(sampleTask);
    expect(state.lifecycleTaskRefreshFailed).toBe(true);
    expect(state.lastRefreshError).toBe("task confirmation unavailable");
  });

  it("keeps linked-poll task failures sticky until a full refresh succeeds", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const cards = Array.from({ length: 33 }, (_, index) => ({
      ...sampleCard,
      id: `card-${index}`,
      status: "running" as const,
      taskId: `task-${index}`,
    }));
    const tasks = cards.map((card, index) => ({
      ...sampleTask,
      id: card.taskId,
      taskId: card.taskId,
      runId: `run-${index}`,
    }));
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

    await loadWorkboard({ host, client: client as never, force: true, taskRefresh: "linked" });
    const retryAt = state.lifecycleTaskRefreshRetryAt;
    expect(state.lifecycleTaskRefreshFailed).toBe(true);
    expect(state.lifecycleTasksPrepared).toBe(false);
    expect(state.lastRefreshError).toBe("task-31 unavailable");

    await loadWorkboard({ host, client: client as never, force: true, taskRefresh: "linked" });
    expect(failedTaskRequests).toBe(1);
    expect(state.lifecycleTaskRefreshFailed).toBe(true);
    expect(state.lifecycleTaskRefreshRetryAt).toBe(retryAt);
    expect(state.lifecycleTasksPrepared).toBe(false);
    expect(state.lastRefreshError).toBe("task-31 unavailable");

    await loadWorkboard({ host, client: client as never, force: true, taskRefresh: "all" });
    expect(state.lifecycleTaskRefreshFailed).toBe(false);
    expect(state.lifecycleTasksPrepared).toBe(true);
    expect(state.lastRefreshError).toBeNull();
  });

  it("clears lifecycle task errors when a linked poll finds no cards", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.lifecycleTaskRefreshFailed = true;
    state.lifecycleTaskRefreshRetryAt = Date.now() + 5000;
    state.lifecycleTaskRefreshError = "tasks unavailable";
    state.lastRefreshError = "tasks unavailable";
    const client = createClient({
      "workboard.cards.list": { cards: [], statuses: ["todo", "running", "done"] },
    });

    await loadWorkboard({ host, client: client as never, force: true, taskRefresh: "linked" });

    expect(state.lifecycleTaskRefreshFailed).toBe(false);
    expect(state.lifecycleTaskRefreshRetryAt).toBeNull();
    expect(state.lifecycleTaskRefreshError).toBeNull();
    expect(state.lastRefreshError).toBeNull();
  });

  it("clears lifecycle task errors when linked polls find no cards needing task data", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.lifecycleTaskRefreshFailed = true;
    state.lifecycleTaskRefreshRetryAt = Date.now() + 5000;
    state.lifecycleTaskRefreshError = "tasks unavailable";
    state.lastRefreshError = "tasks unavailable";
    const client = createClient({
      "workboard.cards.list": { cards: [sampleCard], statuses: ["todo", "running", "done"] },
    });

    await loadWorkboard({ host, client: client as never, force: true, taskRefresh: "linked" });

    expect(state.lifecycleTaskRefreshFailed).toBe(false);
    expect(state.lifecycleTaskRefreshRetryAt).toBeNull();
    expect(state.lifecycleTaskRefreshError).toBeNull();
    expect(state.lastRefreshError).toBeNull();
  });

  it("reuses exact-confirmed full-load tasks for the next lifecycle sync", async () => {
    const host = {};
    const linked = {
      ...sampleCard,
      status: "running",
      taskId: sampleTask.taskId,
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    } satisfies WorkboardCard;
    const client = createClient({
      "workboard.cards.list": { cards: [linked], statuses: ["todo", "running", "done"] },
      "tasks.list": { tasks: [] },
      "tasks.get": { task: sampleTask },
    });

    await loadWorkboard({ host, client: client as never, force: true });

    const state = getWorkboardState(host);
    expect(state.lifecycleTasksPrepared).toBe(true);
    vi.clearAllMocks();

    await syncWorkboardLifecycle({ host, client: client as never, sessions: [] });

    expect(client.request).not.toHaveBeenCalled();
    expect(state.tasksByCardId.get(sampleCard.id)).toEqual(sampleTask);
  });

  it("keeps a canonical task link over a newer loose session match", async () => {
    const host = {};
    const linked = {
      ...sampleCard,
      taskId: sampleTask.taskId,
      sessionKey: sampleTaskSessionKey,
      runId: sampleTask.runId,
    } satisfies WorkboardCard;
    const unrelated = {
      ...sampleTask,
      id: "task-unrelated",
      taskId: "task-unrelated",
      updatedAt: 10,
    };
    const client = createClient({
      "workboard.cards.list": { cards: [linked], statuses: ["todo", "done"] },
      "tasks.list": { tasks: [sampleTask, unrelated] },
    });

    await loadWorkboard({ host, client: client as never, force: true });

    const state = getWorkboardState(host);
    expect(state.cards[0]).toMatchObject({ taskId: sampleTask.taskId });
    expect(state.tasksByCardId.get(sampleCard.id)).toEqual(sampleTask);
  });

  it("records live refresh metadata after reconciliation", async () => {
    const host = {};
    const client = createClient({
      "workboard.cards.list": { cards: [sampleCard], statuses: ["todo", "done"] },
      "tasks.list": { tasks: [] },
    });
    await refreshWorkboard({
      host,
      client: client as never,
      source: "live",
    });

    const state = getWorkboardState(host);
    expect(client.request).toHaveBeenCalledWith("workboard.cards.list", {});
    expect(state.lastRefreshSource).toBe("live");
    expect(state.lastRefreshAt).toEqual(expect.any(Number));
    expect(state.lastRefreshError).toBeNull();
    expect(state.lifecycleTasksPrepared).toBe(true);
  });

  it("preserves mutation errors during successful live refreshes", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.error = "move denied";
    const client = createClient({
      "workboard.cards.list": { cards: [sampleCard], statuses: ["todo", "done"] },
      "tasks.list": { tasks: [] },
    });

    await refreshWorkboard({
      host,
      client: client as never,
      source: "live",
    });

    expect(state.error).toBe("move denied");
    expect(state.lastRefreshError).toBeNull();
    expect(state.lastRefreshAt).toEqual(expect.any(Number));
  });

  it("clears a recovered load error during successful live refreshes", async () => {
    const host = {};
    let cardsAvailable = false;
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        if (!cardsAvailable) {
          throw new Error("cards unavailable");
        }
        return { cards: [sampleCard], statuses: ["todo", "done"] };
      }
      if (method === "tasks.list") {
        return { tasks: [] };
      }
      return {};
    });

    await loadWorkboard({ host, client: client as never, force: true });

    const state = getWorkboardState(host);
    expect(state.loaded).toBe(false);
    expect(state.error).toBe("cards unavailable");

    stopWorkboardLifecycleRefresh(host);
    expect(state.loadAttempted).toBe(false);

    cardsAvailable = true;
    await refreshWorkboard({
      host,
      client: client as never,
      source: "live",
    });

    expect(state.loaded).toBe(true);
    expect(state.cards).toEqual([sampleCard]);
    expect(state.error).toBeNull();
    expect(state.lastRefreshError).toBeNull();
    expect(state.lastRefreshAt).toEqual(expect.any(Number));
  });

  it("preserves newer mutation errors while recovering failed loads", async () => {
    const host = {};
    let cardsAvailable = false;
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        if (!cardsAvailable) {
          throw new Error("cards unavailable");
        }
        return { cards: [sampleCard], statuses: ["todo", "done"] };
      }
      if (method === "tasks.list") {
        return { tasks: [] };
      }
      return {};
    });

    await loadWorkboard({ host, client: client as never, force: true });

    const state = getWorkboardState(host);
    state.error = "move denied";
    cardsAvailable = true;

    await refreshWorkboard({
      host,
      client: client as never,
      source: "live",
    });

    expect(state.loaded).toBe(true);
    expect(state.cards).toEqual([sampleCard]);
    expect(state.error).toBe("move denied");
    expect(state.lastRefreshError).toBeNull();
  });

  it("records live refresh failures without replacing mutation errors", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.error = "move denied";
    const client = createClient(() => {
      throw new Error("refresh unavailable");
    });

    await refreshWorkboard({
      host,
      client: client as never,
      source: "live",
    });

    expect(state.error).toBe("move denied");
    expect(state.lastRefreshError).toBe("refresh unavailable");
    expect(state.lastRefreshAt).toBeNull();
  });

  it("does not mark a disconnected refresh as successful", async () => {
    const host = {};
    const updates: Array<string | null> = [];

    await refreshWorkboard({
      host,
      client: null,
      source: "manual",
      requestUpdate: () => updates.push(getWorkboardState(host).lastRefreshError),
    });

    const state = getWorkboardState(host);
    expect(state.lastRefreshAt).toBeNull();
    expect(state.lastRefreshError).toBe("Gateway client unavailable");
    expect(updates).toContain("Gateway client unavailable");
  });

  it("clears stale refresh errors after a later direct load succeeds", async () => {
    const host = {};
    await refreshWorkboard({
      host,
      client: null,
      source: "manual",
    });

    const client = createClient({
      "workboard.cards.list": { cards: [sampleCard], statuses: ["todo", "done"] },
      "tasks.list": { tasks: [] },
    });
    await loadWorkboard({ host, client: client as never, force: true });

    const state = getWorkboardState(host);
    expect(state.loaded).toBe(true);
    expect(state.error).toBeNull();
    expect(state.lastRefreshError).toBeNull();
  });

  it("keeps refreshed cards when task enrichment fails", async () => {
    const host = {};
    const refreshedCard = { ...sampleCard, title: "Refreshed card" };
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return { cards: [refreshedCard], statuses: ["todo", "done"] };
      }
      if (method === "tasks.list") {
        throw new Error("tasks unavailable");
      }
      return {};
    });

    await refreshWorkboard({
      host,
      client: client as never,
      source: "manual",
    });

    const state = getWorkboardState(host);
    expect(state.cards).toMatchObject([{ title: "Refreshed card" }]);
    expect(state.error).toBeNull();
    expect(state.lastRefreshError).toBe("tasks unavailable");
    expect(state.lastRefreshAt).toEqual(expect.any(Number));
  });

  it("defers task-backed lifecycle sync until a later load enrichment succeeds", async () => {
    const host = {};
    const linkedCard = {
      ...sampleCard,
      taskId: sampleTask.taskId,
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    } satisfies WorkboardCard;
    const requestUpdate = vi.fn();
    let tasksAvailable = false;
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return { cards: [linkedCard], statuses: ["todo", "done"] };
      }
      if (method === "tasks.list") {
        if (!tasksAvailable) {
          throw new Error("tasks unavailable");
        }
        return { tasks: [sampleTask] };
      }
      return {};
    });

    await loadWorkboard({
      host,
      client: client as never,
      force: true,
      requestUpdate,
    });
    vi.clearAllMocks();

    await syncWorkboardLifecycle({ host, client: client as never, sessions: [], requestUpdate });
    await syncWorkboardLifecycle({ host, client: client as never, sessions: [], requestUpdate });

    expect(client.request).not.toHaveBeenCalled();
    expect(requestUpdate).not.toHaveBeenCalled();

    tasksAvailable = true;
    await loadWorkboard({ host, client: client as never, force: true });
    vi.clearAllMocks();
    await syncWorkboardLifecycle({ host, client: client as never, sessions: [] });

    expect(client.request).not.toHaveBeenCalledWith("tasks.list", { limit: 500 });
    expect(getWorkboardState(host).tasksByCardId.get(sampleCard.id)).toEqual(sampleTask);
  });

  it("keeps prepared task summaries when bounded poll enrichment fails", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const linkedCard = {
      ...sampleCard,
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    } satisfies WorkboardCard;
    state.tasksByCardId.set(sampleCard.id, sampleTask);
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return { cards: [linkedCard], statuses: ["todo", "done"] };
      }
      if (method === "tasks.get") {
        throw new Error("tasks unavailable");
      }
      return {};
    });

    await refreshWorkboard({
      host,
      client: client as never,
      source: "live",
    });

    expect(state.tasksByCardId.get(sampleCard.id)).toEqual(sampleTask);
    expect(state.lifecycleTasksPrepared).toBe(false);
    expect(state.lastRefreshError).toBe("tasks unavailable");
  });

  it("tracks terminal task links after authoritative task pruning", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const linkedCard = {
      ...sampleCard,
      taskId: sampleTask.taskId,
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    } satisfies WorkboardCard;
    state.tasksByCardId.set(sampleCard.id, { ...sampleTask, status: "completed" });
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return { cards: [linkedCard], statuses: ["todo", "done"] };
      }
      if (method === "tasks.get") {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: `task not found: ${sampleTask.taskId}`,
        });
      }
      return {};
    });

    await refreshWorkboard({
      host,
      client: client as never,
      source: "live",
    });

    expect(client.request).toHaveBeenCalledWith("tasks.get", { taskId: sampleTask.taskId });
    expect(state.cards[0]).toMatchObject({ taskId: sampleTask.taskId });
    expect(state.tasksByCardId.has(sampleCard.id)).toBe(false);
    expect(state.missingTaskIds).toEqual(new Set([sampleTask.taskId]));
    expect(state.lastRefreshError).toBeNull();

    vi.clearAllMocks();
    await refreshWorkboard({
      host,
      client: client as never,
      source: "live",
    });

    expect(client.request).not.toHaveBeenCalledWith("tasks.get", { taskId: sampleTask.taskId });
  });

  it("keeps canonical task unlinks during bounded live refreshes", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.tasksByCardId.set(sampleCard.id, sampleTask);
    const client = createClient({
      "workboard.cards.list": { cards: [sampleCard], statuses: ["todo", "done"] },
    });

    await refreshWorkboard({
      host,
      client: client as never,
      source: "live",
    });

    expect(state.cards[0]).not.toHaveProperty("taskId");
    expect(state.tasksByCardId.has(sampleCard.id)).toBe(false);
  });

  it("refreshes live state through the read path without write methods", async () => {
    const host = {};
    const linkedCard = {
      ...sampleCard,
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    } satisfies WorkboardCard;
    const completedTask = { ...sampleTask, status: "completed" as const };
    const olderSessionKey = "subagent:workboard-default-card-2";
    const olderCard = {
      ...sampleCard,
      id: "card-2",
      title: "Older running card",
      sessionKey: olderSessionKey,
      runId: "run-2",
    };
    const olderTask = {
      ...sampleTask,
      id: "task-2",
      taskId: "task-2",
      childSessionKey: olderSessionKey,
      runId: "run-2",
      updatedAt: 1,
    };
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
    const state = getWorkboardState(host);
    state.tasksByCardId.set(sampleCard.id, sampleTask);
    state.tasksByCardId.set(olderCard.id, olderTask);

    await refreshWorkboard({
      host,
      client: client as never,
      source: "live",
    });

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
    const host = {};
    const state = getWorkboardState(host);
    const replacementCard = {
      ...sampleCard,
      sessionKey: sampleTaskSessionKey,
      runId: "run-2",
      taskId: "task-2",
    } satisfies WorkboardCard;
    const replacementTask = {
      ...sampleTask,
      id: "task-2",
      taskId: "task-2",
      runId: "run-2",
      updatedAt: 3,
    };
    state.tasksByCardId.set(sampleCard.id, sampleTask);
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return { cards: [replacementCard], statuses: ["todo", "done"] };
      }
      if (method === "tasks.get") {
        return { task: replacementTask };
      }
      return {};
    });

    await refreshWorkboard({ host, client: client as never, source: "live" });

    expect(client.request).toHaveBeenCalledWith("tasks.get", { taskId: "task-2" });
    expect(client.request).not.toHaveBeenCalledWith("tasks.get", { taskId: "task-1" });
    expect(state.cards[0]).toMatchObject({ taskId: "task-2", runId: "run-2" });
    expect(state.tasksByCardId.get(sampleCard.id)).toMatchObject({
      taskId: "task-2",
      runId: "run-2",
    });
  });

  it("rotates bounded linked-task polling batches", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.cards = Array.from({ length: 40 }, (_, index) => ({
      ...sampleCard,
      id: `card-${index}`,
      taskId: `task-${index}`,
    }));
    const client = createClient((method, params) => {
      if (method === "workboard.cards.list") {
        return { cards: state.cards, statuses: ["todo", "done"] };
      }
      if (method === "tasks.get") {
        const taskId = (params as { taskId: string }).taskId;
        return { task: { ...sampleTask, id: taskId, taskId } };
      }
      return {};
    });

    await refreshWorkboard({ host, client: client as never, source: "live" });
    const firstBatch = client.request.mock.calls
      .filter(([method]) => method === "tasks.get")
      .map(([, params]) => (params as { taskId: string }).taskId);
    vi.clearAllMocks();
    await refreshWorkboard({ host, client: client as never, source: "live" });
    const secondBatch = client.request.mock.calls
      .filter(([method]) => method === "tasks.get")
      .map(([, params]) => (params as { taskId: string }).taskId);

    expect(firstBatch).toHaveLength(32);
    expect(secondBatch).toHaveLength(32);
    expect(secondBatch).not.toEqual(firstBatch);
  });

  it("requires a full lifecycle refresh after a partial bounded task poll", async () => {
    const host = {};
    const cards = Array.from({ length: 33 }, (_, index) => ({
      ...sampleCard,
      id: `card-${index}`,
      status: "running" as const,
      taskId: `task-${index}`,
    }));
    const tasks = cards.map((card) => ({
      ...sampleTask,
      id: card.taskId,
      taskId: card.taskId,
    }));
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

    await refreshWorkboard({ host, client: client as never, source: "live" });

    expect(getWorkboardState(host).lifecycleTasksPrepared).toBe(false);
    vi.clearAllMocks();
    await syncWorkboardLifecycle({ host, client: client as never, sessions: [] });

    expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
  });

  it("rediscovers a bounded batch of running task links during polls", async () => {
    const host = {};
    const cards = Array.from({ length: 6 }, (_, index) => ({
      ...sampleCard,
      id: `card-${index}`,
      status: "running" as const,
      sessionKey: `agent:worker-${index}:subagent:workboard-default-card-${index}`,
      runId: `run-${index}`,
    }));
    const client = createClient((method, params) => {
      if (method === "workboard.cards.list") {
        return { cards, statuses: ["todo", "running", "done"] };
      }
      if (method === "tasks.list") {
        const sessionKey = (params as { sessionKey: string }).sessionKey;
        const index = sessionKey.at(-1);
        return {
          tasks: [
            {
              ...sampleTask,
              id: `task-${index}`,
              taskId: `task-${index}`,
              childSessionKey: sessionKey,
              runId: `run-${index}`,
            },
          ],
        };
      }
      return {};
    });

    await refreshWorkboard({ host, client: client as never, source: "live" });
    const firstDiscoveryCalls = client.request.mock.calls.filter(
      ([method]) => method === "tasks.list",
    );
    expect(firstDiscoveryCalls).toHaveLength(4);
    expect(firstDiscoveryCalls[0]?.[1]).toMatchObject({
      sessionKey: "agent:worker-0:subagent:workboard-default-card-0",
      limit: 500,
    });
    expect(getWorkboardState(host).lifecycleTasksPrepared).toBe(false);

    vi.clearAllMocks();
    await refreshWorkboard({ host, client: client as never, source: "live" });
    const secondDiscoveryCalls = client.request.mock.calls.filter(
      ([method]) => method === "tasks.list",
    );
    expect(secondDiscoveryCalls).toHaveLength(2);
    expect(getWorkboardState(host).cards.every((card) => Boolean(card.taskId))).toBe(true);
  });

  it("rediscovers default-agent task links from an unfiltered bounded page", async () => {
    const host = {};
    const linkedCard = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    } satisfies WorkboardCard;
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return { cards: [linkedCard], statuses: ["todo", "running", "done"] };
      }
      if (method === "tasks.list") {
        return {
          tasks: [{ ...sampleTask, childSessionKey: `agent:main:${sampleTaskSessionKey}` }],
        };
      }
      return {};
    });

    await refreshWorkboard({ host, client: client as never, source: "live" });

    expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    expect(getWorkboardState(host).cards[0]).toMatchObject({ taskId: sampleTask.taskId });
  });

  it("preserves discovered replacements across consecutive polls", async () => {
    const host = {};
    const missingTaskId = "task-pruned-from-ledger";
    const replacementTaskId = "task-replacement";
    const replacementTask = {
      ...sampleTask,
      id: replacementTaskId,
      taskId: replacementTaskId,
      childSessionKey: `agent:main:${sampleTaskSessionKey}`,
    };
    const linkedCard = {
      ...sampleCard,
      status: "running",
      taskId: missingTaskId,
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    } satisfies WorkboardCard;
    const state = getWorkboardState(host);
    state.missingTaskIds = new Set([missingTaskId]);
    const client = createClient((method, params) => {
      if (method === "workboard.cards.list") {
        return { cards: [linkedCard], statuses: ["todo", "running", "done"] };
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

    await refreshWorkboard({ host, client: client as never, source: "live" });

    expect(client.request).not.toHaveBeenCalledWith("tasks.get", { taskId: missingTaskId });
    expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    expect(state.cards[0]).toMatchObject({ taskId: missingTaskId });
    expect(state.tasksByCardId.get(sampleCard.id)).toEqual(replacementTask);
    expect(state.missingTaskIds).toEqual(new Set([missingTaskId]));

    vi.clearAllMocks();
    await refreshWorkboard({ host, client: client as never, source: "live" });

    expect(client.request).toHaveBeenCalledWith("tasks.get", { taskId: replacementTaskId });
    expect(client.request).not.toHaveBeenCalledWith("tasks.get", { taskId: missingTaskId });
    expect(client.request).not.toHaveBeenCalledWith("tasks.list", expect.anything());
    expect(state.cards[0]).toMatchObject({ taskId: missingTaskId });
    expect(state.tasksByCardId.get(sampleCard.id)).toEqual(replacementTask);
    expect(state.missingTaskIds).toEqual(new Set([missingTaskId]));
  });

  it("cycles default-agent task discovery through bounded task pages", async () => {
    const host = {};
    const linkedCard = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    } satisfies WorkboardCard;
    const client = createClient((method, params) => {
      if (method === "workboard.cards.list") {
        return { cards: [linkedCard], statuses: ["todo", "running", "done"] };
      }
      if (method === "tasks.list") {
        return (params as { cursor?: string }).cursor === "500"
          ? { tasks: [{ ...sampleTask, childSessionKey: `agent:main:${sampleTaskSessionKey}` }] }
          : { tasks: [], nextCursor: "500" };
      }
      return {};
    });

    await refreshWorkboard({ host, client: client as never, source: "live" });
    expect(getWorkboardState(host).cards[0]).not.toHaveProperty("taskId");

    vi.clearAllMocks();
    await refreshWorkboard({ host, client: client as never, source: "live" });

    expect(client.request).toHaveBeenCalledWith("tasks.list", {
      limit: 500,
      cursor: "500",
    });
    expect(getWorkboardState(host).cards[0]).toMatchObject({ taskId: sampleTask.taskId });
  });

  it("restarts default-agent task discovery after a terminal page", async () => {
    const host = {};
    const linkedCard = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    } satisfies WorkboardCard;
    const client = createClient((method, params) => {
      if (method === "workboard.cards.list") {
        return { cards: [linkedCard], statuses: ["todo", "running", "done"] };
      }
      if (method === "tasks.list") {
        return (params as { cursor?: string }).cursor === "500"
          ? { tasks: [] }
          : { tasks: [], nextCursor: "500" };
      }
      return {};
    });

    await refreshWorkboard({ host, client: client as never, source: "live" });
    await refreshWorkboard({ host, client: client as never, source: "live" });
    await refreshWorkboard({ host, client: client as never, source: "live" });

    const discoveryCalls = client.request.mock.calls.filter(([method]) => method === "tasks.list");
    expect(discoveryCalls.map(([, params]) => params)).toEqual([
      { limit: 500 },
      { limit: 500, cursor: "500" },
      { limit: 500 },
    ]);
  });

  it("discards an in-flight poll when a card drag starts", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const listedCards = createDeferred<unknown>();
    const initialCard = { ...sampleCard, title: "Drag target" };
    const refreshedCard = { ...sampleCard, title: "Server refresh" };
    state.cards = [initialCard];
    state.loaded = true;
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return listedCards.promise;
      }
      return {};
    });

    const refresh = refreshWorkboard({
      host,
      client: client as never,
      source: "live",
    });
    await Promise.resolve();
    state.draggedCardId = initialCard.id;
    listedCards.resolve({ cards: [refreshedCard], statuses: ["todo", "done"] });
    await refresh;

    expect(state.cards).toEqual([initialCard]);
    expect(state.draggedCardId).toBe(initialCard.id);
    expect(state.lastRefreshAt).toBeNull();
  });

  it("discards an in-flight poll when an edit draft opens", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const listedCards = createDeferred<unknown>();
    const initialCard = { ...sampleCard, title: "Edit target" };
    const refreshedCard = { ...sampleCard, title: "Server refresh" };
    state.cards = [initialCard];
    state.loaded = true;
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return listedCards.promise;
      }
      return {};
    });

    const refresh = refreshWorkboard({
      host,
      client: client as never,
      source: "live",
    });
    await Promise.resolve();
    state.draftOpen = true;
    state.editingCardId = initialCard.id;
    state.draftTitle = initialCard.title;
    listedCards.resolve({ cards: [refreshedCard], statuses: ["todo", "done"] });
    await refresh;

    expect(state.cards).toEqual([initialCard]);
    expect(state.editingCardId).toBe(initialCard.id);
    expect(state.draftTitle).toBe(initialCard.title);
    expect(state.lastRefreshAt).toBeNull();
  });

  it("tracks dispatch independently from refresh loading state", async () => {
    const host = {};
    const state = getWorkboardState(host);
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
      "workboard.cards.list": { cards: [sampleCard], statuses: ["todo", "done"] },
      "tasks.list": { tasks: [] },
    });

    await dispatchWorkboard({
      host,
      client: client as never,
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

  it("clears stale refresh errors after a successful dispatch reload", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.lastRefreshError = "poll unavailable";
    const client = createClient({
      "workboard.cards.dispatch": {
        promoted: [],
        reclaimed: [],
        blocked: [],
        orchestrated: [],
        count: 0,
      },
      "workboard.cards.list": { cards: [sampleCard], statuses: ["todo", "done"] },
      "tasks.list": { tasks: [] },
    });

    await dispatchWorkboard({ host, client: client as never });

    expect(state.lastRefreshError).toBeNull();
  });

  it("blocks dispatch while a card draft write is in flight", async () => {
    const host = {};
    const state = getWorkboardState(host);
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
        return { cards: [sampleCard], statuses: ["todo", "done"] };
      }
      if (method === "tasks.list") {
        return { tasks: [] };
      }
      return {};
    });

    const save = saveWorkboardCardDraft({ host, client: client as never });
    await Promise.resolve();
    await dispatchWorkboard({ host, client: client as never });

    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.dispatch", {});

    update.resolve({ card: sampleCard });
    await save;
  });

  it("keeps concurrent card writes busy until each write finishes", async () => {
    const host = {};
    const first = createDeferred<unknown>();
    const second = createDeferred<unknown>();
    const secondCard = { ...sampleCard, id: "card-2", title: "Second card" };
    const client = createClient((method, params) => {
      if (method === "workboard.cards.move") {
        return (params as { id: string }).id === sampleCard.id ? first.promise : second.promise;
      }
      if (method === "workboard.cards.dispatch") {
        return { promoted: [], reclaimed: [], blocked: [], orchestrated: [] };
      }
      return {};
    });

    const firstMove = moveWorkboardCard({
      host,
      client: client as never,
      cardId: sampleCard.id,
      status: "review",
      position: 1000,
    });
    const secondMove = moveWorkboardCard({
      host,
      client: client as never,
      cardId: secondCard.id,
      status: "review",
      position: 2000,
    });
    await Promise.resolve();

    expect(getWorkboardState(host).busyCardIds).toEqual(new Set([sampleCard.id, secondCard.id]));
    await moveWorkboardCard({
      host,
      client: client as never,
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

    first.resolve({ card: { ...sampleCard, status: "review" } });
    getWorkboardState(host).draggedCardId = secondCard.id;
    await firstMove;

    expect(getWorkboardState(host).busyCardIds).toEqual(new Set([secondCard.id]));
    expect(getWorkboardState(host).draggedCardId).toBe(secondCard.id);
    await dispatchWorkboard({ host, client: client as never });
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.dispatch", {});

    second.resolve({ card: { ...secondCard, status: "review" } });
    await secondMove;
    expect(getWorkboardState(host).busyCardIds.size).toBe(0);
    expect(getWorkboardState(host).draggedCardId).toBeNull();
  });

  it("does not refresh while a card write is active", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.busyCardIds.add(sampleCard.id);
    const client = createClient({
      "workboard.cards.list": { cards: [sampleCard], statuses: ["todo", "done"] },
      "tasks.list": { tasks: [] },
    });

    await refreshWorkboard({
      host,
      client: client as never,
      source: "manual",
    });

    expect(client.request).not.toHaveBeenCalled();
  });

  it("clears stale task summaries when dispatch task refresh fails", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.tasksByCardId.set("card-1", sampleTask);
    const dispatchedCard = { ...sampleCard, status: "ready" as const };
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
        return { cards: [dispatchedCard], statuses: ["todo", "ready", "done"] };
      }
      if (method === "tasks.list") {
        throw new Error("task ledger unavailable");
      }
      return {};
    });

    await dispatchWorkboard({ host, client: client as never });

    expect(state.cards).toEqual([dispatchedCard]);
    expect(state.loaded).toBe(true);
    expect(state.tasksByCardId.size).toBe(0);
    expect(state.lifecycleTaskRefreshFailed).toBe(true);
    expect(state.lastRefreshError).toBe("task ledger unavailable");
  });

  it("skips refreshes while dispatch is in flight", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.dispatching = true;
    const client = createClient({
      "workboard.cards.list": { cards: [sampleCard], statuses: ["todo", "done"] },
    });

    await refreshWorkboard({
      host,
      client: client as never,
      source: "manual",
    });

    expect(client.request).not.toHaveBeenCalled();
    expect(state.lastRefreshStartedAt).toBeNull();
  });

  it.each(["dispatch", "card write"] as const)(
    "blocks direct forced loads while a %s is active",
    async (activeMutation) => {
      const host = {};
      const state = getWorkboardState(host);
      if (activeMutation === "dispatch") {
        state.dispatching = true;
      } else {
        state.busyCardIds.add(sampleCard.id);
      }
      const client = createClient({
        "workboard.cards.list": { cards: [sampleCard], statuses: ["todo", "done"] },
      });

      await expect(loadWorkboard({ host, client: client as never, force: true })).resolves.toBe(
        false,
      );

      expect(client.request).not.toHaveBeenCalled();
    },
  );

  it("blocks card writes while dispatch is relisting cards", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.dispatching = true;
    state.cards = [sampleCard];
    state.draftTitle = "Queued edit";
    state.editingCardId = sampleCard.id;
    const client = createClient({});

    await saveWorkboardCardDraft({ host, client: client as never });
    await moveWorkboardCard({
      host,
      client: client as never,
      cardId: sampleCard.id,
      status: "review",
      position: 2000,
    });
    await deleteWorkboardCard({ host, client: client as never, cardId: sampleCard.id });
    await archiveWorkboardCard({ host, client: client as never, cardId: sampleCard.id });
    await addWorkboardCardComment({
      host,
      client: client as never,
      cardId: sampleCard.id,
      body: "hold",
    });

    expect(client.request).not.toHaveBeenCalled();
    expect(state.cards).toEqual([sampleCard]);
  });

  it("does not let an older refresh overwrite cards listed after dispatch", async () => {
    const host = {};
    const refreshList = createDeferred<unknown>();
    const staleCard = { ...sampleCard, title: "Stale refresh card" };
    const dispatchedCard = { ...sampleCard, title: "Dispatched card" };
    let listCalls = 0;
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        listCalls += 1;
        return listCalls === 1
          ? refreshList.promise
          : { cards: [dispatchedCard], statuses: ["todo", "done"] };
      }
      if (method === "workboard.cards.dispatch") {
        return {
          promoted: [],
          reclaimed: [],
          blocked: [],
          orchestrated: [],
          count: 0,
        };
      }
      if (method === "tasks.list") {
        return { tasks: [] };
      }
      return {};
    });

    const refresh = refreshWorkboard({
      host,
      client: client as never,
      source: "manual",
    });
    await Promise.resolve();
    expect(getWorkboardState(host).loading).toBe(true);

    await dispatchWorkboard({ host, client: client as never });
    expect(getWorkboardState(host).cards).toMatchObject([{ title: "Dispatched card" }]);

    refreshList.resolve({ cards: [staleCard], statuses: ["todo", "done"] });
    await refresh;

    const state = getWorkboardState(host);
    expect(state.cards).toMatchObject([{ title: "Dispatched card" }]);
    expect(state.loading).toBe(false);
    expect(state.lastRefreshAt).toBeNull();
  });

  it("does not let an older refresh overwrite a card move", async () => {
    const host = {};
    const refreshList = createDeferred<unknown>();
    const staleCard = { ...sampleCard, status: "ready" as const, title: "Stale ready card" };
    const movedCard = { ...sampleCard, status: "review" as const, title: "Moved card" };
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

    const refresh = refreshWorkboard({
      host,
      client: client as never,
      source: "manual",
    });
    await Promise.resolve();

    await moveWorkboardCard({
      host,
      client: client as never,
      cardId: sampleCard.id,
      status: "review",
      position: 2000,
    });
    refreshList.resolve({ cards: [staleCard], statuses: ["ready", "review"] });
    await refresh;

    const state = getWorkboardState(host);
    expect(state.cards).toMatchObject([{ title: "Moved card", status: "review" }]);
  });

  it("allows automatic reload after an initial load is invalidated by a write", async () => {
    const host = {};
    const initialList = createDeferred<unknown>();
    const reloadedList = createDeferred<unknown>();
    const movedCard = { ...sampleCard, title: "Moved during initial load" };
    const reloadedCard = { ...sampleCard, title: "Reloaded canonical card" };
    let listCalls = 0;
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        listCalls += 1;
        return listCalls === 1 ? initialList.promise : reloadedList.promise;
      }
      if (method === "workboard.cards.move") {
        return { card: movedCard };
      }
      if (method === "tasks.list") {
        return { tasks: [] };
      }
      return {};
    });

    const initialLoad = loadWorkboard({ host, client: client as never });
    await Promise.resolve();
    await moveWorkboardCard({
      host,
      client: client as never,
      cardId: sampleCard.id,
      status: "review",
      position: 2000,
    });

    const state = getWorkboardState(host);
    expect(state.loaded).toBe(false);
    expect(state.loadAttempted).toBe(false);
    expect(state.loading).toBe(false);

    const reload = loadWorkboard({ host, client: client as never });
    expect(listCalls).toBe(2);
    reloadedList.resolve({ cards: [reloadedCard], statuses: ["todo", "done"] });
    await reload;
    expect(state.cards).toMatchObject([{ title: "Reloaded canonical card" }]);
    expect(state.loaded).toBe(true);

    initialList.resolve({ cards: [sampleCard], statuses: ["todo", "done"] });
    await initialLoad;
    expect(state.cards).toMatchObject([{ title: "Reloaded canonical card" }]);
  });

  it("does not clear draft-save loading state from an invalidated refresh", async () => {
    const host = {};
    const state = getWorkboardState(host);
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

    const refresh = loadWorkboard({ host, client: client as never, force: true });
    await Promise.resolve();
    const save = saveWorkboardCardDraft({ host, client: client as never });
    await waitForFast(() => {
      expect(client.request).toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    });
    refreshList.resolve({ cards: [sampleCard], statuses: ["todo", "done"] });
    await refresh;

    expect(state.draftSaving).toBe(true);
    expect(state.loading).toBe(true);
    await addWorkboardCardComment({
      host,
      client: client as never,
      cardId: sampleCard.id,
      body: "must wait for save",
    });
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.comment", expect.anything());

    saveResponse.resolve({ card: { ...sampleCard, title: "Saved title" } });
    await save;
    expect(state.draftSaving).toBe(false);
    expect(state.loading).toBe(false);
  });

  it("queues a forced full refresh behind an in-flight bounded poll load", async () => {
    const host = {};
    const pollList = createDeferred<unknown>();
    const forcedCard = { ...sampleCard, title: "Forced full refresh" };
    let cardListCalls = 0;
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        cardListCalls += 1;
        return cardListCalls === 1
          ? pollList.promise
          : { cards: [forcedCard], statuses: ["todo", "done"] };
      }
      if (method === "tasks.list") {
        return { tasks: [] };
      }
      return {};
    });

    const poll = loadWorkboard({
      host,
      client: client as never,
      force: true,
      taskRefresh: "linked",
    });
    await Promise.resolve();
    const forced = loadWorkboard({
      host,
      client: client as never,
      force: true,
      refreshDiagnostics: true,
      taskRefresh: "all",
    });
    pollList.resolve({ cards: [sampleCard], statuses: ["todo", "done"] });
    await Promise.all([poll, forced]);

    expect(client.request).toHaveBeenCalledWith("workboard.cards.diagnostics.refresh", {});
    expect(
      client.request.mock.calls.filter(([method]) => method === "workboard.cards.list"),
    ).toHaveLength(2);
    expect(client.request.mock.calls.filter(([method]) => method === "tasks.list")).toHaveLength(1);
    expect(getWorkboardState(host).cards).toMatchObject([{ title: "Forced full refresh" }]);
  });

  it("preserves a stronger forced refresh behind another queued forced refresh", async () => {
    const host = {};
    const initialList = createDeferred<unknown>();
    const weakerCard = { ...sampleCard, title: "Weaker queued refresh" };
    const strongerCard = { ...sampleCard, title: "Stronger queued refresh" };
    let cardListCalls = 0;
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        cardListCalls += 1;
        if (cardListCalls === 1) {
          return initialList.promise;
        }
        return {
          cards: [cardListCalls === 2 ? weakerCard : strongerCard],
          statuses: ["todo", "done"],
        };
      }
      if (method === "tasks.list") {
        return { tasks: [] };
      }
      return {};
    });

    const initial = loadWorkboard({
      host,
      client: client as never,
      force: true,
      taskRefresh: "linked",
    });
    await Promise.resolve();
    const weaker = loadWorkboard({
      host,
      client: client as never,
      force: true,
      taskRefresh: "linked",
    });
    const stronger = loadWorkboard({
      host,
      client: client as never,
      force: true,
      refreshDiagnostics: true,
      taskRefresh: "all",
    });
    initialList.resolve({ cards: [sampleCard], statuses: ["todo", "done"] });
    await Promise.all([initial, weaker, stronger]);

    expect(client.request).toHaveBeenCalledWith("workboard.cards.diagnostics.refresh", {});
    expect(
      client.request.mock.calls.filter(([method]) => method === "workboard.cards.list"),
    ).toHaveLength(3);
    expect(client.request.mock.calls.filter(([method]) => method === "tasks.list")).toHaveLength(1);
    expect(getWorkboardState(host).cards).toMatchObject([{ title: "Stronger queued refresh" }]);
  });

  it("does not restart a queued forced refresh after lifecycle teardown", async () => {
    const host = {};
    const pollList = createDeferred<unknown>();
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return pollList.promise;
      }
      return {};
    });

    const poll = loadWorkboard({
      host,
      client: client as never,
      force: true,
      taskRefresh: "linked",
    });
    await Promise.resolve();
    const forced = loadWorkboard({
      host,
      client: client as never,
      force: true,
      refreshDiagnostics: true,
      taskRefresh: "all",
    });
    stopWorkboardLifecycleRefresh(host);
    pollList.resolve({ cards: [sampleCard], statuses: ["todo", "done"] });
    await Promise.all([poll, forced]);

    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.diagnostics.refresh", {});
    expect(
      client.request.mock.calls.filter(([method]) => method === "workboard.cards.list"),
    ).toHaveLength(1);
    expect(getWorkboardState(host).loaded).toBe(false);
  });

  it("reloads a previously loaded board after lifecycle teardown", async () => {
    const host = {};
    const reopenedCard = { ...sampleCard, title: "Reopened board" };
    let listCalls = 0;
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        listCalls += 1;
        return {
          cards: [listCalls === 1 ? sampleCard : reopenedCard],
          statuses: ["todo", "done"],
        };
      }
      return {};
    });

    await loadWorkboard({ host, client: client as never });

    const state = getWorkboardState(host);
    expect(state.loaded).toBe(true);
    expect(state.cards).toEqual([sampleCard]);

    stopWorkboardLifecycleRefresh(host);

    expect(state.loaded).toBe(false);
    expect(state.loadAttempted).toBe(false);
    expect(state.mutationReadiness).toBe("canonical_reload_required");
    await expect(loadWorkboard({ host, client: client as never })).resolves.toBe(true);
    expect(listCalls).toBe(2);
    expect(state.cards).toEqual([reopenedCard]);
    expect(state.mutationReadiness).toBe("ready");
  });

  it("preserves edit drafts without re-enabling their stale save payload", async () => {
    const editHost = {};
    const editState = getWorkboardState(editHost);
    const editClient = createClient({
      "workboard.cards.list": {
        cards: [{ ...sampleCard, title: "Canonical title" }],
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
      "workboard.cards.list": { cards: [], statuses: ["todo", "done"] },
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
    const host = {};
    const state = getWorkboardState(host);
    let rejectSave: ((reason?: unknown) => void) | undefined;
    const saveResponse = new Promise<unknown>((_resolve, reject) => {
      rejectSave = reject;
    });
    const client = createClient((method) => {
      if (method === "workboard.cards.update") {
        return saveResponse;
      }
      if (method === "workboard.cards.list") {
        return { cards: [sampleCard], statuses: ["todo", "done"] };
      }
      if (method === "tasks.list") {
        return { tasks: [] };
      }
      return {};
    });
    state.loaded = true;
    state.cards = [sampleCard];
    state.draftOpen = true;
    state.editingCardId = sampleCard.id;
    state.draftTitle = "Unsaved edit";

    const save = saveWorkboardCardDraft({ host, client: client as never });
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
    const host = {};
    const state = getWorkboardState(host);
    const dispatchResult = createDeferred<unknown>();
    const client = createClient((method) => {
      if (method === "workboard.cards.dispatch") {
        return dispatchResult.promise;
      }
      if (method === "workboard.cards.list") {
        return { cards: [sampleCard], statuses: ["todo", "done"] };
      }
      if (method === "tasks.list") {
        return { tasks: [] };
      }
      return {};
    });
    state.loaded = true;
    state.cards = [sampleCard];

    const dispatch = dispatchWorkboard({ host, client: client as never });
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
    const host = {};
    const staleList = createDeferred<unknown>();
    const reopenedList = createDeferred<unknown>();
    const reopenedCard = { ...sampleCard, title: "Reopened board" };
    let cardListCalls = 0;
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        cardListCalls += 1;
        return cardListCalls === 1 ? staleList.promise : reopenedList.promise;
      }
      return {};
    });

    const initial = loadWorkboard({
      host,
      client: client as never,
      force: true,
      taskRefresh: "linked",
    });
    await Promise.resolve();
    const forced = loadWorkboard({
      host,
      client: client as never,
      force: true,
      refreshDiagnostics: true,
      taskRefresh: "all",
    });
    stopWorkboardLifecycleRefresh(host);
    const reopened = loadWorkboard({ host, client: client as never });

    staleList.resolve({ cards: [sampleCard], statuses: ["todo", "done"] });
    await initial;
    reopenedList.resolve({ cards: [reopenedCard], statuses: ["todo", "done"] });
    await Promise.all([forced, reopened]);

    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.diagnostics.refresh", {});
    expect(
      client.request.mock.calls.filter(([method]) => method === "workboard.cards.list"),
    ).toHaveLength(2);
    expect(getWorkboardState(host).cards).toMatchObject([{ title: "Reopened board" }]);
  });

  it("detaches a stalled initial load during lifecycle teardown", async () => {
    const host = {};
    const initialList = createDeferred<unknown>();
    const reopenedCard = { ...sampleCard, title: "Reopened board" };
    let listCalls = 0;
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        listCalls += 1;
        return listCalls === 1
          ? initialList.promise
          : { cards: [reopenedCard], statuses: ["todo", "done"] };
      }
      return {};
    });

    const initialLoad = loadWorkboard({ host, client: client as never });
    await Promise.resolve();
    const state = getWorkboardState(host);
    expect(state.loading).toBe(true);
    expect(state.loadAttempted).toBe(true);

    stopWorkboardLifecycleRefresh(host);

    expect(state.loading).toBe(false);
    expect(state.loadAttempted).toBe(false);
    await expect(loadWorkboard({ host, client: client as never })).resolves.toBe(true);
    expect(listCalls).toBe(2);
    expect(state.cards).toMatchObject([{ title: "Reopened board" }]);

    initialList.resolve({ cards: [sampleCard], statuses: ["todo", "done"] });
    await expect(initialLoad).resolves.toBe(false);
    expect(state.cards).toMatchObject([{ title: "Reopened board" }]);
  });

  it("does not start a queued forced refresh after a card write begins", async () => {
    const host = {};
    const pollList = createDeferred<unknown>();
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return pollList.promise;
      }
      return {};
    });

    const poll = loadWorkboard({
      host,
      client: client as never,
      force: true,
      taskRefresh: "linked",
    });
    await Promise.resolve();
    const forced = loadWorkboard({
      host,
      client: client as never,
      force: true,
      refreshDiagnostics: true,
      taskRefresh: "all",
    });
    getWorkboardState(host).busyCardIds.add(sampleCard.id);
    pollList.resolve({ cards: [sampleCard], statuses: ["todo", "done"] });
    await Promise.all([poll, forced]);

    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.diagnostics.refresh", {});
    expect(
      client.request.mock.calls.filter(([method]) => method === "workboard.cards.list"),
    ).toHaveLength(1);
  });

  it("does not mark a load successful when task enrichment is invalidated by a write", async () => {
    const host = {};
    const taskList = createDeferred<unknown>();
    const movedCard = { ...sampleCard, title: "Moved during task enrichment" };
    const reloadedCard = { ...sampleCard, title: "Reloaded after task invalidation" };
    let listCalls = 0;
    let taskCalls = 0;
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        listCalls += 1;
        return listCalls === 1
          ? { cards: [sampleCard], statuses: ["todo", "done"] }
          : { cards: [reloadedCard], statuses: ["todo", "done"] };
      }
      if (method === "tasks.list") {
        taskCalls += 1;
        return taskCalls === 1 ? taskList.promise : { tasks: [] };
      }
      if (method === "workboard.cards.move") {
        return { card: movedCard };
      }
      return {};
    });

    const initialLoad = loadWorkboard({ host, client: client as never });
    await Promise.resolve();
    await Promise.resolve();
    expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });

    await moveWorkboardCard({
      host,
      client: client as never,
      cardId: sampleCard.id,
      status: "review",
      position: 2000,
    });
    taskList.resolve({ tasks: [sampleTask] });
    await expect(initialLoad).resolves.toBe(false);

    const state = getWorkboardState(host);
    expect(state.loaded).toBe(false);
    expect(state.loadAttempted).toBe(false);

    await loadWorkboard({ host, client: client as never });
    expect(state.cards).toMatchObject([{ title: "Reloaded after task invalidation" }]);
    expect(state.loaded).toBe(true);
  });

  it("links cards from paginated Gateway task results", async () => {
    const host = {};
    const linked = {
      ...sampleCard,
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    } satisfies WorkboardCard;
    const client = createClient((method, params) => {
      if (method === "workboard.cards.list") {
        return { cards: [linked], statuses: ["todo", "done"] };
      }
      if (method === "tasks.list" && (params as { cursor?: string }).cursor === "page-2") {
        return { tasks: [sampleTask] };
      }
      if (method === "tasks.list") {
        return { tasks: [], nextCursor: "page-2" };
      }
      return {};
    });

    await loadWorkboard({ host, client: client as never, force: true });

    expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    expect(client.request).toHaveBeenCalledWith("tasks.list", {
      limit: 500,
      cursor: "page-2",
    });
    expect(getWorkboardState(host).cards[0]).toMatchObject({ taskId: "task-1" });
  });

  it("summarizes parent dependency readiness from loaded cards", () => {
    const parentDone = {
      ...sampleCard,
      id: "parent-done",
      title: "Done parent",
      status: "done",
    } satisfies WorkboardCard;
    const parentTodo = {
      ...sampleCard,
      id: "parent-todo",
      title: "Todo parent",
      status: "todo",
    } satisfies WorkboardCard;
    const child = {
      ...sampleCard,
      id: "child-1",
      metadata: {
        links: [
          { id: "link-1", type: "parent", targetCardId: parentDone.id, createdAt: 1 },
          { id: "link-2", type: "parent", targetCardId: parentTodo.id, createdAt: 1 },
          { id: "link-3", type: "parent", targetCardId: "missing-parent", createdAt: 1 },
        ],
      },
    } satisfies WorkboardCard;

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
    const running = {
      ...sampleCard,
      id: "running",
      status: "running",
      sessionKey: sampleSession.key,
    } satisfies WorkboardCard;
    const blocked = { ...sampleCard, id: "blocked", status: "blocked" } satisfies WorkboardCard;
    const ready = { ...sampleCard, id: "ready", status: "ready" } satisfies WorkboardCard;
    const missingProof = { ...sampleCard, id: "done", status: "done" } satisfies WorkboardCard;
    const artifactProof = {
      ...sampleCard,
      id: "artifact-proof",
      status: "done",
      metadata: { artifacts: [{ id: "artifact-1", createdAt: 1, label: "log" }] },
    } satisfies WorkboardCard;
    const failed = {
      ...sampleCard,
      id: "failed",
      metadata: {
        failureCount: 2,
        attempts: [{ id: "attempt-1", status: "blocked", startedAt: 1 }],
        stale: { detectedAt: 2, reason: "old" },
      },
    } satisfies WorkboardCard;
    const recovered = {
      ...sampleCard,
      id: "recovered",
      metadata: {
        failureCount: 0,
        attempts: [{ id: "attempt-1", status: "failed", startedAt: 1 }],
      },
    } satisfies WorkboardCard;
    const tasksByCardId = new Map<string, WorkboardTaskSummary>([
      [
        "ready",
        {
          ...sampleTask,
          taskId: "task-ready",
          id: "task-ready",
          status: "timed_out",
        },
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
    const represented = {
      ...sampleCard,
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
    } satisfies WorkboardCard;
    const unrepresented = {
      ...sampleCard,
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
    } satisfies WorkboardCard;
    const tasksByCardId = new Map<string, WorkboardTaskSummary>([
      ["represented", { ...sampleTask, status: "failed" }],
      ["unrepresented", { ...sampleTask, status: "failed" }],
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
    const taskRunOnly = {
      ...sampleCard,
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
    } satisfies WorkboardCard;
    const attemptRunOnly = {
      ...sampleCard,
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
    } satisfies WorkboardCard;
    const tasksByCardId = new Map<string, WorkboardTaskSummary>([
      ["task-run-only", { ...sampleTask, status: "failed" }],
      ["attempt-run-only", { ...sampleTask, status: "failed", runId: undefined }],
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
    const card = {
      ...sampleCard,
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
    } satisfies WorkboardCard;
    const tasksByCardId = new Map<string, WorkboardTaskSummary>([
      [
        card.id,
        {
          ...sampleTask,
          status: "failed",
          childSessionKey: `agent:main:${sampleTaskSessionKey}`,
        },
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
      { ...sampleCard, id: "default-agent" },
      { ...sampleCard, id: "assigned", agentId: "agent-1" },
      { ...sampleCard, id: "ready", status: "ready" },
      { ...sampleCard, id: "review", status: "review" },
      { ...sampleCard, id: "done", status: "done", completedAt: now - 60_000 },
      {
        ...sampleCard,
        id: "old-done",
        status: "done",
        completedAt: now - 10 * 24 * 60 * 60 * 1000,
      },
    ] satisfies WorkboardCard[];

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
    const host = {};
    const linked = {
      ...sampleCard,
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    } satisfies WorkboardCard;
    const client = createClient({
      "workboard.cards.list": { cards: [linked], statuses: ["todo", "done"] },
      "tasks.list": {
        tasks: [
          {
            ...sampleTask,
            childSessionKey: `agent:main:${sampleTaskSessionKey}`,
            runId: "run-1",
          },
        ],
      },
    });

    await loadWorkboard({ host, client: client as never, force: true });

    expect(getWorkboardState(host).cards[0]).toMatchObject({ taskId: "task-1" });
  });

  it("does not relink a loaded card to a stale task from another session", async () => {
    const host = {};
    const linked = {
      ...sampleCard,
      sessionKey: "agent:main:dashboard:new",
      runId: "run-1",
    } satisfies WorkboardCard;
    const client = createClient({
      "workboard.cards.list": { cards: [linked], statuses: ["todo", "done"] },
      "tasks.list": {
        tasks: [
          {
            ...sampleTask,
            childSessionKey: sampleTaskSessionKey,
            runId: "run-1",
          },
        ],
      },
    });

    await loadWorkboard({ host, client: client as never, force: true });

    const state = getWorkboardState(host);
    expect(state.cards[0]).not.toHaveProperty("taskId");
    expect(state.tasksByCardId.has("card-1")).toBe(false);
  });

  it("preserves contract-owned metadata loaded from the plugin gateway method", async () => {
    const host = {};
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

    await loadWorkboard({ host, client: client as never, force: true });

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
    const host = {};
    const state = getWorkboardState(host);
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
    const updated = {
      ...sampleCard,
      title: "Updated board",
      notes: "New notes",
      status: "review",
      priority: "high",
      labels: ["ui", "polish"],
      agentId: "dev",
      sessionKey: sampleSession.key,
    };
    const client = createClient({ "workboard.cards.update": { card: updated } });

    await saveWorkboardCardDraft({ host, client: client as never });

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
    const host = {};
    const state = getWorkboardState(host);
    state.draftTitle = "Write tests";
    state.draftNotes = "Cover the happy path";
    state.draftSessionKey = "agent:main:dashboard:1";
    const created = {
      ...sampleCard,
      id: "card-2",
      title: "Write tests",
      sessionKey: "agent:main:dashboard:1",
    };
    const client = createClient({ "workboard.cards.create": { card: created } });

    await saveWorkboardCardDraft({ host, client: client as never });

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

  it("creates template-backed cards through the save action", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.draftTitle = "Fix: flaky worker";
    state.draftTemplateId = "bugfix";
    const created = {
      ...sampleCard,
      id: "card-2",
      title: "Fix: flaky worker",
      metadata: { templateId: "bugfix" },
    } satisfies WorkboardCard;
    const client = createClient({ "workboard.cards.create": { card: created } });

    await saveWorkboardCardDraft({ host, client: client as never });

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
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      sessionKey: sampleSession.key,
      execution: {
        id: "exec-1",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "openai/gpt-5.5",
        sessionKey: sampleSession.key,
        startedAt: 1,
        updatedAt: 1,
      },
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [linked];
    state.draftOpen = true;
    state.editingCardId = linked.id;
    state.draftTitle = linked.title;
    state.draftNotes = linked.notes ?? "";
    state.draftStatus = "running";
    state.draftPriority = linked.priority;
    state.draftLabels = linked.labels.join(", ");
    state.draftAgentId = linked.agentId ?? "";
    state.draftSessionKey = linked.sessionKey ?? "";
    const saved = {
      ...linked,
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
    } satisfies WorkboardCard;
    const client = createClient((method) => {
      if (method === "workboard.cards.update") {
        return { card: saved };
      }
      return {};
    });

    await saveWorkboardCardDraft({ host, client: client as never });
    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [{ ...sampleSession, hasActiveRun: false, status: "done", updatedAt: 1 }],
    });

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
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.dispatching = true;
    state.cards = [{ ...sampleCard, sessionKey: sampleSession.key }];
    const client = createClient({
      "workboard.cards.update": { card: { ...sampleCard, status: "running" } },
    });

    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [{ ...sampleSession, status: "running", hasActiveRun: true }],
    });

    expect(client.request).not.toHaveBeenCalled();
  });

  it.each(["editing", "dragging"] as const)(
    "does not start lifecycle writes while a card is %s",
    async (interaction) => {
      const host = {};
      const state = getWorkboardState(host);
      state.loaded = true;
      state.cards = [{ ...sampleCard, sessionKey: sampleSession.key }];
      if (interaction === "editing") {
        state.draftOpen = true;
        state.editingCardId = sampleCard.id;
      } else {
        state.draggedCardId = sampleCard.id;
      }
      const client = createClient({
        "workboard.cards.update": { card: { ...sampleCard, status: "running" } },
      });

      await syncWorkboardLifecycle({
        host,
        client: client as never,
        sessions: [{ ...sampleSession, status: "running", hasActiveRun: true }],
      });

      expect(client.request).not.toHaveBeenCalled();
    },
  );

  it("does not start lifecycle writes while a canonical refresh is loading", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [{ ...sampleCard, sessionKey: sampleSession.key }];
    const loadResponse = createDeferred<unknown>();
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return loadResponse.promise;
      }
      if (method === "workboard.cards.update") {
        return { card: { ...sampleCard, status: "running" } };
      }
      return {};
    });

    const loading = loadWorkboard({ host, client: client as never, force: true });
    await Promise.resolve();
    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [{ ...sampleSession, status: "running", hasActiveRun: true }],
    });

    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request).toHaveBeenCalledWith("workboard.cards.list", {});
    loadResponse.resolve({ cards: [sampleCard] });
    await loading;
  });

  it("does not start lifecycle writes while edit-modal saves are in flight", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      sessionKey: sampleSession.key,
      execution: {
        id: "exec-1",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "openai/gpt-5.5",
        sessionKey: sampleSession.key,
        startedAt: 1,
        updatedAt: 1,
      },
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [linked];
    state.draftOpen = true;
    state.editingCardId = linked.id;
    state.draftTitle = linked.title;
    state.draftNotes = linked.notes ?? "";
    state.draftStatus = "running";
    state.draftPriority = linked.priority;
    state.draftLabels = linked.labels.join(", ");
    state.draftAgentId = linked.agentId ?? "";
    state.draftSessionKey = linked.sessionKey ?? "";
    const saved = {
      ...linked,
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
    } satisfies WorkboardCard;
    const saveResponse = createDeferred<{ card: WorkboardCard }>();
    const client = createClient((method) => {
      if (method === "workboard.cards.update") {
        return saveResponse.promise;
      }
      return {};
    });

    const saving = saveWorkboardCardDraft({ host, client: client as never });
    await Promise.resolve();
    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [{ ...sampleSession, hasActiveRun: false, status: "done", updatedAt: 1 }],
    });

    expect(client.request).toHaveBeenCalledOnce();
    saveResponse.resolve({ card: saved });
    await saving;
    expect(state.cards[0]).toMatchObject({ status: "running" });
  });

  it("adds operator notes to a selected detail card without opening the edit draft", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.cards = [sampleCard];
    state.detailCardId = sampleCard.id;
    state.detailCommentBody = "Need one more proof run.";
    const updated = {
      ...sampleCard,
      metadata: {
        comments: [{ id: "comment-1", body: "Need one more proof run.", createdAt: 2 }],
      },
    } satisfies WorkboardCard;
    const client = createClient({ "workboard.cards.comment": { card: updated } });

    await addWorkboardCardComment({
      host,
      client: client as never,
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
    const host = {};
    const session = {
      ...sampleSession,
      label: "Fix login",
      status: "done",
      hasActiveRun: false,
    } as const;
    const created = {
      ...sampleCard,
      title: "Fix login",
      status: "review",
      sessionKey: sampleSession.key,
    } as const;
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return { cards: [], statuses: ["todo", "running", "review"] };
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
        `Thread: ${sampleSession.key}`,
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

  it("does not duplicate existing captured sessions", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const existing = {
      ...sampleCard,
      execution: {
        id: "exec-1",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        model: "openai/gpt-5.5",
        status: "running",
        sessionKey: sampleSession.key,
        startedAt: 1,
        updatedAt: 1,
      },
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [existing];
    const client = createClient({});

    const card = await captureSessionToWorkboard({
      host,
      client: client as never,
      session: sampleSession,
    });

    expect(card).toBe(existing);
    expect(client.request).not.toHaveBeenCalled();
  });

  it("restores archived captured sessions instead of leaving them hidden", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const archived = {
      ...sampleCard,
      sessionKey: sampleSession.key,
      metadata: { archivedAt: 10 },
    } satisfies WorkboardCard;
    const restored = {
      ...archived,
      metadata: {},
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [archived];
    const client = createClient({
      "workboard.cards.archive": { card: restored },
    });

    const card = await captureSessionToWorkboard({
      host,
      client: client as never,
      session: sampleSession,
    });

    expect(card).toMatchObject({ id: restored.id, sessionKey: sampleSession.key });
    expect(card?.metadata?.archivedAt).toBeUndefined();
    expect(client.request).toHaveBeenCalledWith("workboard.cards.archive", {
      id: archived.id,
      archived: false,
    });
    expect(state.cards[0]?.metadata?.archivedAt).toBeUndefined();
  });

  it("does not start duplicate capture requests while a session is in flight", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.capturingSessionKeys.add(sampleSession.key);
    const existing = { ...sampleCard, sessionKey: sampleSession.key };
    state.cards = [existing];
    const client = createClient({});

    const card = await captureSessionToWorkboard({
      host,
      client: client as never,
      session: sampleSession,
    });

    expect(card).toBe(existing);
    expect(client.request).not.toHaveBeenCalled();
  });

  it("captures different sessions concurrently", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    const firstSession = { ...sampleSession, key: "agent:main:dashboard:first" };
    const secondSession = { ...sampleSession, key: "agent:main:dashboard:second" };
    const firstCard = { ...sampleCard, id: "card-first", sessionKey: firstSession.key };
    const secondCard = { ...sampleCard, id: "card-second", sessionKey: secondSession.key };
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

    const firstCapture = captureSessionToWorkboard({
      host,
      client: client as never,
      session: firstSession,
    });
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
    const host = {};
    const state = getWorkboardState(host);
    const list = createDeferred<unknown>();
    const create = createDeferred<unknown>();
    const created = { ...sampleCard, sessionKey: sampleSession.key };
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

    const firstCapture = captureSessionToWorkboard({
      host,
      client: client as never,
      session: sampleSession,
    });
    const secondCapture = captureSessionToWorkboard({
      host,
      client: client as never,
      session: sampleSession,
    });
    list.resolve({ cards: [], statuses: ["todo"] });
    await waitForFast(() => {
      expect(client.request).toHaveBeenCalledWith(
        "workboard.cards.create",
        expect.objectContaining({ sessionKey: sampleSession.key }),
      );
    });

    expect(
      client.request.mock.calls.filter(([method]) => method === "workboard.cards.create"),
    ).toHaveLength(1);
    create.resolve({ card: created });
    const captures = await Promise.all([firstCapture, secondCapture]);

    expect(captures.filter(Boolean)).toEqual([created]);
    expect(state.cards).toEqual([created]);
    expect(state.capturingSessionKeys.size).toBe(0);
  });

  it("does not capture sessions while dispatch is active", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.dispatching = true;
    const client = createClient({});

    const card = await captureSessionToWorkboard({
      host,
      client: client as never,
      session: sampleSession,
    });

    expect(card).toBeNull();
    expect(client.request).not.toHaveBeenCalled();
  });

  it("does not create capture cards when the duplicate preflight list fails", async () => {
    const host = {};
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        throw new Error("list unavailable");
      }
      return {};
    });

    const card = await captureSessionToWorkboard({
      host,
      client: client as never,
      session: sampleSession,
    });

    expect(card).toBeNull();
    expect(client.request).toHaveBeenCalledOnce();
    expect(client.request).toHaveBeenCalledWith("workboard.cards.list", {});
  });

  it("waits for an in-flight Workboard load before capturing a session", async () => {
    const host = {};
    const list = createDeferred<unknown>();
    const created = { ...sampleCard, sessionKey: sampleSession.key };
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

    const loading = loadWorkboard({ host, client: client as never, force: true });
    const captured = captureSessionToWorkboard({
      host,
      client: client as never,
      session: sampleSession,
    });

    await Promise.resolve();
    expect(client.request).toHaveBeenCalledTimes(1);
    list.resolve({ cards: [], statuses: ["todo"] });
    await loading;

    await expect(captured).resolves.toMatchObject({ sessionKey: sampleSession.key });
    expect(client.request).toHaveBeenCalledWith("workboard.cards.create", expect.any(Object));
  });

  it("waits for retained lifecycle writes before capturing after teardown", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const lifecycleCard = {
      ...sampleCard,
      sessionKey: sampleSession.key,
    } satisfies WorkboardCard;
    const capturedSession = {
      ...sampleSession,
      key: "agent:main:dashboard:capture",
    };
    const capturedCard = {
      ...sampleCard,
      id: "captured-card",
      sessionKey: capturedSession.key,
    };
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
    state.loaded = true;
    state.cards = [lifecycleCard];
    state.lifecycleTasksPrepared = true;
    state.lifecycleTasksPreparedAt = Date.now();

    const syncing = syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [sampleSession],
    });
    await waitForFast(() => {
      expect(client.request).toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    });
    stopWorkboardLifecycleRefresh(host);
    const capture = captureSessionToWorkboard({
      host,
      client: client as never,
      session: capturedSession,
    });
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
    const host = {};
    const titlePrefix = "x".repeat(176);
    const textPrefix = "y".repeat(696);
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return { cards: [], statuses: ["todo"] };
      }
      if (method === "chat.history") {
        return {
          messages: [{ role: "user", content: [{ type: "text", text: `${textPrefix}😀tail` }] }],
        };
      }
      if (method === "workboard.cards.create") {
        return { card: { ...sampleCard, title: `${titlePrefix}...` } };
      }
      return {};
    });

    await captureSessionToWorkboard({
      host,
      client: client as never,
      session: { ...sampleSession, label: `${titlePrefix}😀tail` },
    });

    expect(client.request).toHaveBeenNthCalledWith(
      3,
      "workboard.cards.create",
      expect.objectContaining({
        title: `${titlePrefix}...`,
        notes: [`Thread: ${sampleSession.key}`, "", `Recent user prompt: ${textPrefix}...`].join(
          "\n",
        ),
      }),
    );
  });

  it("starts a task run and links it back to the card", async () => {
    const host = {};
    const running = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
      taskId: "task-1",
    };
    const client = createClient({
      agent: { sessionKey: sampleTaskSessionKey, runId: "run-1" },
      "tasks.list": { tasks: [sampleTask] },
      "workboard.cards.update": { card: running },
    });

    const sessionKey = await startWorkboardCard({
      host,
      client: client as never,
      card: sampleCard,
    });

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
    const host = {};
    const title = `${"a".repeat(499)}🚀tail`;
    const client = createClient({
      agent: { sessionKey: sampleTaskSessionKey, runId: "run-1" },
      "tasks.list": { tasks: [sampleTask] },
      "workboard.cards.update": { card: { ...sampleCard, title, status: "running" } },
    });

    await startWorkboardCard({
      host,
      client: client as never,
      card: { ...sampleCard, title },
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
    const host = {};
    const expectedSessionKey = "agent:codex-main:subagent:workboard-default-card-1";
    const staleLinked = {
      ...sampleCard,
      agentId: "codex-main",
      sessionKey: "agent:old-agent:dashboard:stale",
    } satisfies WorkboardCard;
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
        tasks: [{ ...sampleTask, childSessionKey: expectedSessionKey }],
      },
      "workboard.cards.update": { card: running },
    });

    const sessionKey = await startWorkboardCard({
      host,
      client: client as never,
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

  it("waits briefly for task ledger registration after a started run", async () => {
    vi.useFakeTimers();
    const host = {};
    const running = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
      taskId: "task-1",
    };
    let taskLists = 0;
    const client = createClient((method) => {
      if (method === "agent") {
        return { sessionKey: sampleTaskSessionKey, runId: "run-1" };
      }
      if (method === "tasks.list") {
        taskLists += 1;
        return { tasks: taskLists >= 3 ? [sampleTask] : [] };
      }
      return { card: running };
    });

    const started = startWorkboardCard({
      host,
      client: client as never,
      card: sampleCard,
    });
    await vi.advanceTimersByTimeAsync(350);
    const sessionKey = await started;

    expect(sessionKey).toBe(sampleTaskSessionKey);
    expect(taskLists).toBe(3);
    expect(client.request).toHaveBeenLastCalledWith(
      "workboard.cards.update",
      expect.objectContaining({
        patch: expect.objectContaining({ taskId: "task-1" }),
      }),
    );
  });

  it("keeps a successfully started run when task lookup stays unavailable", async () => {
    vi.useFakeTimers();
    const host = {};
    const running = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
    } satisfies WorkboardCard;
    const client = createClient((method) => {
      if (method === "agent") {
        return { sessionKey: sampleTaskSessionKey, runId: "run-1" };
      }
      if (method === "tasks.list") {
        throw new Error("task ledger unavailable");
      }
      return { card: running };
    });

    const started = startWorkboardCard({
      host,
      client: client as never,
      card: sampleCard,
    });
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
    const host = {};
    const parent = { ...sampleCard, id: "parent-1", title: "Parent", status: "running" };
    const child: WorkboardCard = {
      ...sampleCard,
      id: "child-1",
      title: "Child",
      metadata: {
        links: [{ id: "link-1", type: "parent", targetCardId: parent.id, createdAt: 1 }],
      },
    };
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
    await loadWorkboard({ host, client: client as never, force: true });
    client.request.mockClear();

    const sessionKey = await startWorkboardCard({
      host,
      client: client as never,
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
    const host = {};
    const client = createClient((method) => {
      if (method === "workboard.cards.update") {
        throw new Error("Parent cards must be done before starting this card.");
      }
      return { key: "agent:main:dashboard:1" };
    });

    const sessionKey = await startWorkboardCard({
      host,
      client: client as never,
      card: sampleCard,
    });

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
    const host = {};
    const running = { ...sampleCard, status: "running" } satisfies WorkboardCard;
    let updateCalls = 0;
    const client = createClient((method) => {
      if (method === "workboard.cards.update") {
        updateCalls += 1;
        return { card: updateCalls === 1 ? running : sampleCard };
      }
      if (method === "agent") {
        throw new Error("gateway disconnected");
      }
      return {};
    });

    const sessionKey = await startWorkboardCard({
      host,
      client: client as never,
      card: sampleCard,
    });

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
    const host = {};
    const running = { ...sampleCard, status: "running" } satisfies WorkboardCard;
    let updateCalls = 0;
    const client = createClient((method) => {
      if (method === "workboard.cards.update") {
        updateCalls += 1;
        if (updateCalls === 1) {
          return { card: running };
        }
        if (updateCalls === 2) {
          throw new Error("write conflict");
        }
        return { card: sampleCard };
      }
      if (method === "agent") {
        return { sessionKey: sampleTaskSessionKey, runId: "run-1" };
      }
      if (method === "tasks.list") {
        return { tasks: [sampleTask] };
      }
      if (method === "chat.abort") {
        return { aborted: true, runIds: ["run-1"] };
      }
      return {};
    });

    const sessionKey = await startWorkboardCard({
      host,
      client: client as never,
      card: sampleCard,
    });

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
    const host = {};
    const scheduled = {
      ...sampleCard,
      id: "scheduled-1",
      status: "scheduled",
      metadata: { automation: { scheduledAt: Date.now() + 60_000 } },
    } satisfies WorkboardCard;
    const client = createClient({
      "workboard.cards.list": { cards: [scheduled], statuses: ["scheduled", "running", "done"] },
    });
    await loadWorkboard({ host, client: client as never, force: true });
    client.request.mockClear();

    const sessionKey = await startWorkboardCard({
      host,
      client: client as never,
      card: scheduled,
    });

    expect(sessionKey).toBeNull();
    expect(client.request).not.toHaveBeenCalled();
    expect(getWorkboardState(host).error).toBe(
      "Scheduled cards cannot start before their scheduled time.",
    );

    const manualScheduled = {
      ...sampleCard,
      id: "scheduled-2",
      status: "scheduled",
      metadata: { automation: { scheduledAt: Date.now() + 60_000 } },
    } satisfies WorkboardCard;
    const manualLinked = {
      ...manualScheduled,
      status: "todo",
      metadata: {},
      sessionKey: "agent:main:dashboard:manual",
      execution: {
        id: "exec-manual",
        kind: "agent-session",
        engine: "codex",
        mode: "manual",
        status: "idle",
        model: "openai/gpt-5.5",
        sessionKey: "agent:main:dashboard:manual",
        startedAt: 1,
        updatedAt: 1,
      },
    } satisfies WorkboardCard;
    const manualClient = createClient({
      "sessions.create": { key: "agent:main:dashboard:manual" },
      "workboard.cards.update": { card: manualLinked },
    });
    const manualSessionKey = await startWorkboardCard({
      host,
      client: manualClient as never,
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

    const readyWithSchedule = {
      ...sampleCard,
      id: "scheduled-2b",
      status: "ready",
      metadata: { automation: { scheduledAt: Date.now() + 60_000 } },
    } satisfies WorkboardCard;
    const readyManualClient = createClient({
      "sessions.create": { key: "agent:main:dashboard:ready-manual" },
      "workboard.cards.update": {
        card: { ...readyWithSchedule, sessionKey: "agent:main:dashboard:ready-manual" },
      },
    });
    await startWorkboardCard({
      host,
      client: readyManualClient as never,
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

    const dueScheduled = {
      ...scheduled,
      id: "scheduled-3",
      metadata: { automation: { scheduledAt: Date.now() - 60_000 } },
    } satisfies WorkboardCard;
    const dueRunning = {
      ...dueScheduled,
      status: "running",
      sessionKey: "subagent:workboard-default-scheduled-3",
      runId: "run-due",
      taskId: "task-due",
    } satisfies WorkboardCard;
    const dueClient = createClient((method) => {
      if (method === "workboard.cards.list") {
        return { cards: [dueScheduled], statuses: ["scheduled", "running", "done"] };
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
            {
              ...sampleTask,
              id: "task-due",
              taskId: "task-due",
              childSessionKey: "subagent:workboard-default-scheduled-3",
              runId: "run-due",
            },
          ],
        };
      }
      if (method === "workboard.cards.update") {
        return { card: dueRunning };
      }
      return {};
    });
    await loadWorkboard({ host, client: dueClient as never, force: true });
    dueClient.request.mockClear();

    const dueSessionKey = await startWorkboardCard({
      host,
      client: dueClient as never,
      card: dueScheduled,
    });

    expect(dueSessionKey).toBe("subagent:workboard-default-scheduled-3");
    expect(dueClient.request).toHaveBeenCalledWith(
      "agent",
      expect.objectContaining({
        label: "Build board (schedule)",
      }),
    );
  });

  it("starts a Codex execution with an explicit model override", async () => {
    const host = {};
    const running = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleTaskSessionKey,
      taskId: "task-1",
      execution: {
        id: "card-1:codex",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        model: "openai/gpt-5.6-sol",
        status: "running",
        sessionKey: sampleTaskSessionKey,
        runId: "run-1",
        startedAt: 10,
        updatedAt: 10,
      },
    };
    let updateCalls = 0;
    const client = createClient((method) => {
      if (method === "workboard.cards.update") {
        updateCalls += 1;
        return { card: updateCalls === 1 ? { ...sampleCard, status: "running" } : running };
      }
      if (method === "agent") {
        return { sessionKey: sampleTaskSessionKey, runId: "run-1" };
      }
      if (method === "tasks.list") {
        return { tasks: [sampleTask] };
      }
      return {};
    });

    await startWorkboardCard({
      host,
      client: client as never,
      card: sampleCard,
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
      const host = {};
      const previous = {
        ...sampleCard,
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
      } satisfies WorkboardCard;
      const client = createClient({
        agent: { sessionKey: "agent:main:dashboard:1", runId: "run-2" },
        "tasks.list": {
          tasks: [
            {
              ...sampleTask,
              taskId: "task-2",
              id: "task-2",
              childSessionKey: "agent:main:dashboard:1",
              runId: "run-2",
            },
          ],
        },
        "workboard.cards.update": { card: previous },
      });

      await startWorkboardCard({
        host,
        client: client as never,
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
    const host = {};
    const running = {
      ...sampleCard,
      status: "todo",
      sessionKey: "agent:main:dashboard:1",
      execution: {
        id: "card-1:claude",
        kind: "agent-session",
        engine: "claude",
        mode: "manual",
        status: "idle",
        model: "anthropic/claude-sonnet-4-6",
        sessionKey: "agent:main:dashboard:1",
        startedAt: 10,
        updatedAt: 10,
      },
    };
    const client = createClient({
      "sessions.create": { key: "agent:main:dashboard:1", runStarted: false },
      "workboard.cards.update": { card: running },
    });

    const sessionKey = await startWorkboardCard({
      host,
      client: client as never,
      card: sampleCard,
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
    const host = {};
    const staleLinkedCard = {
      ...sampleCard,
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
      taskId: "task-1",
      execution: {
        id: "card-1:codex",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "blocked",
        model: "openai/gpt-5.5",
        sessionKey: sampleTaskSessionKey,
        runId: "run-1",
        startedAt: 10,
        updatedAt: 20,
      },
    } satisfies WorkboardCard;
    const reopened = {
      ...sampleCard,
      sessionKey: "agent:main:dashboard:new",
      execution: {
        id: "card-1:claude",
        kind: "agent-session",
        engine: "claude",
        mode: "manual",
        status: "idle",
        model: "anthropic/claude-sonnet-4-6",
        sessionKey: "agent:main:dashboard:new",
        startedAt: 10,
        updatedAt: 10,
      },
    } satisfies WorkboardCard;
    const client = createClient({
      "sessions.create": { key: "agent:main:dashboard:new", runStarted: false },
      "workboard.cards.update": { card: reopened },
    });
    getWorkboardState(host).tasksByCardId.set("card-1", sampleTask);

    await startWorkboardCard({
      host,
      client: client as never,
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
    const host = {};
    let updateCalls = 0;
    const client = createClient((method) => {
      if (method === "agent") {
        return {
          sessionKey: sampleTaskSessionKey,
          runStarted: false,
          runError: { message: "provider unavailable" },
        };
      }
      if (method === "workboard.cards.update") {
        updateCalls += 1;
        return { card: updateCalls === 1 ? { ...sampleCard, status: "running" } : sampleCard };
      }
      return {};
    });

    const sessionKey = await startWorkboardCard({
      host,
      client: client as never,
      card: sampleCard,
    });

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
    const host = {};
    const moved = { ...sampleCard, status: "blocked", position: 2000 };
    const client = createClient({ "workboard.cards.move": { card: moved } });

    await moveWorkboardCard({
      host,
      client: client as never,
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
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      sessionKey: sampleSession.key,
      execution: {
        id: "exec-1",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        model: "openai/gpt-5.5",
        status: "running",
        sessionKey: sampleSession.key,
        startedAt: 1,
        updatedAt: 1,
      },
    } satisfies WorkboardCard;
    const moved = {
      ...linked,
      status: "running",
      position: 2000,
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
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [linked];
    const client = createClient((method) => {
      if (method === "workboard.cards.move") {
        return { card: moved };
      }
      if (method === "workboard.cards.update") {
        return { card: { ...moved, status: "review", updatedAt: 3 } };
      }
      return {};
    });

    await moveWorkboardCard({
      host,
      client: client as never,
      cardId: "card-1",
      status: "running",
      position: 2000,
    });
    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [{ ...sampleSession, hasActiveRun: false, status: "done", updatedAt: 1 }],
    });

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
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      sessionKey: sampleSession.key,
      execution: {
        id: "exec-1",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "openai/gpt-5.5",
        sessionKey: sampleSession.key,
        startedAt: 1,
        updatedAt: 1,
      },
    } satisfies WorkboardCard;
    const moved = {
      ...linked,
      status: "running",
      position: 2000,
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
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [linked];
    const moveResponse = createDeferred<{ card: WorkboardCard }>();
    const client = createClient((method) => {
      if (method === "workboard.cards.move") {
        return moveResponse.promise;
      }
      return {};
    });

    const moving = moveWorkboardCard({
      host,
      client: client as never,
      cardId: "card-1",
      status: "running",
      position: 2000,
    });
    await Promise.resolve();
    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [{ ...sampleSession, hasActiveRun: false, status: "done", updatedAt: 1 }],
    });

    expect(client.request).toHaveBeenCalledOnce();
    moveResponse.resolve({ card: moved });
    await moving;
    expect(state.cards[0]).toMatchObject({ status: "running", position: 2000 });
  });

  it("ignores stale lifecycle responses when dragged status changes while sync is in flight", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const linked = { ...sampleCard, sessionKey: sampleSession.key } satisfies WorkboardCard;
    const moved = {
      ...linked,
      status: "running",
      position: 2000,
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
    } satisfies WorkboardCard;
    const staleLifecycleCard = {
      ...linked,
      status: "review",
      updatedAt: 3,
      metadata: { lifecycleStatusSourceUpdatedAt: 1 },
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [linked];
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

    const syncing = syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [{ ...sampleSession, hasActiveRun: false, status: "done", updatedAt: 1 }],
    });
    await Promise.resolve();
    await moveWorkboardCard({
      host,
      client: client as never,
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
    const host = {};
    const state = getWorkboardState(host);
    const linked = { ...sampleCard, sessionKey: sampleSession.key } satisfies WorkboardCard;
    const commented = {
      ...linked,
      updatedAt: 2,
      metadata: {
        comments: [{ id: "comment-1", body: "Keep this", createdAt: 2 }],
      },
    } satisfies WorkboardCard;
    const lifecycleResponse = createDeferred<{ card: WorkboardCard }>();
    state.loaded = true;
    state.cards = [linked];
    const client = createClient((method) => {
      if (method === "workboard.cards.update") {
        return lifecycleResponse.promise;
      }
      if (method === "workboard.cards.comment") {
        return { card: commented };
      }
      return {};
    });

    const syncing = syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [{ ...sampleSession, hasActiveRun: false, status: "done", updatedAt: 1 }],
    });
    await Promise.resolve();
    await addWorkboardCardComment({
      host,
      client: client as never,
      cardId: linked.id,
      body: "Keep this",
    });
    lifecycleResponse.resolve({ card: { ...linked, status: "review", updatedAt: 3 } });
    await syncing;

    expect(state.cards[0]?.metadata?.comments?.[0]?.body).toBe("Keep this");
  });

  it("ignores lifecycle responses without provenance when dragged status changes while sync is in flight", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      sessionKey: sampleSession.key,
      execution: {
        id: "exec-1",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        model: "openai/gpt-5.5",
        status: "running",
        sessionKey: sampleSession.key,
        startedAt: 1,
        updatedAt: 1,
      },
    } satisfies WorkboardCard;
    const moved = {
      ...linked,
      status: "running",
      position: 2000,
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
    } satisfies WorkboardCard;
    const staleLifecycleCard = {
      ...linked,
      status: "review",
      updatedAt: 3,
      execution: { ...linked.execution, status: "review" as const, updatedAt: 3 },
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [linked];
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

    const syncing = syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [{ ...sampleSession, hasActiveRun: false, status: "done", updatedAt: null }],
    });
    await Promise.resolve();
    await moveWorkboardCard({
      host,
      client: client as never,
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
    const host = {};
    const state = getWorkboardState(host);
    const edited = {
      ...sampleCard,
      title: "Renamed only",
      status: "running",
      sessionKey: sampleSession.key,
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
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [edited];
    const client = createClient({
      "workboard.cards.update": {
        card: { ...edited, status: "review", updatedAt: 6 },
      },
    });

    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [{ ...sampleSession, hasActiveRun: false, status: "done", updatedAt: 3 }],
    });

    expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: "card-1",
      patch: expect.objectContaining({ status: "review" }),
    });
    expect(state.cards[0]).toMatchObject({ title: "Renamed only", status: "review" });
  });

  it("keeps lifecycle-created moves following newer linked session lifecycle sync", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const lifecycleMoved = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleSession.key,
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
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [lifecycleMoved];
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

    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [{ ...sampleSession, hasActiveRun: false, status: "done", updatedAt: 3 }],
    });

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
    const host = {};
    const parent: WorkboardCard = {
      ...sampleCard,
      id: "parent-1",
      title: "Parent",
      status: "done",
    };
    const child: WorkboardCard = {
      ...sampleCard,
      id: "child-1",
      title: "Child",
      metadata: {
        links: [{ id: "link-1", type: "parent", targetCardId: parent.id, createdAt: 1 }],
      },
    };
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

    await deleteWorkboardCard({
      host,
      client: client as never,
      cardId: parent.id,
    });

    const remaining = expectDefined(getWorkboardState(host).cards[0], "remaining child card");
    expect(remaining).toMatchObject({ id: child.id });
    expect(remaining.metadata?.links).toBeUndefined();

    client.request.mockClear();
    await startWorkboardCard({
      host,
      client: client as never,
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
    expect(getWorkboardLifecycle(sampleCard, [sampleSession])).toEqual({
      session: null,
      state: "unlinked",
    });

    const linked = { ...sampleCard, sessionKey: sampleSession.key };
    expect(getWorkboardLifecycle(linked, [sampleSession])).toMatchObject({
      state: "running",
      targetStatus: "running",
    });
    expect(
      getWorkboardLifecycle(linked, [{ ...sampleSession, hasActiveRun: false, status: "running" }]),
    ).toMatchObject({
      state: "running",
      targetStatus: "running",
    });
    expect(
      getWorkboardLifecycle(linked, [{ ...sampleSession, hasActiveRun: false, status: "done" }]),
    ).toMatchObject({
      state: "succeeded",
      targetStatus: "review",
    });
    expect(
      getWorkboardLifecycle(linked, [{ ...sampleSession, hasActiveRun: false, status: "failed" }]),
    ).toMatchObject({
      state: "failed",
      targetStatus: "blocked",
    });
    expect(
      getWorkboardLifecycle(linked, [
        {
          ...sampleSession,
          hasActiveRun: false,
          status: "running",
          updatedAt: Date.now() - 31 * 60 * 1000,
        },
      ]),
    ).toMatchObject({
      state: "stale",
      targetStatus: "running",
    });
    expect(
      getWorkboardLifecycle(linked, [
        { ...sampleSession, hasActiveRun: true, updatedAt: Date.now() - 31 * 60 * 1000 },
      ]),
    ).toMatchObject({
      state: "running",
      targetStatus: "running",
    });
    expect(
      getWorkboardLifecycle(linked, [
        { ...sampleSession, hasActiveRun: undefined, updatedAt: Date.now() - 31 * 60 * 1000 },
      ]),
    ).toMatchObject({
      state: "running",
      targetStatus: "running",
    });
    expect(
      getWorkboardLifecycle(
        {
          ...sampleCard,
          execution: {
            id: "exec-1",
            kind: "agent-session",
            engine: "codex",
            mode: "autonomous",
            status: "running",
            model: "openai/gpt-5.5",
            sessionKey: sampleSession.key,
            startedAt: 1,
            updatedAt: 1,
          },
        },
        [sampleSession],
      ),
    ).toMatchObject({
      state: "running",
      targetStatus: "running",
    });
  });

  it("derives lifecycle state from linked Gateway tasks", () => {
    const linked = { ...sampleCard, sessionKey: sampleTaskSessionKey, runId: "run-1" };

    expect(getWorkboardLifecycle(linked, [], sampleTask)).toMatchObject({
      state: "running",
      targetStatus: "running",
    });
    expect(getWorkboardLifecycle(linked, [], { ...sampleTask, status: "completed" })).toMatchObject(
      {
        state: "succeeded",
        targetStatus: "review",
      },
    );
    expect(getWorkboardLifecycle(linked, [], { ...sampleTask, status: "timed_out" })).toMatchObject(
      {
        state: "failed",
        targetStatus: "blocked",
      },
    );
    expect(
      getWorkboardLifecycle(
        linked,
        [{ ...sampleSession, key: sampleTaskSessionKey, hasActiveRun: false, status: "done" }],
        sampleTask,
      ),
    ).toMatchObject({
      state: "succeeded",
      targetStatus: "review",
    });
  });

  it("syncs linked card status from session lifecycle without overriding manual review", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      { ...sampleCard, sessionKey: sampleSession.key },
      { ...sampleCard, id: "card-review", status: "review", sessionKey: "session-review" },
    ];
    const client = createClient((method) => {
      if (method === "workboard.cards.update") {
        return { card: { ...sampleCard, status: "running", sessionKey: sampleSession.key } };
      }
      return {};
    });

    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [
        sampleSession,
        { ...sampleSession, key: "session-review", status: "failed", hasActiveRun: false },
      ],
    });

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
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        ...sampleCard,
        status: "running",
        sessionKey: sampleSession.key,
        createdAt: 2000,
        updatedAt: 2000,
        events: [{ id: "event-created", kind: "created", at: 2000, toStatus: "running" }],
      },
    ];
    const client = createClient({
      "workboard.cards.update": {
        card: { ...sampleCard, status: "review", sessionKey: sampleSession.key },
      },
    });

    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [
        {
          ...sampleSession,
          status: "done",
          hasActiveRun: false,
          updatedAt: 1000,
        },
      ],
    });

    expect(client.request).toHaveBeenCalledOnce();
    expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    expect(state.cards[0]?.status).toBe("running");
  });

  it("does not sync linked card status from sessions without lifecycle provenance", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [{ ...sampleCard, sessionKey: sampleSession.key }];
    const client = createClient({
      "workboard.cards.update": {
        card: { ...sampleCard, status: "review", sessionKey: sampleSession.key },
      },
    });

    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [
        {
          ...sampleSession,
          status: "done",
          hasActiveRun: false,
          updatedAt: null,
        },
      ],
    });

    expect(client.request).not.toHaveBeenCalled();
    expect(state.cards[0]).toMatchObject({ status: "todo" });
  });

  it("refreshes task lifecycle before syncing task-backed cards", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
      taskId: "task-1",
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [linked];
    state.tasksByCardId.set("card-1", sampleTask);
    const client = createClient({
      "tasks.list": { tasks: [{ ...sampleTask, status: "completed" }] },
      "workboard.cards.update": {
        card: { ...linked, status: "review" },
      },
    });

    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [],
    });

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
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
      taskId: "task-1",
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [linked];
    state.tasksByCardId.set("card-1", sampleTask);
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

    const sync = syncWorkboardLifecycle({ host, client: client as never, sessions: [] });
    await waitForFast(() => {
      expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    });
    stopWorkboardLifecycleRefresh(host);
    taskList.resolve({ tasks: [{ ...sampleTask, status: "completed" }] });
    await sync;

    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    expect(state.cards[0]?.status).toBe("running");
  });

  it("cancels remaining lifecycle card writes when refresh stops", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const first = { ...sampleCard, id: "card-1", sessionKey: "session-1" };
    const second = { ...sampleCard, id: "card-2", sessionKey: "session-2" };
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
    const sessions = [
      { ...sampleSession, key: "session-1" },
      { ...sampleSession, key: "session-2" },
    ];

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

    expect(
      client.request.mock.calls.filter(([method]) => method === "workboard.cards.update"),
    ).toHaveLength(1);
  });

  it("reuses an in-flight lifecycle task refresh across render-driven syncs", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
      taskId: "task-1",
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [linked];
    state.tasksByCardId.set("card-1", sampleTask);
    const taskList = createDeferred<unknown>();
    const client = createClient((method) => {
      if (method === "tasks.list") {
        return taskList.promise;
      }
      return {};
    });

    const first = syncWorkboardLifecycle({ host, client: client as never, sessions: [] });
    await waitForFast(() => {
      expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    });
    const second = syncWorkboardLifecycle({ host, client: client as never, sessions: [] });
    await Promise.resolve();

    expect(client.request.mock.calls.filter(([method]) => method === "tasks.list")).toHaveLength(1);

    taskList.resolve({ tasks: [sampleTask] });
    await Promise.all([first, second]);

    expect(client.request.mock.calls.filter(([method]) => method === "tasks.list")).toHaveLength(1);
    expect(state.lifecycleTasksPrepared).toBe(true);
  });

  it("requests a fresh lifecycle sync after a shared task refresh is invalidated by a write", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
      taskId: sampleTask.taskId,
    } satisfies WorkboardCard;
    const commented = {
      ...linked,
      updatedAt: 2,
      metadata: { comments: [{ id: "comment-1", body: "Keep this", createdAt: 2 }] },
    } satisfies WorkboardCard;
    const completedTask = { ...sampleTask, status: "completed" as const, updatedAt: 3 };
    const firstTaskList = createDeferred<unknown>();
    let taskListCalls = 0;
    state.loaded = true;
    state.cards = [linked];
    state.tasksByCardId.set(linked.id, sampleTask);
    const client = createClient((method) => {
      if (method === "tasks.list") {
        taskListCalls += 1;
        return taskListCalls === 1 ? firstTaskList.promise : { tasks: [completedTask] };
      }
      if (method === "workboard.cards.comment") {
        return { card: commented };
      }
      if (method === "workboard.cards.update") {
        return { card: { ...commented, status: "review", updatedAt: 4 } };
      }
      return {};
    });
    const requestUpdate = vi.fn();

    const first = syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [],
      requestUpdate,
    });
    await waitForFast(() => {
      expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    });
    await addWorkboardCardComment({
      host,
      client: client as never,
      cardId: linked.id,
      body: "Keep this",
      requestUpdate,
    });
    vi.clearAllMocks();

    const second = syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [],
      requestUpdate,
    });
    firstTaskList.resolve({ tasks: [sampleTask] });
    await Promise.all([first, second]);

    expect(requestUpdate).toHaveBeenCalledOnce();
    vi.clearAllMocks();

    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [],
      requestUpdate,
    });

    expect(client.request).toHaveBeenNthCalledWith(1, "tasks.list", { limit: 500 });
    expect(client.request).toHaveBeenNthCalledWith(2, "workboard.cards.update", {
      id: linked.id,
      patch: expect.objectContaining({ status: "review" }),
    });
    expect(state.cards[0]?.status).toBe("review");
  });

  it("authoritatively refreshes running linked cards without task ids before lifecycle sync", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        ...sampleCard,
        status: "running",
        sessionKey: sampleTaskSessionKey,
        runId: "run-1",
      },
    ];
    const client = createClient({
      "tasks.list": { tasks: [] },
    });

    await syncWorkboardLifecycle({ host, client: client as never, sessions: [] });

    expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    expect(state.lifecycleTasksPrepared).toBe(true);
  });

  it("reconciles session-only cards when task discovery is unavailable", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleSession.key,
      runId: "run-1",
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [linked];
    const client = createClient((method) => {
      if (method === "tasks.list") {
        throw new Error("tasks unavailable");
      }
      if (method === "workboard.cards.update") {
        return { card: { ...linked, status: "review" } };
      }
      return {};
    });

    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [{ ...sampleSession, status: "done", hasActiveRun: false }],
    });

    expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: linked.id,
      patch: expect.objectContaining({ status: "review" }),
    });
    expect(state.cards[0]?.status).toBe("review");
  });

  it("honors task refresh backoff while reconciling session-only cards", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleSession.key,
      runId: "run-1",
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [linked];
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

    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [{ ...sampleSession, status: "done", hasActiveRun: false }],
    });

    expect(client.request).not.toHaveBeenCalledWith("tasks.list", expect.anything());
    expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: linked.id,
      patch: expect.objectContaining({ status: "review" }),
    });
    expect(state.cards[0]?.status).toBe("review");
  });

  it("exact-confirms task list omissions before lifecycle writes", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
      taskId: sampleTask.taskId,
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [linked];
    state.tasksByCardId.set(linked.id, sampleTask);
    const client = createClient({
      "tasks.list": { tasks: [] },
      "tasks.get": { task: sampleTask },
    });

    await syncWorkboardLifecycle({ host, client: client as never, sessions: [] });

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
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleTaskSessionKey,
      runId: "run-stale",
      taskId: sampleTask.taskId,
    } satisfies WorkboardCard;
    const confirmedTask = { ...sampleTask, runId: taskRunId };
    state.loaded = true;
    state.cards = [linked];
    const client = createClient({
      "tasks.list": { tasks: [] },
      "tasks.get": { task: confirmedTask },
    });
    const requestUpdate = vi.fn();

    await syncWorkboardLifecycle({ host, client: client as never, sessions: [], requestUpdate });

    expect(state.tasksByCardId.get(linked.id)).toEqual(confirmedTask);
    expect(state.lifecycleTasksPrepared).toBe(true);
    vi.clearAllMocks();
    await vi.advanceTimersByTimeAsync(100);
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("rotates bounded exact confirmations before lifecycle writes", async () => {
    vi.useFakeTimers();
    const host = {};
    const state = getWorkboardState(host);
    const cards = Array.from({ length: 65 }, (_, index) => ({
      ...sampleCard,
      id: `card-${index}`,
      status: "running" as const,
      taskId: `task-${index}`,
    }));
    state.loaded = true;
    state.cards = cards;
    const client = createClient((method, params) => {
      if (method === "tasks.list") {
        return { tasks: [] };
      }
      if (method === "tasks.get") {
        const taskId = (params as { taskId: string }).taskId;
        return { task: { ...sampleTask, id: taskId, taskId } };
      }
      return {};
    });
    const requestUpdate = vi.fn();

    await syncWorkboardLifecycle({ host, client: client as never, sessions: [], requestUpdate });

    expect(client.request.mock.calls.filter(([method]) => method === "tasks.get")).toHaveLength(32);
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    expect(state.lifecycleTasksPrepared).toBe(false);

    vi.clearAllMocks();
    await vi.advanceTimersByTimeAsync(100);
    expect(requestUpdate).toHaveBeenCalledOnce();
    vi.clearAllMocks();
    await syncWorkboardLifecycle({ host, client: client as never, sessions: [], requestUpdate });

    expect(client.request.mock.calls.filter(([method]) => method === "tasks.get")).toHaveLength(32);
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    expect(state.lifecycleTasksPrepared).toBe(false);

    vi.clearAllMocks();
    await vi.advanceTimersByTimeAsync(100);
    await syncWorkboardLifecycle({ host, client: client as never, sessions: [], requestUpdate });

    expect(client.request.mock.calls.filter(([method]) => method === "tasks.get")).toHaveLength(1);
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    expect(state.lifecycleTasksPrepared).toBe(true);
  });

  it("fails closed when bounded confirmations exceed their freshness window", async () => {
    vi.useFakeTimers();
    const host = {};
    const state = getWorkboardState(host);
    const cards = Array.from({ length: 33 }, (_, index) => ({
      ...sampleCard,
      id: `card-${index}`,
      status: "running" as const,
      taskId: `task-${index}`,
    }));
    state.loaded = true;
    state.cards = cards;
    const client = createClient((method, params) => {
      if (method === "tasks.list") {
        return { tasks: [] };
      }
      if (method === "tasks.get") {
        const taskId = (params as { taskId: string }).taskId;
        return { task: { ...sampleTask, id: taskId, taskId } };
      }
      return {};
    });
    const requestUpdate = vi.fn();

    await syncWorkboardLifecycle({ host, client: client as never, sessions: [], requestUpdate });

    expect(client.request.mock.calls.filter(([method]) => method === "tasks.get")).toHaveLength(32);
    expect(state.lifecycleTaskRefreshContinueAt).not.toBeNull();

    vi.clearAllMocks();
    await vi.advanceTimersByTimeAsync(5001);
    await syncWorkboardLifecycle({ host, client: client as never, sessions: [], requestUpdate });

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
    const host = {};
    const state = getWorkboardState(host);
    const cards = Array.from({ length: 33 }, (_, index) => ({
      ...sampleCard,
      id: `card-${index}`,
      status: "running" as const,
      taskId: `task-${index}`,
    }));
    state.loaded = true;
    state.cards = cards;
    const client = createClient((method, params) => {
      if (method === "tasks.list") {
        return { tasks: [] };
      }
      if (method === "tasks.get") {
        const taskId = (params as { taskId: string }).taskId;
        if (taskId === "task-0") {
          throw new Error("task confirmation unavailable");
        }
        return { task: { ...sampleTask, id: taskId, taskId } };
      }
      return {};
    });

    await syncWorkboardLifecycle({ host, client: client as never, sessions: [] });

    expect(client.request.mock.calls.filter(([method]) => method === "tasks.get")).toHaveLength(32);
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    expect(state.lifecycleTaskRefreshFailed).toBe(true);
    expect(state.lifecycleTasksPrepared).toBe(false);
  });

  it("exact-confirms a tracked replacement omitted from lifecycle task listing", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const missingTaskId = "task-pruned-from-ledger";
    const replacementTask = {
      ...sampleTask,
      id: "task-replacement",
      taskId: "task-replacement",
    };
    const linked = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
      taskId: missingTaskId,
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [linked];
    state.tasksByCardId.set(linked.id, replacementTask);
    state.missingTaskIds = new Set([missingTaskId]);
    const client = createClient({
      "tasks.list": { tasks: [] },
      "tasks.get": { task: replacementTask },
    });

    await syncWorkboardLifecycle({ host, client: client as never, sessions: [] });

    expect(client.request).toHaveBeenCalledWith("tasks.get", {
      taskId: replacementTask.taskId,
    });
    expect(client.request).not.toHaveBeenCalledWith("tasks.get", { taskId: missingTaskId });
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    expect(state.tasksByCardId.get(linked.id)).toEqual(replacementTask);
    expect(state.missingTaskIds).toEqual(new Set([missingTaskId]));
  });

  it("preserves a tracked replacement when lifecycle task refresh fails", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const missingTaskId = "task-pruned-from-ledger";
    const replacementTask = {
      ...sampleTask,
      id: "task-replacement",
      taskId: "task-replacement",
    };
    const linked = {
      ...sampleCard,
      status: "ready",
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
      taskId: missingTaskId,
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [linked];
    state.tasksByCardId.set(linked.id, replacementTask);
    state.missingTaskIds = new Set([missingTaskId]);
    const client = createClient(() => {
      throw new Error("tasks unavailable");
    });

    await syncWorkboardLifecycle({ host, client: client as never, sessions: [] });

    expect(client.request).toHaveBeenCalledOnce();
    expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    expect(state.tasksByCardId.get(linked.id)).toEqual(replacementTask);
    expect(state.missingTaskIds).toEqual(new Set([missingTaskId]));
    expect(state.lifecycleTaskRefreshError).toBe("tasks unavailable");
  });

  it("preserves a tracked replacement when exact confirmation fails", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const missingTaskId = "task-pruned-from-ledger";
    const replacementTask = {
      ...sampleTask,
      id: "task-replacement",
      taskId: "task-replacement",
    };
    const linked = {
      ...sampleCard,
      status: "ready",
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
      taskId: missingTaskId,
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [linked];
    state.tasksByCardId.set(linked.id, replacementTask);
    state.missingTaskIds = new Set([missingTaskId]);
    const client = createClient((method) => {
      if (method === "tasks.list") {
        return { tasks: [] };
      }
      throw new Error("task confirmation unavailable");
    });

    await syncWorkboardLifecycle({ host, client: client as never, sessions: [] });

    expect(client.request).toHaveBeenNthCalledWith(1, "tasks.list", { limit: 500 });
    expect(client.request).toHaveBeenNthCalledWith(2, "tasks.get", {
      taskId: replacementTask.taskId,
    });
    expect(state.tasksByCardId.get(linked.id)).toEqual(replacementTask);
    expect(state.missingTaskIds).toEqual(new Set([missingTaskId]));
    expect(state.lifecycleTaskRefreshError).toBe("task confirmation unavailable");
  });

  it("defers lifecycle writes when exact confirmation after task listing fails", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
      taskId: sampleTask.taskId,
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [linked];
    state.tasksByCardId.set(linked.id, sampleTask);
    const client = createClient((method) => {
      if (method === "tasks.list") {
        return { tasks: [] };
      }
      if (method === "tasks.get") {
        throw new Error("task confirmation unavailable");
      }
      return {};
    });

    await syncWorkboardLifecycle({ host, client: client as never, sessions: [] });

    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    expect(state.lifecycleTaskRefreshFailed).toBe(true);
    expect(state.error).toBeNull();
    expect(state.lifecycleTaskRefreshError).toBe("task confirmation unavailable");
  });

  it("requests a render after lifecycle refresh marks a task missing", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      status: "ready",
      taskId: sampleTask.taskId,
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [linked];
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

    await syncWorkboardLifecycle({ host, client: client as never, sessions: [], requestUpdate });

    expect(state.missingTaskIds).toEqual(new Set([sampleTask.taskId]));
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    expect(requestUpdate).toHaveBeenCalledOnce();
  });

  it("keeps prepared task lifecycle state after no-op syncs", async () => {
    vi.useFakeTimers();
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
      taskId: "task-1",
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [linked];
    state.tasksByCardId.set("card-1", sampleTask);
    state.lifecycleTasksPrepared = true;
    state.lifecycleTasksPreparedAt = Date.now();
    const client = createClient({
      "tasks.list": { tasks: [sampleTask] },
    });

    await syncWorkboardLifecycle({ host, client: client as never, sessions: [] });
    await syncWorkboardLifecycle({ host, client: client as never, sessions: [] });

    expect(client.request).not.toHaveBeenCalled();
    expect(state.lifecycleTasksPrepared).toBe(true);
  });

  it("refreshes prepared task lifecycle state after its freshness window", async () => {
    vi.useFakeTimers();
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
      taskId: "task-1",
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [linked];
    state.tasksByCardId.set("card-1", sampleTask);
    state.lifecycleTasksPrepared = true;
    state.lifecycleTasksPreparedAt = Date.now();
    const completedTask = { ...sampleTask, status: "completed" as const };
    const client = createClient({
      "tasks.list": { tasks: [completedTask] },
      "workboard.cards.update": { card: { ...linked, status: "review" } },
    });
    const requestUpdate = vi.fn();

    await syncWorkboardLifecycle({ host, client: client as never, sessions: [], requestUpdate });
    expect(client.request).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    expect(requestUpdate).toHaveBeenCalledOnce();
    vi.clearAllMocks();
    await syncWorkboardLifecycle({ host, client: client as never, sessions: [], requestUpdate });

    expect(client.request).toHaveBeenNthCalledWith(1, "tasks.list", { limit: 500 });
    expect(client.request).toHaveBeenNthCalledWith(2, "workboard.cards.update", expect.anything());
  });

  it("retries a failed lifecycle task refresh after backoff", async () => {
    vi.useFakeTimers();
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
      taskId: "task-1",
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [linked];
    state.tasksByCardId.set("card-1", sampleTask);
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

    await syncWorkboardLifecycle({ host, client: client as never, sessions: [], requestUpdate });
    expect(client.request).toHaveBeenCalledOnce();
    expect(requestUpdate).toHaveBeenCalledOnce();
    expect(state.lifecycleTaskRefreshError).toBe("tasks unavailable");
    state.lastRefreshError = "tasks unavailable";
    vi.clearAllMocks();

    await syncWorkboardLifecycle({ host, client: client as never, sessions: [], requestUpdate });

    expect(client.request).not.toHaveBeenCalled();
    expect(requestUpdate).not.toHaveBeenCalled();

    tasksAvailable = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(requestUpdate).toHaveBeenCalledOnce();
    vi.clearAllMocks();
    state.error = "unrelated write error";
    state.lastRefreshError = "newer cards refresh failure";
    await syncWorkboardLifecycle({ host, client: client as never, sessions: [], requestUpdate });

    expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    expect(state.lifecycleTaskRefreshFailed).toBe(false);
    expect(state.lifecycleTaskRefreshError).toBeNull();
    expect(state.lastRefreshError).toBe("newer cards refresh failure");
    expect(state.error).toBe("unrelated write error");
    expect(requestUpdate).toHaveBeenCalledOnce();
  });

  it("does not resume lifecycle writes when dispatch starts during task refresh", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
      taskId: "task-1",
    } satisfies WorkboardCard;
    const taskList = createDeferred<unknown>();
    state.loaded = true;
    state.cards = [linked];
    state.tasksByCardId.set("card-1", sampleTask);
    const client = createClient((method) => {
      if (method === "tasks.list") {
        return taskList.promise;
      }
      return { card: { ...linked, status: "review" } };
    });

    const syncing = syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [],
    });
    await Promise.resolve();
    state.dispatching = true;
    taskList.resolve({ tasks: [{ ...sampleTask, status: "completed" }] });
    await syncing;

    expect(client.request).toHaveBeenCalledOnce();
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
  });

  it("does not apply lifecycle task refresh after a newer card write", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
      taskId: "task-1",
    } satisfies WorkboardCard;
    const commented = {
      ...linked,
      updatedAt: 2,
      metadata: { comments: [{ id: "comment-1", body: "Keep this", createdAt: 2 }] },
    } satisfies WorkboardCard;
    const taskList = createDeferred<unknown>();
    state.loaded = true;
    state.cards = [linked];
    state.tasksByCardId.set("card-1", sampleTask);
    const client = createClient((method) => {
      if (method === "tasks.list") {
        return taskList.promise;
      }
      if (method === "workboard.cards.comment") {
        return { card: commented };
      }
      return {};
    });

    const syncing = syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [],
    });
    await Promise.resolve();
    await addWorkboardCardComment({
      host,
      client: client as never,
      cardId: linked.id,
      body: "Keep this",
    });
    taskList.resolve({ tasks: [{ ...sampleTask, status: "completed" }] });
    await syncing;

    expect(state.cards[0]?.metadata?.comments?.[0]?.body).toBe("Keep this");
    expect(state.tasksByCardId.get("card-1")).toEqual(sampleTask);
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
  });

  it("moves stale running sessions into running while recording stale metadata", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const staleUpdatedAt = Date.now() - 31 * 60 * 1000;
    const linked = {
      ...sampleCard,
      sessionKey: sampleSession.key,
      metadata: {
        comments: [{ id: "comment-1", body: "Keep me", createdAt: 1 }],
      },
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [linked];
    const client = createClient({
      "workboard.cards.update": {
        card: {
          ...linked,
          status: "running",
          metadata: {
            stale: {
              detectedAt: 1,
              lastSessionUpdatedAt: staleUpdatedAt,
              reason: "Linked thread has not reported recent activity.",
            },
          },
        },
      },
    });

    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [{ ...sampleSession, updatedAt: staleUpdatedAt, hasActiveRun: false }],
    });

    expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: "card-1",
      patch: {
        status: "running",
        metadata: {
          lifecycleStatusSourceUpdatedAt: staleUpdatedAt,
          stale: expect.objectContaining({
            lastSessionUpdatedAt: staleUpdatedAt,
            reason: "Linked thread has not reported recent activity.",
          }),
        },
      },
    });
  });

  it("syncs stale session metadata and clears it when the session recovers", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleSession.key,
      metadata: {
        comments: [{ id: "comment-1", body: "Keep me", createdAt: 1 }],
        stale: {
          detectedAt: 1,
          lastSessionUpdatedAt: 1,
          reason: "Linked thread has not reported recent activity.",
        },
      },
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [linked];
    const client = createClient({
      "workboard.cards.update": {
        card: { ...linked, metadata: undefined, updatedAt: 3 },
      },
    });

    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [{ ...sampleSession, updatedAt: Date.now(), hasActiveRun: true }],
    });

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
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleSession.key,
      metadata: {
        stale: {
          detectedAt: 1,
          lastSessionUpdatedAt: 1,
          reason: "Linked thread has not reported recent activity.",
        },
      },
      events: [
        {
          id: "move-1",
          kind: "moved",
          at: 5,
          fromStatus: "todo",
          toStatus: "running",
        },
      ],
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [linked];
    const client = createClient({
      "workboard.cards.update": {
        card: { ...linked, metadata: undefined, updatedAt: 6 },
      },
    });

    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [
        {
          ...sampleSession,
          status: "running",
          updatedAt: 3,
          hasActiveRun: true,
        },
      ],
    });

    expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: "card-1",
      patch: { metadata: { stale: null } },
    });
    expect(state.cards[0]?.metadata?.stale).toBeUndefined();
  });

  it("does not rewrite unchanged stale session metadata", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const staleUpdatedAt = Date.now() - 31 * 60 * 1000;
    const linked = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleSession.key,
      metadata: {
        stale: {
          detectedAt: 1,
          lastSessionUpdatedAt: staleUpdatedAt,
          reason: "Linked thread has not reported recent activity.",
        },
      },
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [linked];
    const client = createClient({ "workboard.cards.update": { card: linked } });

    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [{ ...sampleSession, updatedAt: staleUpdatedAt, hasActiveRun: false }],
    });

    expect(client.request).toHaveBeenCalledOnce();
    expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
  });

  it("does not mark executions blocked when the linked session is missing from the current list", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      status: "running",
      sessionKey: "agent:main:dashboard:missing",
      execution: {
        id: "exec-1",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "openai/gpt-5.5",
        sessionKey: "agent:main:dashboard:missing",
        startedAt: 1,
        updatedAt: 1,
      },
    } as const;
    state.loaded = true;
    state.cards = [linked];
    const client = createClient({ "workboard.cards.update": { card: linked } });

    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [],
    });

    expect(client.request).toHaveBeenCalledOnce();
    expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
  });

  it("skips lifecycle writeback for read-only workboard clients", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [{ ...sampleCard, sessionKey: sampleSession.key }];
    const client = createClient(() => {
      throw new Error("write denied");
    });

    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [sampleSession],
      canWrite: false,
    });

    expect(client.request).not.toHaveBeenCalled();
    expect(state.error).toBeNull();
  });

  it("recovers task refresh failures for read-only workboard clients", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleTaskSessionKey,
      runId: sampleTask.runId,
      taskId: sampleTask.taskId,
    } satisfies WorkboardCard;
    state.loaded = true;
    state.cards = [linked];
    state.lifecycleTaskRefreshFailed = true;
    state.lifecycleTaskRefreshError = "tasks unavailable";
    state.lastRefreshError = "tasks unavailable";
    const client = createClient({ "tasks.list": { tasks: [sampleTask] } });

    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [],
      canWrite: false,
    });

    expect(client.request).toHaveBeenCalledOnce();
    expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    expect(state.lifecycleTaskRefreshFailed).toBe(false);
    expect(state.lifecycleTaskRefreshError).toBeNull();
    expect(state.lastRefreshError).toBeNull();
    expect(state.lifecycleTasksPrepared).toBe(true);
  });

  it("resyncs cards manually moved back to an active lifecycle column", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleSession.key,
      updatedAt: 1000,
    } as const;
    const completedSession = {
      ...sampleSession,
      hasActiveRun: false,
      status: "done",
      updatedAt: 2000,
    } as const;
    state.loaded = true;
    state.cards = [linked];
    const client = createClient({
      "workboard.cards.update": {
        card: { ...linked, status: "review", updatedAt: 3000 },
      },
    });

    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [completedSession],
    });
    state.cards = [{ ...linked, updatedAt: 4000 }];
    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [completedSession],
    });

    expect(client.request).toHaveBeenCalledTimes(3);
    expect(client.request).toHaveBeenCalledWith("tasks.list", { limit: 500 });
  });

  it("does not retry a failed lifecycle task refresh before backoff", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleSession.key,
      updatedAt: 1000,
    } as const;
    const completedSession = {
      ...sampleSession,
      hasActiveRun: false,
      status: "done",
      updatedAt: 2000,
    } as const;
    state.loaded = true;
    state.cards = [linked];
    const client = createClient((method) => {
      if (method === "tasks.list") {
        throw new Error("tasks unavailable");
      }
      if (method === "workboard.cards.update") {
        return { card: { ...linked, status: "review", updatedAt: 3000 } };
      }
      return {};
    });

    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [completedSession],
    });
    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [completedSession],
    });

    expect(client.request.mock.calls.filter(([method]) => method === "tasks.list")).toHaveLength(1);
    expect(
      client.request.mock.calls.filter(([method]) => method === "workboard.cards.update"),
    ).toHaveLength(1);
    expect(state.error).toBeNull();
    expect(state.lifecycleTaskRefreshError).toBe("tasks unavailable");
    expect(state.cards[0]?.status).toBe("review");
  });

  it("stops linked sessions and marks cards blocked", async () => {
    const host = {};
    const linked = { ...sampleCard, sessionKey: sampleSession.key, runId: "run-1" };
    const blocked = { ...linked, status: "blocked" };
    const client = createClient({
      "chat.abort": { aborted: true, runIds: ["run-1"] },
      "workboard.cards.update": { card: blocked },
    });

    await stopWorkboardCard({ host, client: client as never, card: linked });

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
    const host = {};
    const linked = {
      ...sampleCard,
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
      taskId: "task-1",
    };
    const blocked = { ...linked, status: "blocked" };
    const state = getWorkboardState(host);
    state.cards = [linked];
    state.tasksByCardId.set("card-1", sampleTask);
    const client = createClient({
      "tasks.cancel": { cancelled: true },
      "chat.abort": { aborted: true, runIds: ["run-1"] },
      "workboard.cards.update": { card: blocked },
    });

    await stopWorkboardCard({ host, client: client as never, card: linked });

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
    const host = {};
    const linked = {
      ...sampleCard,
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
      taskId: "task-1",
    };
    const blocked = { ...linked, status: "blocked" };
    const state = getWorkboardState(host);
    state.cards = [linked];
    state.tasksByCardId.set("card-1", sampleTask);
    const client = createClient((method) => {
      if (method === "tasks.cancel") {
        return { cancelled: true };
      }
      if (method === "chat.abort") {
        throw new Error("run already removed");
      }
      if (method === "workboard.cards.update") {
        return { card: blocked };
      }
      return {};
    });

    await stopWorkboardCard({ host, client: client as never, card: linked });

    expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: "card-1",
      patch: { status: "blocked" },
    });
    expect(state.cards[0]).toMatchObject({ status: "blocked" });
    expect(state.error).toBeNull();
  });

  it("cancels a tracked replacement instead of its confirmed-missing task link", async () => {
    const host = {};
    const missingTaskId = "task-pruned-from-ledger";
    const replacementTask = {
      ...sampleTask,
      id: "task-replacement",
      taskId: "task-replacement",
    };
    const linked = {
      ...sampleCard,
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
      taskId: missingTaskId,
    };
    const blocked = { ...linked, status: "blocked" };
    const state = getWorkboardState(host);
    state.cards = [linked];
    state.tasksByCardId.set("card-1", replacementTask);
    state.missingTaskIds = new Set([missingTaskId]);
    const client = createClient({
      "tasks.cancel": { cancelled: true },
      "chat.abort": { aborted: true, runIds: ["run-1"] },
      "workboard.cards.update": { card: blocked },
    });

    await stopWorkboardCard({ host, client: client as never, card: linked });

    expect(client.request).toHaveBeenNthCalledWith(1, "tasks.cancel", {
      taskId: replacementTask.taskId,
      reason: "Stopped from Workboard.",
    });
    expect(state.tasksByCardId.get("card-1")).toMatchObject({
      taskId: replacementTask.taskId,
      status: "cancelled",
    });
  });

  it("cancels unresolved task-only cards through their canonical task id", async () => {
    const host = {};
    const linked = { ...sampleCard, status: "running" as const, taskId: "task-1" };
    const blocked = { ...linked, status: "blocked" as const };
    const state = getWorkboardState(host);
    state.cards = [linked];
    const client = createClient({
      "tasks.cancel": { cancelled: true },
      "workboard.cards.update": { card: blocked },
    });

    await stopWorkboardCard({ host, client: client as never, card: linked });

    expect(client.request).toHaveBeenNthCalledWith(1, "tasks.cancel", {
      taskId: "task-1",
      reason: "Stopped from Workboard.",
    });
    expect(client.request).toHaveBeenNthCalledWith(2, "workboard.cards.update", {
      id: "card-1",
      patch: { status: "blocked" },
    });
    expect(state.tasksByCardId.get("card-1")).toMatchObject({
      taskId: "task-1",
      status: "cancelled",
    });
  });

  it("records found:false task cancellation before aborting its linked session", async () => {
    const host = {};
    const linked = {
      ...sampleCard,
      status: "running" as const,
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
      taskId: "task-pruned",
    };
    const blocked = { ...linked, status: "blocked" as const };
    const state = getWorkboardState(host);
    state.cards = [linked];
    const client = createClient((method) => {
      if (method === "tasks.cancel") {
        return { found: false, cancelled: false };
      }
      if (method === "chat.abort") {
        return { aborted: true, runIds: ["run-1"] };
      }
      return { card: blocked };
    });

    await stopWorkboardCard({ host, client: client as never, card: linked });

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
    const host = {};
    const linked = {
      ...sampleCard,
      status: "running" as const,
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
      taskId: "task-pruned",
    };
    const state = getWorkboardState(host);
    state.cards = [linked];
    const client = createClient((method) => {
      if (method === "tasks.cancel") {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "task not found: task-pruned",
        });
      }
      if (method === "chat.abort") {
        return { aborted: false, runIds: [] };
      }
      return { card: { ...linked, status: "blocked" } };
    });

    await stopWorkboardCard({ host, client: client as never, card: linked });

    expect(client.request).toHaveBeenCalledTimes(3);
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    expect(state.cards).toEqual([linked]);
    expect(state.missingTaskIds).toEqual(new Set(["task-pruned"]));
    expect(state.error).toBeNull();
  });

  it("reports linked session abort errors after a missing task cancellation", async () => {
    const host = {};
    const linked = {
      ...sampleCard,
      status: "running" as const,
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
      taskId: "task-pruned",
    };
    const state = getWorkboardState(host);
    state.cards = [linked];
    const client = createClient((method) => {
      if (method === "tasks.cancel") {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "task not found: task-pruned",
        });
      }
      if (method === "chat.abort") {
        throw new Error("session abort unavailable");
      }
      return { card: { ...linked, status: "blocked" } };
    });

    await stopWorkboardCard({ host, client: client as never, card: linked });

    expect(client.request).toHaveBeenCalledTimes(2);
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    expect(state.cards).toEqual([linked]);
    expect(state.missingTaskIds).toEqual(new Set(["task-pruned"]));
    expect(state.error).toBe("session abort unavailable");
  });

  it("treats found:false task cancellation as stopped for task-only cards", async () => {
    const host = {};
    const linked = {
      ...sampleCard,
      status: "running" as const,
      taskId: "task-pruned",
    };
    const blocked = { ...linked, status: "blocked" as const };
    const state = getWorkboardState(host);
    state.cards = [linked];
    const client = createClient((method) => {
      if (method === "tasks.cancel") {
        return { found: false, cancelled: false };
      }
      return { card: blocked };
    });

    await stopWorkboardCard({ host, client: client as never, card: linked });

    expect(client.request).toHaveBeenNthCalledWith(1, "tasks.cancel", {
      taskId: "task-pruned",
      reason: "Stopped from Workboard.",
    });
    expect(client.request).toHaveBeenNthCalledWith(2, "workboard.cards.update", {
      id: "card-1",
      patch: { status: "blocked" },
    });
    expect(state.cards).toEqual([blocked]);
    expect(state.missingTaskIds).toEqual(new Set(["task-pruned"]));
    expect(state.error).toBeNull();
  });

  it("treats missing task cancellation as stopped for task-only cards", async () => {
    const host = {};
    const linked = {
      ...sampleCard,
      status: "running" as const,
      taskId: "task-pruned",
    };
    const blocked = { ...linked, status: "blocked" as const };
    const state = getWorkboardState(host);
    state.cards = [linked];
    const client = createClient((method) => {
      if (method === "tasks.cancel") {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "task not found: task-pruned",
        });
      }
      return { card: blocked };
    });

    await stopWorkboardCard({ host, client: client as never, card: linked });

    expect(client.request).toHaveBeenNthCalledWith(1, "tasks.cancel", {
      taskId: "task-pruned",
      reason: "Stopped from Workboard.",
    });
    expect(client.request).toHaveBeenNthCalledWith(2, "workboard.cards.update", {
      id: "card-1",
      patch: { status: "blocked" },
    });
    expect(state.cards).toEqual([blocked]);
    expect(state.missingTaskIds).toEqual(new Set(["task-pruned"]));
    expect(state.error).toBeNull();
  });

  it("reports task cancellation errors without aborting the linked session", async () => {
    const host = {};
    const linked = {
      ...sampleCard,
      status: "running" as const,
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
      taskId: "task-1",
    };
    const state = getWorkboardState(host);
    state.cards = [linked];
    state.tasksByCardId.set(linked.id, sampleTask);
    const client = createClient((method) => {
      if (method === "tasks.cancel") {
        throw new Error("task ledger unavailable");
      }
      if (method === "chat.abort") {
        return { aborted: true, runIds: ["run-1"] };
      }
      return { card: { ...linked, status: "blocked" } };
    });

    await stopWorkboardCard({ host, client: client as never, card: linked });

    expect(client.request).toHaveBeenCalledOnce();
    expect(client.request).toHaveBeenCalledWith("tasks.cancel", {
      taskId: "task-1",
      reason: "Stopped from Workboard.",
    });
    expect(state.cards).toEqual([linked]);
    expect(state.error).toBe("task ledger unavailable");
  });

  it("marks task-linked cards blocked when task cancellation already stopped the session", async () => {
    const host = {};
    const linked = {
      ...sampleCard,
      sessionKey: sampleTaskSessionKey,
      runId: "run-1",
      taskId: "task-1",
    };
    const state = getWorkboardState(host);
    state.cards = [linked];
    state.tasksByCardId.set("card-1", sampleTask);
    const blocked = { ...linked, status: "blocked" as const };
    const client = createClient({
      "tasks.cancel": { cancelled: true },
      "chat.abort": { aborted: false, runIds: [] },
      "workboard.cards.update": { card: blocked },
    });

    await stopWorkboardCard({ host, client: client as never, card: linked });

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
    const host = {};
    const blocked = { ...sampleCard, status: "blocked" };
    const state = getWorkboardState(host);
    state.cards = [sampleCard];
    state.tasksByCardId.set("card-1", sampleTask);
    const client = createClient({
      "tasks.cancel": { cancelled: true },
      "workboard.cards.update": { card: blocked },
    });

    await stopWorkboardCard({ host, client: client as never, card: sampleCard });

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
    const host = {};
    const archived = {
      ...sampleCard,
      metadata: { archivedAt: 20 },
    } satisfies WorkboardCard;
    const client = createClient({ "workboard.cards.archive": { card: archived } });

    await archiveWorkboardCard({
      host,
      client: client as never,
      cardId: "card-1",
    });

    expect(client.request).toHaveBeenCalledWith("workboard.cards.archive", {
      id: "card-1",
      archived: true,
    });
    expect(getWorkboardState(host).cards[0]?.metadata?.archivedAt).toBe(20);
  });

  it("falls back to the active session abort when the stored run id is stale", async () => {
    const host = {};
    const linked = { ...sampleCard, sessionKey: sampleSession.key, runId: "old-run" };
    const blocked = { ...linked, status: "blocked" };
    const client = createClient((method, params) => {
      if (method === "chat.abort" && (params as { runId?: string }).runId === "old-run") {
        return { aborted: false, runIds: [] };
      }
      if (method === "chat.abort") {
        return { aborted: true, runIds: ["new-run"] };
      }
      return { card: blocked };
    });

    await stopWorkboardCard({ host, client: client as never, card: linked });

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
    const host = {};
    const linked = { ...sampleCard, sessionKey: sampleSession.key, runId: "stale-run" };
    const state = getWorkboardState(host);
    state.cards = [linked];
    const client = createClient({
      "chat.abort": { aborted: false, runIds: [] },
    });

    await stopWorkboardCard({ host, client: client as never, card: linked });

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
