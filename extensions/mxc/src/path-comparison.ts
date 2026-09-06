import path from "node:path";

// MXC path identity is lexical. Preserve extended/UNC prefixes and avoid realpath;
// collapsing aliases changes mount dedupe and same-root policy decisions.
export function normalizeMxcPathForComparison(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
