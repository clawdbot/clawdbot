import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export function scopedPolicyValue(
  overlay: Record<string, unknown>,
  path: readonly string[],
): unknown {
  const [root, ...remainingPath] = path;
  if (!root) {
    return undefined;
  }
  const scopedRoot = root === "agents" ? overlay.agents : overlay[root];
  return getPolicyPath(scopedRoot, remainingPath);
}

export function getPolicyPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}
