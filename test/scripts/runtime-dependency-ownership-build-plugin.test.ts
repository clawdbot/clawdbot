import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectRuntimeDependencyOwnership } from "../../scripts/lib/runtime-dependency-ownership-build-plugin.mts";

type ModuleFixture = {
  dynamicallyImportedIds?: string[];
  importedIds?: string[];
  isEntry?: boolean;
  isExternal?: boolean;
};

function collect(modules: Record<string, ModuleFixture>) {
  const rootDir = path.resolve("/repo");
  return collectRuntimeDependencyOwnership({
    rootDir,
    includedModuleIds: new Set(
      Object.entries(modules)
        .filter(([, info]) => !info.isExternal)
        .map(([id]) => id),
    ),
    getModuleInfo: (id) => {
      const info = modules[id];
      return info
        ? {
            id,
            importedIds: info.importedIds ?? [],
            dynamicallyImportedIds: info.dynamicallyImportedIds ?? [],
            isEntry: info.isEntry ?? false,
            isExternal: info.isExternal ?? false,
          }
        : null;
    },
  });
}

describe("runtime dependency ownership build contract", () => {
  it("does not authorize dependencies reachable from a root entry", () => {
    const shared = path.resolve("/repo/src/shared.ts");
    const external = "@example/runtime/subpath";
    expect(
      collect({
        [path.resolve("/repo/src/entry.ts")]: { isEntry: true, importedIds: [shared] },
        [path.resolve("/repo/extensions/discord/index.ts")]: {
          isEntry: true,
          importedIds: [shared],
        },
        [shared]: { importedIds: [external] },
        [external]: { isExternal: true },
      }),
    ).toEqual({ formatVersion: 1, dependencies: {} });
  });

  it("records extension-only static and dynamic imports without parsing emitted JavaScript", () => {
    const dynamic = path.resolve("/repo/extensions/matrix/dynamic.ts");
    expect(
      collect({
        [path.resolve("/repo/extensions/matrix/index.ts")]: {
          isEntry: true,
          importedIds: ["matrix-js-sdk"],
          dynamicallyImportedIds: [dynamic],
        },
        [dynamic]: { importedIds: ["link-preview-js"] },
        "matrix-js-sdk": { isExternal: true },
        "link-preview-js": { isExternal: true },
      }),
    ).toEqual({
      formatVersion: 1,
      dependencies: {
        "link-preview-js": { root: false, extensions: ["matrix"] },
        "matrix-js-sdk": { root: false, extensions: ["matrix"] },
      },
    });
  });

  it("omits Node builtins from the package ownership contract", () => {
    expect(
      collect({
        [path.resolve("/repo/src/entry.ts")]: {
          isEntry: true,
          importedIds: ["node:fs", "path"],
        },
        "node:fs": { isExternal: true },
        path: { isExternal: true },
      }),
    ).toEqual({ formatVersion: 1, dependencies: {} });
  });
});
