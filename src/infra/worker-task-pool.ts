import { AsyncLocalStorage } from "node:async_hooks";
import { availableParallelism } from "node:os";
import { parentPort, Worker, type Transferable, type WorkerOptions } from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";

// Reusable workers must not retain the first submitting caller's async scope.
const runInWorkerPoolContext = AsyncLocalStorage.snapshot();

type WorkerTaskInput<Input> = Input | (() => Input | Promise<Input>);
export type WorkerTaskResponse = {
  input: unknown;
  /** Remaining owner budget, plus its existing watchdog grace. */
  timeoutMs: number;
  /** Release input ownership only after worker consumption or confirmed termination. */
  onConsumed?: () => void;
};

export type WorkerTaskRequestContext = {
  /** Task lifetime: closes on completion/checkpoint as well as cancellation. */
  signal: AbortSignal;
  /** Queue pressure requests a checkpoint; it does not cancel underlying host work. */
  yieldSignal: AbortSignal;
};

type WorkerTaskOptions<Input> = {
  /** When supplied, queueing and asynchronous preparation consume the execution deadline. */
  timeoutMs?: number;
  signal?: AbortSignal;
  transferList?: (input: Input) => readonly Transferable[];
  onRequest?: (value: unknown, context: WorkerTaskRequestContext) => Promise<WorkerTaskResponse>;
  onInputConsumed?: () => void;
};
type WorkerReply<Output> = { status: "ok"; value: Output } | { status: "failed"; error: string };
type WorkerHostExchange = {
  id: number;
  pressure: AbortController;
  onConsumed?: () => void;
  sent: boolean;
};
type WorkerChannelResponse = { input: unknown; consumed: () => void };
type WorkerConversation = {
  taskId: number;
  responseId: number;
  pending?: Deferred<WorkerChannelResponse>;
};
type Task<Input, Output> = Deferred<Output> & {
  id: number;
  runInContext: ReturnType<typeof AsyncLocalStorage.snapshot>;
  controller: AbortController;
  exchange?: WorkerHostExchange;
  inputConsumed: boolean;
  exchangeSequence: number;
  input?: WorkerTaskInput<Input>;
  options: WorkerTaskOptions<Input>;
  timer?: NodeJS.Timeout;
  abort: () => void;
  done: boolean;
  slot?: Slot<Input, Output>;
};
type Slot<Input, Output> = {
  worker?: Worker;
  task?: Task<Input, Output>;
  idleTimer?: NodeJS.Timeout;
  retiring?: Promise<void>;
};

export class WorkerTaskError extends Error {
  constructor(
    message: string,
    readonly code: "unavailable" | "timeout" | "failed",
  ) {
    super(message);
    this.name = "WorkerTaskError";
  }
}

/** Bounded execution workers; each worker accepts one task at a time. */
export class WorkerTaskPool<Input, Output> {
  private readonly slots = new Set<Slot<Input, Output>>();
  private readonly queue: Task<Input, Output>[] = [];
  private readonly maxWorkers: number;
  private closedError?: Error;
  private nextTaskId = 0;
  // Idle retirement is armed from worker messages, outside any caller's turn.
  // Bind the clock at construction so a process-wide pool cannot land that timer
  // on a fake or stubbed setTimeout an unrelated test installed later; on the
  // wrong clock the worker never retires and that test's timer count is off.
  private readonly setTimeoutFn = setTimeout;
  private readonly clearTimeoutFn = clearTimeout;

  constructor(
    private readonly options: {
      workerUrl: URL;
      workerOptions?: Omit<WorkerOptions, "eval">;
      maxWorkers?: number;
      idleTimeoutMs?: number;
      restartOnError?: boolean;
      validateResult?: (value: Output) => void;
    },
  ) {
    this.maxWorkers = options.maxWorkers ?? availableParallelism();
  }

  run(input: WorkerTaskInput<Input>, options: WorkerTaskOptions<Input>): Promise<Output> {
    if (this.closedError) {
      return Promise.reject(this.closedError);
    }
    // A Promise executor would let the task's timer/abort closures retain input too.
    const task: Task<Input, Output> = {
      ...createDeferredCore<Output>(),
      id: ++this.nextTaskId,
      runInContext: AsyncLocalStorage.snapshot(),
      controller: new AbortController(),
      inputConsumed: false,
      exchangeSequence: 0,
      input,
      options: { ...options },
      abort: () => this.cancel(task, toErrorObject(options.signal?.reason, "worker task aborted")),
      done: false,
    };
    if (options.timeoutMs !== undefined) {
      this.armTimeout(task, options.timeoutMs);
    }
    options.signal?.addEventListener("abort", task.abort, { once: true });
    this.queue.push(task);
    if (options.signal?.aborted) {
      task.abort();
    } else {
      this.dispatch();
    }
    return task.promise;
  }

