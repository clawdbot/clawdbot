/** Classifies runtime executable paths for daemon command rendering. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

const NODE_VERSIONED_PATTERN = /^node(?:-\d+|\d+)(?:\.\d+)*(?:\.exe)?$/;

function normalizeRuntimeBasename(execPath: string): string {
  const trimmed = execPath.trim().replace(/^["']|["']$/g, "");
  const lastSlash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const basename = lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
  return normalizeLowercaseStringOrEmpty(basename);
}

/** Returns whether an executable path names a Node runtime binary. */
export function isNodeRuntime(execPath: string): boolean {
  const base = normalizeRuntimeBasename(execPath);
  return (
    base === "node" ||
    base === "node.exe" ||
    base === "nodejs" ||
    base === "nodejs.exe" ||
    NODE_VERSIONED_PATTERN.test(base)
  );
}

/** Returns whether an executable path names a Bun runtime binary. */
export function isBunRuntime(execPath: string): boolean {
  const base = normalizeRuntimeBasename(execPath);
  return base === "bun" || base === "bun.exe";
}
