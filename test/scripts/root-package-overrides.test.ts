import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type RootPackageManifest = {
  overrides?: Record<string, string>;
  pnpm?: {
    overrides?: Record<string, string>;
  };
};

function readRootManifest(): RootPackageManifest {
  const manifestPath = path.resolve(process.cwd(), "package.json");
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as RootPackageManifest;
}

describe("root package override guardrails", () => {
  it("pins the node-domexception alias exactly in npm and pnpm overrides", () => {
    const manifest = readRootManifest();
    const pnpmOverride = manifest.pnpm?.overrides?.["node-domexception"];

    expect(pnpmOverride).toBe("npm:@nolyfill/domexception@1.0.28");
    expect(manifest.overrides?.["node-domexception"]).toBe(pnpmOverride);
  });
});
