import {
  resolveDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
  resolveNonNegativeIntegerOption,
} from "../../packages/normalization-core/src/number-coercion.js";
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

export type DeliveryRecoverySummary = {
  recovered: number;
  failed: number;
  skippedMaxRetries: number;
  deferredBackoff: number;
};

export type DeliveryRecoveryDrainDecision = {
  match: boolean;
  bypassBackoff?: boolean;
};

export type ActiveDeliveryRecoveryClaimResult<T> =
  | { status: "claimed"; value: T }
  | { status: "claimed-by-other-owner" };

type DeliveryRecoveryEntry = {
  id: string;
  enqueuedAt: number;
  retryCount: number;
  lastAttemptAt?: number;
  availableAt?: number;
};

type DeliveryRecoveryScanOptions<T extends DeliveryRecoveryEntry> = {
  entries: readonly T[];
  loadEntry: (id: string) => Promise<T | null>;
  onEntry: (entry: T) => Promise<"continue" | "stop" | void>;
  deadlineMs?: number;
  onDeadlineExceeded?: () => void;
  onClaimConflict?: (entry: T) => void;
  onMissingEntry?: (entry: T) => void;
};

export function createEmptyDeliveryRecoverySummary(): DeliveryRecoverySummary {
  return { recovered: 0, failed: 0, skippedMaxRetries: 0, deferredBackoff: 0 };
}

export function resolveDeliveryRecoveryDeadlineMs(maxRecoveryMs: number | undefined): number {
  const durationMs = resolveNonNegativeIntegerOption(maxRecoveryMs, 60_000);
  if (durationMs <= 0) {
    return resolveDateTimestampMs(Date.now());
  }
  return resolveExpiresAtMsFromDurationMs(durationMs) ?? resolveDateTimestampMs(Date.now());
}

export function isDeliveryRecoveryRetryEligible(
  entry: DeliveryRecoveryEntry,
  now: number,
): { eligible: true } | { eligible: false; remainingBackoffMs: number } {
  if (entry.availableAt && now < entry.availableAt) {
    return { eligible: false, remainingBackoffMs: entry.availableAt - now };
  }
  const backoff = computeBackoffMs(entry.retryCount);
  if (backoff <= 0 || (entry.retryCount === 0 && entry.lastAttemptAt === undefined)) {
    return { eligible: true };
  }
  const lastAttemptAt = entry.lastAttemptAt;
  const baseAttemptAt =
    typeof lastAttemptAt === "number" && Number.isFinite(lastAttemptAt) && lastAttemptAt > 0
      ? lastAttemptAt
      : entry.enqueuedAt;
  const remainingBackoffMs = baseAttemptAt + backoff - now;
  return remainingBackoffMs > 0 ? { eligible: false, remainingBackoffMs } : { eligible: true };
}

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

function createRecoveryReplayPacer(): {
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

/** Own one queue namespace's live claims, drain exclusion, and replay pacing. */
export function createDeliveryRecoveryCoordinator<T extends DeliveryRecoveryEntry>() {
  const activeDrains = new Set<string>();
  const activeEntries = new Set<string>();
  const replayPacer = createRecoveryReplayPacer();

  async function withClaim<Result>(
    entryId: string,
    run: () => Promise<Result>,
  ): Promise<ActiveDeliveryRecoveryClaimResult<Result>> {
    if (activeEntries.has(entryId)) {
      return { status: "claimed-by-other-owner" };
    }
    activeEntries.add(entryId);
    try {
      return { status: "claimed", value: await run() };
    } finally {
      activeEntries.delete(entryId);
    }
  }

  return {
    withClaim,

    async withDrain(drainKey: string, run: () => Promise<void>): Promise<boolean> {
      if (activeDrains.has(drainKey)) {
        return false;
      }
      activeDrains.add(drainKey);
      try {
        await run();
        return true;
      } finally {
        activeDrains.delete(drainKey);
      }
    },

    async scan(options: DeliveryRecoveryScanOptions<T>): Promise<void> {
      for (const entry of options.entries.toSorted((a, b) => a.enqueuedAt - b.enqueuedAt)) {
        if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs) {
          options.onDeadlineExceeded?.();
          break;
        }

        // Claim before the authoritative reload so a stale startup snapshot
        // can never race a reconnect drain or recipient-visible live send.
        const claim = await withClaim(entry.id, async () => {
          const current = await options.loadEntry(entry.id);
          if (!current) {
            options.onMissingEntry?.(entry);
            return "continue" as const;
          }
          return (await options.onEntry(current)) ?? "continue";
        });
        if (claim.status === "claimed-by-other-owner") {
          options.onClaimConflict?.(entry);
          continue;
        }
        if (claim.value === "stop") {
          break;
        }
      }
    },

    waitForReplay(deadlineMs?: number): Promise<"ready" | "deadline-exceeded"> {
      return replayPacer.wait(deadlineMs);
    },
  };
}
