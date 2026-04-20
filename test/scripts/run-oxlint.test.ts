import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { shouldPrepareExtensionPackageBoundaryArtifacts } from "../../scripts/run-oxlint.mjs";

describe("run-oxlint", () => {
  it("prepares extension package boundary artifacts for normal lint runs", () => {
    expect(shouldPrepareExtensionPackageBoundaryArtifacts([])).toBe(true);
    expect(shouldPrepareExtensionPackageBoundaryArtifacts(["src/index.ts"])).toBe(true);
    expect(shouldPrepareExtensionPackageBoundaryArtifacts(["--type-aware"])).toBe(true);
  });

  it("skips artifact preparation for metadata-only oxlint commands", () => {
    expect(shouldPrepareExtensionPackageBoundaryArtifacts(["--help"])).toBe(false);
    expect(shouldPrepareExtensionPackageBoundaryArtifacts(["--version"])).toBe(false);
    expect(shouldPrepareExtensionPackageBoundaryArtifacts(["--print-config"])).toBe(false);
    expect(shouldPrepareExtensionPackageBoundaryArtifacts(["--rules"])).toBe(false);
  });

  it("does not run package-boundary artifact prep twice in pnpm check", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const shardedLintRunner = readFileSync("scripts/run-oxlint-shards.mjs", "utf8");

    expect(packageJson.scripts.check).toBe("node scripts/check.mjs");
    expect(packageJson.scripts.lint).toBe("node scripts/run-oxlint-shards.mjs");
    expect(packageJson.scripts.check).not.toContain(
      "node scripts/prepare-extension-package-boundary-artifacts.mjs",
    );
    expect(shardedLintRunner).toContain("prepare-extension-package-boundary-artifacts.mjs");
    expect(shardedLintRunner).toContain('OPENCLAW_OXLINT_SKIP_PREPARE: "1"');
  });
});
