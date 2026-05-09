import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const allowedRuntimeResolverRefs = new Set([
  "src/commands/doctor.e2e-harness.ts",
  "src/infra/outbound/channel-bootstrap.runtime.ts",
  "src/plugins/capability-provider-runtime.ts",
  "src/plugins/loader.ts",
]);

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") {
      continue;
    }
    const path = resolve(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...listSourceFiles(path));
      continue;
    }
    if (!path.endsWith(".ts") || path.endsWith(".test.ts") || path.endsWith(".test.tsx")) {
      continue;
    }
    files.push(path);
  }
  return files;
}

describe("runtime plugin registry boundary", () => {
  it("keeps runtime registry resolution behind the loader boundary", () => {
    const offenders = listSourceFiles(resolve(repoRoot, "src"))
      .map((path) => ({
        path,
        relativePath: relative(repoRoot, path),
        source: readFileSync(path, "utf8"),
      }))
      .filter(
        (file) =>
          !allowedRuntimeResolverRefs.has(file.relativePath) &&
          file.source.includes("resolveRuntimePluginRegistry"),
      )
      .map((file) => file.relativePath);

    expect(offenders).toStrictEqual([]);
  });
});
