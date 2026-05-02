import fs from "node:fs";
import { describe, expect, it } from "vitest";

type PackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe("bonjour package manifest", () => {
  it("keeps ciao available in packaged startup runtimes", () => {
    const pluginPackageJson = JSON.parse(
      fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"),
    ) as PackageManifest;
    const rootPackageJson = JSON.parse(
      fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as PackageManifest;

    expect(pluginPackageJson.dependencies?.["@homebridge/ciao"]).toBe("^1.3.7");
    expect(rootPackageJson.dependencies?.["@homebridge/ciao"]).toBeUndefined();
    expect(pluginPackageJson.devDependencies?.["@homebridge/ciao"]).toBeUndefined();
  });
});
