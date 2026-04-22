import type { ReplyToMode } from "../../config/types.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

export type ReplyReferencePlanner = {
  /** Returns the effective reply/thread id for the next send without updating state. */
  peek(): string | undefined;
  /** Returns the effective reply/thread id for the next send and updates state. */
  use(): string | undefined;
  /** Mark that a reply was sent (needed when no reference is used). */
  markSent(): void;
  /** Whether a reply has been sent in this flow. */
  hasReplied(): boolean;
};

export function isSingleUseReplyToMode(mode: ReplyToMode): boolean {
  return mode === "first" || mode === "batched";
}

export function createReplyReferencePlanner(options: {
  replyToMode: ReplyToMode;
  /** Existing thread/reference id (preferred when allowed by replyToMode). */
  existingId?: string;
  /** Id to start a new thread/reference when allowed (e.g., parent message id). */
  startId?: string;
  /** Disable reply references entirely (e.g., when posting inside a new thread). */
  allowReference?: boolean;
  /** Seed the planner with prior reply state. */
  hasReplied?: boolean;
}): ReplyReferencePlanner {
  let hasReplied = options.hasReplied ?? false;
  const allowReference = options.allowReference !== false;
  const existingId = normalizeOptionalString(options.existingId);
  const startId = normalizeOptionalString(options.startId);

  const resolve = (): string | undefined => {
    if (!allowReference) {
      return undefined;
    }
    if (options.replyToMode === "off") {
      return undefined;
    }
    const id = existingId ?? startId;
    if (!id) {
      return undefined;
    }
    if (options.replyToMode === "all") {
      return id;
    }
    if (isSingleUseReplyToMode(options.replyToMode) && hasReplied) {
      return undefined;
    }
    return id;
  };

  const use = (): string | undefined => {
    const id = resolve();
    if (!id) {
      return undefined;
    }
    hasReplied = true;
    return id;
  };

  const markSent = () => {
    hasReplied = true;
  };

  return {
    peek: resolve,
    use,
    markSent,
    hasReplied: () => hasReplied,
  };
}
