// User-facing logging for plugin and hook-pack update outcomes.
import { theme } from "../../packages/terminal-core/src/theme.js";

type PluginUpdateCliOutcome = {
  status: string;
  message: string;
  channelFallback?: {
    message: string;
  };
};

/** Log update outcomes with severity styling and report whether any errors occurred. */
export function logPluginUpdateOutcomes(params: {
  outcomes: readonly PluginUpdateCliOutcome[];
  log: (message: string) => void;
}): { hasErrors: boolean } {
  let hasErrors = false;
  for (const outcome of params.outcomes) {
    if (outcome.status === "error") {
      hasErrors = true;
      params.log(theme.error(outcome.message));
      if (outcome.channelFallback) {
        params.log(theme.warn(outcome.channelFallback.message));
      }
      continue;
    }
    if (outcome.status === "skipped") {
      params.log(theme.warn(outcome.message));
      if (outcome.channelFallback) {
        params.log(theme.warn(outcome.channelFallback.message));
      }
      continue;
    }
    params.log(outcome.message);
    if (outcome.channelFallback) {
      params.log(theme.warn(outcome.channelFallback.message));
    }
  }
  return { hasErrors };
}
