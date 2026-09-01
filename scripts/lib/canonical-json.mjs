const ASCII_JSON_PATTERN = /^[\x20-\x7e]+\n$/u;
const compareAscii = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function fail(message) {
  throw new Error(message);
}

function canonicalPath(parent, key) {
  return `${parent}[${JSON.stringify(key)}]`;
}

export function canonicalizeJsonValue(value, path = "$", ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail(`canonical JSON number at ${path} must be finite`);
    }
    if (Object.is(value, -0)) {
      fail(`canonical JSON number at ${path} must not be negative zero`);
    }
    return value;
  }
  if (typeof value !== "object") {
    fail(`canonical JSON contains unsupported ${typeof value} at ${path}`);
  }
  if (ancestors.has(value)) {
    fail(`canonical JSON must not contain cycles at ${path}`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value).filter((key) => key !== "length");
      if (
        keys.length !== value.length ||
        keys.some((key, index) => typeof key !== "string" || key !== String(index))
      ) {
        fail(`canonical JSON array at ${path} must be dense and contain no extra properties`);
      }
      return keys.map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          fail(`canonical JSON array at ${path} must contain enumerable data properties only`);
        }
        return canonicalizeJsonValue(descriptor.value, canonicalPath(path, key), ancestors);
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(`canonical JSON object at ${path} must be plain`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      fail(`canonical JSON object at ${path} must use string keys only`);
    }
    return Object.fromEntries(
      keys.toSorted(compareAscii).map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          fail(`canonical JSON object at ${path} must contain enumerable data properties only`);
        }
        return [key, canonicalizeJsonValue(descriptor.value, canonicalPath(path, key), ancestors)];
      }),
    );
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalAsciiJson(value) {
  const json = `${JSON.stringify(canonicalizeJsonValue(value))}\n`;
  if (!ASCII_JSON_PATTERN.test(json)) {
    fail("canonical JSON must be printable ASCII with exactly one trailing newline");
  }
  return json;
}
