// Package manager config tests validate workspace package manager settings.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  mergeOverrides,
  parsePnpmPackageKey,
  readNpmLockOverrides,
} from "../scripts/generate-npm-package-lock.mts";

type PnpmBuildConfig = {
  allowBuilds?: Record<string, boolean>;
  blockExoticSubdeps?: boolean;
  ignoredBuiltDependencies?: string[];
  onlyBuiltDependencies?: string[];
};

type RootPackageJson = {
  files?: string[];
  pnpm?: PnpmBuildConfig;
};

type WorkspaceConfig = PnpmBuildConfig & {
  verifyDepsBeforeRun?: boolean;
};

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

function collectPnpmLockPackages(): Set<string> {
  const lockfile = parse(fs.readFileSync("pnpm-lock.yaml", "utf8")) as {
    packages?: Record<string, { version?: unknown }>;
  };
  const packages = new Set<string>();
  for (const [packageKey, metadata] of Object.entries(lockfile.packages ?? {})) {
    const parsed = parsePnpmPackageKey(packageKey);
    if (!parsed) {
      continue;
    }
    packages.add(`${parsed.name}@${parsed.version}`);
    if (typeof metadata.version === "string") {
      packages.add(`${parsed.name}@${metadata.version}`);
    }
  }
  return packages;
}

describe("package manager build policy", () => {
  it("keeps optional native Discord opus builds disabled by default", () => {
    const packageJson = readJson("package.json") as RootPackageJson;
    const workspace = parse(fs.readFileSync("pnpm-workspace.yaml", "utf8")) as WorkspaceConfig;

    expect(packageJson.pnpm).toBeUndefined();
    expect(workspace.allowBuilds?.["@discordjs/opus"]).toBe(false);
    expect(workspace.blockExoticSubdeps).toBe(true);
    expect(workspace.verifyDepsBeforeRun).toBe(false);
    expect(workspace.onlyBuiltDependencies).toBeUndefined();
  });

  it("includes third-party notices in the published root package", () => {
    const packageJson = readJson("package.json") as RootPackageJson;

    expect(packageJson.files).toContain("THIRD_PARTY_NOTICES.md");
  });

  it("omits source-only Crabbox wrapper modules from the published root package", () => {
    const packageJson = readJson("package.json") as RootPackageJson;

    for (const sourcePath of [
      "scripts/crabbox-wrapper.mjs",
      "scripts/crabbox-wrapper.mts",
      "scripts/crabbox-wrapper-providers.mts",
      "scripts/crabbox-routing-policy.mts",
      "scripts/testbox-lease-freshness.mts",
      "scripts/lib/tsx-cli-shim.mjs",
    ]) {
      expect(packageJson.files).not.toContain(sourcePath);
    }
  });

  it("pins forked transitive dependencies with parent-scoped npm-lock overrides", () => {
    const overrides = readNpmLockOverrides() as Record<string, unknown>;

    const packages = collectPnpmLockPackages();

    expect(overrides["lru-cache"]).toBeUndefined();
    expect(overrides["lru-memoizer@2.3.0"]).toMatchObject({
      "lru-cache": { ".": "6.0.0", yallist: "4.0.0" },
    });
    if (packages.has("lru-memoizer@3.0.0")) {
      const lruCacheVersion = (overrides["lru-memoizer@3.0.0"] as Record<string, string>)[
        "lru-cache"
      ];
      expect(lruCacheVersion).toMatch(/^11\.\d+\.\d+$/u);
      expect(packages.has(`lru-cache@${lruCacheVersion}`)).toBe(true);
    }
  });

  it("merges exact npm-lock pins with nested lock-derived pins", () => {
    expect(
      mergeOverrides(
        { "@mistralai/mistralai": "2.2.1" },
        { "@mistralai/mistralai": { ".": "2.2.1", zod: "4.4.3" } },
        {},
      ),
    ).toEqual({
      "@mistralai/mistralai": { ".": "2.2.1", zod: "4.4.3" },
    });
  });

  it("preserves npm alias pins when merging nested lock-derived pins", () => {
    expect(
      mergeOverrides(
        { "node-domexception": "npm:@nolyfill/domexception@1.0.28" },
        { "node-domexception": { ".": "1.0.28", child: "2.0.0" } },
        {},
      ),
    ).toEqual({
      "node-domexception": {
        ".": "npm:@nolyfill/domexception@1.0.28",
        child: "2.0.0",
      },
    });
  });

  it("preserves later npm alias pins when nested pins are already merged", () => {
    expect(
      mergeOverrides(
        { "node-domexception": { ".": "1.0.28", child: "2.0.0" } },
        { "node-domexception": "npm:@nolyfill/domexception@1.0.28" },
        {},
      ),
    ).toEqual({
      "node-domexception": {
        ".": "npm:@nolyfill/domexception@1.0.28",
        child: "2.0.0",
      },
    });
  });

  it("rejects non-exact root pins when merging nested pins", () => {
    expect(() =>
      mergeOverrides(
        { "floating-package": "^1.0.0" },
        { "floating-package": { ".": "~1.0.0", child: "2.0.0" } },
        {},
      ),
    ).toThrow(/conflicts with pnpm lock policy/u);
    expect(() =>
      mergeOverrides(
        { "floating-package": { ".": "^1.0.0", child: "2.0.0" } },
        { "floating-package": "~1.0.0" },
        {},
      ),
    ).toThrow(/conflicts with pnpm lock policy/u);
  });

  it("rejects distinct npm alias targets with matching versions", () => {
    expect(() =>
      mergeOverrides(
        { "aliased-package": "npm:@safe/foo@1.0.0" },
        { "aliased-package": { ".": "npm:@other/foo@1.0.0", child: "2.0.0" } },
        {},
      ),
    ).toThrow(/conflicts with pnpm lock policy/u);
    expect(() =>
      mergeOverrides(
        { "aliased-package": { ".": "npm:@safe/foo@1.0.0", child: "2.0.0" } },
        { "aliased-package": "npm:@other/foo@1.0.0" },
        {},
      ),
    ).toThrow(/conflicts with pnpm lock policy/u);
  });
});
