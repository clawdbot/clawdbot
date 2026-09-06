import { availableParallelism } from "node:os";
import { parentPort, Worker, type Transferable, type WorkerOptions } from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";

type WorkerTaskInput<Input> = Input | (() => Input | Promise<Input>);
type WorkerTaskOptions<Input> = {
  /** When supplied, queueing and asynchronous preparation consume the execution deadline. */
  timeoutMs?: number;
  signal?: AbortSignal;
  transferList?: (input: Input) => readonly Transferable[];
};
type WorkerReply<Output> = { status: "ok"; value: Output } | { status: "failed"; error: string };
type Task<Input, Output> = Deferred<Output> & {
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
      input,
      options,
      abort: () => this.cancel(task, toErrorObject(options.signal?.reason, "worker task aborted")),
      done: false,
    };
    if (options.timeoutMs !== undefined) {
      task.timer = setTimeout(
        () => this.cancel(task, new WorkerTaskError("worker task timed out", "timeout")),
        resolveTimerTimeoutMs(options.timeoutMs, 60_000),
      );
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
      void this.start(slot, task);
    }
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
      if (!slot.worker) {
        const worker = new Worker(this.options.workerUrl, {
          execArgv: this.options.workerUrl.pathname.endsWith(".ts") ? ["--import", "tsx"] : [],
          ...this.options.workerOptions,
        });
        slot.worker = worker;
        worker.on("message", (message: unknown) => this.receive(slot, message));
        worker.on("error", (error) =>
          this.fail(slot, new WorkerTaskError(String(error), "unavailable")),
        );
        worker.on("messageerror", (error) =>
          this.fail(slot, new WorkerTaskError(String(error), "unavailable")),
        );
        worker.once("exit", (code) =>
          this.fail(slot, new WorkerTaskError(`worker exited with code ${code}`, "unavailable")),
        );
      }
      const transferList = task.options.transferList?.(input);
      if (!task.done) {
        slot.worker.postMessage({ input }, transferList);
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
    if (!task || !isRecord(message) || (message.status !== "ok" && message.status !== "failed")) {
      this.fail(slot, new WorkerTaskError("invalid worker task response", "unavailable"));
      return;
    }
    // SAFETY: The private worker entry owns Output; the transport discriminant is checked above.
    const reply = message as WorkerReply<Output>;
    if (reply.status === "failed") {
      this.finish(task, new WorkerTaskError(reply.error, "failed"));
      return;
    }
    try {
      // The owner must accept its lifecycle-bound result before a successor can execute.
      this.options.validateResult?.(reply.value);
    } catch (error) {
      this.fail(slot, toErrorObject(error, "worker result validation failed"));
      return;
    }
    this.finish(task, undefined, reply.value);
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
    clearTimeout(task.timer);
    task.options.signal?.removeEventListener("abort", task.abort);
    // SAFETY: Only a validated successful reply reaches finish without an error and supplies Output.
    const complete = () => (error ? task.reject(error) : task.resolve(value as Output));
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

/** Pool dispatch is serial per worker; handlers finish cleanup before returning their result. */
export function serveWorkerTasks<Output>(
  handler: (input: unknown) => Output | Promise<Output>,
  options: { transferList?: (value: Output) => Transferable[] } = {},
): void {
  const port = parentPort;
  if (!port) {
    return;
  }
  port.on("message", ({ input }: { input: unknown }) => {
    void Promise.resolve()
      .then(() => handler(input))
      .then((value) =>
        port.postMessage(
          { status: "ok", value } satisfies WorkerReply<Output>,
          options.transferList?.(value) ?? [],
        ),
      )
      .catch((error: unknown) =>
        port.postMessage({
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        } satisfies WorkerReply<Output>),
      );
  });
}
