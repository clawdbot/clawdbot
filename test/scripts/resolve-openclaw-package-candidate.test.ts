import { describe, expect, it } from "vitest";
import {
  parseArgs,
  validateOpenClawPackageSpec,
} from "../../scripts/resolve-openclaw-package-candidate.mjs";

describe("resolve-openclaw-package-candidate", () => {
  it("accepts only OpenClaw release package specs for npm candidates", () => {
    expect(() => validateOpenClawPackageSpec("openclaw@beta")).not.toThrow();
    expect(() => validateOpenClawPackageSpec("openclaw@latest")).not.toThrow();
    expect(() => validateOpenClawPackageSpec("openclaw@2026.4.27")).not.toThrow();
    expect(() => validateOpenClawPackageSpec("openclaw@2026.4.27-1")).not.toThrow();
    expect(() => validateOpenClawPackageSpec("openclaw@2026.4.27-beta.2")).not.toThrow();

    expect(() => validateOpenClawPackageSpec("@evil/openclaw@1.0.0")).toThrow(
      "package_spec must be openclaw@beta",
    );
    expect(() => validateOpenClawPackageSpec("openclaw@canary")).toThrow(
      "package_spec must be openclaw@beta",
    );
    expect(() => validateOpenClawPackageSpec("openclaw@2026.04.27")).toThrow(
      "package_spec must be openclaw@beta",
    );
  });

  it("parses optional empty workflow inputs without rejecting the command line", () => {
    expect(
      parseArgs([
        "--source",
        "npm",
        "--package-ref",
        "release/2026.4.27",
        "--package-spec",
        "openclaw@beta",
        "--package-url",
        "",
        "--package-sha256",
        "",
        "--artifact-dir",
        ".",
        "--output-dir",
        ".artifacts/docker-e2e-package",
      ]),
    ).toMatchObject({
      artifactDir: ".",
      outputDir: ".artifacts/docker-e2e-package",
      packageSha256: "",
      packageRef: "release/2026.4.27",
      packageSpec: "openclaw@beta",
      packageUrl: "",
      source: "npm",
    });
  });
});
