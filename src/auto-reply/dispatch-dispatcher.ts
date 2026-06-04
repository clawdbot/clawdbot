// Reply dispatcher lifecycle helpers used by auto-reply dispatch paths.
import type { ReplyDispatcher } from "./reply/reply-dispatcher.types.js";

/** Mark a dispatcher complete, wait for pending work, then run optional cleanup. */
export async function settleReplyDispatcher(params: {
  dispatcher: ReplyDispatcher;
  onSettled?: () => void | Promise<void>;
}): Promise<void> {
  params.dispatcher.markComplete();
  try {
    await params.dispatcher.waitForIdle();
  } finally {
    await params.onSettled?.();
  }
}

/** Run work with a dispatcher and always drain it before returning or throwing. */
export async function withReplyDispatcher<T>(params: {
  dispatcher: ReplyDispatcher;
  run: () => Promise<T>;
  onSettled?: () => void | Promise<void>;
}): Promise<T> {
  try {
    return await params.run();
  } finally {
    await settleReplyDispatcher(params);
  }
}
