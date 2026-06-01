import type { SessionConfig } from "@github/copilot-sdk";

// Compaction bridge for the GitHub Copilot agent runtime.
//
// Shapes `SessionConfig.infiniteSessions` from a typed options bag so
// attempt.ts can opt the SDK in to background auto-compaction at session
// creation. The SDK manages the actual compaction under the `infiniteSessions`
// config and the session-scoped history compaction RPC.
//
// Host back-pointers (NOT imported here to keep the package boundary
// clean):
//   - `src/agents/pi-embedded-runner/compact.types.ts` — canonical
//     `CompactEmbeddedPiSessionParams`.
//   - `src/agents/pi-embedded-runner/types.ts` — canonical
//     `EmbeddedPiCompactResult`.

type SdkInfiniteSessionConfig = NonNullable<SessionConfig["infiniteSessions"]>;

export type { SdkInfiniteSessionConfig as CopilotInfiniteSessionConfig };

export interface CopilotInfiniteSessionOptions {
  enabled?: boolean;
  backgroundCompactionThreshold?: number;
  bufferExhaustionThreshold?: number;
}

/**
 * Shape an `InfiniteSessionConfig` for `SessionConfig.infiniteSessions`.
 * Returns `undefined` when no fields were supplied so callers can
 * spread conditionally and let the SDK apply its own defaults
 * (`enabled: true`, background 0.80, buffer 0.95). Any explicitly-set
 * value (including `enabled: false` to disable infinite sessions) is
 * preserved.
 */
export function createInfiniteSessionConfig(
  options?: CopilotInfiniteSessionOptions,
): SdkInfiniteSessionConfig | undefined {
  if (!options) {
    return undefined;
  }
  const result: SdkInfiniteSessionConfig = {};
  if (options.enabled !== undefined) {
    result.enabled = options.enabled;
  }
  if (options.backgroundCompactionThreshold !== undefined) {
    result.backgroundCompactionThreshold = options.backgroundCompactionThreshold;
  }
  if (options.bufferExhaustionThreshold !== undefined) {
    result.bufferExhaustionThreshold = options.bufferExhaustionThreshold;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
