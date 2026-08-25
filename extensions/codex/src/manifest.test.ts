// Codex tests cover manifest plugin behavior.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { CODEX_APP_SERVER_VERSION } from "./app-server/version.js";

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
    expect(packageJson.dependencies?.["@openai/codex"]).toBe(CODEX_APP_SERVER_VERSION);
    expect(packageJson.dependencies?.semver).toBe("7.8.5");
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

  it("keeps managed Codex and the ACP adapter on the same exact bundled version", () => {
    const workspace = fs.readFileSync(
      new URL("../../../pnpm-workspace.yaml", import.meta.url),
      "utf8",
    );
    const lockfile = fs.readFileSync(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8");

    expect(workspace).toContain(
      `"@agentclientprotocol/codex-acp@1.4.0>@openai/codex": ${CODEX_APP_SERVER_VERSION}`,
    );
    expect(lockfile).toContain(
      `'@agentclientprotocol/codex-acp@1.4.0>@openai/codex': ${CODEX_APP_SERVER_VERSION}`,
    );
    const lockedCodexVersions = new Set(
      [...lockfile.matchAll(/@openai\/codex@(\d+\.\d+\.\d+)/g)].map((match) => match[1]),
    );
    expect([...lockedCodexVersions]).toEqual([CODEX_APP_SERVER_VERSION]);
  });
});
