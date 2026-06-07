import { describe, expect, it } from "vitest";
import { parseArgs as parseBulkBuildArgs } from "../../scripts/check-plugin-npm-runtime-builds.mjs";
import { parseArgs as parseSingleBuildArgs } from "../../scripts/lib/plugin-npm-runtime-build.mjs";

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
  });

  it("rejects missing or option-looking package targets", () => {
    expect(() => parseBulkBuildArgs(["--package"])).toThrow("missing value for --package");
    expect(() => parseBulkBuildArgs(["--package", "--package", "extensions/slack"])).toThrow(
      "missing value for --package",
    );
    expect(() => parseSingleBuildArgs(["--package"])).toThrow(
      "usage: node scripts/lib/plugin-npm-runtime-build.mjs <package-dir>",
    );
  });
});
