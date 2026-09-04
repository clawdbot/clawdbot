// Reply dispatcher lifecycle helpers used by auto-reply dispatch paths.
import type { ReplyDispatchReceipt, ReplyDispatcher } from "./reply/reply-dispatcher.types.js";

type ReplyDispatcherSettledTask = () => Promise<void> | void;

const settledTasksByDispatcher = new WeakMap<ReplyDispatcher, Set<ReplyDispatcherSettledTask>>();

/** Register post-delivery work owned by the dispatcher's settle lifecycle. */
export function registerReplyDispatcherSettledTask(
  dispatcher: ReplyDispatcher,
  task: ReplyDispatcherSettledTask,
): void {
  const tasks = settledTasksByDispatcher.get(dispatcher) ?? new Set<ReplyDispatcherSettledTask>();
  tasks.add(task);
  settledTasksByDispatcher.set(dispatcher, tasks);
}

/** Mark a dispatcher complete, wait for pending work, then run optional cleanup. */
export async function settleReplyDispatcher(params: {
  dispatcher: ReplyDispatcher;
  onSettled?: () => void | Promise<void>;
}): Promise<ReplyDispatchReceipt | undefined> {
  params.dispatcher.markComplete();
  let receipt: ReplyDispatchReceipt | void = undefined;
  const failures: unknown[] = [];
  try {
    receipt = await params.dispatcher.waitForIdle();
  } catch (error) {
    failures.push(error);
  }
  const tasks = settledTasksByDispatcher.get(params.dispatcher) ?? [];
  settledTasksByDispatcher.delete(params.dispatcher);
  // Draining may reject after delivery outcomes settle; release every owner in order
  // without replacing the original error (including typed retryable no-send errors).
  for (const task of [...tasks, params.onSettled]) {
    try {
      await task?.();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw failures[0];
  }
  return receipt || undefined;
}

/** Run work with a dispatcher and always drain it before returning or throwing. */
export async function withReplyDispatcher<T>(params: {
  dispatcher: ReplyDispatcher;
  run: () => Promise<T>;
  onSettled?: () => void | Promise<void>;
  onSettledReceipt?: (receipt: ReplyDispatchReceipt | undefined) => void;
}): Promise<T> {
  let run: { value: T } | { error: unknown };
  try {
    run = { value: await params.run() };
  } catch (error) {
    run = { error };
  }
  try {
    const receipt = await settleReplyDispatcher(params);
    params.onSettledReceipt?.(receipt);
  } catch (error) {
    if ("value" in run) {
      throw error;
    }
  }
  if ("error" in run) {
    throw run.error;
  }
  return run.value;
}
