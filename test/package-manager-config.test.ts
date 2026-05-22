import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  collectPnpmLockViolations,
  parsePnpmPackageKey,
} from "../scripts/generate-npm-shrinkwrap.mjs";

type PnpmBuildConfig = {
  allowBuilds?: Record<string, boolean>;
  blockExoticSubdeps?: boolean;
  ignoredBuiltDependencies?: string[];
  onlyBuiltDependencies?: string[];
};

type RootPackageJson = {
  pnpm?: PnpmBuildConfig;
};

type WorkspaceConfig = PnpmBuildConfig;
type WorkspaceDependencyPolicy = WorkspaceConfig & {
  overrides?: Record<string, string | number>;
};
type NpmShrinkwrap = {
  name?: string;
  version?: string;
  packages?: Record<string, { name?: string; version?: string; dev?: boolean }>;
};

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

function collectPnpmLockPackages(): Set<string> {
  const lockfile = parse(fs.readFileSync("pnpm-lock.yaml", "utf8")) as {
    packages?: Record<string, unknown>;
  };
  return new Set(
    Object.keys(lockfile.packages ?? {})
      .map((packageKey) => {
        const parsed = parsePnpmPackageKey(packageKey);
        return parsed ? `${parsed.name}@${parsed.version}` : null;
      })
      .filter((packageKey) => packageKey !== null),
  );
}

describe("package manager build policy", () => {
  it("keeps optional native Discord opus builds disabled by default", () => {
    const packageJson = readJson("package.json") as RootPackageJson;
    const workspace = parse(fs.readFileSync("pnpm-workspace.yaml", "utf8")) as WorkspaceConfig;

    expect(packageJson.pnpm).toBeUndefined();
    expect(workspace.allowBuilds?.["@discordjs/opus"]).toBe(false);
    expect(workspace.blockExoticSubdeps).toBe(true);
    expect(workspace.onlyBuiltDependencies).toBeUndefined();
  });

  it("keeps npm shrinkwrap aligned with workspace overrides", () => {
    const workspace = parse(
      fs.readFileSync("pnpm-workspace.yaml", "utf8"),
    ) as WorkspaceDependencyPolicy;
    const shrinkwrap = readJson("npm-shrinkwrap.json") as NpmShrinkwrap;

    for (const packageName of [
      "@anthropic-ai/sdk",
      "hono",
      "@aws-sdk/client-bedrock-runtime",
      "protobufjs",
    ]) {
      expect(shrinkwrap.packages?.[`node_modules/${packageName}`]?.version).toBe(
        String(workspace.overrides?.[packageName]),
      );
    }
  });

  it("keeps npm shrinkwrap package versions inside the pnpm lock graph", () => {
    const pnpmLockPackages = collectPnpmLockPackages();
    const shrinkwrapPaths = [
      "npm-shrinkwrap.json",
      ...fs
        .readdirSync("extensions", { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `extensions/${entry.name}/npm-shrinkwrap.json`)
        .filter((shrinkwrapPath) => fs.existsSync(shrinkwrapPath))
        .sort((left, right) => left.localeCompare(right)),
    ];

    for (const shrinkwrapPath of shrinkwrapPaths) {
      const shrinkwrap = readJson(shrinkwrapPath);
      expect(collectPnpmLockViolations(shrinkwrap, pnpmLockPackages), shrinkwrapPath).toEqual([]);
    }
  });

  it("ships shrinkwrap for every publishable plugin package", () => {
    for (const entry of fs.readdirSync("extensions", { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const packageJsonPath = `extensions/${entry.name}/package.json`;
      if (!fs.existsSync(packageJsonPath)) {
        continue;
      }
      const packageJson = readJson(packageJsonPath) as {
        name?: string;
        version?: string;
        openclaw?: { release?: { publishToNpm?: boolean } };
      };
      if (packageJson.openclaw?.release?.publishToNpm !== true) {
        continue;
      }

      const shrinkwrapPath = `extensions/${entry.name}/npm-shrinkwrap.json`;
      const shrinkwrap = readJson(shrinkwrapPath) as NpmShrinkwrap;
      const devLockedPackages = Object.entries(shrinkwrap.packages ?? {}).filter(
        ([, lockedPackage]) => lockedPackage.dev === true,
      );

      expect(shrinkwrap.name, shrinkwrapPath).toBe(packageJson.name);
      expect(shrinkwrap.version, shrinkwrapPath).toBe(packageJson.version);
      expect(shrinkwrap.packages?.[""]?.name, shrinkwrapPath).toBe(packageJson.name);
      expect(shrinkwrap.packages?.[""]?.version, shrinkwrapPath).toBe(packageJson.version);
      expect(devLockedPackages, shrinkwrapPath).toEqual([]);
    }
  });
});
