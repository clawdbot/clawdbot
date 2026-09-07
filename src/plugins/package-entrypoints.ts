// Standalone build scripts load this before workspace packages are available.
import path from "node:path";

/** True when a package entrypoint needs built JavaScript candidates. */
export function isTypeScriptPackageEntry(entryPath: string): boolean {
  return [".ts", ".tsx", ".mts", ".cts"].includes(path.extname(entryPath).toLowerCase());
}

/** Lists built runtime entry candidates for a TypeScript package entrypoint. */
export function listBuiltRuntimeEntryCandidates(entryPath: string): string[] {
  if (!isTypeScriptPackageEntry(entryPath)) {
    return [];
  }
  const normalized = entryPath.replace(/\\/g, "/");
  const withoutExtension = normalized.replace(/\.[^.]+$/u, "");
  const normalizedRelative = withoutExtension.replace(/^\.\//u, "");
  const distWithoutExtension = normalizedRelative.startsWith("src/")
    ? `./dist/${normalizedRelative.slice("src/".length)}`
    : `./dist/${normalizedRelative}`;
  const sourceExtension = path.extname(normalized).toLowerCase();
  // TypeScript preserves module format for .mts/.cts, and rootDir can retain src/ in dist/.
  const outputExtensions =
    sourceExtension === ".mts"
      ? [".mjs", ".js", ".cjs"]
      : sourceExtension === ".cts"
        ? [".cjs", ".js", ".mjs"]
        : [".js", ".mjs", ".cjs"];
  // Dist/source bases and JS suffixes form unique candidates, never the TS source.
  return [
    distWithoutExtension,
    ...(normalizedRelative.startsWith("src/") ? [`./dist/${normalizedRelative}`] : []),
    withoutExtension,
  ].flatMap((basePath) => outputExtensions.map((extension) => `${basePath}${extension}`));
}
