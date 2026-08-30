import { randomUUID } from "node:crypto";
import type { A2aMessageRecord, A2aTaskRecord } from "./protocol.js";

const A2A_TERMINAL_MAX_TASKS = 500;
const A2A_TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;
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
  readonly #pendingByContext = new Map<string, string[]>();
  readonly #terminalTasks = new Map<string, number>();
  readonly #waiters = new Map<string, Set<A2aTaskWaiter>>();

  create(contextId: string, ownerPeer?: string): A2aTaskRecord {
    this.#pruneTerminalTasks();
    const task: A2aTaskRecord = {
      id: randomUUID(),
      contextId,
      status: { state: "TASK_STATE_SUBMITTED", timestamp: new Date().toISOString() },
      artifacts: [],
      history: [],
    };
    this.#tasks.set(task.id, task);
    if (ownerPeer !== undefined) {
      this.#taskOwners.set(task.id, ownerPeer);
    }
    const conversationKey = this.#conversationKey(contextId, ownerPeer);
    const pending = this.#pendingByContext.get(conversationKey) ?? [];
    pending.push(task.id);
    this.#pendingByContext.set(conversationKey, pending);
    return task;
  }

  get(taskId: string, ownerPeer?: string): A2aTaskRecord | undefined {
    this.#pruneTerminalTasks();
    if (ownerPeer !== undefined && this.#taskOwners.get(taskId) !== ownerPeer) {
      return undefined;
    }
    return this.#tasks.get(taskId);
  }

  start(taskId: string): A2aTaskRecord | undefined {
    const task = this.#tasks.get(taskId);
    if (task?.status.state === "TASK_STATE_SUBMITTED") {
      task.status = { state: "TASK_STATE_WORKING", timestamp: new Date().toISOString() };
    }
    return task;
  }

  completeNext(
    contextId: string,
    text: string | undefined,
    ownerPeer?: string,
  ): A2aTaskRecord | undefined {
    const conversationKey = this.#conversationKey(contextId, ownerPeer);
    const queue = this.#pendingByContext.get(conversationKey);
    if (!queue?.length) {
      return undefined;
    }
    const nextTaskId = queue.shift();
    if (queue.length === 0) {
      this.#pendingByContext.delete(conversationKey);
    }
    if (!nextTaskId) {
      return undefined;
    }

    const task = this.#tasks.get(nextTaskId);
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
        ? { message: createStatusMessage(contextId, "Agent completed without reply text") }
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
    this.#pendingByContext.clear();
    this.#terminalTasks.clear();
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
    const conversationKey = this.#conversationKey(task.contextId, this.#taskOwners.get(task.id));
    const queue = this.#pendingByContext.get(conversationKey);
    if (queue) {
      const position = queue.indexOf(taskId);
      if (position !== -1) {
        queue.splice(position, 1);
      }
      if (queue.length === 0) {
        this.#pendingByContext.delete(conversationKey);
      }
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
      this.#tasks.delete(taskId);
    }
  }

  #conversationKey(contextId: string, ownerPeer?: string): string {
    return ownerPeer === undefined ? contextId : `${ownerPeer}\0${contextId}`;
  }
}
