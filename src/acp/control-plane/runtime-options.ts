import { isAbsolute } from "node:path";
import type { AcpSessionRuntimeOptions, SessionAcpMeta } from "../../config/sessions/types.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { normalizeText } from "../normalize-text.js";
import { AcpRuntimeError } from "../runtime/errors.js";

export { normalizeText } from "../normalize-text.js";

const MAX_RUNTIME_MODE_LENGTH = 64;
const MAX_MODEL_LENGTH = 200;
const MAX_THINKING_LENGTH = 32;
const MAX_PERMISSION_PROFILE_LENGTH = 80;
const MAX_CWD_LENGTH = 4096;
const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;
const MAX_BACKEND_OPTION_KEY_LENGTH = 64;
const MAX_BACKEND_OPTION_VALUE_LENGTH = 512;
const MAX_BACKEND_EXTRAS = 32;

const SAFE_OPTION_KEY_RE = /^[a-z0-9][a-z0-9._:-]*$/i;
const RUNTIME_CONFIG_OPTION_ALIASES = {
  model: ["model"],
  thinking: ["thinking", "effort", "reasoning_effort", "thought_level"],
  permissionProfile: ["approval_policy", "permission_profile", "permissions", "permission_mode"],
  timeoutSeconds: ["timeout", "timeout_seconds"],
} as const;

function failInvalidOption(message: string): never {
  throw new AcpRuntimeError("ACP_INVALID_RUNTIME_OPTION", message);
}

function validateNoControlChars(value: string, field: string): string {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) {
      failInvalidOption(`${field} must not include control characters.`);
    }
  }
  return value;
}

function validateBoundedText(params: { value: unknown; field: string; maxLength: number }): string {
  const normalized = normalizeText(params.value);
  if (!normalized) {
    failInvalidOption(`${params.field} must not be empty.`);
  }
  if (normalized.length > params.maxLength) {
    failInvalidOption(`${params.field} must be at most ${params.maxLength} characters.`);
  }
  return validateNoControlChars(normalized, params.field);
}

function validateBackendOptionKey(rawKey: unknown): string {
  const key = validateBoundedText({
    value: rawKey,
    field: "ACP config key",
    maxLength: MAX_BACKEND_OPTION_KEY_LENGTH,
  });
  if (!SAFE_OPTION_KEY_RE.test(key)) {
    failInvalidOption(
      "ACP config key must use letters, numbers, dots, colons, underscores, or dashes.",
    );
  }
  return key;
}

function validateBackendOptionValue(rawValue: unknown): string {
  return validateBoundedText({
    value: rawValue,
    field: "ACP config value",
    maxLength: MAX_BACKEND_OPTION_VALUE_LENGTH,
  });
}

export function validateRuntimeModeInput(rawMode: unknown): string {
  return validateBoundedText({
    value: rawMode,
    field: "Runtime mode",
    maxLength: MAX_RUNTIME_MODE_LENGTH,
  });
}

export function validateRuntimeModelInput(rawModel: unknown): string {
  return validateBoundedText({
    value: rawModel,
    field: "Model id",
    maxLength: MAX_MODEL_LENGTH,
  });
}

function validateRuntimeThinkingInput(rawThinking: unknown): string {
  return validateBoundedText({
    value: rawThinking,
    field: "Thinking level",
    maxLength: MAX_THINKING_LENGTH,
  });
}

export function validateRuntimePermissionProfileInput(rawProfile: unknown): string {
  return validateBoundedText({
    value: rawProfile,
    field: "Permission profile",
    maxLength: MAX_PERMISSION_PROFILE_LENGTH,
  });
}

export function validateRuntimeCwdInput(rawCwd: unknown): string {
  const cwd = validateBoundedText({
    value: rawCwd,
    field: "Working directory",
    maxLength: MAX_CWD_LENGTH,
  });
  if (!isAbsolute(cwd)) {
    failInvalidOption(`Working directory must be an absolute path. Received "${cwd}".`);
  }
  return cwd;
}

function validateRuntimeTimeoutSecondsInput(rawTimeout: unknown): number {
  if (typeof rawTimeout !== "number" || !Number.isFinite(rawTimeout)) {
    failInvalidOption("Timeout must be a positive integer in seconds.");
  }
  const timeout = Math.round(rawTimeout);
  if (timeout < MIN_TIMEOUT_SECONDS || timeout > MAX_TIMEOUT_SECONDS) {
    failInvalidOption(
      `Timeout must be between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS} seconds.`,
    );
  }
  return timeout;
}

