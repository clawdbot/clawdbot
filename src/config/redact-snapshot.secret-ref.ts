/** Narrows plain objects that carry the minimum SecretRef fields used by redaction. */
export function isSecretRefShape(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { source: string; id: string } {
  return typeof value.source === "string" && typeof value.id === "string";
}

/** Redacts a SecretRef id while preserving non-secret structural fields for restore matching. */
export function redactSecretRefId(params: {
  value: Record<string, unknown> & { source: string; id: string };
  values: string[];
  redactedSentinel: string;
  isEnvVarPlaceholder: (value: string) => boolean;
}): Record<string, unknown> {
  const { value, values, redactedSentinel, isEnvVarPlaceholder } = params;
  const redacted: Record<string, unknown> = { ...value };
  if (!isEnvVarPlaceholder(value.id)) {
    // `${ENV_VAR}` placeholders are already indirect references; collect and redact only concrete
    // ids so raw replacement cannot erase harmless template syntax.
    values.push(value.id);
    redacted.id = redactedSentinel;
  }
  return redacted;
}
