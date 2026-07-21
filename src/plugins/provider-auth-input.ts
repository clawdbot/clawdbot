import { expectDefined } from "@openclaw/normalization-core";
/** Normalizes provider auth input metadata collected from plugin setup flows. */
import {
  normalizeOptionalLowercaseString,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { isMalformedApiKeyInput } from "../agents/auth-profiles/credential-state.js";
import { resolveEnvApiKey } from "../agents/model-auth-env.js";
import type { OpenClawConfig } from "../config/types.js";
import type { SecretInput } from "../config/types.secrets.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { resolveSecretInputModeForEnvSelection } from "./provider-auth-mode.js";
import {
  extractEnvVarFromSourceLabel,
  promptSecretRefForSetup,
  resolveRefFallbackInput,
} from "./provider-auth-ref.js";
import type { SecretInputMode } from "./provider-auth-types.js";

export { promptSecretRefForSetup } from "./provider-auth-ref.js";
export { resolveSecretInputModeForEnvSelection } from "./provider-auth-mode.js";

const DEFAULT_KEY_PREVIEW = { head: 4, tail: 4 };

/** Normalizes pasted API-key input, including shell assignment forms. */
export function normalizeApiKeyInput(raw: string): string {
  const trimmed = normalizeStringifiedOptionalString(raw) ?? "";
  if (!trimmed) {
    return "";
  }

  const normalizedPaste = normalizeSecretInput(trimmed);
  const assignmentMatch = normalizedPaste.match(
    /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+)$/,
  );
  const valuePart = assignmentMatch
    ? expectDefined(assignmentMatch[1], "assignment match capture group 1").trim()
    : normalizedPaste;
  const withoutSemicolon = valuePart.endsWith(";") ? valuePart.slice(0, -1).trim() : valuePart;

  const unquoted =
    withoutSemicolon.length >= 2 &&
    ((withoutSemicolon.startsWith('"') && withoutSemicolon.endsWith('"')) ||
      (withoutSemicolon.startsWith("'") && withoutSemicolon.endsWith("'")) ||
      (withoutSemicolon.startsWith("`") && withoutSemicolon.endsWith("`")))
      ? withoutSemicolon.slice(1, -1)
      : withoutSemicolon;

  return normalizeSecretInput(unquoted);
}

/** Validates required API-key input for setup prompts. */
export const validateApiKeyInput = (value: string) => {
  const normalized = normalizeApiKeyInput(value);
  if (!normalized) {
    return "Required";
  }
  if (isMalformedApiKeyInput(normalized)) {
    return "Paste the API key value, not an OpenClaw onboarding command.";
  }
  return undefined;
};

/** Formats a redacted API-key preview for setup confirmation prompts. */
export function formatApiKeyPreview(
  raw: string,
  opts: { head?: number; tail?: number } = {},
): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "…";
  }
  const head = opts.head ?? DEFAULT_KEY_PREVIEW.head;
  const tail = opts.tail ?? DEFAULT_KEY_PREVIEW.tail;
  if (trimmed.length <= head + tail) {
    const shortHead = Math.min(2, trimmed.length);
    const shortTail = Math.min(2, trimmed.length - shortHead);
    if (shortTail <= 0) {
      return `${sliceUtf16Safe(trimmed, 0, shortHead)}…`;
    }
    return `${sliceUtf16Safe(trimmed, 0, shortHead)}…${sliceUtf16Safe(trimmed, -shortTail)}`;
  }
  return `${sliceUtf16Safe(trimmed, 0, head)}…${sliceUtf16Safe(trimmed, -tail)}`;
}

/** Normalizes a token-provider selector from CLI/options input. */
export function normalizeTokenProviderInput(
  tokenProvider: string | null | undefined,
): string | undefined {
  return normalizeOptionalLowercaseString(tokenProvider);
}

/** Normalizes secret input mode values accepted by provider setup. */
export function normalizeSecretInputModeInput(
  secretInputMode: string | null | undefined,
): SecretInputMode | undefined {
  const normalized = normalizeOptionalLowercaseString(secretInputMode);
  if (normalized === "plaintext" || normalized === "ref") {
    return normalized;
  }
  return undefined;
}

