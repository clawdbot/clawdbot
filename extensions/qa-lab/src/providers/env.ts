import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { QaProviderMode } from "./index.js";
import { getQaProvider } from "./index.js";

const QA_LIVE_ENV_ALIASES = Object.freeze([
  {
    liveVar: "OPENCLAW_LIVE_OPENAI_KEY",
    providerVar: "OPENAI_API_KEY",
  },
  {
    liveVar: "OPENCLAW_LIVE_ANTHROPIC_KEY",
    providerVar: "ANTHROPIC_API_KEY",
  },
  {
    liveVar: "OPENCLAW_LIVE_GEMINI_KEY",
    providerVar: "GEMINI_API_KEY",
  },
]);

export const QA_LIVE_PROVIDER_CONFIG_PATH_ENV = "OPENCLAW_QA_LIVE_PROVIDER_CONFIG_PATH";
export const QA_LIVE_CLI_BACKEND_PRESERVE_ENV = "OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV";
export const QA_LIVE_CLI_BACKEND_AUTH_MODE_ENV = "OPENCLAW_LIVE_CLI_BACKEND_AUTH_MODE";
export type QaCliBackendAuthMode = "auto" | "api-key" | "subscription";

export const QA_PROVIDER_SECRET_ENV_VARS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "ANTHROPIC_API_KEYS",
  "GEMINI_API_KEY",
  "GEMINI_API_KEYS",
  "GOOGLE_API_KEY",
  "MISTRAL_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_API_KEYS",
  "OPENCLAW_LIVE_ANTHROPIC_KEY",
  "OPENCLAW_LIVE_ANTHROPIC_KEYS",
  "OPENCLAW_LIVE_GEMINI_KEY",
  "OPENCLAW_LIVE_OPENAI_KEY",
  "VOYAGE_API_KEY",
]);

const QA_MOCK_BLOCKED_ENV_VARS = Object.freeze([
  ...QA_PROVIDER_SECRET_ENV_VARS,
  "AWS_REGION",
  "OPENAI_BASE_URL",
  "CODEX_HOME",
]);

const QA_MOCK_BLOCKED_ENV_KEY_PATTERNS = Object.freeze([
  /^DISCORD_/i,
  /^TELEGRAM_/i,
  /^SLACK_/i,
  /^MATRIX_/i,
  /^SIGNAL_/i,
  /^WHATSAPP_/i,
  /^IMESSAGE_/i,
  /^ZALO/i,
  /^TWILIO_/i,
  /^PLIVO_/i,
  /^NGROK_/i,
]);

const QA_LIVE_ALLOWED_ENV_VARS = Object.freeze([
  ...QA_PROVIDER_SECRET_ENV_VARS,
  "AWS_REGION",
  "OPENAI_BASE_URL",
  QA_LIVE_PROVIDER_CONFIG_PATH_ENV,
  "OPENCLAW_CONFIG_PATH",
]);

const QA_LIVE_ALLOWED_ENV_PATTERNS = Object.freeze([
  /^[A-Z0-9_]+_API_KEYS$/u,
  /^[A-Z0-9_]+_API_KEY_[0-9]+$/u,
  /^OPENCLAW_LIVE_[A-Z0-9_]+_KEYS$/u,
]);

