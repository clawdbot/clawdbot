import { normalizeStringifiedEntries } from "@openclaw/normalization-core/string-coerce";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";

export const REPLY_ADMISSION_TICKET = Symbol("openclaw.replyAdmissionTicket");
type ReplyAdmissionTicket = {
  wait(signal?: AbortSignal): Promise<boolean>;
  release(): void;
};
export type ReplyOptionsWithAdmissionTicket = {
  [REPLY_ADMISSION_TICKET]?: ReplyAdmissionTicket;
};

const tails = resolveGlobalMap<string, Promise<void>>(Symbol.for("openclaw.replyAdmissionTickets"));

/** Briefly orders queue publication across a command's source and target sessions. */
export function reserveReplyAdmissionTicket(
  sessionKeys: ReadonlyArray<string | undefined>,
): ReplyAdmissionTicket | undefined {
  const keys = [...new Set(normalizeStringifiedEntries(sessionKeys))].toSorted();
  if (keys.length === 0) {
    return undefined;
  }
  const { promise: completed, resolve: finish } = createDeferredCore();
  const predecessors = keys.map((key) => tails.get(key) ?? Promise.resolve());
  const owned = keys.map((key, index) => {
    const tail = predecessors[index]!.then(() => completed);
    tails.set(key, tail);
    return { key, tail };
  });
  let released = false;
  return {
    async wait(signal) {
      if (signal?.aborted) {
        return false;
      }
      const ready = Promise.all(predecessors).then(() => true);
      if (!signal) {
        return await ready;
      }
      return await new Promise<boolean>((resolve) => {
        const abort = () => resolve(false);
        signal.addEventListener("abort", abort, { once: true });
        void ready.then((value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        });
      });
    },
    release() {
      if (released) {
        return;
      }
      released = true;
      finish();
      for (const { key, tail } of owned) {
        void tail.then(() => tails.get(key) === tail && tails.delete(key));
      }
    },
  };
}
