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
});
