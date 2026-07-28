import type { TSchema } from "typebox";

type ProtocolSchemaFragment = Readonly<Record<string, TSchema>>;
type UnionToIntersection<Value> = (Value extends unknown ? (value: Value) => void : never) extends (
  value: infer Intersection,
) => void
  ? Intersection
  : never;

/** Compose explicitly ordered owner fragments without replacing their schema objects. */
export function composeProtocolSchemaFragments<
  const Fragments extends readonly ProtocolSchemaFragment[],
>(fragments: Fragments): UnionToIntersection<Fragments[number]> {
  const registry: Record<string, TSchema> = {};
  for (const fragment of fragments) {
    for (const [key, schema] of Object.entries(fragment)) {
      if (Object.hasOwn(registry, key)) {
        throw new Error(`Duplicate protocol schema key: ${key}`);
      }
      registry[key] = schema;
    }
  }
  return registry as UnionToIntersection<Fragments[number]>;
}
