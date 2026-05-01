const BLOCKED_ENV_VAR_PATTERNS: ReadonlyArray<RegExp> = [
  /^ANTHROPIC_API_KEY$/i,
  /^OPENAI_API_KEY$/i,
  /^GEMINI_API_KEY$/i,
  /^OPENROUTER_API_KEY$/i,
  /^MINIMAX_API_KEY$/i,
  /^ELEVENLABS_API_KEY$/i,
  /^SYNTHETIC_API_KEY$/i,
  /^TELEGRAM_BOT_TOKEN$/i,
  /^DISCORD_BOT_TOKEN$/i,
  /^SLACK_(BOT|APP)_TOKEN$/i,
  /^LINE_CHANNEL_SECRET$/i,
  /^LINE_CHANNEL_ACCESS_TOKEN$/i,
  /^OPENCLAW_GATEWAY_(TOKEN|PASSWORD)$/i,
  /^AWS_(SECRET_ACCESS_KEY|SECRET_KEY|SESSION_TOKEN)$/i,
  /^(GH|GITHUB)_TOKEN$/i,
  /^(AZURE|AZURE_OPENAI|COHERE|AI_GATEWAY|OPENROUTER)_API_KEY$/i,
  /_?(API_KEY|TOKEN|PASSWORD|PRIVATE_KEY|SECRET)$/i,
];

const ALLOWED_ENV_VAR_PATTERNS: ReadonlyArray<RegExp> = [
  /^LANG$/,
  /^LC_.*$/i,
  /^PATH$/i,
  /^HOME$/i,
  /^USER$/i,
  /^SHELL$/i,
  /^TERM$/i,
  /^TZ$/i,
  /^NODE_ENV$/i,
];

export type EnvVarSanitizationResult = {
  allowed: Record<string, string>;
  blocked: string[];
  warnings: string[];
};

export type EnvSanitizationOptions = {
  strictMode?: boolean;
  customBlockedPatterns?: ReadonlyArray<RegExp>;
  customAllowedPatterns?: ReadonlyArray<RegExp>;
};

export function validateEnvVarValue(value: string): string | undefined {
  if (value.includes("\0")) {
    return "Contains null bytes";
  }
  if (value.length > 32768) {
    return "Value exceeds maximum length";
  }
  if (/^[A-Za-z0-9+/=]{80,}$/.test(value)) {
    return "Value looks like base64-encoded credential data";
  }
  return undefined;
}

function matchesAnyPattern(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

export function sanitizeEnvVars(
  envVars: Record<string, string | undefined>,
  options: EnvSanitizationOptions = {},
): EnvVarSanitizationResult {
  const allowed: Record<string, string> = {};
  const blocked: string[] = [];
  const warnings: string[] = [];

  const blockedPatterns = [...BLOCKED_ENV_VAR_PATTERNS, ...(options.customBlockedPatterns ?? [])];
  const allowedPatterns = [...ALLOWED_ENV_VAR_PATTERNS, ...(options.customAllowedPatterns ?? [])];

  for (const [rawKey, value] of Object.entries(envVars)) {
    const key = rawKey.trim();
    if (!key || value === undefined) {
      continue;
    }

    if (matchesAnyPattern(key, blockedPatterns)) {
      blocked.push(key);
      continue;
    }

    if (options.strictMode && !matchesAnyPattern(key, allowedPatterns)) {
      blocked.push(key);
      continue;
    }

    const warning = validateEnvVarValue(value);
    if (warning) {
      if (warning === "Contains null bytes") {
        blocked.push(key);
        continue;
      }
      warnings.push(`${key}: ${warning}`);
    }

    allowed[key] = value;
  }

  return { allowed, blocked, warnings };
}
