/**
 * Retry and error policy for subagent announcement delivery.
 */
import { clampTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isFastTestRuntimeEnv } from "../../../infra/env.js";
import {
  isOutboundDeliveryError,
  isPlatformMessageRejectedError,
} from "../../../infra/outbound/deliver-types.js";
import { defaultRuntime } from "../../../runtime.js";
import { isFailoverError } from "../../failover-error.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";

const DEFAULT_SUBAGENT_ANNOUNCE_TIMEOUT_MS = 120_000;
// The synchronous announce dispatch waits for two unrelated things, so one
// budget cannot fit both. Lane admission is short by nature: the requester
// session lane is either free now or held for the rest of the requester's turn,
// and waiting past that only stalls the caller. An admitted announce turn is a
// whole agent turn, so it needs far more room than any admission wait.
const DEFAULT_SUBAGENT_ANNOUNCE_ADMISSION_TIMEOUT_MS = 30_000;
const DEFAULT_SUBAGENT_ANNOUNCE_RUN_TIMEOUT_MS = 900_000;

export class SourceOwnerChangedError extends Error {
  constructor() {
    super("subagent source lifecycle changed before completion delivery");
    this.name = "SourceOwnerChangedError";
  }
}

export function sourceOwnerChangedResult(): SubagentAnnounceDeliveryResult {
  return {
    delivered: false,
    path: "none",
    reason: "source_owner_changed",
    error: "subagent source lifecycle changed before completion delivery",
    terminal: true,
    disposition: "intentional_non_delivery",
  };
}

export function resolveSubagentAnnounceTimeoutMs(cfg: OpenClawConfig): number {
  const configured = cfg.agents?.defaults?.subagents?.announceTimeoutMs;
  return clampTimerTimeoutMs(configured) ?? DEFAULT_SUBAGENT_ANNOUNCE_TIMEOUT_MS;
}

function resolveAnnouncePhaseTimeoutMs(
  cfg: OpenClawConfig,
  phaseKey: "announceAdmissionTimeoutMs" | "announceRunTimeoutMs",
  fallbackMs: number,
): number {
  const subagents = cfg.agents?.defaults?.subagents;
  // An operator who pinned the single legacy budget keeps it for both phases
  // until they set the phase-specific key, so existing configs do not change
  // behavior when the split lands.
  return (
    clampTimerTimeoutMs(subagents?.[phaseKey]) ??
    clampTimerTimeoutMs(subagents?.announceTimeoutMs) ??
    fallbackMs
  );
}

export function resolveSubagentAnnounceAdmissionTimeoutMs(cfg: OpenClawConfig): number {
  return resolveAnnouncePhaseTimeoutMs(
    cfg,
    "announceAdmissionTimeoutMs",
    DEFAULT_SUBAGENT_ANNOUNCE_ADMISSION_TIMEOUT_MS,
  );
}

export function resolveSubagentAnnounceRunTimeoutMs(cfg: OpenClawConfig): number {
  return resolveAnnouncePhaseTimeoutMs(
    cfg,
    "announceRunTimeoutMs",
    DEFAULT_SUBAGENT_ANNOUNCE_RUN_TIMEOUT_MS,
  );
}

export function summarizeDeliveryError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || "error";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error === undefined || error === null) {
    return "unknown error";
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "error";
  }
}

