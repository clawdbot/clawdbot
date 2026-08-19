export const MEMORY_TABLE_NAME = "memories";
export const MEMORY_AGENT_ID_COLUMN = "agentId";
export const MEMORY_SCOPE_COLUMN = "scope";

export function quoteLanceSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function memoryAgentPredicate(agentId: string): string {
  return `${MEMORY_AGENT_ID_COLUMN} = ${quoteLanceSqlString(agentId)}`;
}

// Scope is an opaque caller-defined partition WITHIN one agent's rows ("" =
// unscoped/global). The plugin validates keys as slugs ([A-Za-z0-9_-]+) before
// any predicate is built; quoting here is defense-in-depth. The `IS NULL`
// branch normalizes rows migrated from tables that predate the column.
export function memoryScopePredicate(scope: string): string {
  return scope
    ? `${MEMORY_SCOPE_COLUMN} = ${quoteLanceSqlString(scope)}`
    : `(${MEMORY_SCOPE_COLUMN} = '' OR ${MEMORY_SCOPE_COLUMN} IS NULL)`;
}

export function hasAgentScopeColumn(schema: { fields: Array<{ name: string }> }): boolean {
  return schema.fields.some((field) => field.name === MEMORY_AGENT_ID_COLUMN);
}

export function hasMemoryScopeColumn(schema: { fields: Array<{ name: string }> }): boolean {
  return schema.fields.some((field) => field.name === MEMORY_SCOPE_COLUMN);
}

export function legacyMemorySchemaError(): Error {
  return new Error(
    'memory-lancedb: the existing memory table predates per-agent isolation. Run "openclaw doctor --fix" to assign legacy rows to the default agent, then restart OpenClaw.',
  );
}

export function legacyScopeSchemaError(): Error {
  const error = new Error(
    'memory-lancedb: the existing memory table predates scope partitioning. Run "openclaw doctor --fix" to add the scope column (existing rows stay global), then restart OpenClaw.',
  );
  error.name = "LegacyScopeSchemaError";
  return error;
}

// Expected-state discriminator: a scoped operation on a pre-scope table is a
// Doctor-directed refusal, not a store failure, so callers that must keep
// going (auto-capture batches) can skip it without masking real errors.
export function isLegacyScopeSchemaError(error: unknown): boolean {
  return error instanceof Error && error.name === "LegacyScopeSchemaError";
}
