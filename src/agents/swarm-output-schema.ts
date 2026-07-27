import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";

export function validateStructuredOutputSchema(
  schema: Record<string, unknown>,
): string | undefined {
  try {
    validateJsonSchemaValue({
      schema: schema as JsonSchemaObject,
      cacheKey: "swarm-output-schema-preflight",
      value: {},
      cache: false,
    });
    return undefined;
  } catch (error) {
    return `Invalid sessions_spawn outputSchema: ${error instanceof Error ? error.message : String(error)}`;
  }
}
