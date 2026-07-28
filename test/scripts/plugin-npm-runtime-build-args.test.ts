import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs as parseBulkBuildArgs } from "../../scripts/check-plugin-npm-runtime-builds.mjs";
import { listMissingPackageStaticAssetSources } from "../../scripts/lib/plugin-npm-runtime-assets.mjs";
import { parseArgs as parseSingleBuildArgs } from "../../scripts/lib/plugin-npm-runtime-build.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

describe("plugin npm runtime build args", () => {
  it("parses explicit plugin package build targets", () => {
    expect(
      parseBulkBuildArgs(["--package", "extensions/slack", "--package", "extensions/telegram"]),
    ).toEqual({
      packageDirs: ["extensions/slack", "extensions/telegram"],
    });
    expect(parseSingleBuildArgs(["extensions/slack"])).toEqual({
      packageDir: "extensions/slack",
    });
    expect(parseSingleBuildArgs(["--", "extensions/slack"])).toEqual({
      packageDir: "extensions/slack",
    });
  });

  it("returns help before resolving build targets", () => {
    expect(parseBulkBuildArgs(["--help"])).toEqual({
      help: true,
      packageDirs: [],
    });
    expect(parseSingleBuildArgs(["--help"])).toEqual({
      help: true,
      packageDir: "",
    });
  });

  it("rejects missing or option-looking package targets", () => {
    expect(() => parseBulkBuildArgs(["--package"])).toThrow("missing value for --package");
    expect(() => parseBulkBuildArgs(["--package", "--package", "extensions/slack"])).toThrow(
      "missing value for --package",
    );
    expect(() => parseBulkBuildArgs(["--package", "-h"])).toThrow("missing value for --package");
    expect(() => parseSingleBuildArgs(["--package"])).toThrow(
      "usage: node scripts/lib/plugin-npm-runtime-build.mjs <package-dir>",
    );
    expect(() => parseSingleBuildArgs(["extensions/slack", "extra"])).toThrow(
      "unexpected plugin npm runtime build argument: extra",
    );
  });

  it("reports package-local missing static asset sources", () => {
    const repoRoot = createTempDir("openclaw-plugin-npm-runtime-assets-");
    const demoDir = path.join(repoRoot, "extensions", "demo");
    const otherDir = path.join(repoRoot, "extensions", "other");
    fs.mkdirSync(path.join(demoDir, "assets"), { recursive: true });
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(demoDir, "assets", "present.js"), "export {};\n", "utf8");
    fs.writeFileSync(
      path.join(demoDir, "package.json"),
      JSON.stringify({
        openclaw: {
          build: {
            staticAssets: [
              { source: "./assets/present.js", output: "assets/present.js" },
              { source: "./assets/missing.js", output: "assets/missing.js" },
            ],
          },
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(otherDir, "package.json"),
      JSON.stringify({
        openclaw: {
          build: {
            staticAssets: [{ source: "./assets/other-missing.js", output: "assets/other.js" }],
          },
        },
      }),
      "utf8",
    );

    expect(
      listMissingPackageStaticAssetSources({
        repoRoot,
        pluginDir: "demo",
      }),
    ).toEqual(["extensions/demo/assets/missing.js"]);
  });
});