/** Applies a CLI-provided API key when its provider selector matches this auth method. */
async function maybeApplyApiKeyFromOption(params: {
  token: string | undefined;
  tokenProvider: string | undefined;
  secretInputMode?: SecretInputMode;
  expectedProviders: string[];
  normalize: (value: string) => string;
  validate?: (value: string) => string | undefined;
  setCredential: (apiKey: SecretInput, mode?: SecretInputMode) => Promise<void>;
}): Promise<string | undefined> {
  const tokenProvider = normalizeTokenProviderInput(params.tokenProvider);
  const expectedProviders = params.expectedProviders
    .map((provider) => normalizeTokenProviderInput(provider))
    .filter((provider): provider is string => Boolean(provider));
  if (!params.token || !tokenProvider || !expectedProviders.includes(tokenProvider)) {
    return undefined;
  }
  const apiKey = params.normalize(params.token);
  const validationError = params.validate?.(apiKey);
  if (validationError) {
    throw new Error(validationError);
  }
  await params.setCredential(apiKey, params.secretInputMode);
  return apiKey;
}

/** Resolves an API key from CLI options first, then environment or prompt fallback. */
export async function ensureApiKeyFromOptionEnvOrPrompt(params: {
  token: string | undefined;
  tokenProvider: string | undefined;
  secretInputMode?: SecretInputMode;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  expectedProviders: string[];
  provider: string;
  envLabel: string;
  promptMessage: string;
  normalize: (value: string) => string;
  validate: (value: string) => string | undefined;
  prompter: WizardPrompter;
  setCredential: (apiKey: SecretInput, mode?: SecretInputMode) => Promise<void>;
  noteMessage?: string;
  noteTitle?: string;
}): Promise<string> {
  const optionApiKey = await maybeApplyApiKeyFromOption({
    token: params.token,
    tokenProvider: params.tokenProvider,
    secretInputMode: params.secretInputMode,
    expectedProviders: params.expectedProviders,
    normalize: params.normalize,
    validate: params.validate,
    setCredential: params.setCredential,
  });
  if (optionApiKey) {
    return optionApiKey;
  }

  if (params.noteMessage) {
    await params.prompter.note(params.noteMessage, params.noteTitle);
  }

  return await ensureApiKeyFromEnvOrPrompt({
    config: params.config,
    env: params.env,
    provider: params.provider,
    envLabel: params.envLabel,
    promptMessage: params.promptMessage,
    normalize: params.normalize,
    validate: params.validate,
    prompter: params.prompter,
    secretInputMode: params.secretInputMode,
    setCredential: params.setCredential,
  });
}

/** Resolves an API key from environment or interactive prompt and records the chosen secret mode. */
export async function ensureApiKeyFromEnvOrPrompt(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  provider: string;
  envLabel: string;
  promptMessage: string;
  normalize: (value: string) => string;
  validate: (value: string) => string | undefined;
  prompter: WizardPrompter;
  secretInputMode?: SecretInputMode;
  setCredential: (apiKey: SecretInput, mode?: SecretInputMode) => Promise<void>;
}): Promise<string> {
  const selectedMode = await resolveSecretInputModeForEnvSelection({
    prompter: params.prompter,
    explicitMode: params.secretInputMode,
  });
  const env = params.env ?? process.env;
  const envKey = resolveEnvApiKey(params.provider, env);

  if (selectedMode === "ref") {
    if (typeof params.prompter.select !== "function") {
      const fallback = resolveRefFallbackInput({
        config: params.config,
        provider: params.provider,
        preferredEnvVar: envKey?.source ? extractEnvVarFromSourceLabel(envKey.source) : undefined,
        env,
      });
      await params.setCredential(fallback.ref, selectedMode);
      return fallback.resolvedValue;
    }
    const resolved = await promptSecretRefForSetup({
      provider: params.provider,
      config: params.config,
      prompter: params.prompter,
      preferredEnvVar: envKey?.source ? extractEnvVarFromSourceLabel(envKey.source) : undefined,
      env,
    });
    await params.setCredential(resolved.ref, selectedMode);
    return resolved.resolvedValue;
  }

  if (envKey && selectedMode === "plaintext") {
    const useExisting = await params.prompter.confirm({
      message: `Use existing ${params.envLabel} (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
      initialValue: true,
    });
    if (useExisting) {
      await params.setCredential(envKey.apiKey, selectedMode);
      return envKey.apiKey;
    }
  }

  const key = await params.prompter.text({
    message: params.promptMessage,
    placeholder: "API key",
    validate: params.validate,
    sensitive: true,
  });
  const apiKey = params.normalize(key ?? "");
  await params.setCredential(apiKey, selectedMode);
  return apiKey;
}
