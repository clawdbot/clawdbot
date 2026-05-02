import fs from "node:fs";
import { describe, expect, it } from "vitest";

type DiffsPackageManifest = {
  dependencies?: Record<string, string>;
};

describe("diffs package manifest", () => {
  it("keeps runtime dependencies in the package manifest", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as DiffsPackageManifest;

    expect(packageJson.dependencies?.["@pierre/diffs"]).toBeDefined();
  });
});
