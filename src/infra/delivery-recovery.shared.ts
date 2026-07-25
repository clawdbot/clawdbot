import { computeBackoffSchedule } from "../../packages/retry/src/index.js";
import { sleep } from "../utils/sleep.js";
import { collectErrorGraphCandidates, extractErrorCode } from "./errors.js";
import {
  isPlatformMessageNotDispatchedError,
  isPlatformMessageRejectedError,
  type PlatformMessageNotDispatchedError,
} from "./outbound/deliver-types.js";
import { getRetryAttemptErrors } from "./retry-attempt-errors.js";

const RECOVERY_BACKOFF_MS: readonly number[] = [5_000, 25_000, 120_000, 600_000];
const RECOVERY_REPLAY_SPACING_MS = 250;

const PRE_CONNECT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);
const TRANSPORT_ERROR_CODE_RE =
  /^(?:E(?:AI_|CONN|NET|HOST|ADDR|PIPE|TIMEDOUT|SOCKET)|UND_ERR_|ERR_(?:NETWORK|HTTP2|QUIC|TLS|SSL))/;
const UNPROVEN_ERROR_BRANCH = "unproven delivery error branch";

function preserveProofBranches(branches: readonly unknown[] | undefined): unknown[] {
  return branches?.map((branch) => branch ?? UNPROVEN_ERROR_BRANCH) ?? [];
}

function isProvenPreConnectCandidate(candidate: unknown): boolean {
  const code = extractErrorCode(candidate)?.trim().toUpperCase();
  if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_DNS_RESOLVE_FAILED") {
    return true;
  }
  if (!code || !PRE_CONNECT_ERROR_CODES.has(code) || !candidate || typeof candidate !== "object") {
    return false;
  }
  const syscall = (candidate as { syscall?: unknown }).syscall;
  return syscall === "connect" || syscall === "getaddrinfo";
}

function nestedErrorCandidates(current: Record<string, unknown>): unknown[] {
  const retryAttempts = getRetryAttemptErrors(current);
  const retryBranches = preserveProofBranches(retryAttempts);
  // The explicit marker covers its cause: the provider owns the final dispatch
  // boundary and proved that no recipient-visible send could have completed.
  if (isPlatformMessageNotDispatchedError(current) || isProvenPreConnectCandidate(current)) {
    return retryBranches;
  }
  const nested = [current.cause, current.original, current.error, current.reason];
  const nestedObjects = nested.filter(
    (candidate) => candidate !== null && typeof candidate === "object",
  );
  const aggregateBranches = Array.isArray(current.errors)
    ? preserveProofBranches(current.errors)
    : [];
  return [...retryBranches, ...aggregateBranches, ...nestedObjects];
}

export function isProvenDeliveryNotSentError(err: unknown): boolean {
  let foundNotSentProof = false;
  for (const candidate of collectErrorGraphCandidates(err, nestedErrorCandidates)) {
    const code = extractErrorCode(candidate)?.trim().toUpperCase();
    if (isPlatformMessageNotDispatchedError(candidate) || isProvenPreConnectCandidate(candidate)) {
      foundNotSentProof = true;
      continue;
    }
    const nested =
      candidate && typeof candidate === "object"
        ? nestedErrorCandidates(candidate as Record<string, unknown>)
        : [];
    const isPreConnectAggregateSummary =
      candidate !== null &&
      typeof candidate === "object" &&
      Array.isArray((candidate as { errors?: unknown }).errors) &&
      code !== undefined &&
      PRE_CONNECT_ERROR_CODES.has(code);
    // Wrapper nodes may carry neutral SDK codes. Every transport leaf must still
    // prove pre-connect failure; Node AggregateError summary codes are accepted
    // only after their children are traversed and independently prove the same.
    if (
      nested.length === 0 ||
      (code &&
        !isPreConnectAggregateSummary &&
        (PRE_CONNECT_ERROR_CODES.has(code) || TRANSPORT_ERROR_CODE_RE.test(code)))
    ) {
      return false;
    }
  }
  return foundNotSentProof;
}

/** Finds a provider's permanent pre-dispatch rejection through delivery wrappers. */
export function findPlatformMessageRejectedError(
  err: unknown,
): (PlatformMessageNotDispatchedError & { readonly retryable: false }) | undefined {
  for (const candidate of collectErrorGraphCandidates(err, nestedErrorCandidates)) {
    if (isPlatformMessageRejectedError(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export function computeBackoffMs(retryCount: number): number {
  return computeBackoffSchedule(RECOVERY_BACKOFF_MS, retryCount);
}

export function getErrnoCode(err: unknown): string | null {
  return err && typeof err === "object" && "code" in err
    ? String((err as { code?: unknown }).code)
    : null;
}

export function claimRecoveryEntry(entriesInProgress: Set<string>, entryId: string): boolean {
  if (entriesInProgress.has(entryId)) {
    return false;
  }
  entriesInProgress.add(entryId);
  return true;
}

export function releaseRecoveryEntry(entriesInProgress: Set<string>, entryId: string): void {
  entriesInProgress.delete(entryId);
}

export function createRecoveryReplayPacer(): {
  wait(deadlineMs?: number): Promise<"ready" | "deadline-exceeded">;
} {
  let lastReplayStartedAt = 0;
  let waitQueue = Promise.resolve();

  return {
    async wait(deadlineMs) {
      let releaseWaiter: () => void = () => {};
      const previousWaiter = waitQueue;
      waitQueue = new Promise<void>((resolve) => {
        releaseWaiter = resolve;
      });
      await previousWaiter;

      try {
        const now = Date.now();
        if (deadlineMs !== undefined && now >= deadlineMs) {
          return "deadline-exceeded";
        }
        // Clock rollback starts a fresh pacing epoch. Otherwise concurrent startup
        // and reconnect drains serialize here so neither can bypass the spacing floor.
        const elapsedMs = now - lastReplayStartedAt;
        const waitMs = elapsedMs < 0 ? 0 : Math.max(0, RECOVERY_REPLAY_SPACING_MS - elapsedMs);
        if (waitMs > 0) {
          const remainingBudgetMs =
            deadlineMs === undefined ? waitMs : Math.max(0, deadlineMs - now);
          await sleep(Math.min(waitMs, remainingBudgetMs));
        }
        if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
          return "deadline-exceeded";
        }
        lastReplayStartedAt = Date.now();
        return "ready";
      } finally {
        releaseWaiter();
      }
    },
  };
}
