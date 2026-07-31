import { expectDefined as expectDefinedCore } from "../../packages/normalization-core/src/expect.js";

// Keep the public declaration local so sibling normalization helpers stay private.
export function expectDefined<T>(value: T | null | undefined, context: string): T {
  return expectDefinedCore(value, context);
}