export function parseRuntimeTimeoutSecondsInput(rawTimeout: unknown): number {
  const normalized = normalizeText(rawTimeout);
  if (!normalized || !/^\d+$/.test(normalized)) {
    failInvalidOption("Timeout must be a positive integer in seconds.");
  }
  return validateRuntimeTimeoutSecondsInput(Number.parseInt(normalized, 10));
}

export function validateRuntimeConfigOptionInput(
  rawKey: unknown,
  rawValue: unknown,
): {
  key: string;
  value: string;
} {
  return {
    key: validateBackendOptionKey(rawKey),
    value: validateBackendOptionValue(rawValue),
  };
}

export function validateRuntimeOptionPatch(
  patch: Partial<AcpSessionRuntimeOptions> | undefined,
): Partial<AcpSessionRuntimeOptions> {
  if (!patch) {
    return {};
  }
  const rawPatch = patch as Record<string, unknown>;
  const allowedKeys = new Set([
    "runtimeMode",
    "model",
    "thinking",
    "cwd",
    "permissionProfile",
    "timeoutSeconds",
    "backendExtras",
  ]);
  for (const key of Object.keys(rawPatch)) {
    if (!allowedKeys.has(key)) {
      failInvalidOption(`Unknown runtime option "${key}".`);
    }
  }

  const next: Partial<AcpSessionRuntimeOptions> = {};
  if (Object.hasOwn(rawPatch, "runtimeMode")) {
    if (rawPatch.runtimeMode === undefined) {
      next.runtimeMode = undefined;
    } else {
      next.runtimeMode = validateRuntimeModeInput(rawPatch.runtimeMode);
    }
  }
  if (Object.hasOwn(rawPatch, "model")) {
    if (rawPatch.model === undefined) {
      next.model = undefined;
    } else {
      next.model = validateRuntimeModelInput(rawPatch.model);
    }
  }
  if (Object.hasOwn(rawPatch, "thinking")) {
    if (rawPatch.thinking === undefined) {
      next.thinking = undefined;
    } else {
      next.thinking = validateRuntimeThinkingInput(rawPatch.thinking);
    }
  }
  if (Object.hasOwn(rawPatch, "cwd")) {
    if (rawPatch.cwd === undefined) {
      next.cwd = undefined;
    } else {
      next.cwd = validateRuntimeCwdInput(rawPatch.cwd);
    }
  }
  if (Object.hasOwn(rawPatch, "permissionProfile")) {
    if (rawPatch.permissionProfile === undefined) {
      next.permissionProfile = undefined;
    } else {
      next.permissionProfile = validateRuntimePermissionProfileInput(rawPatch.permissionProfile);
    }
  }
  if (Object.hasOwn(rawPatch, "timeoutSeconds")) {
    if (rawPatch.timeoutSeconds === undefined) {
      next.timeoutSeconds = undefined;
    } else {
      next.timeoutSeconds = validateRuntimeTimeoutSecondsInput(rawPatch.timeoutSeconds);
    }
  }
  if (Object.hasOwn(rawPatch, "backendExtras")) {
    const rawExtras = rawPatch.backendExtras;
    if (rawExtras === undefined) {
      next.backendExtras = undefined;
    } else if (!rawExtras || typeof rawExtras !== "object" || Array.isArray(rawExtras)) {
      failInvalidOption("Backend extras must be a key/value object.");
    } else {
      const entries = Object.entries(rawExtras);
      if (entries.length > MAX_BACKEND_EXTRAS) {
        failInvalidOption(`Backend extras must include at most ${MAX_BACKEND_EXTRAS} entries.`);
      }
      const extras: Record<string, string> = {};
      for (const [entryKey, entryValue] of entries) {
        const { key, value } = validateRuntimeConfigOptionInput(entryKey, entryValue);
        extras[key] = value;
      }
      next.backendExtras = Object.keys(extras).length > 0 ? extras : undefined;
    }
  }

  return next;
}

