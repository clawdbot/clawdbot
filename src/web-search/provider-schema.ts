import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

/** Returns a top-level property explicitly declared by a provider tool schema. */
export function resolveSchemaProperty(schema: unknown, propertyName: string): unknown {
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
