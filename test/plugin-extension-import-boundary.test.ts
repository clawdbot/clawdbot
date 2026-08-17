// Plugin extension import boundary tests enforce plugin extension import rules.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectRetiredWebSearchCorePathEntries } from "../scripts/check-plugin-extension-import-boundary.mts";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("plugin extension import boundary inventory", () => {
  it("rejects retired core web-search ownership paths", () => {
    const root = tempDirs.make("openclaw-retired-web-search-");
    const relativeFile = "src/plugins/web-search-providers.mjs";
    const filePath = path.join(root, relativeFile);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "export {};\n", "utf8");

    expect(collectRetiredWebSearchCorePathEntries(root)).toEqual([
      expect.objectContaining({
        file: relativeFile,
        kind: "retired-path",
      }),
    ]);
  });
});