export function normalizeRuntimeOptions(
  options: AcpSessionRuntimeOptions | undefined,
): AcpSessionRuntimeOptions {
  const runtimeMode = normalizeText(options?.runtimeMode);
  const model = normalizeText(options?.model);
  const thinking = normalizeText(options?.thinking);
  const cwd = normalizeText(options?.cwd);
  const permissionProfile = normalizeText(options?.permissionProfile);
  let timeoutSeconds: number | undefined;
  if (typeof options?.timeoutSeconds === "number" && Number.isFinite(options.timeoutSeconds)) {
    const rounded = Math.round(options.timeoutSeconds);
    if (rounded > 0) {
      timeoutSeconds = rounded;
    }
  }
  const backendExtrasEntries = Object.entries(options?.backendExtras ?? {})
    .map(([key, value]) => [normalizeText(key), normalizeText(value)] as const)
    .filter(([key, value]) => Boolean(key && value)) as Array<[string, string]>;
  const backendExtras =
    backendExtrasEntries.length > 0 ? Object.fromEntries(backendExtrasEntries) : undefined;
  return {
    ...(runtimeMode ? { runtimeMode } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(cwd ? { cwd } : {}),
    ...(permissionProfile ? { permissionProfile } : {}),
    ...(typeof timeoutSeconds === "number" ? { timeoutSeconds } : {}),
    ...(backendExtras ? { backendExtras } : {}),
  };
}

export function mergeRuntimeOptions(params: {
  current?: AcpSessionRuntimeOptions;
  patch?: Partial<AcpSessionRuntimeOptions>;
}): AcpSessionRuntimeOptions {
  const current = normalizeRuntimeOptions(params.current);
  const patch = normalizeRuntimeOptions(validateRuntimeOptionPatch(params.patch));
  const mergedExtras = {
    ...current.backendExtras,
    ...patch.backendExtras,
  };
  return normalizeRuntimeOptions({
    ...current,
    ...patch,
    ...(Object.keys(mergedExtras).length > 0 ? { backendExtras: mergedExtras } : {}),
  });
}

export function resolveRuntimeOptionsFromMeta(meta: SessionAcpMeta): AcpSessionRuntimeOptions {
  const normalized = normalizeRuntimeOptions(meta.runtimeOptions);
  if (normalized.cwd || !meta.cwd) {
    return normalized;
  }
  return normalizeRuntimeOptions({
    ...normalized,
    cwd: meta.cwd,
  });
}

export function runtimeOptionsEqual(
  a: AcpSessionRuntimeOptions | undefined,
  b: AcpSessionRuntimeOptions | undefined,
): boolean {
  return JSON.stringify(normalizeRuntimeOptions(a)) === JSON.stringify(normalizeRuntimeOptions(b));
}

export function buildRuntimeControlSignature(options: AcpSessionRuntimeOptions): string {
  const normalized = normalizeRuntimeOptions(options);
  const extras = Object.entries(normalized.backendExtras ?? {}).toSorted(([a], [b]) =>
    a.localeCompare(b),
  );
  return JSON.stringify({
    runtimeMode: normalized.runtimeMode ?? null,
    model: normalized.model ?? null,
    thinking: normalized.thinking ?? null,
    permissionProfile: normalized.permissionProfile ?? null,
    timeoutSeconds: normalized.timeoutSeconds ?? null,
    backendExtras: extras,
  });
}

export function buildRuntimeConfigOptionPairs(
  options: AcpSessionRuntimeOptions,
  advertisedConfigOptionKeys?: readonly string[],
): Array<[string, string]> {
  const normalized = normalizeRuntimeOptions(options);
  const pairs = new Map<string, string>();
  if (normalized.model) {
    pairs.set(resolveRuntimeConfigOptionKey("model", advertisedConfigOptionKeys), normalized.model);
  }
  if (normalized.thinking) {
    pairs.set(
      resolveRuntimeConfigOptionKey("thinking", advertisedConfigOptionKeys),
      normalized.thinking,
    );
  }
  if (normalized.permissionProfile) {
    pairs.set(
      resolveRuntimeConfigOptionKey("approval_policy", advertisedConfigOptionKeys),
      normalized.permissionProfile,
    );
  }
  if (
    typeof normalized.timeoutSeconds === "number" &&
    shouldEmitTimeoutConfigOption(advertisedConfigOptionKeys)
  ) {
    pairs.set(
      resolveRuntimeConfigOptionKey("timeout", advertisedConfigOptionKeys),
      String(normalized.timeoutSeconds),
    );
  }
  for (const [key, value] of Object.entries(normalized.backendExtras ?? {})) {
    const wireKey = resolveRuntimeConfigOptionKey(key, advertisedConfigOptionKeys);
    if (!pairs.has(wireKey)) {
      pairs.set(wireKey, value);
    }
  }
  return [...pairs.entries()];
}

function shouldEmitTimeoutConfigOption(advertisedConfigOptionKeys?: readonly string[]): boolean {
  const advertisedKeys = buildAdvertisedConfigOptionKeyMap(advertisedConfigOptionKeys);
  return (
    advertisedKeys.size === 0 ||
    RUNTIME_CONFIG_OPTION_ALIASES.timeoutSeconds.some((alias) =>
      advertisedKeys.has(normalizeLowercaseStringOrEmpty(alias)),
    )
  );
}

function buildAdvertisedConfigOptionKeyMap(
  advertisedConfigOptionKeys?: readonly string[],
): Map<string, string> {
  const advertisedKeys = new Map<string, string>();
  for (const rawKey of advertisedConfigOptionKeys ?? []) {
    const key = normalizeText(rawKey);
    const normalizedKey = normalizeLowercaseStringOrEmpty(key);
    if (key && normalizedKey && !advertisedKeys.has(normalizedKey)) {
      advertisedKeys.set(normalizedKey, key);
    }
  }
  return advertisedKeys;
}

function resolveRuntimeConfigOptionAliases(key: string): readonly string[] {
  const normalizedKey = normalizeLowercaseStringOrEmpty(key);
  for (const aliases of Object.values(RUNTIME_CONFIG_OPTION_ALIASES)) {
    if (aliases.some((alias) => normalizeLowercaseStringOrEmpty(alias) === normalizedKey)) {
      return aliases;
    }
  }
  return [key];
}

export function resolveRuntimeConfigOptionKey(
  key: string,
  advertisedConfigOptionKeys?: readonly string[],
): string {
  const normalizedKey = normalizeText(key) ?? "";
  const normalizedLookupKey = normalizeLowercaseStringOrEmpty(normalizedKey);
  const advertisedKeys = buildAdvertisedConfigOptionKeyMap(advertisedConfigOptionKeys);
  if (!normalizedKey || advertisedKeys.size === 0) {
    return normalizedKey;
  }
  const exactAdvertisedKey = advertisedKeys.get(normalizedLookupKey);
  if (exactAdvertisedKey) {
    return exactAdvertisedKey;
  }
  for (const alias of resolveRuntimeConfigOptionAliases(normalizedKey)) {
    const advertisedAlias = advertisedKeys.get(normalizeLowercaseStringOrEmpty(alias));
    if (advertisedAlias) {
      return advertisedAlias;
    }
  }
  return normalizedKey;
}

export function inferRuntimeOptionPatchFromConfigOption(
  key: string,
  value: string,
): Partial<AcpSessionRuntimeOptions> {
  const validated = validateRuntimeConfigOptionInput(key, value);
  const normalizedKey = normalizeLowercaseStringOrEmpty(validated.key);
  if (normalizedKey === "model") {
    return { model: validateRuntimeModelInput(validated.value) };
  }
  if (
    normalizedKey === "thinking" ||
    normalizedKey === "effort" ||
    normalizedKey === "thought_level" ||
    normalizedKey === "reasoning_effort"
  ) {
    return { thinking: validateRuntimeThinkingInput(validated.value) };
  }
  if (
    normalizedKey === "approval_policy" ||
    normalizedKey === "permission_profile" ||
    normalizedKey === "permissions" ||
    normalizedKey === "permission_mode"
  ) {
    return { permissionProfile: validateRuntimePermissionProfileInput(validated.value) };
  }
  if (normalizedKey === "timeout" || normalizedKey === "timeout_seconds") {
    return { timeoutSeconds: parseRuntimeTimeoutSecondsInput(validated.value) };
  }
  if (normalizedKey === "cwd") {
    return { cwd: validateRuntimeCwdInput(validated.value) };
  }
  return {
    backendExtras: {
      [validated.key]: validated.value,
    },
  };
}
