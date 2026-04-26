export function jsonUtf8Bytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Buffer.byteLength(String(value), "utf8");
  }
}

export type BoundedJsonUtf8Bytes = {
  bytes: number;
  complete: boolean;
};

export function jsonUtf8BytesOrInfinity(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string"
      ? Buffer.byteLength(serialized, "utf8")
      : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function jsonStringByteLengthUpToLimit(value: string, remainingBytes: number): number {
  if (value.length + 2 > remainingBytes) {
    return remainingBytes + 1;
  }
  return jsonUtf8BytesOrInfinity(value);
}

function* enumerableOwnEntries(value: object): Generator<[string, unknown]> {
  const record = value as Record<string, unknown>;
  for (const key in record) {
    if (Object.prototype.propertyIsEnumerable.call(record, key)) {
      yield [key, record[key]];
    }
  }
}

export function firstEnumerableOwnKeys(value: object, maxKeys: number): string[] {
  const keys: string[] = [];
  for (const key in value as Record<string, unknown>) {
    if (!Object.prototype.propertyIsEnumerable.call(value, key)) {
      continue;
    }
    keys.push(key);
    if (keys.length >= maxKeys) {
      break;
    }
  }
  return keys;
}

export function boundedJsonUtf8Bytes(value: unknown, maxBytes: number): BoundedJsonUtf8Bytes {
  let bytes = 0;
  const seen = new WeakSet<object>();

  const add = (amount: number): void => {
    bytes += amount;
    if (bytes > maxBytes) {
      throw new Error("json_byte_limit_exceeded");
    }
  };

  const visit = (entry: unknown, inArray: boolean): void => {
    if (entry === null) {
      add(4);
      return;
    }
    switch (typeof entry) {
      case "string":
        add(jsonStringByteLengthUpToLimit(entry, maxBytes - bytes));
        return;
      case "number":
        add(jsonUtf8BytesOrInfinity(Number.isFinite(entry) ? entry : null));
        return;
      case "boolean":
        add(entry ? 4 : 5);
        return;
      case "undefined":
      case "function":
      case "symbol":
        if (inArray) {
          add(4);
        }
        return;
      case "bigint":
        throw new Error("json_byte_length_unsupported");
      case "object":
        break;
    }

    const objectEntry = entry as object;
    if (seen.has(objectEntry)) {
      throw new Error("json_byte_length_circular");
    }
    if (
      typeof (objectEntry as { toJSON?: unknown }).toJSON === "function" &&
      !(objectEntry instanceof Date)
    ) {
      throw new Error("json_byte_length_custom_to_json");
    }
    seen.add(objectEntry);
    try {
      if (objectEntry instanceof Date) {
        visit(objectEntry.toJSON(), inArray);
        return;
      }
      if (Array.isArray(objectEntry)) {
        add(1);
        for (let index = 0; index < objectEntry.length; index += 1) {
          if (index > 0) {
            add(1);
          }
          visit(objectEntry[index], true);
        }
        add(1);
        return;
      }

      add(1);
      let wroteField = false;
      for (const [key, field] of enumerableOwnEntries(objectEntry)) {
        if (field === undefined || typeof field === "function" || typeof field === "symbol") {
          continue;
        }
        if (wroteField) {
          add(1);
        }
        wroteField = true;
        add(jsonStringByteLengthUpToLimit(key, maxBytes - bytes));
        add(1);
        visit(field, false);
      }
      add(1);
    } finally {
      seen.delete(objectEntry);
    }
  };

  try {
    visit(value, false);
    return { bytes, complete: true };
  } catch {
    return { bytes: Math.max(bytes, maxBytes + 1), complete: false };
  }
}
