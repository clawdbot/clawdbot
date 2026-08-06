import { describe, expect, it } from "vitest";
import {
  openClawNpmPrepublishVerifyUsage,
  parseOpenClawNpmPrepublishVerifyArgs,
  usesPreparedLocalDependencyInstall,
} from "../scripts/openclaw-npm-prepublish-verify.ts";

describe("parseOpenClawNpmPrepublishVerifyArgs", () => {
  it("supports help, optional versions, and package-manager separators", () => {
    expect(parseOpenClawNpmPrepublishVerifyArgs(["--help"])).toEqual({
      dependencyTarballPaths: [],
      help: true,
      tarballPath: "",
    });
    expect(parseOpenClawNpmPrepublishVerifyArgs(["openclaw.tgz"])).toEqual({
      dependencyTarballPaths: [],
      help: false,
      tarballPath: "openclaw.tgz",
    });
    expect(parseOpenClawNpmPrepublishVerifyArgs(["--", "openclaw.tgz", "2026.3.23"])).toEqual({
      dependencyTarballPaths: [],
      expectedVersion: "2026.3.23",
      help: false,
      tarballPath: "openclaw.tgz",
    });
  });

  it("rejects missing, option-like, and extra arguments before installing", () => {
    expect(() => parseOpenClawNpmPrepublishVerifyArgs([])).toThrow(
      openClawNpmPrepublishVerifyUsage(),
    );
    expect(() => parseOpenClawNpmPrepublishVerifyArgs(["--tag"])).toThrow(
      "Unknown openclaw npm prepublish verifier option: --tag",
    );
    expect(() => parseOpenClawNpmPrepublishVerifyArgs(["openclaw.tgz", "--tag"])).toThrow(
      "Unknown openclaw npm prepublish verifier option: --tag",
    );
    expect(
      parseOpenClawNpmPrepublishVerifyArgs(["openclaw.tgz", "2026.3.23", "llm-core.tgz", "ai.tgz"]),
    ).toEqual({
      dependencyTarballPaths: ["llm-core.tgz", "ai.tgz"],
      expectedVersion: "2026.3.23",
      help: false,
      tarballPath: "openclaw.tgz",
    });
    expect(() =>
      parseOpenClawNpmPrepublishVerifyArgs(["openclaw.tgz", "2026.3.23", "--bad"]),
    ).toThrow("Invalid dependency tarball path: --bad");
  });
});

describe("usesPreparedLocalDependencyInstall", () => {
  it("uses the prepared local project only for the single AI tarball release path", () => {
    expect(usesPreparedLocalDependencyInstall(0)).toBe(false);
    expect(usesPreparedLocalDependencyInstall(1)).toBe(true);
    expect(usesPreparedLocalDependencyInstall(2)).toBe(false);
  });
});
