export type OpenClawSchemaVersions = {
  state: number;
  agent: number;
};

export function parseOpenClawSchemaVersions(value: unknown): OpenClawSchemaVersions | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    !Number.isInteger(record.state) ||
    (record.state as number) < 0 ||
    !Number.isInteger(record.agent) ||
    (record.agent as number) < 0
  ) {
    return undefined;
  }
  return { state: record.state as number, agent: record.agent as number };
}

export function parsePackageOpenClawSchemaVersions(
  packageJson: unknown,
): OpenClawSchemaVersions | undefined {
  if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) {
    return undefined;
  }
  const openclaw = (packageJson as Record<string, unknown>).openclaw;
  if (!openclaw || typeof openclaw !== "object" || Array.isArray(openclaw)) {
    return undefined;
  }
  return parseOpenClawSchemaVersions((openclaw as Record<string, unknown>).schemaVersions);
}
