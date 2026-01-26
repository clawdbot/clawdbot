import type { AuthProfileStore } from "../agents/auth-profiles.js";
import { CLAUDE_CLI_PROFILE_ID, CODEX_CLI_PROFILE_ID } from "../agents/auth-profiles.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import type { AuthChoice } from "./onboard-types.js";

export type AuthChoiceOption = {
  value: AuthChoice;
  label: string;
  hint?: string;
};

export type AuthChoiceGroupId =
  | "openai"
  | "anthropic"
  | "google"
  | "copilot"
  | "openrouter"
  | "ai-gateway"
  | "moonshot"
  | "zai"
  | "opencode-zen"
  | "minimax"
  | "synthetic"
  | "venice"
  | "qwen";

export type AuthChoiceGroup = {
  value: AuthChoiceGroupId;
  label: string;
  hint?: string;
  options: AuthChoiceOption[];
};

const AUTH_CHOICE_GROUP_DEFS: {
  value: AuthChoiceGroupId;
  label: string;
  hint?: string;
  choices: AuthChoice[];
}[] = [
  {
    value: "openai",
    label: "OpenAI",
    hint: "Codex OAuth + API key",
    choices: ["codex-cli", "openai-codex", "openai-api-key"],
  },
  {
    value: "anthropic",
    label: "Anthropic",
    hint: "Claude Code CLI + API key",
    choices: ["token", "claude-cli", "apiKey"],
  },
  {
    value: "minimax",
    label: "MiniMax",
    hint: "M2.1 (recommended)",
    choices: ["minimax-api", "minimax-api-lightning"],
  },
  {
    value: "qwen",
    label: "Qwen",
    hint: "OAuth",
    choices: ["qwen-portal"],
  },
  {
    value: "synthetic",
    label: "Synthetic",
    hint: "Anthropic-compatible (multi-model)",
    choices: ["synthetic-api-key"],
  },
  {
    value: "venice",
    label: "Venice AI",
    hint: "Privacy-focused (uncensored models)",
    choices: ["venice-api-key"],
  },
  {
    value: "google",
    label: "Google",
    hint: "Gemini API key + OAuth",
    choices: ["gemini-api-key", "google-antigravity", "google-gemini-cli"],
  },
  {
    value: "copilot",
    label: "Copilot",
    hint: "GitHub + local proxy",
    choices: ["github-copilot", "copilot-proxy"],
  },
  {
    value: "openrouter",
    label: "OpenRouter",
    hint: "API key",
    choices: ["openrouter-api-key"],
  },
  {
    value: "ai-gateway",
    label: "Vercel AI Gateway",
    hint: "API key",
    choices: ["ai-gateway-api-key"],
  },
  {
    value: "moonshot",
    label: "Moonshot AI",
    hint: "Kimi K2 + Kimi Code",
    choices: ["moonshot-api-key", "kimi-code-api-key"],
  },
  {
    value: "zai",
    label: "Z.AI (GLM 4.7)",
    hint: "API key",
    choices: ["zai-api-key"],
  },
  {
    value: "opencode-zen",
    label: "OpenCode Zen",
    hint: "API key",
    choices: ["opencode-zen"],
  },
];

