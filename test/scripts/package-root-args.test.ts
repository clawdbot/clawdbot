import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parsePackageRootArg } from "../../scripts/lib/package-root-args.mjs";

const ENV_NAME = "OPENCLAW_PACKAGE_ROOT_ARGS_TEST";
const originalEnvValue = process.env[ENV_NAME];

afterEach(() => {
  if (originalEnvValue === undefined) {
    delete process.env[ENV_NAME];
    return;
  }
  process.env[ENV_NAME] = originalEnvValue;
});

describe("package-root-args", () => {
  it("uses the package root flag before the environment fallback", () => {
    process.env[ENV_NAME] = "/env/root";

    expect(parsePackageRootArg(["--package-root", "package"], ENV_NAME)).toEqual({
      packageRoot: path.resolve("package"),
    });
    expect(parsePackageRootArg(["--package-root=dist/package"], ENV_NAME)).toEqual({
      packageRoot: path.resolve("dist/package"),
    });
  });

  it("rejects missing package root flag values", () => {
    expect(() => parsePackageRootArg(["--package-root"], ENV_NAME)).toThrow(
      "--package-root requires a value",
    );
    expect(() => parsePackageRootArg(["--package-root", "--other"], ENV_NAME)).toThrow(
      "--package-root requires a value",
    );
    expect(() => parsePackageRootArg(["--package-root="], ENV_NAME)).toThrow(
      "--package-root requires a value",
    );
  });
});
