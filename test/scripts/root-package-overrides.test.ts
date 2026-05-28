import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

type RootPackageManifest = {
  dependencies?: Record<string, string>;
  overrides?: Record<string, string>;
};

type PnpmWorkspaceConfig = {
  overrides?: Record<string, string>;
};

function readRootManifest(): RootPackageManifest {
  const manifestPath = path.resolve(process.cwd(), "package.json");
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as RootPackageManifest;
}

function readPnpmWorkspaceConfig(): PnpmWorkspaceConfig {
  const workspacePath = path.resolve(process.cwd(), "pnpm-workspace.yaml");
  return YAML.parse(fs.readFileSync(workspacePath, "utf8")) as PnpmWorkspaceConfig;
}

function readPackageManifest(packagePath: string): RootPackageManifest {
  return JSON.parse(fs.readFileSync(packagePath, "utf8")) as RootPackageManifest;
}

describe("root package override guardrails", () => {
  it("keeps Bedrock runtime ownership in the Amazon provider plugin", () => {
    const manifest = readRootManifest();
    const pnpmWorkspace = readPnpmWorkspaceConfig();
    const packageName = "@aws-sdk/client-bedrock-runtime";
    const bedrockManifest = readPackageManifest(
      path.resolve(process.cwd(), "extensions", "amazon-bedrock", "package.json"),
    );
    const bedrockRuntimeDependency = bedrockManifest.dependencies?.[packageName];
    const npmOverride = manifest.overrides?.[packageName];

    expect(bedrockRuntimeDependency).toBeDefined();
    expect(manifest.dependencies).not.toHaveProperty(packageName);
    expect(npmOverride).toBeUndefined();
    expect(pnpmWorkspace.overrides).not.toHaveProperty(packageName);
  });

  it("pins the node-domexception alias exactly in npm and pnpm overrides", () => {
    const manifest = readRootManifest();
    const pnpmWorkspace = readPnpmWorkspaceConfig();
    const pnpmOverride = pnpmWorkspace.overrides?.["node-domexception"];
    const npmOverride = manifest.overrides?.["node-domexception"];

    expect(pnpmOverride).toBe("npm:@nolyfill/domexception@1.0.28");
    expect(npmOverride).toBe(pnpmOverride);
  });
});
