import type { AuthProfileStore } from "../agents/auth-profiles.js";
import {
  CLAUDE_CLI_PROFILE_ID,
  CODEX_CLI_PROFILE_ID,
} from "../agents/auth-profiles.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import type { AuthChoice } from "./onboard-types.js";

export type AuthChoiceOption = {
  value: AuthChoice;
  label: string;
  hint?: string;
};

function formatOAuthHint(
  expires?: number,
  opts?: { allowStale?: boolean },
): string {
  const rich = isRich();
  if (!expires) {
    return colorize(rich, theme.muted, "token unavailable");
  }
  const now = Date.now();
  const remaining = expires - now;
  if (remaining <= 0) {
    if (opts?.allowStale) {
      return colorize(rich, theme.warn, "token present · refresh on use");
    }
    return colorize(rich, theme.error, "token expired");
  }
  const minutes = Math.round(remaining / (60 * 1000));
  const duration =
    minutes >= 120
      ? `${Math.round(minutes / 60)}h`
      : minutes >= 60
        ? "1h"
        : `${Math.max(minutes, 1)}m`;
  const label = `token ok · expires in ${duration}`;
  if (minutes <= 10) {
    return colorize(rich, theme.warn, label);
  }
  return colorize(rich, theme.success, label);
}

export function buildAuthChoiceOptions(params: {
  store: AuthProfileStore;
  includeSkip: boolean;
}): AuthChoiceOption[] {
  const options: AuthChoiceOption[] = [];

  const codexCli = params.store.profiles[CODEX_CLI_PROFILE_ID];
  if (codexCli?.type === "oauth") {
    options.push({
      value: "codex-cli",
      label: "OpenAI Codex OAuth (Codex CLI)",
      hint: formatOAuthHint(codexCli.expires, { allowStale: true }),
    });
  }

  const claudeCli = params.store.profiles[CLAUDE_CLI_PROFILE_ID];
  if (claudeCli?.type === "oauth") {
    options.push({
      value: "claude-cli",
      label: "Anthropic OAuth (Claude CLI)",
      hint: formatOAuthHint(claudeCli.expires),
    });
  }

  options.push({ value: "oauth", label: "Anthropic OAuth (Claude Pro/Max)" });

  options.push({
    value: "openai-codex",
    label: "OpenAI Codex (ChatGPT OAuth)",
  });
  options.push({
    value: "antigravity",
    label: "Google Antigravity (Claude Opus 4.5, Gemini 3, etc.)",
  });
  options.push({ value: "apiKey", label: "Anthropic API key" });
  options.push({ value: "minimax", label: "Minimax M2.1 (LM Studio)" });
  if (params.includeSkip) {
    options.push({ value: "skip", label: "Skip for now" });
  }

  return options;
}
