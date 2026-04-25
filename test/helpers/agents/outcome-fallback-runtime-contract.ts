import type { EmbeddedPiRunResult } from "../../../src/agents/pi-embedded-runner/types.js";

export const OUTCOME_FALLBACK_RUNTIME_CONTRACT = {
  primaryProvider: "openai-codex",
  primaryModel: "gpt-5.4",
  fallbackProvider: "anthropic",
  fallbackModel: "claude-haiku-3-5",
  sessionId: "session-outcome-contract",
  sessionKey: "agent:main:outcome-contract",
  runId: "run-outcome-contract",
  prompt: "finish the contract turn",
  reasoningOnlyText: "I need to reason about this before answering.",
  planningOnlyText: "Inspect state, then decide the next step.",
} as const;

export function createContractRunResult(
  overrides: Partial<EmbeddedPiRunResult> = {},
): EmbeddedPiRunResult {
  const { meta, ...rest } = overrides;
  return {
    payloads: [],
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    successfulCronAdds: 0,
    ...rest,
    meta: {
      durationMs: 1,
      ...meta,
    },
  };
}

export function createContractFallbackConfig() {
  return {
    agents: {
      defaults: {
        model: {
          primary: `${OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryProvider}/${OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel}`,
          fallbacks: [
            `${OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackProvider}/${OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackModel}`,
          ],
        },
      },
    },
  } as const;
}
