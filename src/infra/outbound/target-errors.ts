/**
 * Formats the user-facing error shown when no target is available.
 */
export function missingTargetMessage(provider: string, hint?: string): string {
  return `Delivering to ${provider} requires target${formatTargetHint(hint)}`;
}

/**
 * Builds an Error for missing outbound target failures.
 */
export function missingTargetError(provider: string, hint?: string): Error {
  return new Error(missingTargetMessage(provider, hint));
}

/**
 * Formats the user-facing error shown when a target name resolves ambiguously.
 */
export function ambiguousTargetMessage(provider: string, raw: string, hint?: string): string {
  return `Ambiguous target "${raw}" for ${provider}. Provide a unique name or an explicit id.${formatTargetHint(hint, true)}`;
}

/**
 * Builds an Error for ambiguous outbound target failures.
 */
export function ambiguousTargetError(provider: string, raw: string, hint?: string): Error {
  return new Error(ambiguousTargetMessage(provider, raw, hint));
}

/**
 * Formats the user-facing error shown when no target matches the input.
 */
export function unknownTargetMessage(provider: string, raw: string, hint?: string): string {
  return `Unknown target "${raw}" for ${provider}.${formatTargetHint(hint, true)}`;
}

/**
 * Builds an Error for unknown outbound target failures.
 */
export function unknownTargetError(provider: string, raw: string, hint?: string): Error {
  return new Error(unknownTargetMessage(provider, raw, hint));
}

function formatTargetHint(hint?: string, withLabel = false): string {
  const normalized = hint?.trim();
  if (!normalized) {
    return "";
  }
  return withLabel ? ` Hint: ${normalized}` : ` ${normalized}`;
}
