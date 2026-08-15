export const MEMORY_TABLE_NAME = "memories";
export const MEMORY_AGENT_ID_COLUMN = "agentId";

export function quoteLanceSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function memoryAgentPredicate(agentId: string): string {
  return `${MEMORY_AGENT_ID_COLUMN} = ${quoteLanceSqlString(agentId)}`;
}

export function hasAgentScopeColumn(schema: { fields: Array<{ name: string }> }): boolean {
  return schema.fields.some((field) => field.name === MEMORY_AGENT_ID_COLUMN);
}

export function legacyMemorySchemaError(): Error {
  return new Error(
    'memory-lancedb: the existing memory table predates per-agent isolation. Run "openclaw doctor --fix" to assign legacy rows to the default agent, then restart OpenClaw.',
  );
}
