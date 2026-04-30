import type { ReplyDispatcher } from "./reply/reply-dispatcher.types.js";

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
