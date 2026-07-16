import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLanceDbDependencySpec } from "./lancedb-runtime.js";

function mapReader(
  entries: ReadonlyArray<[string, { dependencies?: Record<string, string> } | null]>,
): (manifestPath: string) => { dependencies?: Record<string, string> } | null {
  const byPath = new Map(
    entries.map(([manifestPath, value]) => [path.normalize(manifestPath), value]),
  );
  return (manifestPath: string) => byPath.get(path.normalize(manifestPath)) ?? null;
}

describe("resolveLanceDbDependencySpec", () => {
  it("reads dependency from source-layout sibling manifest", () => {
    const modulePath = path.join("/repo/extensions/memory-lancedb", "lancedb-runtime.js");
    const packagePath = path.join("/repo/extensions/memory-lancedb", "package.json");
    const readPackageJson = mapReader([
      [
        packagePath,
        {
          dependencies: { "@lancedb/lancedb": "^0.27.1" },
        },
      ],
    ]);

    expect(resolveLanceDbDependencySpec(modulePath, readPackageJson)).toBe("^0.27.1");
  });

  it("falls back to dist/extensions memory-lancedb manifest for flattened bundles", () => {
    const modulePath = path.join(
      "/usr/lib/node_modules/openclaw/dist",
      "lancedb-runtime-3m75WU-W.js",
    );
    const distPackagePath = path.join("/usr/lib/node_modules/openclaw/dist", "package.json");
    const extensionPackagePath = path.join(
      "/usr/lib/node_modules/openclaw/dist/extensions/memory-lancedb",
      "package.json",
    );
    const readPackageJson = mapReader([
      [distPackagePath, { dependencies: {} }],
      [
        extensionPackagePath,
        {
          dependencies: { "@lancedb/lancedb": "^0.27.1" },
        },
      ],
    ]);

    expect(resolveLanceDbDependencySpec(modulePath, readPackageJson)).toBe("^0.27.1");
  });

  it("walks parent directories to support nested dist chunk paths", () => {
    const modulePath = path.join(
      "/usr/lib/node_modules/openclaw/dist/chunks/runtime",
      "lancedb-runtime-3m75WU-W.js",
    );
    const extensionPackagePath = path.join(
      "/usr/lib/node_modules/openclaw/dist/extensions/memory-lancedb",
      "package.json",
    );
    const readPackageJson = mapReader([
      [
        extensionPackagePath,
        {
          dependencies: { "@lancedb/lancedb": "0.27.2" },
        },
      ],
    ]);

    expect(resolveLanceDbDependencySpec(modulePath, readPackageJson)).toBe("0.27.2");
  });

  it("throws when no candidate package manifest declares @lancedb/lancedb", () => {
    const modulePath = path.join(
      "/usr/lib/node_modules/openclaw/dist",
      "lancedb-runtime-3m75WU-W.js",
    );
    const readPackageJson = mapReader([
      [path.join("/usr/lib/node_modules/openclaw/dist", "package.json"), null],
    ]);

    expect(() => resolveLanceDbDependencySpec(modulePath, readPackageJson)).toThrow(
      'memory-lancedb package.json is missing "@lancedb/lancedb"',
    );
  });
});
