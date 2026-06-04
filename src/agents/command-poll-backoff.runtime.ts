import { pruneStaleCommandPolls as pruneStaleCommandPollsImpl } from "./command-poll-backoff.js";

// Runtime seam for command poll backoff cleanup.
type PruneStaleCommandPolls = typeof import("./command-poll-backoff.js").pruneStaleCommandPolls;

/** Prune stale command polls using the production backoff implementation. */
export function pruneStaleCommandPolls(
  ...args: Parameters<PruneStaleCommandPolls>
): ReturnType<PruneStaleCommandPolls> {
  return pruneStaleCommandPollsImpl(...args);
}
