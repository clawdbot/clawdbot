import { expect } from "vitest";

type SchemaParseResult<TData = unknown> =
  | { success: true; data: TData }
  | { success: false; error: { issues: Array<{ path: PropertyKey[]; message?: string }> } };

export function expectSchemaConfigValue(params: {
  schema: { safeParse: (value: unknown) => SchemaParseResult };
  config: unknown;
  readValue: (config: unknown) => unknown;
  expectedValue: unknown;
}) {
  const res = params.schema.safeParse(params.config);
  expect(res.success).toBe(true);
  if (!res.success) {
    throw new Error("expected schema config to be valid");
  }
  expect(params.readValue(res.data)).toBe(params.expectedValue);
}

export function expectSchemaValid(
  schema: { safeParse: (value: unknown) => SchemaParseResult },
  config: unknown,
) {
  const res = schema.safeParse(config);
  expect(res.success).toBe(true);
}

export function expectSchemaValidationIssue(params: {
  schema: { safeParse: (value: unknown) => SchemaParseResult };
  config: unknown;
  expectedPath: string;
  expectedMessage?: string;
}) {
  const res = params.schema.safeParse(params.config);
  expect(res.success).toBe(false);
  if (!res.success) {
    const issue = res.error.issues[0];
    expect(issue?.path.join(".")).toBe(params.expectedPath);
    if (params.expectedMessage !== undefined) {
      expect(issue?.message).toContain(params.expectedMessage);
    }
  }
}
