// Vitest bundled config wires the bundled test shard.
import path from "node:path";
import {
  bundledPluginDependentUnitTestFiles,
  unitTestAdditionalExcludePatterns,
} from "./vitest.unit-paths.mjs";
import { createUnitVitestConfigWithOptions } from "./vitest.unit.config.ts";

function normalizeGlobCandidate(value: string): string {
  return value.split(path.sep).join("/");
}

function excludePatternCouldMatchFile(pattern: string, file: string): boolean {
  const normalizedPattern = normalizeGlobCandidate(pattern);
  const normalizedFile = normalizeGlobCandidate(file);
  if (normalizedPattern === normalizedFile) {
    return true;
  }
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    return normalizedFile === prefix || normalizedFile.startsWith(`${prefix}/`);
  }
  return path.matchesGlob(normalizedFile, normalizedPattern);
}

const bundledUnitExcludePatterns = unitTestAdditionalExcludePatterns.filter(
  (pattern) =>
    !bundledPluginDependentUnitTestFiles.some((file) =>
      excludePatternCouldMatchFile(pattern, file),
    ),
);

export function createBundledVitestConfig(env: Record<string, string | undefined> = process.env) {
  return createUnitVitestConfigWithOptions(env, {
    includePatterns: bundledPluginDependentUnitTestFiles,
    extraExcludePatterns: bundledUnitExcludePatterns,
    name: "bundled",
  });
}

export default createBundledVitestConfig();
