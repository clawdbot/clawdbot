// Keys blocked from object writes to avoid prototype pollution at untrusted
// object boundaries.
const BLOCKED_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Return true when assigning `key` could mutate an object prototype. */
export function isBlockedObjectKey(key: string): boolean {
  return BLOCKED_OBJECT_KEYS.has(key);
}
