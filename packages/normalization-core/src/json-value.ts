// Browser-safe validation and equality for acyclic JSON values.

export function isJsonValue(
  value: unknown,
  active = new WeakSet<object>(),
  complete = new WeakSet<object>(),
): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object") {
    return false;
  }
  let entries: unknown[];
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      if (
        ownKeys.length !== value.length + 1 ||
        ownKeys.some((key) => {
          if (key === "length") {
            return false;
          }
          if (typeof key !== "string") {
            return true;
          }
          const index = Number(key);
          return (
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= value.length ||
            String(index) !== key
          );
        })
      ) {
        return false;
      }
      entries = value;
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        return false;
      }
      const ownKeys = Reflect.ownKeys(value);
      if (
        ownKeys.some(
          (key) =>
            typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key),
        )
      ) {
        return false;
      }
      entries = Object.values(value);
    }
  } catch {
    return false;
  }
  if (complete.has(value)) {
    return true;
  }
  if (active.has(value)) {
    return false;
  }
  active.add(value);
  const valid = entries.every((entry) => isJsonValue(entry, active, complete));
  active.delete(value);
  if (valid) {
    complete.add(value);
  }
  return valid;
}

// Keep TypeBox's array-first comparison, including object-to-array equality,
// without importing its namespace-wide Guard barrel into browser startup.
function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left)) {
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((_, index) => jsonValuesEqual(left[index], right[index]))
    );
  }
  if (left !== null && typeof left === "object") {
    if (right === null || typeof right !== "object") {
      return false;
    }
    const keys = Object.getOwnPropertyNames(left);
    return (
      keys.length === Object.getOwnPropertyNames(right).length &&
      keys.every((key) => jsonValuesEqual(Reflect.get(left, key), Reflect.get(right, key)))
    );
  }
  return left === right;
}

/** Compare acyclic JSON values using the same equality semantics as TypeBox. */
export function jsonSchemaValuesEqual(left: unknown, right: unknown): boolean {
  if (!isJsonValue(left) || !isJsonValue(right)) {
    return false;
  }
  try {
    return jsonValuesEqual(left, right);
  } catch {
    return false;
  }
}
