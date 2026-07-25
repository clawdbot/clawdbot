// Package manager config tests validate workspace package manager settings.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  collectCurrentShrinkwrapOverrides,
  collectPnpmLockViolations,
  mergeOverrides,
  parsePnpmPackageKey,
  readShrinkwrapOverrides,
} from "../scripts/generate-npm-shrinkwrap.mjs";

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
    expect(workspace.allowBuilds?.["node-llama-cpp"]).toBe(false);
    expect(workspace.blockExoticSubdeps).toBe(true);
    expect(workspace.onlyBuiltDependencies).toBeUndefined();
  });

  it("includes third-party notices in the published root package", () => {
    const packageJson = readJson("package.json") as RootPackageJson;

    expect(packageJson.files).toContain("THIRD_PARTY_NOTICES.md");
  });

  it("includes the Crabbox wrapper runtime modules in the published root package", () => {
    const packageJson = readJson("package.json") as RootPackageJson;

    expect(packageJson.files).toEqual(
      expect.arrayContaining([
        "scripts/crabbox-wrapper.mjs",
        "scripts/crabbox-wrapper-providers.mjs",
        "scripts/testbox-lease-freshness.mjs",
      ]),
    );
  });

  it("keeps npm shrinkwrap aligned with workspace overrides", () => {
    const workspace = parse(
      fs.readFileSync("pnpm-workspace.yaml", "utf8"),
    ) as WorkspaceDependencyPolicy;
    const shrinkwrap = readJson("npm-shrinkwrap.json") as NpmShrinkwrap;

    for (const packageName of ["@anthropic-ai/sdk", "hono", "protobufjs"]) {
      expect(shrinkwrap.packages?.[`node_modules/${packageName}`]?.version).toBe(
        String(workspace.overrides?.[packageName]),
      );
    }
  });

  it("pins forked transitive dependencies with parent-scoped shrinkwrap overrides", () => {
    const overrides = readShrinkwrapOverrides() as Record<string, unknown>;

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

  it("can preserve current forked shrinkwrap dependencies with parent-scoped overrides", () => {
    const overrides = collectCurrentShrinkwrapOverrides(
      {
        packages: {
          "": { dependencies: { "current-parent": "1.0.0" } },
          "node_modules/current-parent": {
            version: "1.0.0",
            dependencies: { "forked-child": "^2.0.0" },
          },
          "node_modules/current-parent/node_modules/forked-child": {
            version: "2.0.0",
          },
          "node_modules/legacy-parent": {
            version: "1.0.0",
            dependencies: { "forked-child": "1.0.0" },
          },
          "node_modules/legacy-parent/node_modules/forked-child": {
            version: "1.0.0",
          },
          "node_modules/stable-child": {
            version: "3.0.0",
          },
        },
      },
      new Set(["current-parent"]),
      new Set([
        "current-parent@1.0.0",
        "legacy-parent@1.0.0",
        "forked-child@1.0.0",
        "forked-child@2.0.0",
        "stable-child@3.0.0",
      ]),
    );

    expect(overrides).toEqual({
      "current-parent@1.0.0": { "forked-child": "2.0.0" },
      "legacy-parent": { ".": "1.0.0", "forked-child": "1.0.0" },
      "legacy-parent@1.0.0": { "forked-child": "1.0.0" },
      "stable-child": "3.0.0",
    });
  });

  it("merges exact current shrinkwrap pins with nested lock-derived pins", () => {
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

  it("keeps npm shrinkwrap package versions inside the pnpm lock graph", () => {
    const pnpmLockPackages = collectPnpmLockPackages();
    const shrinkwrapPaths = [
      "npm-shrinkwrap.json",
      ...fs
        .readdirSync("extensions", { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `extensions/${entry.name}/npm-shrinkwrap.json`)
        .filter((shrinkwrapPath) => fs.existsSync(shrinkwrapPath))
        .toSorted((left, right) => left.localeCompare(right)),
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