  close(
    error: Error = new WorkerTaskError("worker task pool closed", "unavailable"),
  ): Promise<void> {
    this.closedError ??= error;
    for (const task of this.queue.splice(0)) {
      this.finish(task, this.closedError);
    }
    for (const slot of this.slots) {
      if (slot.task) {
        this.finish(slot.task, this.closedError, undefined, true);
      }
    }
    return Promise.all([...this.slots].map((slot) => this.retire(slot))).then(() => undefined);
  }

  private dispatch(): void {
    while (!this.closedError && this.queue.length) {
      let slot = [...this.slots].find((entry) => !entry.task && !entry.retiring);
      if (!slot) {
        if (this.slots.size >= this.maxWorkers) {
          // A host-waiting task can checkpoint rather than monopolize a worker.
          // Signal one owner per queued contender, in slot admission order.
          let contenders = this.queue.length;
          for (const occupied of this.slots) {
            if (
              occupied.task?.exchange &&
              !occupied.task.exchange.sent &&
              !occupied.task.exchange.pressure.signal.aborted &&
              contenders-- > 0
            ) {
              occupied.task.exchange.pressure.abort();
            }
          }
          return;
        }
        slot = {};
        this.slots.add(slot);
      }
      this.clearTimeoutFn(slot.idleTimer);
      const task = this.queue.shift()!;
      slot.task = task;
      task.slot = slot;
      slot.worker?.ref();
      void task.runInContext(() => this.start(slot, task));
    }
  }

  // Worker listeners outlive tasks; their creation scope must not retain an async task frame.
  private createWorker(slot: Slot<Input, Output>): Worker {
    const worker = runInWorkerPoolContext(
      () =>
        new Worker(this.options.workerUrl, {
          // Preserve native require(ESM) and its transitive import-only exports.
          execArgv: this.options.workerUrl.pathname.endsWith(".ts") ? ["--import", "tsx/esm"] : [],
          ...this.options.workerOptions,
        }),
    );
    slot.worker = worker;
    worker.on("message", (message: unknown) => {
      const task = slot.task;
      if (task) {
        task.runInContext(() => this.receive(slot, message));
      } else {
        this.receive(slot, message);
      }
    });
    worker.on("error", (error) =>
      this.fail(slot, new WorkerTaskError(String(error), "unavailable")),
    );
    worker.on("messageerror", (error) =>
      this.fail(slot, new WorkerTaskError(String(error), "unavailable")),
    );
    worker.once("exit", (code) =>
      this.fail(slot, new WorkerTaskError(`worker exited with code ${code}`, "unavailable")),
    );
    return worker;
  }

  private async start(slot: Slot<Input, Output>, task: Task<Input, Output>): Promise<void> {
    // Execution owns the input now; retaining it on task duplicates the worker's clone.
    const taskInput = task.input!;
    delete task.input;
    let input: Input;
    try {
      input =
        typeof taskInput === "function"
          ? await (taskInput as () => Input | Promise<Input>)() // SAFETY: Callable inputs are factories.
          : taskInput;
    } catch (error) {
      this.fail(slot, toErrorObject(error, "worker task preparation failed"));
      return;
    }
    // A cancelled preparation may finish later, but it must never create or feed a worker.
    if (task.done) {
      return;
    }
    try {
      const worker = slot.worker ?? this.createWorker(slot);
      const transferList = task.options.transferList?.(input);
      if (!task.done) {
        worker.postMessage(
          { input, taskId: task.id, interactive: Boolean(task.options.onRequest) },
          transferList,
        );
      }
    } catch (error) {
      this.fail(slot, new WorkerTaskError(String(error), "unavailable"));
    }
  }

