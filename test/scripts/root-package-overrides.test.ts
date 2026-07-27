// Root Package Overrides tests cover root package overrides script behavior.
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

type PnpmLockfileConfig = {
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

function readPnpmLockfileConfig(): PnpmLockfileConfig {
  const lockfilePath = path.resolve(process.cwd(), "pnpm-lock.yaml");
  return YAML.parse(fs.readFileSync(lockfilePath, "utf8")) as PnpmLockfileConfig;
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

  it("pins the node-domexception alias exactly in pnpm override metadata", () => {
    const manifest = readRootManifest();
    const pnpmWorkspace = readPnpmWorkspaceConfig();
    const pnpmOverride = pnpmWorkspace.overrides?.["node-domexception"];

    expect(pnpmOverride).toBe("npm:@nolyfill/domexception@1.0.28");
    expect(manifest.overrides).toBeUndefined();
  });

  it("keeps pnpm and lockfile override metadata aligned without duplicating root package policy", () => {
    const manifest = readRootManifest();
    const pnpmWorkspace = readPnpmWorkspaceConfig();
    const pnpmLockfile = readPnpmLockfileConfig();

    expect(manifest.overrides).toBeUndefined();
    expect(pnpmLockfile.overrides).toEqual(pnpmWorkspace.overrides);
  });
});
