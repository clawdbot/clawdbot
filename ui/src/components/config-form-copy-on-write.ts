const INVALID_PATH_PATCH = Symbol("invalid-path-patch");

type PathPatchResult =
  | { ok: true; value: unknown }
  | { ok: false; value: typeof INVALID_PATH_PATCH };

function patchPathValue(
  current: unknown,
  path: Array<string | number>,
  index: number,
  replacement: unknown,
): PathPatchResult {
  const segment = path[index];
  if (segment === undefined) {
    return { ok: false, value: INVALID_PATH_PATCH };
  }
  const last = index === path.length - 1;

  if (typeof segment === "number") {
    if (current != null && !Array.isArray(current)) {
      return { ok: false, value: INVALID_PATH_PATCH };
    }
    const next = Array.isArray(current) ? [...current] : [];
    if (last) {
      if (replacement === undefined) {
        next.splice(segment, 1);
      } else {
        next[segment] = replacement;
      }
      return { ok: true, value: next };
    }
    const child = patchPathValue(next[segment], path, index + 1, replacement);
    if (!child.ok) {
      return child;
    }
    next[segment] = child.value;
    return { ok: true, value: next };
  }

  if (current != null && (typeof current !== "object" || Array.isArray(current))) {
    return { ok: false, value: INVALID_PATH_PATCH };
  }
  const next = current ? { ...(current as Record<string, unknown>) } : {};
  if (last) {
    if (replacement === undefined) {
      delete next[segment];
    } else {
      Object.defineProperty(next, segment, {
        value: replacement,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return { ok: true, value: next };
  }
  const child = patchPathValue(
    Object.hasOwn(next, segment) ? next[segment] : undefined,
    path,
    index + 1,
    replacement,
  );
  if (!child.ok) {
    return child;
  }
  Object.defineProperty(next, segment, {
    value: child.value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return { ok: true, value: next };
}

export function copyWithPathPatch(
  current: unknown,
  path: Array<string | number>,
  replacement: unknown,
): PathPatchResult {
  if (path.length === 0) {
    return { ok: true, value: replacement };
  }
  return patchPathValue(current, path, 0, replacement);
}
