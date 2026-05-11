import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  blockedInstallDependencyPackageNames,
  findBlockedPackageDirectoryInPath,
  findBlockedPackageFileAliasInPath,
  findBlockedManifestDependencies,
  findBlockedNodeModulesDirectory,
  findBlockedNodeModulesFileAlias,
} from "./dependency-denylist.js";

type RootPackageManifest = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  overrides?: Record<string, string | Record<string, string>>;
  peerDependencies?: Record<string, string>;
};

type PnpmWorkspaceConfig = {
  overrides?: Record<string, string>;
};

function readRootManifest(): RootPackageManifest {
  return JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"),
  ) as RootPackageManifest;
}

function readPnpmWorkspaceConfig(): PnpmWorkspaceConfig {
  return YAML.parse(
    fs.readFileSync(path.resolve(process.cwd(), "pnpm-workspace.yaml"), "utf8"),
  ) as PnpmWorkspaceConfig;
}

function readRootLockfile(): string {
  return fs.readFileSync(path.resolve(process.cwd(), "pnpm-lock.yaml"), "utf8");
}

describe("dependency denylist guardrails", () => {
  it("finds blocked package names on vendored manifests", () => {
    expect(
      findBlockedManifestDependencies({
        name: "plain-crypto-js",
      }),
    ).toEqual([
      {
        dependencyName: "plain-crypto-js",
        field: "name",
      },
    ]);
  });

  it("finds blocked packages declared through npm alias specs", () => {
    expect(
      findBlockedManifestDependencies({
        dependencies: {
          "safe-name": "npm:plain-crypto-js@^4.2.1",
        },
        peerDependencies: {
          "@alias/safe": "npm:@scope/ok@^1.0.0",
        },
      }),
    ).toEqual([
      {
        dependencyName: "plain-crypto-js",
        declaredAs: "safe-name",
        field: "dependencies",
      },
    ]);
  });

  it("finds blocked packages declared through nested override alias specs", () => {
    expect(
      findBlockedManifestDependencies({
        overrides: {
          axios: "1.15.0",
          "@scope/parent": {
            "safe-name": "npm:plain-crypto-js@^4.2.1",
          },
        },
      }),
    ).toEqual([
      {
        dependencyName: "plain-crypto-js",
        declaredAs: "@scope/parent > safe-name",
        field: "overrides",
      },
    ]);
  });

  it("pins the axios override to an exact version", () => {
    const manifest = readRootManifest();
    const pnpmWorkspace = readPnpmWorkspaceConfig();
    expect(manifest.overrides?.axios).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pnpmWorkspace.overrides?.axios).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("finds blocked package directories under node_modules regardless of node_modules casing", () => {
    expect(
      findBlockedNodeModulesDirectory({
        directoryRelativePath: "vendor/Node_Modules/plain-crypto-js",
      }),
    ).toEqual({
      dependencyName: "plain-crypto-js",
      directoryRelativePath: "vendor/Node_Modules/plain-crypto-js",
    });
  });

  it("finds blocked package directories regardless of blocked package segment casing", () => {
    expect(
      findBlockedNodeModulesDirectory({
        directoryRelativePath: "vendor/node_modules/Plain-Crypto-Js",
      }),
    ).toEqual({
      dependencyName: "Plain-Crypto-Js",
      directoryRelativePath: "vendor/node_modules/Plain-Crypto-Js",
    });
  });

  it("finds blocked package file aliases under node_modules regardless of casing", () => {
    expect(
      findBlockedNodeModulesFileAlias({
        fileRelativePath: "vendor/Node_Modules/Plain-Crypto-Js.Js",
      }),
    ).toEqual({
      dependencyName: "Plain-Crypto-Js",
      fileRelativePath: "vendor/Node_Modules/Plain-Crypto-Js.Js",
    });
  });

  it("finds blocked extensionless package file aliases under node_modules", () => {
    expect(
      findBlockedNodeModulesFileAlias({
        fileRelativePath: "vendor/Node_Modules/Plain-Crypto-Js",
      }),
    ).toEqual({
      dependencyName: "Plain-Crypto-Js",
      fileRelativePath: "vendor/Node_Modules/Plain-Crypto-Js",
    });
  });

  it("finds blocked package directories anywhere in a resolved path", () => {
    expect(
      findBlockedPackageDirectoryInPath({
        pathRelativeToRoot: "vendor/Plain-Crypto-Js/dist/index.js",
      }),
    ).toEqual({
      dependencyName: "Plain-Crypto-Js",
      directoryRelativePath: "vendor/Plain-Crypto-Js/dist/index.js",
    });
  });

  it("finds blocked package file aliases anywhere in a resolved path", () => {
    expect(
      findBlockedPackageFileAliasInPath({
        pathRelativeToRoot: "vendor/Plain-Crypto-Js.Js",
      }),
    ).toEqual({
      dependencyName: "Plain-Crypto-Js",
      fileRelativePath: "vendor/Plain-Crypto-Js.Js",
    });
  });

  it("does not treat similarly named non-node_modules segments as package-resolution paths", () => {
    expect(
      findBlockedNodeModulesDirectory({
        directoryRelativePath: "vendor/node_modules_backup/plain-crypto-js",
      }),
    ).toBeUndefined();
  });

  it("does not treat similarly named non-node_modules file aliases as package-resolution paths", () => {
    expect(
      findBlockedNodeModulesFileAlias({
        fileRelativePath: "vendor/plain-crypto-js.js",
      }),
    ).toBeUndefined();
  });

  it("does not treat dotted non-loadable file aliases as blocked package paths", () => {
    expect(
      findBlockedNodeModulesFileAlias({
        fileRelativePath: "vendor/node_modules/plain-crypto-js.txt",
      }),
    ).toBeUndefined();
  });

  it("does not treat similarly named non-package paths as blocked package directories", () => {
    expect(
      findBlockedPackageDirectoryInPath({
        pathRelativeToRoot: "vendor/safe-plain-crypto-js-notes/index.js",
      }),
    ).toBeUndefined();
  });

  it("does not flag the unscoped name segment from an allowed scoped package path", () => {
    expect(
      findBlockedPackageDirectoryInPath({
        pathRelativeToRoot: "vendor/@scope/plain-crypto-js/dist/index.js",
      }),
    ).toBeUndefined();
  });

  it("keeps blocked packages out of the root manifest", () => {
    const manifest = readRootManifest();
    expect(findBlockedManifestDependencies(manifest)).toStrictEqual([]);
  });

  it("keeps blocked packages out of the lockfile graph", () => {
    const lockfile = readRootLockfile();
    for (const packageName of blockedInstallDependencyPackageNames) {
      expect(lockfile).not.toContain(`\n  ${packageName}@`);
      expect(lockfile).not.toContain(`\n      ${packageName}: `);
    }
  });
});
