const GATEWAY_STATE_SCHEMA_MIGRATION_REQUIRED_REASON = "gateway.state_schema_migration_required";

type OpenClawStateDatabaseSchemaMigrationRequiredKind =
  | "agent-databases-composite-primary-key"
  | "audit-events-v2";

export class OpenClawStateDatabaseSchemaMigrationRequiredError extends Error {
  readonly code = GATEWAY_STATE_SCHEMA_MIGRATION_REQUIRED_REASON;

  constructor(
    readonly kind: OpenClawStateDatabaseSchemaMigrationRequiredKind,
    readonly pathname: string,
  ) {
    super(
      `OpenClaw state database schema migration required (${kind}) at ${pathname}; run openclaw doctor --fix to migrate it.`,
    );
    this.name = "OpenClawStateDatabaseSchemaMigrationRequiredError";
  }
}

const STATE_SCHEMA_MIGRATION_REQUIRED_MESSAGE =
  /^OpenClaw state database schema migration required \((agent-databases-composite-primary-key|audit-events-v2)\) at (.+); run openclaw doctor --fix to migrate it\.$/u;

function parseStateSchemaMigrationRequiredMessage(
  message: unknown,
): OpenClawStateDatabaseSchemaMigrationRequiredError | undefined {
  if (typeof message !== "string") {
    return undefined;
  }
  const match = STATE_SCHEMA_MIGRATION_REQUIRED_MESSAGE.exec(message);
  const kind = match?.[1] as OpenClawStateDatabaseSchemaMigrationRequiredKind | undefined;
  const pathname = match?.[2];
  if (!kind || !pathname) {
    return undefined;
  }
  return new OpenClawStateDatabaseSchemaMigrationRequiredError(kind, pathname);
}

export function findOpenClawStateDatabaseSchemaMigrationRequiredError(
  error: unknown,
): OpenClawStateDatabaseSchemaMigrationRequiredError | undefined {
  let current = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    if (current instanceof OpenClawStateDatabaseSchemaMigrationRequiredError) {
      return current;
    }
    const errorLike = current as { cause?: unknown; message?: unknown };
    const parsed = parseStateSchemaMigrationRequiredMessage(errorLike.message);
    if (parsed) {
      return parsed;
    }
    seen.add(current);
    current = errorLike.cause;
  }
  return undefined;
}
