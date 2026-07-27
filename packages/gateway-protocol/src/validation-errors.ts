/** Normalized validation error shape exposed by every protocol validator. */
export type ValidationError = {
  /** Failed schema keyword, when the validator can report one. */
  keyword?: string;
  /** JSON-pointer path to the failing data location. */
  instancePath?: string;
  /** JSON-pointer path to the failing schema location. */
  schemaPath?: string;
  /** Validator-specific keyword parameters for richer diagnostics. */
  params?: Record<string, unknown>;
  /** Human-readable validation message. */
  message?: string;
};

function firstStringParam(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.find(
      (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
    );
  }
  return undefined;
}

/** Convert validator errors into compact operator-facing failure text. */
export function formatValidationErrors(errors: ValidationError[] | null | undefined) {
  if (!errors?.length) {
    return "unknown validation error";
  }

  const parts: string[] = [];

  for (const err of errors) {
    const keyword = typeof err?.keyword === "string" ? err.keyword : "";
    const instancePath = typeof err?.instancePath === "string" ? err.instancePath : "";

    if (keyword === "additionalProperties") {
      const additionalProperty =
        firstStringParam(err?.params?.additionalProperty) ??
        firstStringParam(err?.params?.additionalProperties);
      if (additionalProperty) {
        const where = instancePath ? `at ${instancePath}` : "at root";
        parts.push(`${where}: unexpected property ${JSON.stringify(additionalProperty)}`);
        continue;
      }
    }
    if (keyword === "required") {
      const missingProperty =
        firstStringParam(err?.params?.missingProperty) ??
        firstStringParam(err?.params?.requiredProperties);
      if (missingProperty) {
        const where = instancePath ? `at ${instancePath}: ` : "";
        parts.push(`${where}must have required property ${JSON.stringify(missingProperty)}`);
        continue;
      }
    }

    const failingKeyword =
      typeof err?.params?.failingKeyword === "string" ? err.params.failingKeyword : "";
    // TypeBox reports conditional required-property misses through if/then
    // keywords, which otherwise hide the actionable missing-property context.
    const message =
      keyword === "then" || (keyword === "if" && failingKeyword === "then")
        ? "must have required conditional properties"
        : typeof err?.message === "string" && err.message.trim()
          ? err.message
          : "validation error";
    const where = instancePath ? `at ${instancePath}: ` : "";
    parts.push(`${where}${message}`);
  }

  const unique = [...new Set(parts.filter((part) => part.trim()))];
  return unique.length > 0 ? unique.join("; ") : "unknown validation error";
}

export function messageReportsUnexpectedProperty(
  message: string,
  propertyName: string,
  requestContext?: string,
): boolean {
  if (requestContext !== undefined && !message.includes(requestContext)) {
    return false;
  }
  return (
    message.includes(`unexpected property '${propertyName}'`) ||
    message.includes(`unexpected property ${JSON.stringify(propertyName)}`)
  );
}