  private receive(slot: Slot<Input, Output>, message: unknown): void {
    if (slot.retiring) {
      return;
    }
    const task = slot.task;
    if (
      task &&
      isRecord(message) &&
      (message.status === "request" || message.status === "consumed")
    ) {
      try {
        this.receiveExchange(slot, task, message);
      } catch (error) {
        this.fail(slot, toErrorObject(error, "worker consumption callback failed"));
      }
      return;
    }
    if (
      !task ||
      !isRecord(message) ||
      ((task.options.onRequest || message.taskId !== undefined) && message.taskId !== task.id) ||
      (message.status !== "ok" && message.status !== "failed")
    ) {
      this.fail(slot, new WorkerTaskError("invalid worker task response", "unavailable"));
      return;
    }
    // SAFETY: The private worker entry owns Output; the transport discriminant is checked above.
    const reply = message as WorkerReply<Output>;
    if (reply.status === "failed") {
      this.finish(
        task,
        new WorkerTaskError(reply.error, "failed"),
        undefined,
        Boolean(task.exchange) || (Boolean(task.options.onInputConsumed) && !task.inputConsumed),
      );
      return;
    }
    try {
      // The owner must accept its lifecycle-bound result before a successor can execute.
      this.options.validateResult?.(reply.value);
    } catch (error) {
      this.fail(slot, toErrorObject(error, "worker result validation failed"));
      return;
    }
    if (task.exchange || (task.options.onInputConsumed && !task.inputConsumed)) {
      // A failed handler may not reach its consumption receipt. Termination,
      // rather than a result message, proves it no longer owns those inputs.
      this.finish(task, undefined, reply.value, true);
      return;
    }
    this.finish(task, undefined, reply.value);
  }

  private armTimeout(task: Task<Input, Output>, timeoutMs: number): void {
    clearTimeout(task.timer);
    task.timer = setTimeout(
      () => this.cancel(task, new WorkerTaskError("worker task timed out", "timeout")),
      resolveTimerTimeoutMs(timeoutMs, 60_000),
    );
  }

  private receiveExchange(
    slot: Slot<Input, Output>,
    task: Task<Input, Output>,
    message: Record<string, unknown>,
  ): void {
    if (message.taskId !== task.id) {
      this.fail(slot, new WorkerTaskError("stale worker exchange", "unavailable"));
      return;
    }
    if (message.status === "consumed") {
      if (message.id === 0 && !task.inputConsumed) {
        task.inputConsumed = true;
        const release = task.options.onInputConsumed;
        task.options.onInputConsumed = undefined;
        release?.();
      } else if (task.exchange?.sent && message.id === task.exchange.id) {
        const release = task.exchange.onConsumed;
        task.exchange = undefined;
        release?.();
      } else {
        this.fail(slot, new WorkerTaskError("invalid worker consumption receipt", "unavailable"));
      }
      return;
    }
    if (
      !task.options.onRequest ||
      task.exchange ||
      !Number.isSafeInteger(message.id) ||
      message.id !== task.exchangeSequence + 1
    ) {
      this.fail(slot, new WorkerTaskError("invalid worker exchange", "unavailable"));
      return;
    }
    // The owner, not a second pool clock, budgets host waits and pauses approvals.
    clearTimeout(task.timer);
    const exchange: WorkerHostExchange = {
      id: ++task.exchangeSequence,
      pressure: new AbortController(),
      sent: false,
      onConsumed: undefined,
    };
    task.exchange = exchange;
    this.dispatch();
    void Promise.resolve()
      .then(() => {
        if (task.done || slot.task !== task) {
          throw new WorkerTaskError("worker task closed before host dispatch", "unavailable");
        }
        return task.options.onRequest!(message.value, {
          signal: task.controller.signal,
          yieldSignal: exchange.pressure.signal,
        });
      })
      .then(async (response) => {
        if (task.done || slot.task !== task || slot.retiring) {
          // A slow host handler may settle after cancellation. Never feed a successor.
          await slot.retiring;
          response.onConsumed?.();
          return;
        }
        exchange.onConsumed = response.onConsumed;
        exchange.sent = true;
        this.armTimeout(task, response.timeoutMs);
        try {
          slot.worker!.postMessage(
            {
              taskId: task.id,
              responseId: exchange.id,
              input: response.input,
            },
            [],
          );
        } catch (error) {
          this.fail(slot, toErrorObject(error, "worker response delivery failed"));
        }
      })
      .catch((error: unknown) => {
        if (!task.done && slot.task === task) {
          this.fail(slot, toErrorObject(error, "worker host exchange failed"));
        }
      });
  }

  private cancel(task: Task<Input, Output>, error: Error): void {
    if (task.done) {
      return;
    }
    if (task.slot) {
      this.fail(task.slot, error);
    } else {
      // Only queued tasks lack a slot; dispatch and close remove their entries themselves.
      this.queue.splice(this.queue.indexOf(task), 1);
      this.finish(task, error);
    }
  }

  private fail(slot: Slot<Input, Output>, error: Error): void {
    if (slot.retiring) {
      return;
    }
    if (this.options.restartOnError === false) {
      void this.close(error);
    } else if (slot.task) {
      this.finish(slot.task, error, undefined, true);
    } else {
      void this.retire(slot);
    }
  }

