import {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
  resolveSecretInputRef,
} from "../../config/types.secrets.js";

export function hasConfiguredMemorySecretInput(value: unknown): boolean {
  return hasConfiguredSecretInput(value);
}

export function resolveMemorySecretInputString(params: {
  value: unknown;
  path: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const { ref } = resolveSecretInputRef({ value: params.value });
  if (ref?.source === "env") {
    const envValue = normalizeSecretInputString((params.env ?? process.env)[ref.id]);
    if (envValue) {
      return envValue;
    }
  }
  return normalizeResolvedSecretInputString({
    value: params.value,
    path: params.path,
  });
}
