/** Defensive object guard for values that may have hostile traps. */
export function isRecordWithoutThrowing(value: unknown): value is Record<string, unknown> {
  try {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  } catch {
    return false;
  }
}

/** Read one property from a record-like value without letting traps escape. */
export function readRecordValue(value: unknown, key: string): unknown {
  if (!isRecordWithoutThrowing(value)) {
    return undefined;
  }
  try {
    return value[key];
  } catch {
    return undefined;
  }
}

/** Copy array entries defensively from values that may throw on length/index access. */
export function copyArrayEntries(value: unknown): unknown[] {
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    return [];
  }
  if (!isArray) {
    return [];
  }

  const arrayValue = value as readonly unknown[];
  let length: number;
  try {
    length = arrayValue.length;
  } catch {
    return [];
  }

  const entries: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    try {
      entries.push(arrayValue[index]);
    } catch {
      continue;
    }
  }
  return entries;
}

/** Copy record entries whose values are also record-shaped. */
export function copyRecordEntries<T>(value: unknown): Array<[string, T]> {
  if (!isRecordWithoutThrowing(value)) {
    return [];
  }

  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return [];
  }

  const entries: Array<[string, T]> = [];
  for (const key of keys) {
    const entry = readRecordValue(value, key);
    // Callers use this for nested config maps; non-object leaves are ignored so
    // later code does not need repeated record guards.
    if (isRecordWithoutThrowing(entry)) {
      entries.push([key, entry as T]);
    }
  }
  return entries;
}
