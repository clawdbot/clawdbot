/**
 * Native harness compaction recovery helpers.
 *
 * CLI compaction uses these guards to recognize thread-binding failures that can
 * fall back to context-engine compaction after clearing stale session bindings.
 * A model-locked native harness cannot reach the context engine, so the queued
 * owner stamps a boolean recovery marker that lets the turn layer safe-continue
 * instead of string-sniffing the failure reason.
 */
import type { EmbeddedAgentCompactResult } from "../embedded-agent-runner/types.js";

/** Recognizes a recoverable native binding failure reason (structured or free-text). */
function isRecoverableNativeHarnessBindingReason(reason: unknown): boolean {
  if (typeof reason !== "string") {
    return false;
  }
  const normalized = reason.trim().toLowerCase();
  // Structured markers plus their provider free-text spellings: "no thread
  // binding" is a missing binding and "thread not found" is a gone binding;
  // both are recoverable by clearing the stale binding and rotating.
  return (
    normalized === "missing_thread_binding" ||
    normalized === "stale_thread_binding" ||
    normalized.includes("no thread binding") ||
    normalized.includes("thread not found")
  );
}

/**
 * Returns whether a compact result failed due to a recoverable native binding
 * issue. Prefers the structured failure reason over the display reason.
 */
export function isRecoverableNativeHarnessBindingFailure(
  result: EmbeddedAgentCompactResult | undefined,
): boolean {
  if (result?.ok !== false) {
    return false;
  }
  return (
    isRecoverableNativeHarnessBindingReason(result.failure?.reason) ||
    isRecoverableNativeHarnessBindingReason(result.reason)
  );
}

/**
 * Resolves the model-locked native harness compaction outcome. A model-locked
 * harness has no context-engine credentials, so a recoverable binding failure
 * must never fall through to the generic engine (that route fails and drops the
 * turn, #119977). The result is sanitized against a forged owner-minted marker
 * first; the recovery marker is stamped only when the private required-preflight
 * capability dispatched, so the turn layer can safe-continue (#119971); every
 * other locked outcome stays an honest ok:false.
 */
export function resolveLockedNativeHarnessCompactionResult(
  result: EmbeddedAgentCompactResult | undefined,
  lockedFailure: EmbeddedAgentCompactResult,
  preflightRequired: boolean,
  requiredPreflightNativeCapabilityUsed: boolean,
): EmbeddedAgentCompactResult {
  let sanitized = result;
  if (sanitized?.nativeHarnessBindingRecovery !== undefined) {
    const { nativeHarnessBindingRecovery: _forged, ...rest } = sanitized;
    sanitized = rest;
  }
  if (sanitized === undefined) {
    return lockedFailure;
  }
  return preflightRequired &&
    requiredPreflightNativeCapabilityUsed &&
    isRecoverableNativeHarnessBindingFailure(sanitized)
    ? { ...sanitized, nativeHarnessBindingRecovery: true }
    : sanitized;
}

/**
 * Returns whether a compaction result carries the authenticated locked-harness
 * binding-recovery marker. Only the queued compaction owner stamps it, and only
 * after the private required-preflight capability dispatched, so the turn layer
 * can safe-continue without re-deriving lock state or matching reason text.
 */
export function isNativeHarnessBindingRecoverySkip(
  result: EmbeddedAgentCompactResult | undefined,
): boolean {
  return result?.nativeHarnessBindingRecovery === true;
}
