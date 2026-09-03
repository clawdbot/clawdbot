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

async function runReplyDispatcherSettledTasks(dispatcher: ReplyDispatcher): Promise<void> {
  const tasks = settledTasksByDispatcher.get(dispatcher);
  if (!tasks) {
    return;
  }
  settledTasksByDispatcher.delete(dispatcher);
  for (const task of tasks) {
    await task();
  }
}

/** Mark a dispatcher complete, wait for pending work, then run optional cleanup. */
export async function settleReplyDispatcher(params: {
  dispatcher: ReplyDispatcher;
  onSettled?: () => void | Promise<void>;
}): Promise<ReplyDispatchReceipt | undefined> {
  params.dispatcher.markComplete();
  try {
    const receipt = await params.dispatcher.waitForIdle();
    await runReplyDispatcherSettledTasks(params.dispatcher);
    return receipt || undefined;
  } finally {
    settledTasksByDispatcher.delete(params.dispatcher);
    await params.onSettled?.();
  }
}

/** Run work with a dispatcher and always drain it before returning or throwing. */
export async function withReplyDispatcher<T>(params: {
  dispatcher: ReplyDispatcher;
  run: () => Promise<T>;
  onSettled?: () => void | Promise<void>;
  onSettledReceipt?: (receipt: ReplyDispatchReceipt | undefined) => void;
}): Promise<T> {
  try {
    return await params.run();
  } finally {
    const receipt = await settleReplyDispatcher(params);
    params.onSettledReceipt?.(receipt);
  }
}
