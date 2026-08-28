import { schemaType, type JsonSchema } from "../lib/config-form-utils.ts";

export function collectAllOfSchemas(schema: JsonSchema): JsonSchema[] {
  const result: JsonSchema[] = [];
  const pending = [schema];
  const seen = new Set<JsonSchema>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);
    result.push(current);
    for (let index = (current.allOf?.length ?? 0) - 1; index >= 0; index -= 1) {
      const entry = current.allOf?.[index];
      if (entry) {
        pending.push(entry);
      }
    }
  }
  return result;
}

export function combinedSchema(candidates: JsonSchema[]): JsonSchema | undefined {
  const base = candidates.find((candidate) => schemaType(candidate) !== undefined) ?? candidates[0];
  return !base || candidates.length === 1
    ? base
    : {
        ...base,
        allOf: [...(base.allOf ?? []), ...candidates.filter((candidate) => candidate !== base)],
      };
}

export function arrayItemSchema(schema: JsonSchema, index: number): JsonSchema | undefined {
  const candidates: JsonSchema[] = [];
  for (const entry of collectAllOfSchemas(schema)) {
    if (Array.isArray(entry.items)) {
      const item =
        entry.items[index] ??
        (entry.additionalItems && typeof entry.additionalItems === "object"
          ? entry.additionalItems
          : undefined);
      if (item) {
        candidates.push(item);
      }
    } else if (entry.items) {
      candidates.push(entry.items);
    }
  }
  return combinedSchema(candidates);
}

export function arrayItemSchemaIndexes(schema: JsonSchema): number[] {
  let count = 0;
  let closedLength: number | undefined;
  for (const entry of collectAllOfSchemas(schema)) {
    if (Array.isArray(entry.items)) {
      const hasTypedTail =
        entry.additionalItems !== null && typeof entry.additionalItems === "object";
      count = Math.max(count, entry.items.length + (hasTypedTail ? 1 : 0));
      if (entry.additionalItems === false) {
        closedLength = Math.min(closedLength ?? Number.POSITIVE_INFINITY, entry.items.length);
      }
    } else if (entry.items) {
      count = Math.max(count, 1);
    }
  }
  if (closedLength !== undefined) {
    count = Math.min(count, closedLength);
  }
  return Array.from({ length: count }, (_, index) => index);
}