function resolveUserPath(value: string, env: NodeJS.ProcessEnv = process.env) {
  if (value === "~") {
    return env.HOME ?? os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(env.HOME ?? os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

function applyLiveProviderEnvAliases(env: NodeJS.ProcessEnv | Record<string, string>) {
  for (const { liveVar, providerVar } of QA_LIVE_ENV_ALIASES) {
    const liveValue = env[liveVar]?.trim();
    if (!liveValue || env[providerVar]?.trim()) {
      continue;
    }
    env[providerVar] = liveValue;
  }
}

function parsePreservedCliEnv(baseEnv: NodeJS.ProcessEnv) {
  const raw = baseEnv[QA_LIVE_CLI_BACKEND_PRESERVE_ENV]?.trim();
  if (raw?.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === "string")
        : [];
    } catch {
      return [];
    }
  }
  return (raw ?? "").split(/[,\s]+/).filter((entry) => entry.length > 0);
}

function renderPreservedCliEnv(values: string[]) {
  return JSON.stringify([...new Set(values)]);
}

export function normalizeQaProviderModeEnv(env: NodeJS.ProcessEnv, providerMode?: QaProviderMode) {
  const provider = providerMode ? getQaProvider(providerMode) : null;
  if (provider?.scrubsLiveProviderEnv) {
    for (const key of QA_MOCK_BLOCKED_ENV_VARS) {
      delete env[key];
    }
    for (const key of Object.keys(env)) {
      if (QA_MOCK_BLOCKED_ENV_KEY_PATTERNS.some((pattern) => pattern.test(key))) {
        delete env[key];
      }
    }
    return env;
  }

  if (provider?.appliesLiveEnvAliases) {
    applyLiveProviderEnvAliases(env);
  }

  return env;
}

export function resolveQaLiveCliAuthEnv(
  baseEnv: NodeJS.ProcessEnv,
  opts?: {
    forwardHostHomeForClaudeCli?: boolean;
    claudeCliAuthMode?: QaCliBackendAuthMode;
  },
) {
  const authMode = opts?.claudeCliAuthMode ?? "auto";
  const hasAnthropicKey = Boolean(
    baseEnv.ANTHROPIC_API_KEY?.trim() || baseEnv.OPENCLAW_LIVE_ANTHROPIC_KEY?.trim(),
  );
  if (opts?.forwardHostHomeForClaudeCli && authMode === "api-key" && !hasAnthropicKey) {
    throw new Error(
      "Claude CLI API-key QA mode requires ANTHROPIC_API_KEY or OPENCLAW_LIVE_ANTHROPIC_KEY",
    );
  }
  const preserveEnvValues = (() => {
    if (!opts?.forwardHostHomeForClaudeCli) {
      return undefined;
    }
    const values = parsePreservedCliEnv(baseEnv).filter((entry) => entry !== "ANTHROPIC_API_KEY");
    if (authMode === "api-key" || (authMode === "auto" && hasAnthropicKey)) {
      values.push("ANTHROPIC_API_KEY");
    }
    return renderPreservedCliEnv(values);
  })();
  const claudeCliEnv = opts?.forwardHostHomeForClaudeCli
    ? {
        [QA_LIVE_CLI_BACKEND_AUTH_MODE_ENV]: authMode,
        ...(preserveEnvValues ? { [QA_LIVE_CLI_BACKEND_PRESERVE_ENV]: preserveEnvValues } : {}),
      }
    : {};
  const configuredCodexHome = baseEnv.CODEX_HOME?.trim();
  if (configuredCodexHome) {
    return {
      CODEX_HOME: configuredCodexHome,
      ...claudeCliEnv,
      ...(opts?.forwardHostHomeForClaudeCli && baseEnv.HOME?.trim()
        ? { HOME: baseEnv.HOME.trim() }
        : {}),
    };
  }
  const hostHome = baseEnv.HOME?.trim();
  if (!hostHome) {
    return {};
  }
  const codexHome = path.join(hostHome, ".codex");
  return {
    ...(existsSync(codexHome) ? { CODEX_HOME: codexHome } : {}),
    ...claudeCliEnv,
    ...(opts?.forwardHostHomeForClaudeCli ? { HOME: hostHome } : {}),
  };
}

export function resolveQaLiveProviderConfigPath(env: NodeJS.ProcessEnv = process.env) {
  const explicit =
    env[QA_LIVE_PROVIDER_CONFIG_PATH_ENV]?.trim() || env.OPENCLAW_CONFIG_PATH?.trim();
  return explicit
    ? { path: resolveUserPath(explicit, env), explicit: true }
    : { path: path.join(os.homedir(), ".openclaw", "openclaw.json"), explicit: false };
}

export function resolveQaForwardedLiveEnv(baseEnv: NodeJS.ProcessEnv = process.env) {
  const forwarded: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(baseEnv)) {
    if (
      !QA_LIVE_ALLOWED_ENV_VARS.includes(key) &&
      !QA_LIVE_ALLOWED_ENV_PATTERNS.some((pattern) => pattern.test(key))
    ) {
      continue;
    }
    const value = rawValue?.trim();
    if (value) {
      forwarded[key] = value;
    }
  }
  applyLiveProviderEnvAliases(forwarded);

  const configuredCodexHome = baseEnv.CODEX_HOME?.trim();
  const codexHome = configuredCodexHome
    ? resolveUserPath(configuredCodexHome, baseEnv)
    : path.join(baseEnv.HOME?.trim() || os.homedir(), ".codex");
  if (existsSync(codexHome)) {
    forwarded.CODEX_HOME = codexHome;
  }
  return forwarded;
}
