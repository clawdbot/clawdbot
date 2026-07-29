// Memory Host SDK module implements secret input behavior.
import {
  hasConfiguredMemorySecretInputValue,
  normalizeEnvSecretInputString,
  normalizeResolvedMemorySecretInputString,
  resolveMemorySecretInputRef,
} from "./secret-input-utils.js";

// Memory-specific facade for resolving provider secret input from config.

/** Return true when a configured memory secret contains a literal value or reference. */
export function hasConfiguredMemorySecretInput(value: unknown): boolean {
  return hasConfiguredMemorySecretInputValue(value);
}

/** Resolve memory secret input, reading env refs directly when available. */
export function resolveMemorySecretInputString(params: {
  value: unknown;
  path: string;
}): string | undefined {
  const ref = resolveMemorySecretInputRef(params.value);
  if (ref?.source === "env") {
    const envValue = normalizeEnvSecretInputString(process.env[ref.id]);
    if (envValue) {
      return envValue;
    }
  }
  return normalizeResolvedMemorySecretInputString({
    value: params.value,
    path: params.path,
  });
}