  private finish(task: Task<Input, Output>, error?: Error, value?: Output, retire = false): void {
    if (task.done) {
      return;
    }
    task.done = true;
    task.runInContext(() => task.controller.abort());
    clearTimeout(task.timer);
    task.options.signal?.removeEventListener("abort", task.abort);
    // SAFETY: Only a validated successful reply reaches finish without an error and supplies Output.
    const complete = () =>
      task.runInContext(() => {
        let completionError = error;
        try {
          // Retiring completion runs only after terminate() resolves. Queued inputs
          // were never delivered; both paths release without claiming consumption.
          if (!task.inputConsumed) {
            task.inputConsumed = true;
            task.options.onInputConsumed?.();
          }
          const release = task.exchange?.onConsumed;
          task.exchange = undefined;
          release?.();
        } catch (releaseError) {
          completionError ??= toErrorObject(releaseError, "worker input release failed");
        }
        if (completionError) {
          task.reject(completionError);
        } else {
          // SAFETY: A successful validated worker reply supplies Output to finish.
          task.resolve(value as Output);
        }
      });
    const slot = task.slot;
    if (slot) {
      slot.task = undefined;
      if (retire) {
        // Keep the slot reserved and the caller pending until its execution actually stops.
        void this.retire(slot).then(complete);
        return;
      }
      if (!this.queue.length) {
        this.idle(slot);
      }
    }
    complete();
    this.dispatch();
  }

  // A separate scope keeps the idle timer from retaining the completed task/result.
  private idle(slot: Slot<Input, Output>): void {
    slot.worker?.unref();
    const idleMs = this.options.idleTimeoutMs ?? 60_000;
    if (idleMs > 0) {
      slot.idleTimer = this.setTimeoutFn(() => void this.retire(slot), idleMs);
      slot.idleTimer.unref();
    }
  }

  private retire(slot: Slot<Input, Output>): Promise<void> {
    this.clearTimeoutFn(slot.idleTimer);
    // Retain error listeners until exit: termination can race a worker startup error.
    return (slot.retiring ??= (slot.worker?.terminate() ?? Promise.resolve()).then(() => {
      slot.worker?.removeAllListeners();
      this.slots.delete(slot);
      this.dispatch();
    }));
  }
}

/** A conversation never outlives the pool task or crosses worker generations. */
export type WorkerTaskChannel = {
  consumeInput: () => void;
  request: (value: unknown) => Promise<{ input: unknown; consumed: () => void }>;
};

/** Pool dispatch is serial per worker; handlers finish cleanup before returning their result. */
export function serveWorkerTasks<Output>(
  handler: (input: unknown, channel?: WorkerTaskChannel) => Output | Promise<Output>,
  options: { transferList?: (value: Output) => Transferable[] } = {},
): void {
  const port = parentPort;
  if (!port) {
    return;
  }
  let active: WorkerConversation | undefined;
  port.on(
    "message",
    (message: { input: unknown; taskId: number; interactive?: boolean; responseId?: number }) => {
      if (message.responseId !== undefined) {
        if (
          !active ||
          message.taskId !== active.taskId ||
          message.responseId !== active.responseId ||
          !active.pending
        ) {
          throw new Error("stale worker task response");
        }
        const pending = active.pending;
        active.pending = undefined;
        let consumed = false;
        const taskId = message.taskId;
        const id = message.responseId;
        pending.resolve({
          input: message.input,
          consumed: () => {
            if (consumed) {
              return;
            }
            consumed = true;
            port.postMessage({ status: "consumed", taskId, id });
          },
        });
        return;
      }
      if (active) {
        throw new Error("overlapping worker tasks");
      }
      const task: WorkerConversation = { taskId: message.taskId, responseId: 0 };
      active = task;
      const channel: WorkerTaskChannel | undefined = message.interactive
        ? {
            consumeInput: () =>
              port.postMessage({ status: "consumed", taskId: task.taskId, id: 0 }),
            request: (value) => {
              if (active !== task || task.pending) {
                throw new Error("closed or busy worker channel");
              }
              task.pending = createDeferredCore();
              port.postMessage({
                status: "request",
                taskId: task.taskId,
                id: ++task.responseId,
                value,
              });
              return task.pending.promise;
            },
          }
        : undefined;
      void Promise.resolve()
        .then(() => handler(message.input, channel))
        .then((value) => {
          active = undefined;
          port.postMessage(
            { status: "ok", value, taskId: task.taskId },
            options.transferList?.(value) ?? [],
          );
        })
        .catch((error: unknown) => {
          active = undefined;
          port.postMessage({
            status: "failed",
            taskId: task.taskId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
  );
}
