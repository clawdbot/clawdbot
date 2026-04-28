import {
  hasConfiguredSecretInput,
  normalizeEnvSecretInputString,
  normalizeResolvedSecretInputString,
  resolveSecretInputRef,
} from "./secret-input-utils.js";

export function hasConfiguredMemorySecretInput(value: unknown): boolean {
  return hasConfiguredSecretInput(value);
}

export function resolveMemorySecretInputString(params: {
  value: unknown;
  path: string;
}): string | undefined {
  const ref = resolveSecretInputRef(params.value);
  if (ref?.source === "env") {
    const envValue = normalizeEnvSecretInputString(process.env[ref.id]);
    if (envValue) {
      return envValue;
    }
  }
  return normalizeResolvedSecretInputString({
    value: params.value,
    path: params.path,
  });
}
