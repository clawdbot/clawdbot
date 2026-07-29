import type { ClaudeCliFallbackSeed } from "../../gateway/cli-session-history.js";
import "./attempt-execution.helpers.js";

type AttemptExecutionHelpersTestApi = {
  claudeCliSessionTranscriptPath(params: {
    sessionId: string | undefined;
    workspaceDir: string | undefined;
    homeDir?: string;
  }): string | null;
  formatClaudeCliFallbackPrelude(
    seed: ClaudeCliFallbackSeed,
    options?: { charBudget?: number },
  ): string;
};

function getTestApi(): AttemptExecutionHelpersTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.attemptExecutionHelpersTestApi")
  ];
  if (!api) {
    throw new Error("attempt execution helpers test API is unavailable");
  }
  return api as AttemptExecutionHelpersTestApi;
}

export function claudeCliSessionTranscriptPath(
  params: Parameters<AttemptExecutionHelpersTestApi["claudeCliSessionTranscriptPath"]>[0],
): string | null {
  return getTestApi().claudeCliSessionTranscriptPath(params);
}

export function formatClaudeCliFallbackPrelude(
  seed: ClaudeCliFallbackSeed,
  options?: { charBudget?: number },
): string {
  return getTestApi().formatClaudeCliFallbackPrelude(seed, options);
}
