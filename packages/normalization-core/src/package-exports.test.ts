import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type PackageManifest = {
  exports: Record<
    string,
    {
      default: string;
      import: string;
      types: string;
    }
  >;
  scripts: { build: string };
};

const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as PackageManifest;

describe("normalization-core package exports", () => {
  it("builds every focused export from its matching source entry", () => {
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      const entryName = subpath === "." ? "index" : subpath.slice(2);
      expect(target).toEqual({
        types: `./dist/${entryName}.d.mts`,
        import: `./dist/${entryName}.mjs`,
        default: `./dist/${entryName}.mjs`,
      });
      expect(manifest.scripts.build.split(/\s+/u)).toContain(`src/${entryName}.ts`);
    }
  });
});
