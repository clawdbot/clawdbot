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

describe("plugin extension import boundary inventory", () => {
  it("keeps dedicated web-search registry shims out of the remaining inventory", async () => {
    const inventory = await collectPluginExtensionImportBoundaryInventory();
    const blockedShimFiles = inventory
      .filter(
        (entry) =>
          entry.file === "src/plugins/web-search-providers.ts" ||
          entry.file === "src/plugins/bundled-web-search-registry.ts",
      )
      .map((entry) => entry.file);

    expect(blockedShimFiles).toEqual([]);
  });

  it("ignores boundary shims by scope", async () => {
    const inventory = await collectPluginExtensionImportBoundaryInventory();
    const boundaryShimFiles = inventory
      .filter(
        (entry) =>
          entry.file.startsWith("src/plugin-sdk/") ||
          entry.file.startsWith("src/plugin-sdk-internal/"),
      )
      .map((entry) => entry.file);

    expect(boundaryShimFiles).toEqual([]);
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
