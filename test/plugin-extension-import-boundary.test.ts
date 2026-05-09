import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectPluginExtensionImportBoundaryInventory,
  diffInventory,
  main,
} from "../scripts/check-plugin-extension-import-boundary.mjs";
import { createCapturedIo } from "./helpers/captured-io.js";

const repoRoot = process.cwd();
const baselinePath = path.join(
  repoRoot,
  "test",
  "fixtures",
  "plugin-extension-import-boundary-inventory.json",
);
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));

function collectInventoryFiles(
  inventory: Awaited<ReturnType<typeof collectPluginExtensionImportBoundaryInventory>>,
  predicate: (file: string) => boolean,
): string[] {
  const files: string[] = [];
  for (const entry of inventory) {
    if (predicate(entry.file)) {
      files.push(entry.file);
    }
  }
  return files;
}

describe("plugin extension import boundary inventory", () => {
  it("keeps dedicated web-search registry shims out of the remaining inventory", async () => {
    const inventory = await collectPluginExtensionImportBoundaryInventory();
    const blockedShimFiles = collectInventoryFiles(
      inventory,
      (file) =>
        file === "src/plugins/web-search-providers.ts" ||
        file === "src/plugins/bundled-web-search-registry.ts",
    );

    expect(blockedShimFiles).toStrictEqual([]);
  });

  it("ignores boundary shims by scope", async () => {
    const inventory = await collectPluginExtensionImportBoundaryInventory();
    const boundaryShimFiles = collectInventoryFiles(
      inventory,
      (file) => file.startsWith("src/plugin-sdk/") || file.startsWith("src/plugin-sdk-internal/"),
    );

    expect(boundaryShimFiles).toStrictEqual([]);
  });

  it("produces stable sorted output", async () => {
    const first = await collectPluginExtensionImportBoundaryInventory();
    const second = await collectPluginExtensionImportBoundaryInventory();

    expect(second).toEqual(first);
    expect(
      [...first].toSorted(
        (left, right) =>
          left.file.localeCompare(right.file) ||
          left.line - right.line ||
          left.kind.localeCompare(right.kind) ||
          left.specifier.localeCompare(right.specifier) ||
          left.reason.localeCompare(right.reason),
      ),
    ).toEqual(first);
  });

  it("matches the checked-in baseline", async () => {
    const actual = await collectPluginExtensionImportBoundaryInventory();

    expect(diffInventory(baseline, actual)).toEqual({ missing: [], unexpected: [] });
  });

  it("script json output matches the baseline exactly", async () => {
    const captured = createCapturedIo();
    const exitCode = await main(["--json"], captured.io);

    expect(exitCode).toBe(0);
    expect(captured.readStderr()).toBe("");
    expect(JSON.parse(captured.readStdout())).toEqual(baseline);
  });
});
