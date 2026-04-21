export function cloneConfigObject<T>(value: T): T {
  return structuredClone(value);
}

export function serializeConfigForm(form: Record<string, unknown>): string {
  return `${JSON.stringify(form, null, 2).trimEnd()}\n`;
}

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isForbiddenKey(key: string | number): boolean {
  return typeof key === "string" && FORBIDDEN_KEYS.has(key);
}

type PathContainer = {
  current: Record<string, unknown> | unknown[];
  lastKey: string | number;
};

function resolvePathContainer(
  obj: Record<string, unknown> | unknown[],
  path: Array<string | number>,
  createMissing: boolean,
): PathContainer | null {
  if (path.length === 0 || path.some(isForbiddenKey)) {
    return null;
  }

  let current: Record<string, unknown> | unknown[] = obj;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    const nextKey = path[i + 1];
    if (typeof key === "number") {
      if (!Array.isArray(current)) {
        return null;
      }
      if (current[key] == null) {
        if (!createMissing) {
          return null;
        }
        current[key] = typeof nextKey === "number" ? [] : ({} as Record<string, unknown>);
      }
      current = current[key] as Record<string, unknown> | unknown[];
      continue;
    }

    if (typeof current !== "object" || current == null) {
      return null;
    }
    const record = current as Record<string, unknown>;
    if (record[key] == null) {
      if (!createMissing) {
        return null;
      }
      record[key] = typeof nextKey === "number" ? [] : ({} as Record<string, unknown>);
    }
    current = record[key] as Record<string, unknown> | unknown[];
  }

  return {
    current,
    lastKey: path[path.length - 1],
  };
}

export function setPathValue(
  obj: Record<string, unknown> | unknown[],
  path: Array<string | number>,
  value: unknown,
) {
  const container = resolvePathContainer(obj, path, true);
  if (!container) {
    return;
  }

  if (typeof container.lastKey === "number") {
    if (Array.isArray(container.current)) {
      container.current[container.lastKey] = value;
    }
    return;
  }
  if (typeof container.current === "object" && container.current != null) {
    (container.current as Record<string, unknown>)[container.lastKey] = value;
  }
}

export function removePathValue(
  obj: Record<string, unknown> | unknown[],
  path: Array<string | number>,
) {
  const container = resolvePathContainer(obj, path, false);
  if (!container) {
    return;
  }

  if (typeof container.lastKey === "number") {
    if (Array.isArray(container.current)) {
      container.current.splice(container.lastKey, 1);
    }
    return;
  }
  if (typeof container.current === "object" && container.current != null) {
    delete (container.current as Record<string, unknown>)[container.lastKey];
  }
}
