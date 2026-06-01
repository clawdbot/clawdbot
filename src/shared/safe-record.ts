export function isRecord(value: unknown): value is Record<string, unknown> {
  try {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  } catch {
    return false;
  }
}

export function readRecordValue(value: unknown, key: string): unknown {
  if (!isRecord(value)) {
    return undefined;
  }
  try {
    return value[key];
  } catch {
    return undefined;
  }
}

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

export function copyRecordEntries<T>(value: unknown): Array<[string, T]> {
  if (!isRecord(value)) {
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
    if (isRecord(entry)) {
      entries.push([key, entry as T]);
    }
  }
  return entries;
}
