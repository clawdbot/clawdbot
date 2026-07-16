import fs from "node:fs";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

const NUL_MARKER_RE = /(?:\^@|\\0|\\x00|\\u0000|null\s*byte|nul\s*byte)/i;

export type ManagedQmdCollection = {
  name: string;
  path: string;
  pattern: string;
  kind: "memory" | "custom" | "sessions";
};

export type ListedQmdCollection = {
  path?: string;
  pattern?: string;
};

export function parseListedQmdCollections(output: string): Map<string, ListedQmdCollection> {
  const listed = new Map<string, ListedQmdCollection>();
  const trimmed = output.trim();
  if (!trimmed) {
    return listed;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (typeof entry === "string") {
          listed.set(entry, {});
          continue;
        }
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const name = (entry as { name?: unknown }).name;
        if (typeof name !== "string") {
          continue;
        }
        const listedPath = (entry as { path?: unknown }).path;
        const listedPattern = (entry as { pattern?: unknown }).pattern;
        const listedMask = (entry as { mask?: unknown }).mask;
        listed.set(name, {
          path: typeof listedPath === "string" ? listedPath : undefined,
          pattern:
            typeof listedPattern === "string"
              ? listedPattern
              : typeof listedMask === "string"
                ? listedMask
                : undefined,
        });
      }
      return listed;
    }
  } catch {
    // Some qmd builds ignore `--json` and still print table output.
  }

  let currentName: string | null = null;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      currentName = null;
      continue;
    }
    const collectionLine = /^\s*([a-z0-9._-]+)\s+\(qmd:\/\/[^)]+\)\s*$/i.exec(line);
    if (collectionLine) {
      currentName = collectionLine[1] ?? null;
      if (currentName && !listed.has(currentName)) {
        listed.set(currentName, {});
      }
      continue;
    }
    if (/^\s*collections\b/i.test(line)) {
      continue;
    }
    const bareNameLine = /^\s*([a-z0-9._-]+)\s*$/i.exec(line);
    if (bareNameLine && !line.includes(":")) {
      currentName = bareNameLine[1] ?? null;
      if (currentName && !listed.has(currentName)) {
        listed.set(currentName, {});
      }
      continue;
    }
    if (!currentName) {
      continue;
    }
    const patternLine = /^\s*(?:pattern|mask)\s*:\s*(.+?)\s*$/i.exec(line);
    if (patternLine?.[1] !== undefined) {
      const existing = listed.get(currentName) ?? {};
      existing.pattern = patternLine[1].trim();
      listed.set(currentName, existing);
      continue;
    }
    const pathLine = /^\s*path\s*:\s*(.+?)\s*$/i.exec(line);
    if (pathLine?.[1] !== undefined) {
      const existing = listed.get(currentName) ?? {};
      existing.path = pathLine[1].trim();
      listed.set(currentName, existing);
    }
  }
  return listed;
}

export function parseShownQmdCollection(output: string): { path?: string; pattern?: string } {
  const result: { path?: string; pattern?: string } = {};
  for (const rawLine of output.split(/\r?\n/)) {
    const pathMatch = /^\s*Path\s*:\s*(.+?)\s*$/.exec(rawLine);
    if (pathMatch?.[1] !== undefined) {
      result.path = pathMatch[1].trim();
      continue;
    }
    const patternMatch = /^\s*Pattern\s*:\s*(.+?)\s*$/.exec(rawLine);
    if (patternMatch?.[1] !== undefined) {
      result.pattern = patternMatch[1].trim();
    }
  }
  return result;
}

export function findQmdCollectionByPathPattern(params: {
  collection: ManagedQmdCollection;
  listed: Map<string, ListedQmdCollection>;
  workspaceDir: string;
}): string | null {
  for (const [name, details] of params.listed) {
    if (!details.path || typeof details.pattern !== "string") {
      continue;
    }
    if (
      qmdCollectionPathsMatch(details.path, params.collection.path, params.workspaceDir) &&
      qmdCollectionPatternsMatch(params.collection.path, details.pattern, params.collection.pattern)
    ) {
      return name;
    }
  }
  return null;
}

export function parseConflictingQmdCollectionName(message: string): string | null {
  if (
    !normalizeLowercaseStringOrEmpty(message).includes(
      "a collection already exists for this path and pattern",
    )
  ) {
    return null;
  }
  const match = /^\s*Name:\s*([a-z0-9._-]+)\s*\(qmd:\/\/[^)\s]+\/?\)\s*$/im.exec(message);
  return match?.[1] ?? null;
}

