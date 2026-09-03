// Control UI helpers create repeated-row identities for array renderers.
import { jsonSchemaValuesEqual } from "@openclaw/normalization-core/json-value";
import { configArrayRowStates } from "../lib/config/config-array-row-state.ts";

export function rowIdentitiesForArray(value: unknown[]): readonly unknown[] {
  const existing = configArrayRowStates.get(value)?.identities;
  if (existing?.length === value.length) {
    return existing;
  }
  const created = Array.from(value, () => Symbol("array-row"));
  preserveArrayRowIdentities(value, created);
  return created;
}

export function preserveArrayRowIdentities(value: unknown[], identities: readonly unknown[]): void {
  configArrayRowStates.set(value, {
    identities,
    preserve(target, visit) {
      // Snapshots preserve unchanged corresponding rows; length changes do not
      // prove correspondence. Local edits carry explicit survivor tokens instead.
      if (identities.length !== value.length || value.length !== target.length) {
        return;
      }
      preserveArrayRowIdentities(
        target,
        target.map((nextValue, index) => {
          const previousValue = value[index];
          // The canonical comparator is asymmetric, so check both directions.
          if (
            !jsonSchemaValuesEqual(previousValue, nextValue) ||
            !jsonSchemaValuesEqual(nextValue, previousValue)
          ) {
            return Symbol("array-row");
          }
          visit(previousValue, nextValue);
          return identities[index];
        }),
      );
    },
  });
}

export function discardArrayRowIdentities(value: unknown[]): void {
  configArrayRowStates.delete(value);
}

export function appendArrayRowIdentities(
  nextValue: unknown[],
  identities: readonly unknown[],
  count: number,
): void {
  // Appending an equal value must not reuse a removed row's identity.
  const appended = Array.from({ length: count }, () => Symbol("array-row"));
  preserveArrayRowIdentities(nextValue, [...identities, ...appended]);
}
