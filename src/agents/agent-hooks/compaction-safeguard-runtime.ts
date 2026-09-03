/** Session-manager scoped runtime state for compaction safeguard configuration. */
import type { AgentCompactionIdentifierPolicy } from "../../config/types.agent-defaults.js";
import type { Model } from "../../llm/types.js";
import { createSessionManagerRuntimeRegistry } from "./session-manager-runtime-registry.js";

export type CompactionSafeguardCancellation = { reason: string; error?: unknown };

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
  /** Hook cancellation hides provider errors behind AgentSession's generic error. */
  cancellation?: CompactionSafeguardCancellation;
};

const registry = createSessionManagerRuntimeRegistry<CompactionSafeguardRuntimeValue>();

export const setCompactionSafeguardRuntime = registry.set;

export const getCompactionSafeguardRuntime = registry.get;

/** Records cancellation atomically; intentional declines carry no provider error. */
export function setCompactionSafeguardCancellation(
  sessionManager: unknown,
  reason: string | undefined,
  error?: unknown,
): void {
  const current = getCompactionSafeguardRuntime(sessionManager);
  const trimmed = reason?.trim();
  if (!current && !trimmed) {
    return;
  }
  const next = { ...current };
  if (trimmed) {
    next.cancellation = { reason: trimmed, ...(error !== undefined ? { error } : {}) };
  } else {
    delete next.cancellation;
  }
  setCompactionSafeguardRuntime(sessionManager, Object.keys(next).length > 0 ? next : null);
}

/** Consumes this attempt's cancellation without clearing session configuration. */
export function consumeCompactionSafeguardCancellation(
  sessionManager: unknown,
): CompactionSafeguardCancellation | null {
  const cancellation = getCompactionSafeguardRuntime(sessionManager)?.cancellation;
  if (cancellation) {
    setCompactionSafeguardCancellation(sessionManager, undefined);
  }
  return cancellation ?? null;
}