export function deriveLegacyQmdCollectionName(scopedName: string, agentId: string): string | null {
  const agentSuffix = `-${sanitizeQmdCollectionNameSegment(agentId)}`;
  if (!scopedName.endsWith(agentSuffix)) {
    return null;
  }
  const legacyName = scopedName.slice(0, -agentSuffix.length).trim();
  return legacyName || null;
}

export function canMigrateLegacyQmdCollection(params: {
  collection: ManagedQmdCollection;
  listed: ListedQmdCollection;
  workspaceDir: string;
}): boolean {
  if (
    params.listed.path &&
    !qmdCollectionPathsMatch(params.listed.path, params.collection.path, params.workspaceDir)
  ) {
    return false;
  }
  return !(
    typeof params.listed.pattern === "string" &&
    !qmdCollectionPatternsMatch(
      params.collection.path,
      params.listed.pattern,
      params.collection.pattern,
    )
  );
}

export function shouldRebindQmdCollection(params: {
  collection: ManagedQmdCollection;
  listed: ListedQmdCollection;
  workspaceDir: string;
}): boolean {
  if (!params.listed.path) {
    return (
      typeof params.listed.pattern === "string" &&
      params.listed.pattern !== params.collection.pattern
    );
  }
  if (!qmdCollectionPathsMatch(params.listed.path, params.collection.path, params.workspaceDir)) {
    return true;
  }
  return (
    typeof params.listed.pattern === "string" &&
    !qmdCollectionPatternsMatch(
      params.collection.path,
      params.listed.pattern,
      params.collection.pattern,
    )
  );
}

export function renderQmdCollectionIndexConfig(collections: ManagedQmdCollection[]): string {
  if (collections.length === 0) {
    return "collections: {}\n";
  }
  const lines = ["collections:"];
  for (const collection of collections) {
    lines.push(
      `  ${JSON.stringify(collection.name)}:`,
      `    path: ${JSON.stringify(collection.path)}`,
      `    pattern: ${JSON.stringify(collection.pattern)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function sanitizeQmdCollectionNameSegment(input: string): string {
  const lower = normalizeLowercaseStringOrEmpty(input).replace(/[^a-z0-9-]+/g, "-");
  const trimmed = lower.replace(/^-+|-+$/g, "");
  return trimmed || "agent";
}

export function isQmdCollectionAlreadyExistsError(message: string): boolean {
  return normalizeLowercaseStringOrEmpty(message).includes("exists");
}

export function isQmdCollectionMissingError(message: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(message);
  return (
    lower.includes("not found") || lower.includes("does not exist") || lower.includes("missing")
  );
}

export function isSameNameQmdCollectionAlreadyExistsError(name: string, message: string): boolean {
  const lowerName = normalizeLowercaseStringOrEmpty(name);
  const lowerMessage = normalizeLowercaseStringOrEmpty(message);
  return (
    lowerMessage.includes(`collection '${lowerName}' already exists`) ||
    lowerMessage.includes(`collection "${lowerName}" already exists`)
  );
}

export function shouldRepairNullByteQmdCollectionError(err: unknown): boolean {
  const message = formatErrorMessage(err);
  const lower = normalizeLowercaseStringOrEmpty(message);
  return (
    (lower.includes("enotdir") ||
      lower.includes("not a directory") ||
      lower.includes("enoent") ||
      lower.includes("no such file")) &&
    NUL_MARKER_RE.test(message)
  );
}

export function shouldRepairDuplicateQmdDocumentConstraint(err: unknown): boolean {
  const lower = normalizeLowercaseStringOrEmpty(formatErrorMessage(err));
  return (
    lower.includes("unique constraint failed") &&
    lower.includes("documents.collection") &&
    lower.includes("documents.path")
  );
}

function qmdCollectionPatternsMatch(
  collectionPath: string,
  leftPattern: string,
  rightPattern: string,
): boolean {
  if (leftPattern === rightPattern) {
    return true;
  }
  if (leftPattern !== "MEMORY.md" || rightPattern !== "MEMORY.md") {
    return false;
  }
  try {
    return fs
      .readdirSync(collectionPath, { withFileTypes: true })
      .some((entry) => !entry.isSymbolicLink() && entry.isFile() && entry.name === "MEMORY.md");
  } catch {
    return false;
  }
}

function qmdCollectionPathsMatch(left: string, right: string, workspaceDir: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.isAbsolute(value)
      ? path.resolve(value)
      : path.resolve(workspaceDir, value);
    const normalized = path.normalize(resolved);
    return process.platform === "win32" ? normalizeLowercaseStringOrEmpty(normalized) : normalized;
  };
  return normalize(left) === normalize(right);
}