function formatOAuthHint(expires?: number, opts?: { allowStale?: boolean }): string {
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
  includeClaudeCliIfMissing?: boolean;
  platform?: NodeJS.Platform;
}): AuthChoiceOption[] {
  const options: AuthChoiceOption[] = [];
  const platform = params.platform ?? process.platform;

  const codexCli = params.store.profiles[CODEX_CLI_PROFILE_ID];
  if (codexCli?.type === "oauth") {
    options.push({
      value: "codex-cli",
      label: "OpenAI Codex OAuth (Codex CLI)",
      hint: formatOAuthHint(codexCli.expires, { allowStale: true }),
    });
  }

  const claudeCli = params.store.profiles[CLAUDE_CLI_PROFILE_ID];
  if (claudeCli?.type === "oauth" || claudeCli?.type === "token") {
    options.push({
      value: "claude-cli",
      label: "Anthropic token (Claude Code CLI)",
      hint: `reuses existing Claude Code auth · ${formatOAuthHint(claudeCli.expires)}`,
    });
  } else if (params.includeClaudeCliIfMissing && platform === "darwin") {
    options.push({
      value: "claude-cli",
      label: "Anthropic token (Claude Code CLI)",
      hint: "reuses existing Claude Code auth · requires Keychain access",
    });
  }

  options.push({
    value: "token",
    label: "Anthropic token (paste setup-token)",
    hint: "run `claude setup-token` elsewhere, then paste the token here",
  });

  options.push({
    value: "openai-codex",
    label: "OpenAI Codex (ChatGPT OAuth)",
  });
  options.push({ value: "chutes", label: "Chutes (OAuth)" });
  options.push({ value: "openai-api-key", label: "OpenAI API key" });
  options.push({ value: "openrouter-api-key", label: "OpenRouter API key" });
  options.push({
    value: "ai-gateway-api-key",
    label: "Vercel AI Gateway API key",
  });
  options.push({ value: "moonshot-api-key", label: "Moonshot AI API key" });
  options.push({ value: "kimi-code-api-key", label: "Kimi Code API key" });
  options.push({ value: "synthetic-api-key", label: "Synthetic API key" });
  options.push({
    value: "venice-api-key",
    label: "Venice AI API key",
    hint: "Privacy-focused inference (uncensored models)",
  });
  options.push({
    value: "github-copilot",
    label: "GitHub Copilot (GitHub device login)",
    hint: "Uses GitHub device flow",
  });
  options.push({ value: "gemini-api-key", label: "Google Gemini API key" });
  options.push({
    value: "google-antigravity",
    label: "Google Antigravity OAuth",
    hint: "Uses the bundled Antigravity auth plugin",
  });
  options.push({
    value: "google-gemini-cli",
    label: "Google Gemini CLI OAuth",
    hint: "Uses the bundled Gemini CLI auth plugin",
  });
  options.push({ value: "zai-api-key", label: "Z.AI (GLM 4.7) API key" });
  options.push({ value: "qwen-portal", label: "Qwen OAuth" });
  options.push({
    value: "copilot-proxy",
    label: "Copilot Proxy (local)",
    hint: "Local proxy for VS Code Copilot models",
  });
  options.push({ value: "apiKey", label: "Anthropic API key" });
  // Token flow is currently Anthropic-only; use CLI for advanced providers.
  options.push({
    value: "opencode-zen",
    label: "OpenCode Zen (multi-model proxy)",
    hint: "Claude, GPT, Gemini via opencode.ai/zen",
  });
  options.push({ value: "minimax-api", label: "MiniMax M2.1" });
  options.push({
    value: "minimax-api-lightning",
    label: "MiniMax M2.1 Lightning",
    hint: "Faster, higher output cost",
  });
  if (params.includeSkip) {
    options.push({ value: "skip", label: "Skip for now" });
  }

  return options;
}

export function buildAuthChoiceGroups(params: {
  store: AuthProfileStore;
  includeSkip: boolean;
  includeClaudeCliIfMissing?: boolean;
  platform?: NodeJS.Platform;
}): {
  groups: AuthChoiceGroup[];
  skipOption?: AuthChoiceOption;
} {
  const options = buildAuthChoiceOptions({
    ...params,
    includeSkip: false,
  });
  const optionByValue = new Map<AuthChoice, AuthChoiceOption>(
    options.map((opt) => [opt.value, opt]),
  );

  const groups = AUTH_CHOICE_GROUP_DEFS.map((group) => ({
    ...group,
    options: group.choices
      .map((choice) => optionByValue.get(choice))
      .filter((opt): opt is AuthChoiceOption => Boolean(opt)),
  }));

  const skipOption = params.includeSkip
    ? ({ value: "skip", label: "Skip for now" } satisfies AuthChoiceOption)
    : undefined;

  return { groups, skipOption };
}
