import { theme } from "../terminal/theme.js";

export type PluginUpdateCliOutcome = {
  status: string;
  message: string;
};

export function logPluginUpdateOutcomes(params: {
  outcomes: readonly PluginUpdateCliOutcome[];
  log: (message: string) => void;
}): { hasErrors: boolean } {
  let hasErrors = false;
  for (const outcome of params.outcomes) {
    if (outcome.status === "error") {
      hasErrors = true;
      params.log(theme.error(outcome.message));
      continue;
    }
    if (outcome.status === "skipped") {
      params.log(theme.warn(outcome.message));
      continue;
    }
    params.log(outcome.message);
  }
  return { hasErrors };
}
