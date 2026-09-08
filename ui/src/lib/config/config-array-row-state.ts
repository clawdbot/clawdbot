// Array-row metadata follows config clones without loading form renderers.
import { isRecord } from "@openclaw/normalization-core/record-coerce";

type ConfigArrayRowState = {
  identities: readonly unknown[];
  preserve: (target: unknown[], visit: (previous: unknown, next: unknown) => void) => void;
};

// Rendered arrays install their correspondence policy with their tokens. Clones
// carry that prepared behavior without loading validation during UI startup.
export const configArrayRowStates = new WeakMap<unknown[], ConfigArrayRowState>();

export function preserveConfigArrayRowIdentities(previous: unknown, next: unknown): void {
  const pairs: Array<[unknown, unknown]> = [[previous, next]];
  const visited = new WeakSet<object>();
  for (const [source, target] of pairs) {
    if (!target || typeof target !== "object" || visited.has(target)) {
      continue;
    }
    visited.add(target);
    if (Array.isArray(source) && Array.isArray(target)) {
      configArrayRowStates.get(source)?.preserve(target, (previousValue, nextValue) => {
        pairs.push([previousValue, nextValue]);
      });
    } else if (isRecord(source) && isRecord(target)) {
      for (const key of Object.keys(target)) {
        if (Object.hasOwn(source, key)) {
          pairs.push([source[key], target[key]]);
        }
      }
    }
  }
}
