import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type PnpmBuildConfig = {
  ignoredBuiltDependencies?: string[];
  onlyBuiltDependencies?: string[];
};

type RootPackageJson = {
  pnpm?: PnpmBuildConfig;
};

type WorkspaceConfig = PnpmBuildConfig;

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

describe("package manager build policy", () => {
  it("keeps optional native Discord opus builds disabled by default", () => {
    const packageJson = readJson<RootPackageJson>("package.json");
    const workspace = parse(fs.readFileSync("pnpm-workspace.yaml", "utf8")) as WorkspaceConfig;

    for (const config of [packageJson.pnpm, workspace]) {
      expect(config?.ignoredBuiltDependencies ?? []).toContain("@discordjs/opus");
      expect(config?.onlyBuiltDependencies ?? []).not.toContain("@discordjs/opus");
    }
  });
});
