import path from "node:path";
import { describe, expect, it } from "vitest";
import { parsePackageRootArg } from "../../scripts/lib/package-root-args.mjs";
import { withEnv } from "../../src/test-utils/env.js";

const ENV_NAME = "OPENCLAW_PACKAGE_ROOT_ARGS_TEST";

describe("package-root-args", () => {
  it("uses the package root flag before the environment fallback", () => {
    withEnv({ [ENV_NAME]: "/env/root" }, () => {
      expect(parsePackageRootArg(["--package-root", "package"], ENV_NAME)).toEqual({
        packageRoot: path.resolve("package"),
      });
      expect(parsePackageRootArg(["--package-root=dist/package"], ENV_NAME)).toEqual({
        packageRoot: path.resolve("dist/package"),
      });
    });
  });

  it("rejects missing package root flag values", () => {
    expect(() => parsePackageRootArg(["--package-root"], ENV_NAME)).toThrow(
      "--package-root requires a value",
    );
    expect(() => parsePackageRootArg(["--package-root", "--other"], ENV_NAME)).toThrow(
      "--package-root requires a value",
    );
    expect(() => parsePackageRootArg(["--package-root", "-h"], ENV_NAME)).toThrow(
      "--package-root requires a value",
    );
    expect(() => parsePackageRootArg(["--package-root="], ENV_NAME)).toThrow(
      "--package-root requires a value",
    );
    expect(() => parsePackageRootArg(["--package-root=-h"], ENV_NAME)).toThrow(
      "--package-root requires a value",
    );
  });
});
