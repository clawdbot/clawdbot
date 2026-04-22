import fs from "node:fs";
import { describe, expect, it } from "vitest";

type TokenjuicePackageManifest = {
  dependencies?: Record<string, string>;
  openclaw?: {
    bundle?: {
      stageRuntimeDependencies?: boolean;
    };
  };
};

type TokenjuicePluginManifest = {
  contracts?: {
    embeddedExtensionFactories?: string[];
  };
};

describe("tokenjuice package manifest", () => {
  it("opts into staging bundled runtime dependencies", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"),
    ) as TokenjuicePackageManifest;

    expect(packageJson.dependencies?.tokenjuice).toBe("0.6.1");
    expect(packageJson.openclaw?.bundle?.stageRuntimeDependencies).toBe(true);
  });

  it("declares Pi embedded extension factory ownership in the manifest contract", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    ) as TokenjuicePluginManifest;

    expect(manifest.contracts?.embeddedExtensionFactories).toEqual(["pi"]);
  });
});
