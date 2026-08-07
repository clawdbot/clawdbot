/** Session-manager scoped runtime state for compaction safeguard configuration. */
import type { AgentCompactionIdentifierPolicy } from "../../config/types.agent-defaults.js";
import type { Model } from "../../llm/types.js";
import { createSessionManagerRuntimeRegistry } from "./session-manager-runtime-registry.js";

/** Runtime knobs consumed by the compaction safeguard extension. */
type CompactionSafeguardRuntimeValue = {
  maxHistoryShare?: number;
  contextWindowTokens?: number;
  identifierPolicy?: AgentCompactionIdentifierPolicy | "custom";
  identifierInstructions?: string;
  customInstructions?: string;
  /**
   * Model to use for compaction summarization.
   * Passed through runtime because `ctx.model` is undefined in the compact.ts workflow
   * (extensionRunner.initialize() is never called in that path).
   */
  model?: Model;
  recentTurnsPreserve?: number;
  workspaceDir?: string;
  postCompactionSections?: string[];
  qualityGuardEnabled?: boolean;
  qualityGuardMaxRetries?: number;
  /**
   * Id of a registered compaction provider plugin.
   * When set and found in the compaction provider registry, the provider's
   * `summarize()` is called instead of the built-in `summarizeInStages()`.
   */
  provider?: string;
  /**
   * Pending human-readable cancel reason from the current safeguard compaction
   * attempt. OpenClaw consumes this to replace the upstream generic
   * "Compaction cancelled" message.
   */
  cancelReason?: string;
  /** Original typed/provider error paired with cancelReason for downstream classification. */
  cancelError?: unknown;
};

const registry = createSessionManagerRuntimeRegistry<CompactionSafeguardRuntimeValue>();

export const setCompactionSafeguardRuntime = registry.set;

export const getCompactionSafeguardRuntime = registry.get;

/** Stores a human-readable compaction cancel reason on the session runtime state. */
export function setCompactionSafeguardCancelReason(
  sessionManager: unknown,
  reason: string | undefined,
): void {
  const current = getCompactionSafeguardRuntime(sessionManager);
  const trimmed = reason?.trim();

  if (!current && !trimmed) {
    return;
  }
  const next = { ...current };
  if (trimmed) {
    next.cancelReason = trimmed;
  } else {
    delete next.cancelReason;
  }
  setCompactionSafeguardRuntime(sessionManager, next);
}

/** Reads and clears the pending compaction cancel reason for one session manager. */
export function consumeCompactionSafeguardCancelReason(sessionManager: unknown): string | null {
  const current = getCompactionSafeguardRuntime(sessionManager);
  const reason = current?.cancelReason?.trim();
  if (!reason) {
    return null;
  }

  const next = { ...current };
  delete next.cancelReason;
  setCompactionSafeguardRuntime(sessionManager, Object.keys(next).length > 0 ? next : null);
  return reason;
}

/** Stores the original safeguard error so compaction preserves status/cause identity. */
export function setCompactionSafeguardCancelError(
  sessionManager: unknown,
  error: unknown | undefined,
): void {
  const current = getCompactionSafeguardRuntime(sessionManager);
  if (!current && error === undefined) {
    return;
  }
  const next = { ...current };
  if (error !== undefined) {
    next.cancelError = error;
  } else {
    delete next.cancelError;
  }
  setCompactionSafeguardRuntime(sessionManager, Object.keys(next).length > 0 ? next : null);
}

/** Reads and clears the original safeguard error for one compaction attempt. */
export function consumeCompactionSafeguardCancelError(sessionManager: unknown): unknown {
  const current = getCompactionSafeguardRuntime(sessionManager);
  if (!current || !("cancelError" in current)) {
    return undefined;
  }
  const error = current.cancelError;
  const next = { ...current };
  delete next.cancelError;
  setCompactionSafeguardRuntime(sessionManager, Object.keys(next).length > 0 ? next : null);
  return error;
}
