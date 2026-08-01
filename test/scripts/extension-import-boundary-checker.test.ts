// Extension import boundary checker tests cover bounded source reads.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExtensionImportBoundaryChecker } from "../../scripts/lib/extension-import-boundary-checker.mjs";

const tempDirs: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-extension-boundary-"));
  tempDirs.push(root);
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("extension import boundary checker", () => {
  it("rejects oversized TypeScript source files before scanning imports", async () => {
    const root = makeTempRoot();
    const sourcePath = path.join(root, "large.ts");
    writeFileSync(sourcePath, "x".repeat(33), "utf8");
    const checker = createExtensionImportBoundaryChecker({
      boundaryLabel: "test",
      cleanMessage: "clean",
      inventoryTitle: "inventory",
      maxSourceBytes: 32,
      roots: [path.relative(process.cwd(), root)],
    });

    await expect(checker.collectInventory()).rejects.toThrow(
      "extension import boundary source file exceeds 32 byte limit",
    );
  });

  it.each([
    {
      name: "comment-obscured side-effect import",
      createSource: (specifier: string) => "import /* gap */ " + JSON.stringify(specifier),
      kind: "import",
    },
    {
      name: "dynamic import with attributes",
      createSource: (specifier: string) =>
        "import /* gap */ (" + JSON.stringify(specifier) + ', { with: { type: "json" } })',
      kind: "dynamic-import",
    },
    {
      name: "CommonJS require",
      createSource: (specifier: string) => "require(" + JSON.stringify(specifier) + ")",
      kind: "commonjs-require",
    },
    {
      name: "import.meta URL",
      createSource: (specifier: string) =>
        "new URL(" + JSON.stringify(specifier) + ", import.meta.url)",
      kind: "import-meta-url",
    },
    {
      name: "comment-obscured namespace export",
      createSource: (specifier: string) =>
        "export /* gap */ * /* gap */ as privateModule from " + JSON.stringify(specifier),
      kind: "export",
    },
    {
      name: "escaped plugin-path separator",
      createSource: (specifier: string) =>
        "import " + JSON.stringify(specifier).replace("extensions/", "extensions\\/"),
      kind: "import",
    },
    {
      name: "Unicode-escaped plugin-path character",
      createSource: (specifier: string) =>
        "import " + JSON.stringify(specifier).replace("extensions/", "exten\\u0073ions/"),
      kind: "import",
    },
    {
      name: "hex-escaped plugin-path character",
      createSource: (specifier: string) =>
        "import " + JSON.stringify(specifier).replace("extensions/", "\\x65xtensions/"),
      kind: "import",
    },
    {
      name: "plugin-path line continuation",
      createSource: (specifier: string) =>
        "import " + JSON.stringify(specifier).replace("extensions/", "exten\\\nsions/"),
      kind: "import",
    },
  ])("rejects $name crossing the real plugin boundary", async ({ createSource, kind }) => {
    const root = makeTempRoot();
    const sourcePath = path.join(root, "guarded.ts");
    const targetPath = path.join(process.cwd(), "extensions", "security-proof", "private.js");
    const specifier = path.relative(root, targetPath).split(path.sep).join("/");
    writeFileSync(sourcePath, createSource(specifier), "utf8");
    const checker = createExtensionImportBoundaryChecker({
      boundaryLabel: "test",
      cleanMessage: "clean",
      inventoryTitle: "inventory",
      roots: [path.relative(process.cwd(), root)],
      skipSourcesWithoutBundledPluginPrefix: true,
    });

    await expect(checker.collectInventory()).resolves.toEqual([
      expect.objectContaining({
        kind,
        resolvedPath: "extensions/security-proof/private.js",
        specifier,
      }),
    ]);
  });
});
