// Resolves package entrypoints for installed and bundled plugins.
import path from "node:path";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";

/** True when a package entrypoint needs built JavaScript candidates. */
export function isTypeScriptPackageEntry(entryPath: string): boolean {
  return [".ts", ".mts", ".cts"].includes(path.extname(entryPath).toLowerCase());
}

/** Lists built runtime entry candidates for a TypeScript package entrypoint. */
export function listBuiltRuntimeEntryCandidates(entryPath: string): string[] {
  if (!isTypeScriptPackageEntry(entryPath)) {
    return [];
  }
  const normalized = entryPath.replace(/\\/g, "/");
  const withoutExtension = normalized.replace(/\.[^.]+$/u, "");
  const normalizedRelative = normalized.replace(/^\.\//u, "");
  const distWithoutExtension = normalizedRelative.startsWith("src/")
    ? `./dist/${normalizedRelative.slice("src/".length).replace(/\.[^.]+$/u, "")}`
    : `./dist/${withoutExtension.replace(/^\.\//u, "")}`;
  const withJavaScriptExtensions = (basePath: string) => [
    `${basePath}.js`,
    `${basePath}.mjs`,
    `${basePath}.cjs`,
  ];
  const candidates = [
    ...withJavaScriptExtensions(distWithoutExtension),
    ...withJavaScriptExtensions(withoutExtension),
  ];
  return uniqueStrings(candidates).filter((candidate) => candidate !== normalized);
}
