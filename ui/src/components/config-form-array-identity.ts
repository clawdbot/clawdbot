// Control UI helpers preserve repeated-row draft ownership across array edits.
import { jsonSchemaValuesEqual } from "@openclaw/normalization-core/json-value";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

const arrayRowIdentities = new WeakMap<unknown[], readonly unknown[]>();

function primitiveRowIdentity(value: unknown, occurrence: number): string {
  const normalized =
    typeof value === "number" && Object.is(value, -0)
      ? "-0"
      : typeof value === "number" && Number.isNaN(value)
        ? "NaN"
        : String(value);
  return `${typeof value}:${normalized}:${occurrence}`;
}

export function rowIdentitiesForArray(value: unknown[]): readonly unknown[] {
  const existing = arrayRowIdentities.get(value);
  if (existing?.length === value.length) {
    return existing;
  }
  const occurrences = new Map<string, number>();
  const created = value.map((entry) => {
    if (entry && typeof entry === "object") {
      return entry;
    }
    const base = primitiveRowIdentity(entry, 0);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return primitiveRowIdentity(entry, occurrence);
  });
  arrayRowIdentities.set(value, created);
  return created;
}

export function preserveArrayRowIdentities(
  nextValue: unknown[],
  identities: readonly unknown[],
): void {
  arrayRowIdentities.set(nextValue, identities);
}

export function discardArrayRowIdentities(value: unknown[]): void {
  arrayRowIdentities.delete(value);
}

export function appendArrayRowIdentities(
  nextValue: unknown[],
  identities: readonly unknown[],
  count: number,
): void {
  // Appended rows need fresh tokens even when their values equal preserved rows.
  // Re-deriving occurrence labels can duplicate a survivor's token after removal.
  const appended = Array.from({ length: count }, () => Symbol("array-row"));
  preserveArrayRowIdentities(nextValue, [...identities, ...appended]);
}

export function preserveConfigArrayRowIdentities(previous: unknown, next: unknown): void {
  const pairs: Array<[unknown, unknown]> = [[previous, next]];
  const visited = new WeakSet<object>();
  for (const [source, target] of pairs) {
    if (!target || typeof target !== "object" || visited.has(target)) {
      continue;
    }
    visited.add(target);
    if (Array.isArray(source) && Array.isArray(target)) {
      const identities = arrayRowIdentities.get(source);
      // Refreshes replace objects, not logical rows. The canonical comparator
      // is asymmetric; correspondence needs both directions. Local edits
      // carry explicit survivor tokens instead.
      if (
        identities?.length !== source.length ||
        !jsonSchemaValuesEqual(source, target) ||
        !jsonSchemaValuesEqual(target, source)
      ) {
        continue;
      }
      preserveArrayRowIdentities(target, identities);
      target.forEach((value, index) => pairs.push([source[index], value]));
    } else if (isRecord(source) && isRecord(target)) {
      for (const key of Object.keys(target)) {
        if (Object.hasOwn(source, key)) {
          pairs.push([source[key], target[key]]);
        }
      }
    }
  }
}
