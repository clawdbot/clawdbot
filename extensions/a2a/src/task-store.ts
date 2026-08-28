import { randomUUID } from "node:crypto";
import type { A2aMessageRecord, A2aTaskRecord } from "./protocol.js";

const A2A_TERMINAL_MAX_TASKS = 500;
const A2A_TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;
// Backstop for turns that never settle (e.g. a hung model endpoint): far above
// the maximum blocking reply wait (replyTimeoutMs caps at 10 minutes).
const A2A_STALE_TASK_TTL_MS = 60 * 60 * 1000;
const A2A_ERROR_MAX_LENGTH = 512;

type A2aTaskWaiter = {
  resolve: (task: A2aTaskRecord) => void;
  timer: ReturnType<typeof setTimeout>;
};

function isTerminalTask(task: A2aTaskRecord): boolean {
  return task.status.state !== "TASK_STATE_SUBMITTED" && task.status.state !== "TASK_STATE_WORKING";
}

function createStatusMessage(contextId: string, text: string): A2aMessageRecord {
  return {
    messageId: randomUUID(),
    contextId,
    role: "ROLE_AGENT",
    parts: [{ text: text.slice(0, A2A_ERROR_MAX_LENGTH) }],
  };
}

export class A2aTaskStore {
  readonly #tasks = new Map<string, A2aTaskRecord>();
  readonly #taskOwners = new Map<string, string>();
  readonly #terminalTasks = new Map<string, number>();
  readonly #lastChangeAt = new Map<string, number>();
  readonly #waiters = new Map<string, Set<A2aTaskWaiter>>();
  readonly #expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  create(contextId: string, ownerPeer?: string): A2aTaskRecord {
    this.#pruneTerminalTasks();
    this.#sweepStaleTasks();
    const task: A2aTaskRecord = {
      id: randomUUID(),
      contextId,
      status: { state: "TASK_STATE_SUBMITTED", timestamp: new Date().toISOString() },
      artifacts: [],
      history: [],
    };
    this.#tasks.set(task.id, task);
    this.#lastChangeAt.set(task.id, Date.now());
    this.#scheduleExpiry(task.id);
    if (ownerPeer !== undefined) {
      this.#taskOwners.set(task.id, ownerPeer);
    }
    return task;
  }

  get(taskId: string, ownerPeer?: string): A2aTaskRecord | undefined {
    this.#pruneTerminalTasks();
    this.#sweepStaleTasks();
    if (ownerPeer !== undefined && this.#taskOwners.get(taskId) !== ownerPeer) {
      return undefined;
    }
    return this.#tasks.get(taskId);
  }

  start(taskId: string): A2aTaskRecord | undefined {
    const task = this.#tasks.get(taskId);
    if (task?.status.state === "TASK_STATE_SUBMITTED") {
      task.status = { state: "TASK_STATE_WORKING", timestamp: new Date().toISOString() };
      this.#lastChangeAt.set(taskId, Date.now());
      this.#scheduleExpiry(taskId);
    }
    return task;
  }

  // Final replies settle the task that originated the turn, never whatever
  // happens to lead the conversation: a reply whose task is already terminal
  // (swept, failed, or rejected) is dropped instead of completing a newer
  // task in the same conversation. Sweeping first also enforces the stale
  // deadline when this delivery is the first store operation to cross it.
  completeTask(taskId: string, text: string | undefined): A2aTaskRecord | undefined {
    this.#sweepStaleTasks();
    const task = this.#tasks.get(taskId);
    if (!task || isTerminalTask(task)) {
      return undefined;
    }
    if (text?.trim()) {
      task.artifacts = [{ artifactId: randomUUID(), parts: [{ text }] }];
    }
    task.status = {
      state: "TASK_STATE_COMPLETED",
      timestamp: new Date().toISOString(),
      ...(!text?.trim()
        ? { message: createStatusMessage(task.contextId, "Agent completed without reply text") }
        : {}),
    };
    return this.#finishTask(task);
  }

  fail(taskId: string, error: unknown): A2aTaskRecord | undefined {
    const reason = error instanceof Error ? error.message : String(error);
    return this.#finishWithMessage(taskId, "TASK_STATE_FAILED", reason);
  }

  reject(taskId: string, reason: string): A2aTaskRecord | undefined {
    return this.#finishWithMessage(taskId, "TASK_STATE_REJECTED", reason);
  }

  wait(taskId: string, timeoutMs: number): Promise<A2aTaskRecord | undefined> {
    const task = this.get(taskId);
    if (!task || isTerminalTask(task)) {
      return Promise.resolve(task);
    }
    return new Promise((resolve) => {
      const waiters = this.#waiters.get(taskId) ?? new Set<A2aTaskWaiter>();
      const waiter: A2aTaskWaiter = {
        resolve,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          if (waiters.size === 0) {
            this.#waiters.delete(taskId);
          }
          resolve(task);
        }, timeoutMs),
      };
      waiters.add(waiter);
      this.#waiters.set(taskId, waiters);
    });
  }

  stop(): void {
    for (const [taskId, waiters] of this.#waiters) {
      const task = this.#tasks.get(taskId);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        if (task) {
          waiter.resolve(task);
        }
      }
    }
    this.#waiters.clear();
    for (const timer of this.#expiryTimers.values()) {
      clearTimeout(timer);
    }
    this.#expiryTimers.clear();
    this.#terminalTasks.clear();
    this.#lastChangeAt.clear();
    this.#taskOwners.clear();
    this.#tasks.clear();
  }

  #finishWithMessage(
    taskId: string,
    state: "TASK_STATE_FAILED" | "TASK_STATE_REJECTED",
    reason: string,
  ): A2aTaskRecord | undefined {
    const task = this.#tasks.get(taskId);
    if (!task || isTerminalTask(task)) {
      return task;
    }
    task.status = {
      state,
      timestamp: new Date().toISOString(),
      message: createStatusMessage(task.contextId, reason),
    };
    return this.#finishTask(task);
  }

  #finishTask(task: A2aTaskRecord): A2aTaskRecord {
    this.#terminalTasks.set(task.id, Date.now());
    this.#lastChangeAt.delete(task.id);
    const expiryTimer = this.#expiryTimers.get(task.id);
    if (expiryTimer) {
      clearTimeout(expiryTimer);
      this.#expiryTimers.delete(task.id);
    }
    const waiters = this.#waiters.get(task.id);
    if (waiters) {
      this.#waiters.delete(task.id);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(task);
      }
    }
    this.#pruneTerminalTasks();
    return task;
  }

  #pruneTerminalTasks(): void {
    const expiresBefore = Date.now() - A2A_TERMINAL_RETENTION_MS;
    for (const [taskId, finishedAt] of this.#terminalTasks) {
      if (finishedAt > expiresBefore && this.#terminalTasks.size <= A2A_TERMINAL_MAX_TASKS) {
        break;
      }
      this.#terminalTasks.delete(taskId);
      this.#taskOwners.delete(taskId);
      this.#lastChangeAt.delete(taskId);
      this.#tasks.delete(taskId);
    }
  }

  // Terminal pruning alone cannot bound the store: a task whose turn never
  // settles stays SUBMITTED/WORKING forever while every peer message adds a
  // new row. Fail stale non-terminal tasks so they age out like any other.
  #sweepStaleTasks(): void {
    const staleBefore = Date.now() - A2A_STALE_TASK_TTL_MS;
    for (const [taskId, changedAt] of this.#lastChangeAt) {
      if (changedAt >= staleBefore) {
        continue;
      }
      this.#finishWithMessage(taskId, "TASK_STATE_FAILED", "Task expired before the agent settled");
    }
  }

  // Autonomous counterpart to the sweep: an otherwise idle store still fails
  // the task at its deadline. Unref'd so the timer never holds the process.
  #scheduleExpiry(taskId: string): void {
    const existing = this.#expiryTimers.get(taskId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.#expiryTimers.delete(taskId);
      this.#finishWithMessage(taskId, "TASK_STATE_FAILED", "Task expired before the agent settled");
    }, A2A_STALE_TASK_TTL_MS);
    timer.unref?.();
    this.#expiryTimers.set(taskId, timer);
  }
}
