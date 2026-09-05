export function hasExactOwnKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    optional.every((key) => Object.hasOwn(value, key) || !Reflect.has(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}
