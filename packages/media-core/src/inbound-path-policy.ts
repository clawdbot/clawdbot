import path from "node:path";

const WILDCARD_SEGMENT = "*";
const WINDOWS_DRIVE_ABS_RE = /^[A-Za-z]:\//;
const WINDOWS_DRIVE_ROOT_RE = /^[A-Za-z]:$/;

function normalizePosixAbsolutePath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0")) {
    return undefined;
  }
  const normalized = path.posix.normalize(trimmed.replaceAll("\\", "/"));
  const isAbsolute = normalized.startsWith("/") || WINDOWS_DRIVE_ABS_RE.test(normalized);
  if (!isAbsolute || normalized === "/") {
    return undefined;
  }
  const withoutTrailingSlash = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  if (WINDOWS_DRIVE_ROOT_RE.test(withoutTrailingSlash)) {
    return undefined;
  }
  return withoutTrailingSlash;
}

function splitPathSegments(value: string): string[] {
  return value.split("/").filter(Boolean);
}

function matchesRootPattern(params: { candidatePath: string; rootPattern: string }): boolean {
  const candidateSegments = splitPathSegments(params.candidatePath);
  const rootSegments = splitPathSegments(params.rootPattern);
  if (candidateSegments.length < rootSegments.length) {
    return false;
  }
  for (let idx = 0; idx < rootSegments.length; idx += 1) {
    const expected = rootSegments[idx];
    const actual = candidateSegments[idx];
    if (expected === WILDCARD_SEGMENT) {
      continue;
    }
    if (expected !== actual) {
      return false;
    }
  }
  return true;
}

export function isValidInboundPathRootPattern(value: string): boolean {
  const normalized = normalizePosixAbsolutePath(value);
  if (!normalized) {
    return false;
  }
  const segments = splitPathSegments(normalized);
  if (segments.length === 0) {
    return false;
  }
  return segments.every((segment) => segment === WILDCARD_SEGMENT || !segment.includes("*"));
}

export function normalizeInboundPathRoots(roots?: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const root of roots ?? []) {
    if (typeof root !== "string") {
      continue;
    }
    if (!isValidInboundPathRootPattern(root)) {
      continue;
    }
    const candidate = normalizePosixAbsolutePath(root);
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    normalized.push(candidate);
  }
  return normalized;
}

export function mergeInboundPathRoots(
  ...rootsLists: Array<readonly string[] | undefined>
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const roots of rootsLists) {
    const normalized = normalizeInboundPathRoots(roots);
    for (const root of normalized) {
      if (seen.has(root)) {
        continue;
      }
      seen.add(root);
      merged.push(root);
    }
  }
  return merged;
}

export function isInboundPathAllowed(params: {
  filePath: string;
  roots: readonly string[];
  fallbackRoots?: readonly string[];
}): boolean {
  const candidatePath = normalizePosixAbsolutePath(params.filePath);
  if (!candidatePath) {
    return false;
  }
  const roots = normalizeInboundPathRoots(params.roots);
  const effectiveRoots =
    roots.length > 0 ? roots : normalizeInboundPathRoots(params.fallbackRoots ?? undefined);
  if (effectiveRoots.length === 0) {
    return false;
  }
  return effectiveRoots.some((rootPattern) => matchesRootPattern({ candidatePath, rootPattern }));
}
