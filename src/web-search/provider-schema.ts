import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { WebSearchProviderModelSchema } from "./provider-model-schema.js";

function resolveSchemaProperty(schema: unknown, propertyName: string): unknown {
  const properties = asOptionalRecord(asOptionalRecord(schema)?.properties);
  if (!properties || !Object.hasOwn(properties, propertyName)) {
    return undefined;
  }
  return properties[propertyName];
}

/** Reports whether a provider tool schema explicitly declares a property. */
export function schemaDeclaresProperty(schema: unknown, propertyName: string): boolean {
  return resolveSchemaProperty(schema, propertyName) !== undefined;
}

function resolveRequiredProperties(schema: unknown): readonly string[] {
  const required = asOptionalRecord(schema)?.required;
  return Array.isArray(required)
    ? required.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** Projects provider-owned properties and their required status into a shared tool schema. */
export function projectProviderModelSchema(
  baseSchema: Record<string, unknown>,
  providerSchema: WebSearchProviderModelSchema | null,
): Record<string, unknown> {
  if (!providerSchema) {
    return baseSchema;
  }
  const properties = { ...asOptionalRecord(baseSchema.properties) };
  const projectedRequired = new Set(resolveRequiredProperties(baseSchema));
  const providerRequired = new Set(resolveRequiredProperties(providerSchema.parameters));
  for (const parameter of providerSchema.providerParameters) {
    if (Object.hasOwn(properties, parameter)) {
      continue;
    }
    const propertySchema = resolveSchemaProperty(providerSchema.parameters, parameter);
    if (propertySchema === undefined) {
      continue;
    }
    properties[parameter] = propertySchema;
    if (providerRequired.has(parameter)) {
      projectedRequired.add(parameter);
    }
  }
  return {
    ...baseSchema,
    properties,
    required: [...projectedRequired],
  };
}
