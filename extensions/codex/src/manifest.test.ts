// Codex tests cover manifest plugin behavior.
import fs from "node:fs";
import { describe, expect, it } from "vitest";

type CodexPackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  openclaw?: {
    install?: {
      requiredPlatformPackages?: string[];
    };
    release?: {
      requireLatestDependencies?: string[];
    };
  };
};

describe("codex package manifest", () => {
  it("keeps runtime dependencies in the package manifest", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as CodexPackageManifest;

    expect(packageJson.devDependencies).toHaveProperty("@openclaw/plugin-sdk");
    expect(packageJson.dependencies?.["@openai/codex"]).toBe("0.144.4");
    expect(packageJson.openclaw?.release?.requireLatestDependencies).toEqual(["@openai/codex"]);
    expect(packageJson.openclaw?.install?.requiredPlatformPackages).toEqual([
      "@openai/codex-linux-x64",
      "@openai/codex-linux-arm64",
      "@openai/codex-darwin-x64",
      "@openai/codex-darwin-arm64",
      "@openai/codex-win32-x64",
      "@openai/codex-win32-arm64",
    ]);
  });
});
