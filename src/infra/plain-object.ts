/**
 * Config merge/patch accepts only `[object Object]` values, excluding Date/Map/Set/class instances.
 * The stricter prototype contract prevents host objects from being merged as authored config.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}
