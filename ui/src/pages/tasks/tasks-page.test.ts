import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import { sessionRefFromPath } from "../../app-session-route-paths.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { TaskStatus, TaskSummary } from "../../lib/tasks/task-summary.ts";
import "./tasks-page.ts";

type TasksPageTestElement = HTMLElement & {
  context: ApplicationContext;
  tasks: TaskSummary[];
  error: string | null;
  cancellingTaskIds: Set<string>;
  cancelTask: (taskId: string) => Promise<void>;
  recoverTask: (taskId: string, action: "retry" | "dismiss") => Promise<void>;
  refreshTasks: () => Promise<void>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createGateway(
  client: GatewayBrowserClient,
  hello: ApplicationGatewaySnapshot["hello"] = null,
) {
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  let snapshotListener: ((snapshot: ApplicationGatewaySnapshot) => void) | undefined;
  const eventListeners = new Set<(event: GatewayEventFrame) => void>();
  const gateway = {
    snapshot,
    subscribe(listener: (snapshot: ApplicationGatewaySnapshot) => void) {
      snapshotListener = listener;
      return () => {
        if (snapshotListener === listener) {
          snapshotListener = undefined;
        }
      };
    },
    subscribeEvents(listener: (event: GatewayEventFrame) => void) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  } as unknown as ApplicationContext["gateway"];
  return {
    emitConnected(connected: boolean) {
      snapshot.phase = connected ? "connected" : "stopped";
      snapshotListener?.(snapshot);
    },
    emitTask(payload: unknown) {
      const event: GatewayEventFrame = { event: "task", payload, type: "event" };
      for (const listener of eventListeners) {
        listener(event);
      }
    },
    gateway,
  };
}

function createTask(
  id: string,
  status: TaskStatus = "running",
  overrides: Partial<TaskSummary> = {},
): TaskSummary {
  return { id, taskId: id, status, agentId: "main", updatedAt: 100, ...overrides };
}

async function createDeferredTaskRefresh(initialTasks: TaskSummary[]) {
  const active = deferred<{ tasks: TaskSummary[] }>();
  const recent = deferred<{ tasks: TaskSummary[] }>();
  let deferRefresh = false;
  let currentTasks = initialTasks;
  const request = vi.fn(
    (method: string, params?: { status?: readonly string[]; taskId?: string }) => {
      if (method === "tasks.cancel") {
        return Promise.resolve({
          found: true,
          cancelled: true,
          task: createTask(params?.taskId ?? "task-missing", "cancelled", { updatedAt: 300 }),
        });
      }
      if (method !== "tasks.list" || !deferRefresh) {
        return Promise.resolve({ tasks: currentTasks });
      }
      return params?.status ? active.promise : recent.promise;
    },
  );
  const source = createGateway({ request } as unknown as GatewayBrowserClient);
  const page = document.createElement("openclaw-tasks-page") as TasksPageTestElement;
  page.context = createContext(source.gateway);
  document.body.append(page);
  await vi.waitFor(() => expect(page.tasks).toHaveLength(initialTasks.length));

  return {
    active,
    page,
    recent,
    request,
    source,
    startRefresh() {
      deferRefresh = true;
      return page.refreshTasks();
    },
    reconnectWithTasks(tasks: TaskSummary[]) {
      deferRefresh = false;
      currentTasks = tasks;
      source.emitConnected(false);
      source.emitConnected(true);
    },
  };
}

function createContext(
  gateway: ApplicationContext["gateway"],
  scopeId: string | null = "main",
): ApplicationContext {
  const subscribe = () => () => undefined;
  return {
    basePath: "",
    gateway,
    agents: {
      state: {
        agentsList: {
          defaultId: scopeId ?? "main",
          mainKey: "main",
          agents: [{ id: "main" }, { id: "research" }, { id: "writer" }],
        },
      },
      ensureList: vi.fn(async () => undefined),
      subscribe,
    },
    agentSelection: {
      state: { selectedId: scopeId, scopeId },
      set: () => undefined,
      setScope: () => undefined,
      subscribe,
    },
    // Session rows carry the durable boardFace that generic navigation reads.
    sessions: {
      state: { result: null, loading: false },
      subscribe,
    },
    navigate: vi.fn(),
    preload: vi.fn(async () => undefined),
  } as unknown as ApplicationContext;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("TasksPage concurrent refresh events", () => {
  it("keeps the later recent page's equally current running progress", async () => {
    const initial = createTask("task-progress", "running", {
      toolUseCount: 2,
      progressSummary: "Preparing the concurrent task report",
    });
    const recent = createTask("task-progress", "running", {
      toolUseCount: 2,
      progressSummary: "Finishing the concurrent task report",
    });
    const refresh = await createDeferredTaskRefresh([initial]);
    const pending = refresh.startRefresh();

    const refreshCalls = refresh.request.mock.calls.slice(-2);
    expect(refreshCalls[0]?.[1]).toMatchObject({ status: ["queued", "running"] });
    expect(refreshCalls[1]?.[1]).not.toHaveProperty("status");
    refresh.active.resolve({ tasks: [initial] });
    refresh.recent.resolve({ tasks: [recent] });
    await pending;

    expect(refresh.page.tasks).toEqual([recent]);
  });

  it("preserves all ten same-title task completions while stale snapshot pages resolve", async () => {
    const initialTasks = Array.from({ length: 10 }, (_, index) =>
      createTask(`task-${index}`, "running", { title: "Investigate concurrent sessions" }),
    );
    const refresh = await createDeferredTaskRefresh(initialTasks);
    const pending = refresh.startRefresh();

    for (const [index, task] of initialTasks.entries()) {
      refresh.source.emitTask({
        action: "upserted",
        task: { ...task, status: "completed", updatedAt: 200 + index },
      });
    }
    expect(refresh.page.tasks).toHaveLength(10);
    expect(refresh.page.tasks.every((task) => task.status === "completed")).toBe(true);

    refresh.active.resolve({ tasks: initialTasks });
    refresh.recent.resolve({ tasks: initialTasks });
    await pending;

    expect(refresh.page.tasks).toHaveLength(10);
    expect(new Set(refresh.page.tasks.map((task) => task.id)).size).toBe(10);
    expect(refresh.page.tasks.every((task) => task.status === "completed")).toBe(true);
  });

  it("does not resurrect a task deleted while its snapshot is in flight", async () => {
    const initialTasks = [createTask("task-deleted"), createTask("task-retained")];
    const refresh = await createDeferredTaskRefresh(initialTasks);
    const pending = refresh.startRefresh();

    refresh.source.emitTask({ action: "deleted", taskId: "task-deleted" });
    expect(refresh.page.tasks.map((task) => task.id)).toEqual(["task-retained"]);

    refresh.active.resolve({ tasks: initialTasks });
    refresh.recent.resolve({ tasks: initialTasks });
    await pending;

    expect(refresh.page.tasks.map((task) => task.id)).toEqual(["task-retained"]);
  });

  it("retains a task created after its snapshot requests started", async () => {
    const initialTasks = [createTask("task-existing")];
    const refresh = await createDeferredTaskRefresh(initialTasks);
    const pending = refresh.startRefresh();

    refresh.source.emitTask({
      action: "upserted",
      task: createTask("task-created", "running", { updatedAt: 200 }),
    });
    expect(refresh.page.tasks.map((task) => task.id)).toEqual(["task-created", "task-existing"]);

    refresh.active.resolve({ tasks: initialTasks });
    refresh.recent.resolve({ tasks: initialTasks });
    await pending;

    expect(refresh.page.tasks.map((task) => task.id)).toEqual(["task-created", "task-existing"]);
  });

  it("does not replay another agent's task into the selected scope", async () => {
    const initialTasks = [createTask("task-main")];
    const refresh = await createDeferredTaskRefresh(initialTasks);
    const pending = refresh.startRefresh();

    refresh.source.emitTask({
      action: "upserted",
      task: createTask("task-writer", "running", { agentId: "writer", updatedAt: 200 }),
    });
    expect(refresh.page.tasks.map((task) => task.id)).toEqual(["task-main"]);

    refresh.active.resolve({ tasks: initialTasks });
    refresh.recent.resolve({ tasks: initialTasks });
    await pending;

    expect(refresh.page.tasks.map((task) => task.id)).toEqual(["task-main"]);
  });

  it("preserves successful cancellation while stale snapshot pages are in flight", async () => {
    const initialTasks = [createTask("task-cancelled")];
    const refresh = await createDeferredTaskRefresh(initialTasks);
    const pending = refresh.startRefresh();

    await refresh.page.cancelTask("task-cancelled");
    expect(refresh.page.tasks.map((task) => [task.id, task.status])).toEqual([
      ["task-cancelled", "cancelled"],
    ]);

    refresh.active.resolve({ tasks: initialTasks });
    refresh.recent.resolve({ tasks: initialTasks });
    await pending;

    expect(refresh.page.tasks.map((task) => [task.id, task.status])).toEqual([
      ["task-cancelled", "cancelled"],
    ]);
  });

  it("does not replay events from a refresh invalidated by a reconnect", async () => {
    const initialTasks = [createTask("task-before-reconnect")];
    const replacementTasks = [createTask("task-after-reconnect")];
    const refresh = await createDeferredTaskRefresh(initialTasks);
    const pending = refresh.startRefresh();

    refresh.source.emitTask({
      action: "upserted",
      task: createTask("task-stale-event", "completed", { updatedAt: 200 }),
    });
    refresh.reconnectWithTasks(replacementTasks);
    await vi.waitFor(() =>
      expect(refresh.page.tasks.map((task) => task.id)).toEqual(["task-after-reconnect"]),
    );

    refresh.active.resolve({ tasks: initialTasks });
    refresh.recent.resolve({ tasks: initialTasks });
    await pending;

    expect(refresh.page.tasks.map((task) => task.id)).toEqual(["task-after-reconnect"]);
  });
});

describe("TasksPage active pagination", () => {
  it("drains active pages with the selected scope and merges each task once", async () => {
    const sharedPageOne = createTask("task-shared", "running", {
      progressSummary: "Page one progress",
      updatedAt: 100,
    });
    const sharedPageTwo = createTask("task-shared", "running", {
      progressSummary: "Page two progress",
      updatedAt: 200,
    });
    const request = vi.fn(
      (
        method: string,
        params?: {
          agentId?: string;
          cursor?: string;
          limit?: number;
          status?: readonly string[];
        },
      ) => {
        expect(method).toBe("tasks.list");
        if (!params?.status) {
          return Promise.resolve({ tasks: [createTask("task-recent", "completed")] });
        }
        if (params.cursor === "active-page-2") {
          return Promise.resolve({
            tasks: [sharedPageTwo, createTask("task-page-2")],
          });
        }
        return Promise.resolve({
          tasks: [sharedPageOne, createTask("task-page-1")],
          nextCursor: "active-page-2",
        });
      },
    );
    const source = createGateway({ request } as unknown as GatewayBrowserClient);
    const page = document.createElement("openclaw-tasks-page") as TasksPageTestElement;
    page.context = createContext(source.gateway, "writer");
    document.body.append(page);

    await vi.waitFor(() => expect(page.tasks).toHaveLength(4));

    expect(request).toHaveBeenCalledWith(
      "tasks.list",
      {
        agentId: "writer",
        cursor: "active-page-2",
        limit: 500,
        status: ["queued", "running"],
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(
      request.mock.calls.filter(([, params]) => !(params as { status?: unknown })?.status),
    ).toHaveLength(1);
    expect(page.tasks.filter((task) => task.id === "task-shared")).toEqual([sharedPageTwo]);
  });

  it("fails visibly when an active page repeats its cursor", async () => {
    let activeCalls = 0;
    const request = vi.fn((_method: string, params?: { status?: readonly string[] }) => {
      if (!params?.status) {
        return Promise.resolve({ tasks: [] });
      }
      activeCalls += 1;
      return Promise.resolve({
        tasks: [createTask(`task-page-${activeCalls}`)],
        nextCursor: "repeated-cursor",
      });
    });
    const source = createGateway({ request } as unknown as GatewayBrowserClient);
    const page = document.createElement("openclaw-tasks-page") as TasksPageTestElement;
    page.context = createContext(source.gateway);
    document.body.append(page);

    await vi.waitFor(() => expect(page.error).toBe("The gateway returned an invalid task list."));

    expect(activeCalls).toBe(2);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("replays buffered events after the final active page resolves", async () => {
    const stale = createTask("task-draining", "running", { updatedAt: 100 });
    const finalPage = deferred<{ tasks: TaskSummary[] }>();
    const request = vi.fn(
      (_method: string, params?: { cursor?: string; status?: readonly string[] }) => {
        if (!params?.status) {
          return Promise.resolve({ tasks: [] });
        }
        if (params.cursor === "active-page-2") {
          return finalPage.promise;
        }
        return Promise.resolve({ tasks: [stale], nextCursor: "active-page-2" });
      },
    );
    const source = createGateway({ request } as unknown as GatewayBrowserClient);
    const page = document.createElement("openclaw-tasks-page") as TasksPageTestElement;
    page.context = createContext(source.gateway);
    document.body.append(page);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "tasks.list",
        expect.objectContaining({ cursor: "active-page-2" }),
        { signal: expect.any(AbortSignal) },
      ),
    );

    source.emitTask({
      action: "upserted",
      task: { ...stale, status: "completed", updatedAt: 200 },
    });
    finalPage.resolve({ tasks: [stale] });
    await vi.waitFor(() => expect(page.tasks[0]?.status).toBe("completed"));

    expect(page.tasks).toHaveLength(1);
  });
});

describe("TasksPage cancellation lifecycle", () => {
  it("lets a read-only operator copy a retained result without mutation controls", async () => {
    const retained = createTask("task-read-only-retained", "completed", {
      deliveryStatus: "failed",
      terminalOutcome: "blocked",
      terminalSummary: "Synthetic retained task completed.",
    });
    const copiedResult = "Synthetic retained result for read-only operator proof.";
    const request = vi.fn((method: string) =>
      Promise.resolve(
        method === "tasks.get"
          ? { task: { ...retained, result: copiedResult } }
          : { tasks: [retained] },
      ),
    );
    const source = createGateway(
      { request } as unknown as GatewayBrowserClient,
      {
        auth: { role: "operator", scopes: ["operator.read"] },
      } as ApplicationGatewaySnapshot["hello"],
    );
    const page = document.createElement("openclaw-tasks-page") as TasksPageTestElement;
    page.context = createContext(source.gateway);
    const writeText = vi.fn(async () => undefined);
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    try {
      document.body.append(page);
      await vi.waitFor(() => expect(page.tasks).toHaveLength(1));

      const copyButton = [...page.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Copy result",
      );
      expect(copyButton).toBeDefined();
      const text = page.textContent ?? "";
      expect(text).not.toContain("Retry delivery");
      expect(text).not.toContain("Dismiss delivery");
      expect(text).not.toContain("Cancel");

      copyButton?.click();
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(copiedResult));
      expect(request).toHaveBeenCalledWith("tasks.get", { taskId: retained.taskId });
    } finally {
      if (originalClipboard) {
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
  });

  it("qualifies unscoped task session links with the selected agent", async () => {
    const request = vi.fn(async () => ({
      tasks: [
        {
          id: "task-1",
          taskId: "task-1",
          status: "running",
          sessionKey: "telegram:12345",
        },
      ],
    }));
    const source = createGateway({ request } as unknown as GatewayBrowserClient);
    const page = document.createElement("openclaw-tasks-page") as TasksPageTestElement;
    page.context = createContext(source.gateway, "research");
    document.body.append(page);

    await vi.waitFor(() =>
      expect(page.querySelector<HTMLAnchorElement>(".session-link")?.getAttribute("href")).toBe(
        "/chat/research/telegram/12345",
      ),
    );
    expect(sessionRefFromPath("/chat/research/telegram/12345")).toMatchObject({
      kind: "literal",
      sessionKey: "agent:research:telegram:12345",
    });
  });

  it("scopes both active and recent task requests to the selected agent", async () => {
    const request = vi.fn(async () => ({ tasks: [] }));
    const source = createGateway({ request } as unknown as GatewayBrowserClient);
    const page = document.createElement("openclaw-tasks-page") as TasksPageTestElement;
    page.context = createContext(source.gateway, "writer");
    document.body.append(page);

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request).toHaveBeenCalledWith(
      "tasks.list",
      expect.objectContaining({ agentId: "writer", status: ["queued", "running"] }),
      { signal: expect.any(AbortSignal) },
    );
    expect(request).toHaveBeenCalledWith(
      "tasks.list",
      expect.objectContaining({ agentId: "writer", limit: 200 }),
      { signal: expect.any(AbortSignal) },
    );
  });

  it("discards a cancellation response across a same-client reconnect", async () => {
    const pendingCancel = deferred<{ cancelled: false; found: true; reason: string }>();
    const request = vi.fn((method: string) => {
      if (method === "tasks.cancel") {
        return pendingCancel.promise;
      }
      return Promise.resolve({ tasks: [] });
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const source = createGateway(client);
    const page = document.createElement("openclaw-tasks-page") as TasksPageTestElement;
    page.context = createContext(source.gateway);
    document.body.append(page);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("tasks.list", expect.anything(), {
        signal: expect.any(AbortSignal),
      }),
    );

    const cancelling = page.cancelTask("task-1");
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("tasks.cancel", { taskId: "task-1" }),
    );
    expect(page.cancellingTaskIds.has("task-1")).toBe(true);

    source.emitConnected(false);
    source.emitConnected(true);
    pendingCancel.resolve({ cancelled: false, found: true, reason: "stale refusal" });
    await cancelling;

    expect(page.error).toBeNull();
    expect(page.cancellingTaskIds.size).toBe(0);
  });

  it("retries a blocked completion and applies the returned delivery projection", async () => {
    const blocked = createTask("task-blocked", "completed", {
      deliveryStatus: "failed",
      terminalOutcome: "blocked",
    });
    const request = vi.fn((method: string) => {
      if (method === "tasks.retry") {
        return Promise.resolve({
          results: [
            {
              taskId: blocked.taskId,
              ok: true,
              duplicateRisk: true,
              task: {
                ...blocked,
                deliveryStatus: "session_queued",
                terminalOutcome: "succeeded",
                updatedAt: 200,
              },
            },
          ],
        });
      }
      return Promise.resolve({ tasks: [blocked] });
    });
    const source = createGateway({ request } as unknown as GatewayBrowserClient);
    const page = document.createElement("openclaw-tasks-page") as TasksPageTestElement;
    page.context = createContext(source.gateway);
    document.body.append(page);
    await vi.waitFor(() => expect(page.tasks).toHaveLength(1));

    await page.recoverTask(blocked.taskId, "retry");

    expect(request).toHaveBeenCalledWith("tasks.retry", { taskIds: [blocked.taskId] });
    expect(page.tasks[0]).toMatchObject({
      deliveryStatus: "session_queued",
      terminalOutcome: "succeeded",
    });
  });

  it("discards a recovery response across a same-client reconnect", async () => {
    const blocked = createTask("task-recovery-reconnect", "completed", {
      deliveryStatus: "failed",
      terminalOutcome: "blocked",
    });
    const pendingRecovery = deferred<{
      results: Array<{ taskId: string; ok: true; task: TaskSummary }>;
    }>();
    const request = vi.fn((method: string) => {
      if (method === "tasks.retry") {
        return pendingRecovery.promise;
      }
      return Promise.resolve({ tasks: [blocked] });
    });
    const source = createGateway({ request } as unknown as GatewayBrowserClient);
    const page = document.createElement("openclaw-tasks-page") as TasksPageTestElement;
    page.context = createContext(source.gateway);
    document.body.append(page);
    await vi.waitFor(() => expect(page.tasks).toHaveLength(1));

    const recovery = page.recoverTask(blocked.taskId, "retry");
    await vi.waitFor(() => expect(page.cancellingTaskIds.has(blocked.taskId)).toBe(true));
    source.emitConnected(false);
    source.emitConnected(true);
    pendingRecovery.resolve({
      results: [
        {
          taskId: blocked.taskId,
          ok: true,
          task: { ...blocked, deliveryStatus: "session_queued", terminalOutcome: "succeeded" },
        },
      ],
    });
    await recovery;

    expect(page.tasks[0]).toMatchObject({
      deliveryStatus: "failed",
      terminalOutcome: "blocked",
    });
    expect(page.cancellingTaskIds.size).toBe(0);
  });

  it("keeps a dismissed completion result copyable without offering another recovery", async () => {
    const dismissed = createTask("task-dismissed", "completed", {
      deliveryStatus: "dismissed",
      terminalOutcome: "blocked",
      terminalSummary: "Task completed; result delivery was dismissed by the operator.",
    });
    const request = vi.fn(() => Promise.resolve({ tasks: [dismissed] }));
    const source = createGateway({ request } as unknown as GatewayBrowserClient);
    const page = document.createElement("openclaw-tasks-page") as TasksPageTestElement;
    page.context = createContext(source.gateway);
    document.body.append(page);
    await vi.waitFor(() => expect(page.tasks).toHaveLength(1));

    const text = page.textContent ?? "";
    expect(text).toContain("Completed; result delivery was dismissed.");
    expect(text).toContain("Copy result");
    expect(text).not.toContain("Retry delivery");
    expect(text).not.toContain("Dismiss delivery");
    expect(text).not.toContain("Retrying may duplicate a result");
  });
});
