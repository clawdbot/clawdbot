import fs from "node:fs";
import { describe, expect, it } from "vitest";

type AcpxPackageManifest = {
  dependencies?: Record<string, string>;
  openclaw?: {
    bundle?: {
      stageRuntimeDependencies?: boolean;
    };
  };
};

describe("acpx package manifest", () => {
  it("opts into staging bundled runtime dependencies", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as AcpxPackageManifest;

    expect(packageJson.dependencies?.acpx).toBeDefined();
    expect(packageJson.openclaw?.bundle?.stageRuntimeDependencies).toBe(true);
  });
});
