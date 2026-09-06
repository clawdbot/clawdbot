// Package manager config tests validate workspace package manager settings.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  mergeOverrides,
  parsePnpmPackageKey,
  readNpmLockOverrides,
} from "../scripts/generate-npm-package-lock.mts";
import { pnpmLockfileDocuments } from "../scripts/lib/pnpm-lockfile-documents.mjs";

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
  minimumReleaseAge?: number;
  minimumReleaseAgeStrict?: boolean;
  verifyDepsBeforeRun?: boolean;
};

type PnpmEnvironmentLock = {
  importers?: Record<
    string,
    {
      packageManagerDependencies?: Record<string, { version?: string }>;
    }
  >;
  packages?: Record<string, unknown>;
  snapshots?: Record<string, { optionalDependencies?: Record<string, string> }>;
};

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

function readPnpmEnvironmentLock(): PnpmEnvironmentLock {
  const committedLockfile = execFileSync("git", ["show", "HEAD:pnpm-lock.yaml"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const environment = pnpmLockfileDocuments(committedLockfile).environment;
  if (!environment) {
    throw new Error("pnpm-lock.yaml is missing its environment document");
  }
  return parse(environment) as PnpmEnvironmentLock;
}

function collectPnpmLockPackages(): Set<string> {
  const lockfile = parse(
    pnpmLockfileDocuments(fs.readFileSync("pnpm-lock.yaml", "utf8")).dependencies,
  ) as {
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
  it("keeps pnpm 12 environment lock portable across platforms", () => {
    const lockfile = readPnpmEnvironmentLock();
    const packageManagerDependencies = lockfile.importers?.["."]?.packageManagerDependencies;
    const pnpmVersion = packageManagerDependencies?.pnpm?.version;
    if (typeof pnpmVersion !== "string") {
      throw new Error("pnpm environment lock is missing its package manager version");
    }
    if (Number.parseInt(pnpmVersion, 10) < 12) {
      return;
    }

    expect(packageManagerDependencies).not.toHaveProperty("@pnpm/exe");
    expect(
      Object.keys(lockfile.packages ?? {}).filter((key) => key.startsWith("@pnpm/exe@")),
    ).toEqual([]);
    expect(
      Object.keys(lockfile.snapshots ?? {}).filter((key) => key.startsWith("@pnpm/exe@")),
    ).toEqual([]);

    const platformExecutables = Object.keys(
      lockfile.snapshots?.[`pnpm@${pnpmVersion}`]?.optionalDependencies ?? {},
    ).filter((name) => name.startsWith("@pnpm/exe."));
    expect(platformExecutables.length).toBeGreaterThan(0);
    for (const packageName of platformExecutables) {
      expect(lockfile.packages).toHaveProperty(`${packageName}@${pnpmVersion}`);
      expect(lockfile.snapshots).toHaveProperty(`${packageName}@${pnpmVersion}`);
    }
  });

  it("keeps optional native Discord opus builds disabled by default", () => {
    const packageJson = readJson("package.json") as RootPackageJson;
    const workspace = parse(fs.readFileSync("pnpm-workspace.yaml", "utf8")) as WorkspaceConfig;

    expect(packageJson.pnpm).toBeUndefined();
    expect(workspace.allowBuilds?.["@discordjs/opus"]).toBe(false);
    expect(workspace.blockExoticSubdeps).toBe(true);
    expect(workspace.minimumReleaseAge).toBe(7 * 24 * 60);
    expect(workspace.minimumReleaseAgeStrict).toBe(true);
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

  it.each(
    (
      [
        ["package", "workspace"],
        ["package", "lock"],
        ["workspace", "lock"],
      ] as const
    ).flatMap(([first, second]) =>
      [false, true].flatMap((childrenFirst) =>
        ["1.2.3", "npm:@scope/parent@1.2.3"].map((rootSpec) => ({
          first,
          second,
          childrenFirst,
          rootSpec,
        })),
      ),
    ),
  )(
    "retains child policy and $rootSpec across sources $first/$second (childrenFirst=$childrenFirst)",
    ({ first, second, childrenFirst, rootSpec }) => {
      const sources: Record<"package" | "workspace" | "lock", Record<string, unknown>> = {
        package: {},
        workspace: {},
        lock: {},
      };
      const children = { parent: { child: "2.0.0" } };
      const self = { parent: rootSpec };
      sources[first] = childrenFirst ? children : self;
      sources[second] = childrenFirst ? self : children;

      expect(mergeOverrides(sources.package, sources.workspace, sources.lock)).toEqual({
        parent: { ".": rootSpec, child: "2.0.0" },
      });
    },
  );

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

  it.each([
    ["^1.0.0", "~1.0.0"],
    ["1.0.0", "2.0.0"],
  ])("rejects conflicting root pins %s and %s when merging nested pins", (left, right) => {
    expect(() =>
      mergeOverrides(
        { "floating-package": left },
        { "floating-package": { ".": right, child: "2.0.0" } },
        {},
      ),
    ).toThrow(/conflicts with pnpm lock policy/u);
    expect(() =>
      mergeOverrides(
        { "floating-package": { ".": left, child: "2.0.0" } },
        { "floating-package": right },
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
