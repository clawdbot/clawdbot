// Update CLI test helpers provide shared fixtures and path helpers for update tests.
import path from "node:path";

function isPathInsideRoot(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isOwningNpmCommand(value: unknown, owningPrefix: string): boolean {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    return false;
  }
  const normalized = path.normalize(value);
  return (
    normalized !== path.normalize("npm") &&
    isPathInsideRoot(normalized, owningPrefix) &&
    /npm(?:\.cmd)?$/i.test(normalized)
  );
}
