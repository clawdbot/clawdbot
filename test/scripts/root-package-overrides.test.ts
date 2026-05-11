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

describe("root package override guardrails", () => {
  it("pins the Bedrock runtime below the Windows ARM Node 24 npm resolver failure", () => {
    const manifest = readRootManifest();
    const pnpmWorkspace = readPnpmWorkspaceConfig();
    const packageName = "@aws-sdk/client-bedrock-runtime";
    const dependencyVersion = manifest.dependencies?.[packageName];
    const npmOverride = manifest.overrides?.[packageName];
    const pnpmOverride = pnpmWorkspace.overrides?.["@aws-sdk/client-bedrock-runtime"];

    expect(manifest.dependencies).toHaveProperty(packageName);
    expect(pnpmOverride).toBe(dependencyVersion);
    expect(npmOverride).toBe(`$${packageName}`);
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
