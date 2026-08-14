import type { MemoryOperation } from "./authorization.js";

/** Operations implied by each conformance action. Keep fixtures and evaluation in lockstep. */
export const MEMORY_AUTHORIZATION_OPERATION_REQUIREMENTS = {
  retrieve: ["retrieve"],
  read: ["retrieve", "read"],
  append: ["append"],
  replace: ["append", "replace"],
  derive: ["retrieve", "read", "derive"],
  deposit: ["deposit"],
  project: ["project"],
  publish: ["publish"],
  import: ["import"],
  export: ["export"],
  delete: ["delete"],
  sync: ["sync"],
  status: ["status"],
  "policy-admin": ["policy-admin"],
} as const satisfies Readonly<Record<MemoryOperation, readonly MemoryOperation[]>>;