const TRANSIENT_ANNOUNCE_DELIVERY_ERROR_PATTERNS: readonly RegExp[] = [
  /\berrorcode=unavailable\b/i,
  /\bstatus\s*[:=]\s*"?unavailable\b/i,
  /\bUNAVAILABLE\b/,
  /no active .* listener/i,
  /gateway not connected/i,
  /gateway closed \(1006/i,
  /gateway timeout/i,
  /\b(econnreset|econnrefused|etimedout|enotfound|ehostunreach|network error)\b/i,
];

const WRITER_CLAIM_REBOUND_ANNOUNCE_RE =
  /session writer claim changed before transcript persistence/i;

const PERMANENT_ANNOUNCE_DELIVERY_ERROR_PATTERNS: readonly RegExp[] = [
  /unsupported channel/i,
  /unknown channel/i,
  /chat not found/i,
  /user not found/i,
  /bot.*not.*member/i,
  /bot was blocked by the user/i,
  /forbidden: bot was kicked/i,
  /recipient is not a valid/i,
  /outbound not configured for channel/i,
  WRITER_CLAIM_REBOUND_ANNOUNCE_RE,
];

export function isWriterClaimReboundAnnounceError(error: unknown): boolean {
  return Boolean(
    (error &&
      typeof error === "object" &&
      (error as { name?: unknown }).name === "SessionTranscriptWriterClaimReboundError") ||
    WRITER_CLAIM_REBOUND_ANNOUNCE_RE.test(summarizeDeliveryError(error)),
  );
}

const ANNOUNCE_ERROR_CHAIN_KEYS = ["cause", "error", "reason"] as const;
type AnnounceErrorChainKey = (typeof ANNOUNCE_ERROR_CHAIN_KEYS)[number];
type AnnounceErrorRecord = Partial<Record<AnnounceErrorChainKey, unknown>> & {
  sentBeforeError?: unknown;
  visibleReplySent?: unknown;
};

function isAnnounceErrorRecord(error: unknown): error is AnnounceErrorRecord {
  return Boolean(error && typeof error === "object");
}

function hasAnnounceErrorMatch(
  error: unknown,
  matches: (candidate: unknown) => boolean,
  seen: Set<object> = new Set(),
): boolean {
  if (matches(error)) {
    return true;
  }
  if (!isAnnounceErrorRecord(error)) {
    return false;
  }
  if (seen.has(error)) {
    return false;
  }
  seen.add(error);

  return ANNOUNCE_ERROR_CHAIN_KEYS.some((key) => hasAnnounceErrorMatch(error[key], matches, seen));
}

function hasWriterClaimReboundAnnounceError(error: unknown): boolean {
  return hasAnnounceErrorMatch(error, isWriterClaimReboundAnnounceError);
}

function isTransientFailoverAnnounceError(error: unknown): boolean {
  return (
    isFailoverError(error) && (error.reason === "overloaded" || (error.attempts?.length ?? 0) > 0)
  );
}

function isPermanentNonWriterAnnounceError(error: unknown): boolean {
  return hasAnnounceErrorMatch(
    error,
    (candidate) =>
      isPlatformMessageRejectedError(candidate) ||
      (!isWriterClaimReboundAnnounceError(candidate) &&
        PERMANENT_ANNOUNCE_DELIVERY_ERROR_PATTERNS.some((pattern) =>
          pattern.test(summarizeDeliveryError(candidate)),
        )),
  );
}

function isTransientAnnounceDeliveryError(error: unknown): boolean {
  // Any committed platform send makes another attempt a possible duplicate;
  // permanent owner rejections also override transient-looking wrapped causes.
  if (hasAnnounceSendEvidence(error) || isPermanentNonWriterAnnounceError(error)) {
    return false;
  }

  if (hasWriterClaimReboundAnnounceError(error)) {
    return true;
  }

  return hasAnnounceErrorMatch(error, (candidate) => {
    if (isTransientFailoverAnnounceError(candidate)) {
      return true;
    }
    const message = summarizeDeliveryError(candidate);
    if (
      candidate &&
      typeof candidate === "object" &&
      (candidate as { gatewayCode?: unknown }).gatewayCode === "UNAVAILABLE" &&
      /cron run continuation/i.test(message)
    ) {
      return true;
    }
    return TRANSIENT_ANNOUNCE_DELIVERY_ERROR_PATTERNS.some((pattern) => pattern.test(message));
  });
}

export function isPermanentAnnounceDeliveryError(error: unknown): boolean {
  return isPermanentNonWriterAnnounceError(error) || hasWriterClaimReboundAnnounceError(error);
}

export function isIncompleteAnnounceAgentResultError(error: unknown): boolean {
  const message = summarizeDeliveryError(error);
  return /(?:incomplete terminal response|code=incomplete_result)\b/i.test(message);
}

function hasDirectAnnounceSendEvidence(error: unknown): boolean {
  if (isOutboundDeliveryError(error) && error.sentBeforeError) {
    return true;
  }
  if (!isAnnounceErrorRecord(error)) {
    return false;
  }
  return error.sentBeforeError === true || error.visibleReplySent === true;
}

export function hasAnnounceSendEvidence(error: unknown): boolean {
  return hasAnnounceErrorMatch(error, hasDirectAnnounceSendEvidence);
}

export async function waitForAnnounceRetryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  if (!signal) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
    return;
  }
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function resolveDirectAnnounceTransientRetryDelaysMs() {
  return isFastTestRuntimeEnv() ? ([8, 16, 32] as const) : ([5_000, 10_000, 20_000] as const);
}

export async function runAnnounceDeliveryWithRetry<T>(params: {
  operation: string;
  signal?: AbortSignal;
  isAttemptAllowed?: () => boolean;
  run: () => Promise<T>;
}): Promise<T> {
  const retryDelaysMs = resolveDirectAnnounceTransientRetryDelaysMs();
  for (const [retryIndex, delayMs] of retryDelaysMs.entries()) {
    if (params.isAttemptAllowed?.() === false) {
      throw new SourceOwnerChangedError();
    }
    if (params.signal?.aborted) {
      throw new Error("announce delivery aborted");
    }
    try {
      return await params.run();
    } catch (err) {
      if (!isTransientAnnounceDeliveryError(err) || params.signal?.aborted) {
        throw err;
      }
      if (params.isAttemptAllowed?.() === false) {
        throw new SourceOwnerChangedError();
      }
      const nextAttempt = retryIndex + 2;
      const maxAttempts = retryDelaysMs.length + 1;
      defaultRuntime.log(
        `[warn] Subagent announce ${params.operation} transient failure, retrying ${nextAttempt}/${maxAttempts} in ${Math.round(delayMs / 1000)}s: ${summarizeDeliveryError(err)}`,
      );
      await waitForAnnounceRetryDelay(delayMs, params.signal);
    }
  }
  if (params.signal?.aborted) {
    throw new Error("announce delivery aborted");
  }
  if (params.isAttemptAllowed?.() === false) {
    throw new SourceOwnerChangedError();
  }
  return await params.run();
}
