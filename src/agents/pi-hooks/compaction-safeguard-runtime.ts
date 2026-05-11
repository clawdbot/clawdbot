import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentCompactionIdentifierPolicy } from "../../config/types.agent-defaults.js";
import { createSessionManagerRuntimeRegistry } from "./session-manager-runtime-registry.js";

export type CompactionSafeguardRuntimeValue = {
  maxHistoryShare?: number;
  contextWindowTokens?: number;
  identifierPolicy?: AgentCompactionIdentifierPolicy;
  identifierInstructions?: string;
  customInstructions?: string;
  /**
   * Model to use for compaction summarization.
   * Passed through runtime because `ctx.model` is undefined in the compact.ts workflow
   * (extensionRunner.initialize() is never called in that path).
   */
  model?: Model<Api>;
  recentTurnsPreserve?: number;
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
};

const registry = createSessionManagerRuntimeRegistry<CompactionSafeguardRuntimeValue>();

export const setCompactionSafeguardRuntime = registry.set;

export const getCompactionSafeguardRuntime = registry.get;

export function setCompactionSafeguardCancelReason(
  sessionManager: unknown,
  reason: string | undefined,
): void {
  const current = getCompactionSafeguardRuntime(sessionManager);
  const trimmed = reason?.trim();

  if (!current) {
    if (!trimmed) {
      return;
    }
    setCompactionSafeguardRuntime(sessionManager, { cancelReason: trimmed });
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
